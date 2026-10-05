/**
 * 数据导出 / 导入集成测试（/api/export、/api/import）
 *
 * 覆盖目标行为：
 *  1. GET /api/export 返回全量数据：与磁盘 data.json（readData 同源）逐字段一致，含图片引用
 *  2. POST /api/import 正常导入：
 *     - 响应 { success, version(+1), missingImages }
 *     - missingImages 统计正确：引用但 uploads/ 缺失的唯一图片数（含"已上传一张图 + 引用一个幽灵文件"
 *       的混合场景 → 1；全部存在 → 0）
 *     - 所有已连接客户端（含发起方）收到导入后数据的 fullSync 广播
 *  3. 格式防呆：缺少 tasks 数组的导入体 → 400
 *  4. 导入空 tasks 数组：会清空全部任务 —— 这是现有实现的既定行为（handleImportData 仅要求
 *     tasks 是数组，无"至少保留一个任务"防呆），按现状断言；若未来加防呆，本断言需随实现更新。
 *
 * 运行方式：node test-export-import.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const http = require('http');
const H = require('./helpers');
const { startServer } = require('../server');
const {
  assert, waitFor, readData, connectWS, httpUpload, PNG_BUFFER, teardown, getCounts, onFatal,
} = H;

function writeSeed() {
  fs.writeFileSync(H.DATA_FILE, JSON.stringify({
    version: 1,
    tasks: [
      {
        id: 'task-exp-a', name: '导出任务A', notes: [],
        bugs: [{ id: 'bug-exp-1', name: '导出Bug1', status: '待修复', statusChangedAt: 1, images: [], notes: [] }],
      },
      {
        id: 'task-exp-b', name: '导出任务B', notes: [],
        bugs: [{ id: 'bug-exp-2', name: '导出Bug2', status: '修复中', statusChangedAt: 1, images: [], notes: [] }],
      },
    ],
  }, null, 2), 'utf-8');
}

/** GET 并解析 JSON（含 statusCode） */
function httpGetJson(port, apiPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: apiPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* 保持 null */ }
        resolve({ statusCode: res.statusCode, body: parsed, raw: text });
      });
    }).on('error', reject);
  });
}

