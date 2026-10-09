/**
 * AI 网关集成测试（M1+M4）。运行：node test/test-ai-gateway.js
 * 隔离：BUGLIST_DATA_ROOT 指向临时目录（helpers 副作用），绝不碰真实数据。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const H = require('./helpers');
const { DATA_ROOT, assert, teardown, getCounts, onFatal } = H;
const { PROTOCOLS, PROVIDER_PRESETS, DEFAULT_CONFIG, createAiGateway } = require('../ai-gateway');
const { startServer } = require('../server');

async function runTests() {
  console.log('\n=== AI 网关测试 ===\n');
  const gw = createAiGateway({ dataRoot: DATA_ROOT });
  const configFile = path.join(DATA_ROOT, 'ai.config.json');
  const dataFile = path.join(DATA_ROOT, 'data.json');
  // 修正点②：data.json 在首次写入前不存在（server readData ENOENT 不落盘）——安全断言必须容错
  const dataJsonText = () => (fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf-8') : '{}');

  assert(fs.existsSync(configFile) === false, '初始无 ai.config.json');
  const d = gw.loadConfig();
  assert(d.enabled === false, '默认 enabled=false');
  assert(d.protocol === 'openai', '默认 protocol=openai');
  assert(d.key === '' && d.context === '' && d.contextSummary === '', '默认 key/context 为空');
  assert(JSON.stringify(d) === JSON.stringify(DEFAULT_CONFIG), 'loadConfig 无文件时等于 DEFAULT_CONFIG');

  const saved = gw.saveConfig({
    enabled: true, provider: 'deepseek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', key: 'sk-test-key-123', model: 'deepseek-chat',
  });
  assert(fs.existsSync(configFile), 'saveConfig 后 ai.config.json 落盘');
  assert(JSON.parse(fs.readFileSync(configFile, 'utf-8')).key === 'sk-test-key-123', '磁盘保存明文 key（仅限 ai.config.json）');
  assert(saved.key === 'sk-test-key-123', 'saveConfig 返回含 key 的完整配置');
  assert(!dataJsonText().includes('sk-test-key-123'), 'data.json 不含 key');

  const masked = gw.maskConfig(gw.loadConfig());
  assert(masked.key === '' && masked.keySet === true, 'maskConfig 掩掉 key 并置 keySet');
  assert(masked.model === 'deepseek-chat', 'maskConfig 保留其余字段');

  const norm = gw.saveConfig({ protocol: 'gpt9', enabled: 'yes', key: 123, baseUrl: null });
  assert(norm.protocol === 'openai' && norm.enabled === false, '非法 protocol/enabled 归一化');
  assert(norm.key === '' && norm.baseUrl === '', '非字符串 key/baseUrl 归一化为空串');

  let threw = false;
  try { gw.saveConfig({ key: 'sk-x', baseUrl: 'not-a-url', protocol: 'openai', model: 'm' }); } catch (e) { threw = true; }
  assert(threw, 'key 非空且 baseUrl 非法时 saveConfig 抛错');

  const cleared = gw.saveConfig({ enabled: false, provider: 'custom', protocol: 'openai', baseUrl: '', key: '', model: '' });
  assert(cleared.key === '' && cleared.enabled === false, '清空配置合法（不校验 baseUrl）');

  // 预设完整性（M1 第一版八项）
  const requiredPresets = ['mimo', 'deepseek', 'glm', 'qwen', 'kimi', 'openai', 'ollama', 'custom'];
  for (const k of requiredPresets) {
    assert(!!PROVIDER_PRESETS[k], `预设存在: ${k}`);
    assert(PROTOCOLS.includes(PROVIDER_PRESETS[k].protocol), `预设 ${k} protocol 合法`);
    assert(typeof PROVIDER_PRESETS[k].label === 'string' && PROVIDER_PRESETS[k].label, `预设 ${k} 有 label`);
    assert(typeof PROVIDER_PRESETS[k].baseUrl === 'string', `预设 ${k} baseUrl 为字符串`);
    assert(typeof PROVIDER_PRESETS[k].modelHint === 'string', `预设 ${k} modelHint 为字符串`);
  }
  assert(PROVIDER_PRESETS.mimo.protocol === 'openai', 'MiMo 走 OpenAI 兼容');
  assert(PROVIDER_PRESETS.kimi.protocol === 'openai', 'Kimi 走 OpenAI 兼容');

  // ---------- Task 2: openai 适配 + 队列 ----------
  const requests = [];
  const mock = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: JSON.parse(body || '{}') });
        // 第二个请求故意延迟 80ms，用于验证队列串行（后发的不越过先发的）
        const delay = requests.length === 2 ? 80 : 0;
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: `reply-${requests.length}` } }] }));
        }, delay);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const mockPort = mock.address().port;

  gw.saveConfig({
    enabled: true, provider: 'custom', protocol: 'openai',
    baseUrl: `http://127.0.0.1:${mockPort}/v1`, key: 'sk-mock', model: 'mock-model',
  });

  const r1 = await gw.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 });
  assert(r1.content === 'reply-1', 'openai 适配返回 choices[0].message.content');
  assert(requests[0].url === '/v1/chat/completions', 'openai 路径 /chat/completions');
  assert(requests[0].auth === 'Bearer sk-mock', 'openai 用 Bearer 认证');
  assert(requests[0].body.model === 'mock-model', 'openai 请求体带 model');
  assert(requests[0].body.max_tokens === 5, 'openai 请求体带 max_tokens');

  // 串行队列：两个并发 chat，后发的请求在先发完成之后才发出
  const order = [];
  const pA = gw.chat({ messages: [{ role: 'user', content: 'a' }] }).then(() => order.push('A'));
  const pB = gw.chat({ messages: [{ role: 'user', content: 'b' }] }).then(() => order.push('B'));
  await Promise.all([pA, pB]);
  assert(order.join('') === 'AB', '并发 chat 串行执行（A 先 B 后）');
  assert(requests.length === 3, '两次并发 chat 共产生 2 个新请求（+此前 1 个）');

  // ---------- Task 3: anthropic / gemini 适配 ----------
  requests.length = 0;
  const mock2 = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({
          method: req.method, url: req.url,
          auth: req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.headers.authorization || '',
          headers: req.headers,
          body: JSON.parse(body || '{}'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.startsWith('/v1/messages')) {
          res.end(JSON.stringify({ content: [{ type: 'text', text: 'claude-reply' }] }));
        } else if (req.url.includes(':generateContent')) {
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini-reply' }] } }] }));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { content: 'openai-reply' } }] }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const mock2Port = mock2.address().port;

  gw.saveConfig({
    enabled: true, provider: 'custom', protocol: 'anthropic',
    baseUrl: `http://127.0.0.1:${mock2Port}`, key: 'sk-ant', model: 'claude-x',
  });
  const ant = await gw.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert(ant.content === 'claude-reply', 'anthropic 适配返回 content[0].text');
  assert(requests[0].url === '/v1/messages', 'anthropic 路径 /v1/messages');
  assert(requests[0].auth === 'sk-ant', 'anthropic 用 x-api-key 认证');
  assert(requests[0].headers['anthropic-version'] === '2023-06-01', 'anthropic 带 anthropic-version');
  assert(requests[0].body.model === 'claude-x', 'anthropic 请求体带 model');
  assert(requests[0].body.max_tokens === 1024, 'anthropic 默认 max_tokens=1024');

  gw.saveConfig({
    enabled: true, provider: 'custom', protocol: 'gemini',
    baseUrl: `http://127.0.0.1:${mock2Port}`, key: 'gm-key', model: 'gemini-x',
  });
  const gem = await gw.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert(gem.content === 'gemini-reply', 'gemini 适配返回 candidates[0].content.parts[0].text');
  assert(requests[1].url.includes('/v1beta/models/gemini-x:generateContent'), 'gemini 路径含 model:generateContent');
  assert(requests[1].auth === 'gm-key', 'gemini 用 x-goog-api-key 认证');

  // anthropic system 拆顶层
  requests.length = 0;
  gw.saveConfig({
    enabled: true, provider: 'custom', protocol: 'anthropic',
    baseUrl: `http://127.0.0.1:${mock2Port}`, key: 'sk-ant', model: 'claude-x',
  });
  await gw.chat({ messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }] });
  assert(requests[0].body.system === '你是助手', 'anthropic system 进顶层 system 字段');
  assert(requests[0].body.messages.length === 1 && requests[0].body.messages[0].role === 'user', 'anthropic messages 不含 system');

  // 修正点B：gemini 不丢 system——并入首条 user
  requests.length = 0;
  gw.saveConfig({
    enabled: true, provider: 'custom', protocol: 'gemini',
    baseUrl: `http://127.0.0.1:${mock2Port}`, key: 'gm-key', model: 'gemini-x',
  });
  await gw.chat({
    messages: [
      { role: 'system', content: '展开提示词SYSTEM_MARK' },
      { role: 'user', content: '前端太丑了' },
    ],
  });
  const gemBody = requests[0].body;
  assert(Array.isArray(gemBody.contents) && gemBody.contents.length >= 1, 'gemini contents 非空');
  assert(String(gemBody.contents[0].parts[0].text).includes('SYSTEM_MARK'), 'gemini 首条 user 含 system 文本（修正点B）');
  assert(String(gemBody.contents[0].parts[0].text).includes('前端太丑了'), 'gemini 首条 user 仍含用户草稿');

  // ---------- Task 4: 连通探测 ----------
  const mock3 = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  gw.saveConfig({
    enabled: true, provider: 'custom', protocol: 'openai',
    baseUrl: `http://127.0.0.1:${mock3.address().port}/v1`, key: 'sk-p', model: 'm',
  });
  const ok = await gw.testConnection();
  assert(ok.ok === true, '连通探测成功返回 ok:true');
  assert(typeof ok.latencyMs === 'number' && ok.latencyMs >= 0, '成功返回 latencyMs');

  const mock4 = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  gw.saveConfig({
    enabled: true, provider: 'custom', protocol: 'openai',
    baseUrl: `http://127.0.0.1:${mock4.address().port}/v1`, key: 'sk-bad', model: 'm',
  });
  const bad = await gw.testConnection();
  assert(bad.ok === false, '连通探测失败返回 ok:false');
  assert(typeof bad.error === 'string' && bad.error.includes('401'), '失败带 HTTP 状态的 error 文本');

  gw.saveConfig({ enabled: false, provider: 'custom', protocol: 'openai', baseUrl: '', key: '', model: '' });
  const incomplete = await gw.testConnection();
  assert(incomplete.ok === false && incomplete.error.includes('配置不完整'), '配置不完整时直接失败');

  // ---------- Task 5: HTTP 路由 ----------
  let httpServer = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;

    const getCfg = () => new Promise((resolve, reject) => {
      http.get({ host: 'localhost', port, path: '/api/ai/config' }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(t) }));
      }).on('error', reject);
    });
    const putCfg = (obj) => new Promise((resolve, reject) => {
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const req = http.request({
        host: 'localhost', port, path: '/api/ai/config', method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(t || '{}'); } catch (e) { /* ignore */ }
          resolve({ statusCode: res.statusCode, body: parsed, raw: t });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
    const postTest = () => new Promise((resolve, reject) => {
      const req = http.request({ host: 'localhost', port, path: '/api/ai/test', method: 'POST' }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(t || '{}') }));
      });
      req.on('error', reject);
      req.end();
    });

    const g = await getCfg();
    assert(g.statusCode === 200, 'GET /api/ai/config 200');
    assert(g.body.config.keySet === false, 'GET 默认 keySet=false');
    assert(g.body.config.key === '', 'GET 响应 key 恒为空串');

    const p = await putCfg({
      enabled: true, provider: 'deepseek', protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1', key: 'sk-http-secret', model: 'deepseek-chat',
    });
    assert(p.statusCode === 200, 'PUT /api/ai/config 200');
    assert(p.body.config.keySet === true, 'PUT 响应 keySet=true');
    assert(p.body.config.key === '', 'PUT 响应绝不回传明文 key');
    assert(!p.raw.includes('sk-http-secret'), 'PUT 响应原文无明文 key');

    const g2 = await getCfg();
    assert(g2.body.config.model === 'deepseek-chat', 'GET 读到保存后的 model');
    assert(g2.body.config.key === '', 'GET 二读依然无明文 key');
    assert(g2.body.config.keySet === true, 'GET 二读 keySet=true');

    const dataRaw = dataJsonText();
    assert(!dataRaw.includes('sk-http-secret'), 'data.json（或尚未创建）不含 HTTP 保存的 key');

    // key 保留语义：PUT 请求体缺省 key 字段 = 保留服务端已存 key
    const pKeep = await putCfg({
      enabled: true, provider: 'custom', protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    });
    assert(pKeep.statusCode === 200, '缺省 key 字段的 PUT 200');
    assert(pKeep.body.config.keySet === true, '缺省 key 字段时保留已存 key（keySet 仍为 true）');
    assert(pKeep.body.config.model === 'deepseek-chat', '缺省 key 字段时其余字段正常更新');

    // 修正点G：畸形 body 防崩
    for (const bad of ['null', '"str"', '123', '[]']) {
      const r = await putCfg(bad);
      assert(r.statusCode === 400, `畸形 body ${bad} → 400`);
      assert(typeof r.body.error === 'string', `畸形 body ${bad} 带 error 文案`);
    }
    const alive = await getCfg();
    assert(alive.statusCode === 200, '畸形 PUT 后进程存活（GET 仍 200）');

    const pBad = await putCfg({ key: 'sk-x', baseUrl: 'ftp://bad', protocol: 'openai', model: 'm' });
    assert(pBad.statusCode === 400, '非法 baseUrl 的 PUT 返回 400');
    assert(typeof pBad.body.error === 'string', '400 带 error 文案');

    // 连通探测：指向本地 mock（401），绝不打真实外网
    const mockFail = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    await putCfg({
      enabled: true, provider: 'custom', protocol: 'openai',
      baseUrl: `http://127.0.0.1:${mockFail.address().port}/v1`, key: 'sk-mock-bad', model: 'm',
    });
    const t = await postTest();
    assert(t.statusCode === 200, 'POST /api/ai/test 恒 200（业务结果放 body）');
    assert(t.body.ok === false, 'mock 401 时 ok:false');
    assert(typeof t.body.error === 'string' && t.body.error.includes('401'), '失败带 HTTP 状态的 error 文案');
    mockFail.close();

    // 静态页与既有路由不受影响（正控）
    const home = await new Promise((resolve, reject) => {
      http.get({ host: 'localhost', port, path: '/' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert(home === 200, '既有 / 路由不受影响');
  } finally {
    // 只关服务，不删 DATA_ROOT——后续任务断言仍要读写配置
    if (httpServer) { try { httpServer.close(); } catch (e) { /* ignore */ } }
    await H.sleep(100);
  }

  // ---------- Task 6-8 及 M4 的分块断言在下方继续追加 ----------
  mock.close();
  mock2.close();
  mock3.close();
  mock4.close();
  const counts = getCounts();
  console.log(`\n=== AI 网关测试结果: ${counts.passed} 通过, ${counts.failed} 失败 ===`);
  return counts;
}

runTests().then(() => process.exit(H.exitCode())).catch(onFatal);
