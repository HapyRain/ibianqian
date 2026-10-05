/**
 * 崩溃加固回归测试（WS 消息守卫 / 畸形编码容错 / 上传文件名穿越拒绝 / data.json 损坏只读保护）
 *
 * 覆盖目标行为：
 *  0. WS 畸形帧守卫：字面量 null / 数字 / 数组 / 字符串 / 非 JSON / type 非法或缺失 /
 *     data 缺失等消息 → 服务器进程存活、连接不断开，后续正常消息仍被处理（正控：createTask 落盘 + 广播）
 *  1. 畸形百分号编码与穿越路径 HTTP 请求 → 4xx 且进程存活：
 *     - GET /uploads/%            （decodeURIComponent 抛 URIError）
 *     - GET /uploads/%2e%2e%2fserver.js（解码为 ../server.js → 文件名不安全）
 *     - GET /uploads/..%2f..%2fserver.js（深度穿越变体）
 *     - DELETE /api/upload/%      （decodeURIComponent 抛 URIError）
 *  2. multipart 上传 filename 带路径穿越（..\..\..\pwned.png 与 ../../pwned.png）→ 4xx 拒绝，
 *     且数据目录树内、系统临时目录根（..\..\ 落点）、临时目录父级（..\..\..\ 落点）均无 pwned.png 落盘
 *  3. 预置损坏 data.json（{{{不是json）后重启服务 → 启动即进入只读保护：
 *     - data.json 原样保留（绝不被空数据覆盖）、生成 .corrupted 备份（仅一份）
 *     - 连接 fullSync 以空数据兜底；createTask/add/updateTask 等写消息全部被拒（无广播、版本不变）
 *     - requestSync / GET /api/export 等读路径仍可用（进程存活、只读语义一致）
 *
 * 运行方式：node test-crash-hardening.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据；
 *       阶段 3 通过"关旧实例 → 同进程重启新端口实例"模拟损坏后启动（实例锁按同进程幂等放行）。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const H = require('./helpers');
const { startServer } = require('../server');
const {
  DATA_ROOT, DATA_FILE, UPLOADS_DIR,
  assert, sleep, waitFor, readData, listUploads, countBroadcasts,
  connectWS, httpUpload, PNG_BUFFER, teardown, getCounts, onFatal,
} = H;

// data.json 损坏后的文件内容必须逐字节保持原样 —— readData() 会 JSON.parse 抛错，
// 本文件只读阶段一律用原始文本读取，不得使用 helpers.readData
const CORRUPT_TEXT = '{{{不是json';
const readRawDataFile = () => fs.readFileSync(DATA_FILE, 'utf-8');

/** 任意 method + 原样请求路径（不做 encodeURIComponent，专门打畸形编码） */
function httpRequestRaw(port, method, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, path: reqPath, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const is4xx = (code) => code >= 400 && code < 500;

/** 递归检查目录树内是否存在名为 fileName 的文件（目录不可读按不存在处理） */
function treeHasFile(rootDir, fileName) {
  let found = false;
  const walk = (dir) => {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (found) return;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === fileName) found = true;
    }
  };
  walk(rootDir);
  return found;
}

/** 穿越落点核查：三类落点都不存在 pwned.png（落点推算见阶段 2 注释） */
function pwnedNowhere() {
  const tmpRoot = os.tmpdir();                       // 系统临时目录根（../../ 落点）
  const tmpParent = path.dirname(os.tmpdir());       // 临时目录父级（..\..\..\ 落点）
  return !treeHasFile(DATA_ROOT, 'pwned.png')
    && !fs.existsSync(path.join(tmpRoot, 'pwned.png'))
    && !fs.existsSync(path.join(tmpParent, 'pwned.png'));
}