/** POST JSON（含 statusCode，供 4xx 断言） */
function httpPostJson(port, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const req = http.request({
      host: 'localhost', port, path: apiPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* 保持 null */ }
        resolve({ statusCode: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const lastFullSync = (client) => client.messages.filter(m => m.type === 'fullSync').pop();

async function runTests() {
  console.log('\n=== 数据导出 / 导入集成测试 ===\n');

  writeSeed();
  let httpServer = null;
  let clientA = null;
  let clientB = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${H.DATA_ROOT}`);

    clientA = await connectWS(port, '发起方A');
    clientB = await connectWS(port, '接收方B');
    await waitFor(() => clientA.messages.some(m => m.type === 'fullSync') && clientB.messages.some(m => m.type === 'fullSync'));

    // 前置：给 bug-exp-1 上传一张真实图片（导出应含引用；导入引用它时 missingImages 不计缺）
    const up = await httpUpload(port, { 'X-Bug-Id': 'bug-exp-1', 'X-Task-Id': 'task-exp-a', 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'exp-imp.png', 'image/png');
    assert(up.statusCode === 200 && up.body && up.body.success === true, `前置：bug-exp-1 上传图片成功（status=${up.statusCode}）`);
    const f1 = up.body && up.body.filename;
    await waitFor(() => (readData().tasks.find(t => t.id === 'task-exp-a').bugs[0].images || []).length === 1);

    // ===== 1. 导出：全量数据 =====
    console.log('\n[阶段1] GET /api/export 返回全量数据:');
    const exp = await httpGetJson(port, '/api/export');
    assert(exp.statusCode === 200 && !!exp.body, `导出接口返回 200 + JSON（status=${exp.statusCode}）`);
    assert(Array.isArray(exp.body.tasks) && exp.body.tasks.length === 2, '导出包含全部 2 个任务');
    const expBug1 = exp.body.tasks.find(t => t.id === 'task-exp-a').bugs.find(b => b.id === 'bug-exp-1');
    assert(!!expBug1 && Array.isArray(expBug1.images) && expBug1.images[0] === f1, '导出中 bug-exp-1 的图片引用完整保留');
    assert(exp.body.version === readData().version, '导出 version 与磁盘 data.json 一致');
    assert(JSON.stringify(exp.body) === JSON.stringify(readData()),
      '导出内容与磁盘 data.json 逐字段一致（readData 同源）');

    // ===== 2. 导入：正常导入 + missingImages 统计 + 全端 fullSync 广播 =====
    console.log('\n[阶段2] POST /api/import（含已存在图片 + 幽灵图片）:');
    const versionBefore = readData().version;
    const importPayload = {
      version: 1,
      tasks: [{
        id: 'task-imp-1', name: '导入项目', notes: [],
        bugs: [{ id: 'bug-imp-1', name: '导入Bug', status: '待修复', statusChangedAt: 5, images: [f1, 'ghost-missing.png'], notes: [] }],
      }],
    };
    const imp = await httpPostJson(port, '/api/import', importPayload);
    assert(imp.statusCode === 200 && imp.body && imp.body.success === true, `导入接口返回 success:true（status=${imp.statusCode}）`);
    assert(imp.body.version === versionBefore + 1, `导入后版本号恰好 +1（${versionBefore} → ${imp.body.version}）`);
    assert(imp.body.missingImages === 1, `missingImages 统计正确（唯一缺失图片 ghost-missing.png，实际=${imp.body && imp.body.missingImages}）`);

    const disk1 = await waitFor(() => readData().tasks.length === 1 && readData().tasks[0].id === 'task-imp-1');
    assert(!!disk1, '导入后磁盘 data.json 已替换为导入内容');
    assert((readData().tasks[0].bugs[0].images || []).length === 2, '导入后 bug.images 保留 [f1, ghost-missing.png]');

    const gotA = await waitFor(() => {
      const s = lastFullSync(clientA);
      return s && s.data.tasks[0] && s.data.tasks[0].id === 'task-imp-1';
    }, 3000);
    const gotB = await waitFor(() => {
      const s = lastFullSync(clientB);
      return s && s.data.tasks[0] && s.data.tasks[0].id === 'task-imp-1';
    }, 3000);
    assert(!!gotA && !!gotB, '所有已连接客户端（含发起方）都收到导入后的 fullSync');
    assert(lastFullSync(clientB).version === versionBefore + 1, 'fullSync 广播携带导入后的新版本号');

    // 正控：引用的图片全部存在 → missingImages=0
    const imp2 = await httpPostJson(port, '/api/import', {
      tasks: [{ id: 'task-imp-2', name: '导入项目2', notes: [], bugs: [{ id: 'bug-imp-2', name: 'x', status: '待修复', images: [f1] }] }],
    });
    assert(imp2.statusCode === 200 && imp2.body.success === true && imp2.body.missingImages === 0,
      `引用图片全部存在时 missingImages=0（实际=${imp2.body && imp2.body.missingImages}）`);
    await waitFor(() => readData().tasks[0] && readData().tasks[0].id === 'task-imp-2');

    // ===== 3. 格式防呆：缺少 tasks 数组 → 400 =====
    console.log('\n[阶段3] 非法导入体（缺 tasks 数组）被拒:');
    const impBad = await httpPostJson(port, '/api/import', { hello: 'world' });
    assert(impBad.statusCode === 400, `缺 tasks 数组的导入被拒（HTTP 400，实际 status=${impBad.statusCode}）`);
    assert(readData().tasks[0] && readData().tasks[0].id === 'task-imp-2', '被拒导入不影响现有数据');

    // ===== 4. 空 tasks 数组：按现有实现清空（无防呆） =====
    console.log('\n[阶段4] 导入空 tasks 数组（现有实现无防呆，会清空）:');
    const versionBefore2 = readData().version;
    const impEmpty = await httpPostJson(port, '/api/import', { tasks: [] });
    assert(impEmpty.statusCode === 200 && impEmpty.body.success === true, `空 tasks 导入被接受（status=${impEmpty.statusCode}）`);
    const cleared = await waitFor(() => readData().tasks.length === 0, 3000);
    assert(!!cleared, '导入空 tasks 数组后磁盘 data.json 清空（现有行为，实现无防呆，见文件头注释）');
    assert(impEmpty.body.version === versionBefore2 + 1, '清空导入同样递增版本号');
    const emptyA = await waitFor(() => {
      const s = lastFullSync(clientA);
      return s && Array.isArray(s.data.tasks) && s.data.tasks.length === 0;
    }, 3000);
    const emptyB = await waitFor(() => {
      const s = lastFullSync(clientB);
      return s && Array.isArray(s.data.tasks) && s.data.tasks.length === 0;
    }, 3000);
    assert(!!emptyA && !!emptyB, '清空后的 fullSync 广播送达所有客户端（tasks=[]）');
  } finally {
    await teardown(httpServer, clientA, clientB);
  }

  const { passed, failed } = getCounts();
  console.log(`\n=== 数据导出 / 导入集成测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(onFatal);
