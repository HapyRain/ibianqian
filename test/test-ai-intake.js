/**
 * 需求介入集成测试（M4）。运行：node test/test-ai-intake.js
 * 隔离：BUGLIST_DATA_ROOT 指向临时目录（helpers 副作用），绝不碰真实数据。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const H = require('./helpers');
const { DATA_ROOT, assert, teardown, getCounts, onFatal, connectWS, waitFor, sleep } = H;
const { createAiIntakeState, nextAiState, buildAiTrace } = require('../public/ai-intake');
const { startServer } = require('../server');

async function runTests() {
  console.log('\n=== 需求介入测试 ===\n');

  // ---------- 状态机纯函数 ----------
  let st = createAiIntakeState();
  assert(st.picked === null && st.rounds === 0 && st.rejected === 0, '初始状态干净');

  st = nextAiState(st, { type: 'setDraft', draft: '前端太丑了' });
  assert(st.draft === '前端太丑了', 'setDraft 写入草稿');

  st = nextAiState(st, { type: 'expandOk', candidates: ['颜色奔放', '布局拥挤', '动效干扰'] });
  assert(st.candidates.length === 3, 'expandOk 写入候选');
  assert(st.rounds === 1, 'expandOk 记 rounds');
  assert(st.originalDraft === '前端太丑了', 'expandOk 锁定原始草稿');

  // 选它
  let pickedState = nextAiState(st, { type: 'pick', text: '颜色奔放' });
  assert(pickedState.picked === '颜色奔放', '选它：picked 就位');
  assert(pickedState.draft === '颜色奔放', '选它：候选进输入框');
  assert(pickedState.edited === false, '选它：edited=false');
  assert(pickedState.candidates.length === 2, '选它：候选移除');

  // 对一半
  let halfState = nextAiState(st, { type: 'half', text: '布局拥挤' });
  assert(halfState.draft === '布局拥挤', '对一半：草稿进输入框');
  assert(halfState.edited === true, '对一半：可标记修改');
  assert(halfState.picked === null, '对一半：尚未最终选中');

  // 再介入一轮
  halfState = nextAiState(halfState, { type: 'expandOk', candidates: ['层级不清', '留白不足', '对比不够'] });
  assert(halfState.rounds === 2, '多轮：rounds+1');

  // 完全不是
  let rejState = nextAiState(st, { type: 'reject', text: '动效干扰' });
  assert(rejState.rejected === 1, '完全不是：rejected+1');
  assert(rejState.candidates.length === 2, '完全不是：候选移除');

  // 全部否掉
  let allRej = nextAiState(st, { type: 'rejectAll' });
  assert(allRej.candidates.length === 0, '全否：候选清空');
  assert(allRej.rejected === 3, '全否：rejected 累计');
  assert(allRej.picked === null, '全否：picked 空');

  // hideDraft
  const hidden = nextAiState(pickedState, { type: 'hideDraft', hidden: true });
  assert(hidden.draftHidden === true, '隐藏草稿标记');

  const trace = buildAiTrace({ ...pickedState, draftHidden: true, originalDraft: '前端太丑了', rounds: 2, rejected: 3, edited: true, pickedRound: 2 });
  assert(trace && trace.used === true && trace.picked === '颜色奔放', 'buildAiTrace 含 picked');
  assert(trace.draft === '前端太丑了' && trace.draftHidden === true, 'buildAiTrace 含 draft/draftHidden');
  assert(trace.rounds === 2 && trace.rejected === 3 && trace.edited === true, 'buildAiTrace 计数字段');
  assert(buildAiTrace(createAiIntakeState()) === null, '无 picked 不产出 aiTrace');

  // ---------- HTTP + 数据落盘 ----------
  let httpServer = null;
  let client = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    client = await connectWS(port, 'intake');

    const dataFile = path.join(DATA_ROOT, 'data.json');
    const readDataJson = () => (fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf-8')) : { tasks: [] });

    // 建项目（协议：data.task = { id, name }）
    const TASK_ID = 'task-ai-intake';
    client.send({ type: 'createTask', clientId: 'c1', data: { task: { id: TASK_ID, name: 'AI项目' } } });
    await waitFor(() => readDataJson().tasks && readDataJson().tasks.some((t) => t.id === TASK_ID));
    const taskId = TASK_ID;

    // 轻启动：无 aiTrace 的 add 行为不变
    client.send({
      type: 'add', clientId: 'c1',
      data: { taskId, bug: { id: 'bug-light', name: '普通任务', status: '待修复', images: [], statusChangedAt: Date.now() } },
    });
    await waitFor(() => {
      const t = readDataJson().tasks.find((x) => x.id === taskId);
      return t && t.bugs.some((b) => b.id === 'bug-light');
    });
    const lightBug = readDataJson().tasks.find((x) => x.id === taskId).bugs.find((b) => b.id === 'bug-light');
    assert(!lightBug.aiTrace, '轻启动路径无 aiTrace');

    // AI 介入路径：add 带合法 aiTrace
    const aiTrace = {
      used: true, rounds: 2, draft: '前端太丑了', draftHidden: false,
      picked: '颜色用的过于奔放', pickedRound: 2, rejected: 3, edited: true,
    };
    client.send({
      type: 'add', clientId: 'c1',
      data: {
        taskId,
        bug: {
          id: 'bug-ai', name: '颜色用的过于奔放', status: '待修复', images: [],
          statusChangedAt: Date.now(), aiTrace,
        },
      },
    });
    await waitFor(() => {
      const t = readDataJson().tasks.find((x) => x.id === taskId);
      return t && t.bugs.some((b) => b.id === 'bug-ai' && b.aiTrace);
    });
    const aiBug = readDataJson().tasks.find((x) => x.id === taskId).bugs.find((b) => b.id === 'bug-ai');
    assert(aiBug.name === '颜色用的过于奔放', 'bug.name 即定稿');
    assert(aiBug.aiTrace && aiBug.aiTrace.picked === '颜色用的过于奔放', 'aiTrace.picked 非空');
    assert(aiBug.aiTrace.draft === '前端太丑了', 'aiTrace.draft 存在');
    assert(aiBug.aiTrace.draftHidden === false, 'aiTrace.draftHidden 默认 false');

    // draftHidden 落盘
    client.send({
      type: 'add', clientId: 'c1',
      data: {
        taskId,
        bug: {
          id: 'bug-hidden', name: '定稿A', status: '待修复', images: [],
          statusChangedAt: Date.now(),
          aiTrace: { used: true, rounds: 1, draft: '草稿B', draftHidden: true, picked: '定稿A', pickedRound: 1, rejected: 0, edited: false },
        },
      },
    });
    await waitFor(() => {
      const t = readDataJson().tasks.find((x) => x.id === taskId);
      return t && t.bugs.some((b) => b.id === 'bug-hidden' && b.aiTrace && b.aiTrace.draftHidden === true);
    });
    const hiddenBug = readDataJson().tasks.find((x) => x.id === taskId).bugs.find((b) => b.id === 'bug-hidden');
    assert(hiddenBug.name === '定稿A' && hiddenBug.aiTrace.draftHidden === true, 'draftHidden 落盘且不影响 name');

    // 修正点E：update 不放行 aiTrace（防事后改写痕迹）
    client.send({
      type: 'update', clientId: 'c1',
      data: {
        taskId, bugId: 'bug-ai', field: 'aiTrace',
        value: { used: true, picked: '被篡改', draft: 'x', draftHidden: true, rounds: 9, rejected: 9, edited: true, pickedRound: 9 },
      },
    });
    await sleep(200);
    const afterUpdate = readDataJson().tasks.find((x) => x.id === taskId).bugs.find((b) => b.id === 'bug-ai');
    assert(afterUpdate.aiTrace.picked === '颜色用的过于奔放', 'update 不放行 aiTrace（痕迹不变）');

    // 非法 aiTrace 形状 → 字段剔除
    client.send({
      type: 'add', clientId: 'c1',
      data: {
        taskId,
        bug: {
          id: 'bug-bad-trace', name: '脏痕迹', status: '待修复', images: [], statusChangedAt: Date.now(),
          aiTrace: 'not-an-object',
        },
      },
    });
    await waitFor(() => {
      const t = readDataJson().tasks.find((x) => x.id === taskId);
      return t && t.bugs.some((b) => b.id === 'bug-bad-trace');
    });
    const badTraceBug = readDataJson().tasks.find((x) => x.id === taskId).bugs.find((b) => b.id === 'bug-bad-trace');
    assert(!badTraceBug.aiTrace, '非法 aiTrace 形状被剔除');

    client.send({
      type: 'add', clientId: 'c1',
      data: {
        taskId,
        bug: {
          id: 'bug-missing-used', name: '缺used', status: '待修复', images: [], statusChangedAt: Date.now(),
          aiTrace: { picked: 'x', draft: 'y' },
        },
      },
    });
    await waitFor(() => {
      const t = readDataJson().tasks.find((x) => x.id === taskId);
      return t && t.bugs.some((b) => b.id === 'bug-missing-used');
    });
    const missingUsed = readDataJson().tasks.find((x) => x.id === taskId).bugs.find((b) => b.id === 'bug-missing-used');
    assert(!missingUsed.aiTrace, '缺 used 的 aiTrace 被剔除');

    // 导入归一化保留 aiTrace
    const importPayload = {
      version: 1,
      tasks: [{
        id: 'imp-task', name: '导入项目',
        bugs: [{
          id: 'imp-bug', name: '导入定稿', status: '待修复', statusChangedAt: 1, images: [],
          aiTrace: { used: true, rounds: 1, draft: '导入草稿', draftHidden: true, picked: '导入定稿', pickedRound: 1, rejected: 0, edited: false },
        }],
        notes: [],
      }],
    };
    await new Promise((resolve, reject) => {
      const body = JSON.stringify(importPayload);
      const req = http.request({
        host: 'localhost', port, path: '/api/import', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(body);
    });
    await waitFor(() => {
      const d = readDataJson();
      return d.tasks.some((t) => t.id === 'imp-task' && t.bugs.some((b) => b.aiTrace));
    });
    const impBug = readDataJson().tasks.find((t) => t.id === 'imp-task').bugs[0];
    assert(impBug.aiTrace && impBug.aiTrace.draft === '导入草稿', '导入归一化保留 aiTrace');

    // data.json 不含明文 key（即使配置了 key）
    const cfgBody = JSON.stringify({
      enabled: true, provider: 'custom', protocol: 'openai',
      baseUrl: 'https://example.com/v1', key: 'sk-intake-secret', model: 'm',
    });
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: 'localhost', port, path: '/api/ai/config', method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cfgBody) },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(cfgBody);
    });
    const dataRaw = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf-8') : '{}';
    assert(!dataRaw.includes('sk-intake-secret'), 'data.json 不含明文 key');
    assert(!dataRaw.includes('sk-intake-secret'), 'WS/落盘数据无 key 泄漏');

    // 轻启动：enabled=false 时 expand 降级（已在 gateway 测过，此处回归 HTTP 面）
    const offBody = JSON.stringify({ enabled: false, provider: 'custom', protocol: 'openai', baseUrl: '', key: '', model: '' });
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: 'localhost', port, path: '/api/ai/config', method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(offBody) },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(offBody);
    });
    const expandOff = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ draft: '前端太丑了' });
      const req = http.request({
        host: 'localhost', port, path: '/api/ai/expand', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => resolve(JSON.parse(t || '{}')));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert(Array.isArray(expandOff.candidates) && expandOff.candidates.length === 0 && String(expandOff.error || '').includes('未开启'),
      'enabled=false 时 expand 降级（轻启动）');
  } finally {
    await teardown(httpServer, client);
  }

  const counts = getCounts();
  console.log(`\n=== 需求介入测试结果: ${counts.passed} 通过, ${counts.failed} 失败 ===`);
  return counts;
}

runTests().then(() => process.exit(H.exitCode())).catch(onFatal);
