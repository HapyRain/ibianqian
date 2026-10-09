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

  // ---------- Task 3-8 及 M4 的分块断言在下方继续追加 ----------
  mock.close();
  const counts = getCounts();
  console.log(`\n=== AI 网关测试结果: ${counts.passed} 通过, ${counts.failed} 失败 ===`);
  return counts;
}

runTests().then(() => process.exit(H.exitCode())).catch(onFatal);