async function runTests() {
  console.log('\n=== 崩溃加固回归测试 ===\n');

  let httpServer = null;
  let clientA = null;
  let clientB = null;
  let clientC = null;
  let clientD = null;
  let httpServer2 = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${DATA_ROOT}`);

    clientA = await connectWS(port, '发送方A');
    clientB = await connectWS(port, '监听方B');
    await waitFor(() => clientA.messages.some(m => m.type === 'fullSync') && clientB.messages.some(m => m.type === 'fullSync'));

    const TASK_ID = 'task-crash-001';

    // ===== 阶段 0：WS 畸形帧守卫 =====
    console.log('\n[阶段0] WS 畸形帧（null/数字/数组/字符串/非JSON/type非法/data缺失）:');
    const BAD_FRAMES = [
      ['字面量 null', 'null'],
      ['数字 123', '123'],
      ['JSON 数组', '[]'],
      ['JSON 字符串', '"hello"'],
      ['非 JSON 文本', 'not-json-at-all'],
      ['type 为数字', '{"type":123}'],
      ['type 为对象', '{"type":{}}'],
      ['顶层对象但无 type', '{"data":{"taskId":"x"}}'],
      ['未知 type', '{"type":"__no_such_type__","data":{}}'],
      ['update 缺 data', '{"type":"update"}'],
      ['update data=null', '{"type":"update","data":null}'],
      ['add 缺 bug', '{"type":"add","data":{"taskId":"x"}}'],
      ['deleteTask 缺 taskId', '{"type":"deleteTask","data":{}}'],
      ['requestSync 外的空对象消息', '{"type":"updateNote"}'],
    ];
    for (const [label, frame] of BAD_FRAMES) {
      clientA.ws.send(frame);
      await sleep(30); // 给服务端处理窗口；任何崩溃都会让后续步骤失败
    }
    assert(clientA.ws.readyState === 1, '畸形帧全部发送后 WS 连接仍为 OPEN（未被误杀）');

    // 正控：畸形帧之后正常消息仍被处理 → createTask 落盘 + 广播
    clientA.send({ type: 'createTask', clientId: 'client-a', data: { task: { id: TASK_ID, name: '崩溃加固任务' } } });
    const created = await waitFor(() => {
      try { return readData().tasks.some(t => t.id === TASK_ID); } catch (e) { return false; }
    });
    assert(created, '畸形帧后 createTask 仍正常落盘（服务器进程存活、消息处理未受影响）');
    const bcAfterCreate = await waitFor(() => countBroadcasts(clientB) >= 1);
    assert(bcAfterCreate, '畸形帧后监听方 B 仍收到 createTask 广播（广播链路正常）');

    // ===== 阶段 1：畸形百分号编码 / 穿越路径 HTTP 请求 =====
    console.log('\n[阶段1] 畸形编码与穿越路径 HTTP 请求（4xx 且进程存活）:');
    const cases1 = [
      ['GET /uploads/%（URIError 容错）', 'GET', '/uploads/%'],
      ['GET /uploads/%2e%2e%2fserver.js（解码为 ../server.js）', 'GET', '/uploads/%2e%2e%2fserver.js'],
      ['GET /uploads/..%2f..%2fserver.js（深度穿越变体）', 'GET', '/uploads/..%2f..%2fserver.js'],
      ['DELETE /api/upload/%（URIError 容错）', 'DELETE', '/api/upload/%'],
    ];
    for (const [label, method, reqPath] of cases1) {
      const res = await httpRequestRaw(port, method, reqPath);
      assert(is4xx(res.statusCode), `${label} → 4xx（实际 status=${res.statusCode}）`);
    }
    // 进程存活证明：HTTP 与 WS 读路径均可用
    const aliveHttp = await httpRequestRaw(port, 'GET', '/api/export');
    assert(aliveHttp.statusCode === 200, '畸形请求后 GET /api/export 仍返回 200（HTTP 服务存活）');
    clientA.send({ type: 'requestSync', clientId: 'client-a' });
    const aliveWS = await waitFor(() => clientA.messages.filter(m => m.type === 'fullSync').length >= 2, 3000);
    assert(aliveWS, '畸形请求后 requestSync 仍返回 fullSync（WS 服务存活）');

    // ===== 阶段 2：multipart 上传 filename 路径穿越拒绝 =====
    console.log('\n[阶段2] multipart 上传 filename 穿越拒绝 + 落盘核查:');
    assert(listUploads().length === 0, '前置：此时 uploads/ 为空（前两阶段无合法文件落盘）');
    // 穿越落点推算（uploads 目录为基准）：
    //   ..\..\..\pwned.png → <系统临时目录父级>\pwned.png（uploads 上跳 3 级）
    //   ../../pwned.png    → <系统临时目录根>\pwned.png（uploads 上跳 2 级）
    //   ../pwned.png       → 数据目录根（由树扫描覆盖）
    const TRAVERSAL_FILENAMES = ['..\\..\\..\\pwned.png', '../../pwned.png', '../pwned.png', 'srv-pwn.png/../../pwned.png'];
    for (const fname of TRAVERSAL_FILENAMES) {
      const up = await httpUpload(
        port,
        { 'X-Bug-Id': 'bug-crash-001', 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' },
        PNG_BUFFER, fname, 'image/png'
      );
      assert(is4xx(up.statusCode), `穿越文件名 "${fname}" 上传被拒（4xx，实际 status=${up.statusCode}）`);
      assert(!(up.body && up.body.success === true) && !(up.body && up.body.filename), `穿越文件名 "${fname}" 响应不含成功标志/文件名`);
    }
    assert(!treeHasFile(DATA_ROOT, 'pwned.png'), '数据目录树内（含 uploads/）无 pwned.png 落盘');
    assert(pwnedNowhere(), '系统临时目录根、临时目录父级均无 pwned.png 落盘');
    assert(listUploads().length === 0, '穿越上传尝试后 uploads/ 仍为空（无任何残留文件）');

    // ===== 阶段 3：data.json 损坏 → 重启后只读保护 =====
    console.log('\n[阶段3] 预置损坏 data.json → 重启进入只读保护:');
    // 收尾实例 1：关客户端 → 关服务 → 预留端口/句柄释放窗口
    clientA.close();
    clientB.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await sleep(200);

    fs.writeFileSync(DATA_FILE, CORRUPT_TEXT, 'utf-8');
    const started2 = await startServer(3051); // 同进程重启：实例锁按 pid 幂等放行
    httpServer2 = started2.httpServer;
    const port2 = started2.port;
    console.log(`第二个实例已启动（损坏数据预读）: ws://localhost:${port2}`);

    clientC = await connectWS(port2, '只读客户端C');
    clientD = await connectWS(port2, '监听方D');
    const syncC = await waitFor(() => clientC.messages.find(m => m.type === 'fullSync'));
    assert(!!syncC && Array.isArray(syncC.data.tasks) && syncC.data.tasks.length === 0 && syncC.data.version === 0,
      '损坏数据下连接 fullSync 以空数据兜底（tasks=[]，version=0），不崩溃');

    // 启动预读即进入只读：.corrupted 备份恰好一份
    const corruptedBackups = () => fs.readdirSync(DATA_ROOT).filter(f => f.startsWith('data.json.corrupted.')).length;
    assert(corruptedBackups() === 1, '启动预读生成恰好一份 data.json.corrupted.* 备份');

    // 写消息全部被拒：createTask / add / updateTask / deleteTask 连发，均不得产生广播或写盘。
    // 随后同连接发 requestSync 作为"处理完毕探针"——WS 同连接消息按序处理，
    // fullSync 到达即证明前面四条写消息都已被服务端处理完（替代固定 sleep，消除时序 flake）
    clientC.send({ type: 'createTask', clientId: 'client-c', data: { task: { id: 'task-ro-1', name: '只读期任务' } } });
    clientC.send({ type: 'add', clientId: 'client-c', data: { taskId: 'task-ro-1', bug: { id: 'bug-ro-1', name: 'x', status: '待修复' } } });
    clientC.send({ type: 'updateTask', clientId: 'client-c', data: { taskId: 'task-ro-1', field: 'name', value: 'y' } });
    clientC.send({ type: 'deleteTask', clientId: 'client-c', data: { taskId: 'task-ro-1' } });
    clientC.send({ type: 'requestSync', clientId: 'client-c' });
    const roSync = await waitFor(() => clientC.messages.filter(m => m.type === 'fullSync').length >= 2, 3000);
    assert(roSync, '只读保护下 requestSync 仍返回 fullSync（读路径可用、进程存活）');

    assert(readRawDataFile() === CORRUPT_TEXT, '只读保护：data.json 内容逐字节保持原样（未被空数据覆盖）');
    assert(countBroadcasts(clientD) === 0, '只读保护：写消息全部被拒，监听方 D 未收到任何广播');
    assert(corruptedBackups() === 1, '只读期间未产生新的 .corrupted 备份（一次性语义）');
    const roExport = await httpRequestRaw(port2, 'GET', '/api/export');
    let roExportOk = roExport.statusCode === 200;
    try { roExportOk = roExportOk && JSON.parse(roExport.body).tasks.length === 0; } catch (e) { roExportOk = false; }
    assert(roExportOk, '只读保护下 GET /api/export 返回 200 + 空数据（损坏兜底语义一致）');
  } finally {
    await teardown(httpServer2, clientC, clientD);
    // 实例 1 的客户端/服务在阶段 3 前已手动关闭；临时目录统一由 teardown 清理
  }

  const { passed, failed } = getCounts();
  console.log(`\n=== 崩溃加固回归测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(onFatal);
