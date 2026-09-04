/**
 * 校验防护集成测试（字段白名单 / 孤儿上传清理 / 魔数强化）
 *
 * 覆盖目标行为：
 *  1. 字段白名单 + 值校验：
 *     - WS update field='id' → data.json 中 bug.id 不变，其他客户端收不到广播
 *     - WS update status='非法值' → data.json 不变
 *     - WS updateTask name=''（及纯空白）→ 任务名不变
 *     - 合法 update / updateTask 仍正常生效（正控，防止白名单误伤）
 *  2. 上传孤儿文件清理：
 *     - 全新空数据目录（无任何任务）启动后，带 X-Bug-Id 头 POST 上传 → uploads/ 为空
 *     - 缺少 X-Bug-Id 的上传 → uploads/ 为空
 *  3. 魔数校验强化：
 *     - "RIFF + AAAA" 伪 webp body（声明 image/webp）→ HTTP 400 且 uploads/ 无残留
 *     - 坏 PNG 头（仅 4 字节签名 + 垃圾，声明 image/png）→ HTTP 400 且 uploads/ 无残留
 *     - 真实 PNG 上传 → 成功（正控）
 *
 * 运行方式：node test-validation-guards.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠️ 必须在 require('../server') 之前设置数据目录（server.js 在 require 时计算 DATA_ROOT）
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'buglist-guards-'));
process.env.BUGLIST_DATA_ROOT = DATA_ROOT;
const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');

const { startServer } = require('../server');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${name}`);
    failed++;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readData() {
  return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'data.json'), 'utf-8'));
}

function listUploads() {
  try {
    return fs.readdirSync(UPLOADS_DIR);
  } catch (e) {
    return [];
  }
}

// 1x1 透明 PNG（合法 PNG 魔数 89504E47...，8 字节签名完整，可过服务端魔数校验）
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// 伪 webp：RIFF 容器头 + 'AAAA'（缺少偏移 8 处的 'WEBP' 标记）+ 垃圾字节
const FAKE_WEBP_BUFFER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from('AAAA', 'ascii'),
  Buffer.from('not-a-real-webp-file', 'ascii'),
]);

// 坏 PNG 头：仅前 4 字节 PNG 签名 + 垃圾字节（8 字节签名不完整）
const BAD_PNG_BUFFER = Buffer.concat([
  PNG_BUFFER.slice(0, 4),
  Buffer.from('broken-png-body-here', 'ascii'),
]);

/** 建立 WS 连接，自动收集收到的消息 */
function connectWS(port, label) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const messages = [];
  ws.on('message', (raw) => {
    try { messages.push(JSON.parse(raw.toString())); } catch (e) { /* 忽略非 JSON */ }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} WS 连接超时`)), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        messages,
        send(obj) { ws.send(JSON.stringify(obj)); },
        close() { try { ws.close(); } catch (e) { /* 忽略 */ } },
      });
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** 手工构造 multipart/form-data 并 POST /api/upload（headers 可自定义，declaredMime 为 part 内 Content-Type） */
function httpUpload(port, headers, fileBuffer, filename, declaredMime) {
  return new Promise((resolve, reject) => {
    const boundary = '----BuglistTestBoundary' + Date.now() + Math.random().toString(36).slice(2);
    const partHeader =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${declaredMime || 'application/octet-stream'}\r\n\r\n`;
    const header = Buffer.from(partHeader, 'utf-8');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([header, fileBuffer, footer]);

    const req = http.request({
      host: 'localhost',
      port,
      path: '/api/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ statusCode: res.statusCode, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 统计某客户端收到的 broadcast 消息数 */
function countBroadcasts(client) {
  return client.messages.filter(m => m.type === 'broadcast').length;
}

async function runTests() {
  console.log('\n=== 校验防护测试 ===\n');

  let httpServer = null;
  let clientA = null;
  let clientB = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${DATA_ROOT}`);

    clientA = await connectWS(port, '发送方A');
    clientB = await connectWS(port, '监听方B');
    await sleep(400); // 等待 fullSync / clientCount

    const TASK_ID = 'task-guard-001';
    const BUG_ID = 'bug-guard-001';

    // ===== 阶段 0：孤儿上传清理（必须最先跑：此时数据目录为空，无任何任务） =====
    console.log('\n[阶段0] 孤儿上传清理（全新空数据目录）:');

    // 0a. 带 X-Bug-Id + X-Task-Id，但目录中没有任何任务 → 数据关联失败，文件须被清理
    const upA = await httpUpload(port, { 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'orphan-a.png', 'image/png');
    console.log(`  [信息] 空目录 + X-Bug-Id + X-Task-Id 上传响应 status=${upA.statusCode}`);
    assert(listUploads().length === 0, '空目录 + 带 X-Bug-Id 上传后 uploads/ 为空（孤儿文件被清理，无残留）');

    // 0b. 带 X-Bug-Id 但不带 X-Task-Id → transform 返回 null（tasks 为空），文件须被清理
    const upB = await httpUpload(port, { 'X-Bug-Id': BUG_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'orphan-b.png', 'image/png');
    console.log(`  [信息] 空目录 + X-Bug-Id（无 X-Task-Id）上传响应 status=${upB.statusCode}`);
    assert(listUploads().length === 0, '空目录 + X-Bug-Id（无 X-Task-Id）上传后 uploads/ 仍为空');

    // 0c. 缺少 X-Bug-Id → 文件已写入但无引用，须被清理
    const upC = await httpUpload(port, { 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'orphan-c.png', 'image/png');
    console.log(`  [信息] 缺少 X-Bug-Id 上传响应 status=${upC.statusCode}`);
    assert(listUploads().length === 0, '缺少 X-Bug-Id 上传后 uploads/ 为空（无孤儿文件）');

    // ===== 阶段 1：建任务 + 建 bug（供白名单测试使用） =====
    console.log('\n[阶段1] 建任务 + 建 bug:');
    clientA.send({ type: 'createTask', clientId: 'client-a', data: { task: { id: TASK_ID, name: '校验测试任务' } } });
    await sleep(400);
    clientA.send({ type: 'add', clientId: 'client-a', data: { taskId: TASK_ID, bug: { id: BUG_ID, name: '校验Bug', status: '待修复' } } });
    await sleep(400);

    // ===== 阶段 2：字段白名单 + 值校验 =====
    console.log('\n[阶段2] 字段白名单 + 值校验:');

    // 基线：B 已收到 createTask / add 两条广播
    const baselineBroadcasts = countBroadcasts(clientB);
    assert(baselineBroadcasts >= 2, `监听方 B 已收到建任务/建 bug 广播（基线=${baselineBroadcasts}）`);

    // 2a. update field='id' → 白名单拒绝：data.json 不变 + B 收不到广播
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'id', value: 'HACKED-ID' } });
    await sleep(400);
    {
      const bug = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
      assert(bug && bug.id === BUG_ID, 'update field=id 被拒：data.json 中 bug.id 不变');
      assert(countBroadcasts(clientB) === baselineBroadcasts, 'update field=id 被拒：其他客户端收不到广播');
    }

    // 2b. update status='非法值' → 值校验拒绝
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'status', value: '非法值' } });
    await sleep(400);
    {
      const bug = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
      assert(bug && bug.status === '待修复', 'update status=非法值 被拒：data.json 中 status 不变');
      assert(countBroadcasts(clientB) === baselineBroadcasts, 'update status=非法值 被拒：其他客户端收不到广播');
    }

    // 2c. updateTask name=''（空字符串）→ 拒绝
    clientA.send({ type: 'updateTask', clientId: 'client-a', data: { taskId: TASK_ID, field: 'name', value: '' } });
    await sleep(400);
    {
      const task = readData().tasks.find(t => t.id === TASK_ID);
      assert(task && task.name === '校验测试任务', 'updateTask name="" 被拒：任务名不变');
      assert(countBroadcasts(clientB) === baselineBroadcasts, 'updateTask name="" 被拒：其他客户端收不到广播');
    }

    // 2d. updateTask name='   '（纯空白）→ trim 后为空，拒绝
    clientA.send({ type: 'updateTask', clientId: 'client-a', data: { taskId: TASK_ID, field: 'name', value: '   ' } });
    await sleep(400);
    {
      const task = readData().tasks.find(t => t.id === TASK_ID);
      assert(task && task.name === '校验测试任务', 'updateTask name="   "（纯空白）被拒：任务名不变');
    }

    // 2e. updateTask field='id' → 字段白名单拒绝
    clientA.send({ type: 'updateTask', clientId: 'client-a', data: { taskId: TASK_ID, field: 'id', value: 'HACKED-TASK-ID' } });
    await sleep(400);
    {
      const task = readData().tasks.find(t => t.id === TASK_ID);
      assert(task && task.id === TASK_ID, 'updateTask field=id 被拒：任务 id 不变');
    }

    // 2f. update field='image'（含 value=null）→ 白名单收敛，被拒：data.json 不变 + B 收不到广播
    // （图片生命周期改由 upload/removeImage/DELETE 端点管理，'image' 不再走 update）
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'image', value: null } });
    await sleep(400);
    {
      const bug = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
      // 被拒：未写入 image 字段，且 images 保持空数组（handleAdd 归一化保证）
      assert(bug && !('image' in bug) && Array.isArray(bug.images) && bug.images.length === 0,
        'update field=image 被拒（白名单收敛）：未写入 image 字段且 images 保持空数组');
      assert(countBroadcasts(clientB) === baselineBroadcasts, 'update field=image 被拒：其他客户端收不到广播');
    }

    // 2g. 正控：updateTask 合法重命名 → 生效
    clientA.send({ type: 'updateTask', clientId: 'client-a', data: { taskId: TASK_ID, field: 'name', value: '校验测试任务v2' } });
    await sleep(400);
    {
      const task = readData().tasks.find(t => t.id === TASK_ID);
      assert(task && task.name === '校验测试任务v2', 'updateTask 合法重命名生效：任务名已更新');
      assert(countBroadcasts(clientB) === baselineBroadcasts + 1, 'updateTask 合法重命名正常广播');
    }

    // 2h. 正控：update 合法 name / status → 生效
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'name', value: '校验Bug改名' } });
    await sleep(400);
    {
      const bug = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
      assert(bug && bug.name === '校验Bug改名', 'update 合法 name 生效');
    }
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'status', value: '修复中' } });
    await sleep(400);
    {
      const bug = readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
      assert(bug && bug.status === '修复中', 'update 合法 status（修复中）生效');
      assert(countBroadcasts(clientB) === baselineBroadcasts + 3, '合法 update 均正常广播（共 +3）');
    }

    // ===== 阶段 3：魔数校验强化 =====
    console.log('\n[阶段3] 魔数校验强化:');

    // 3a. 正控：真实 PNG 上传成功
    const upOk = await httpUpload(port, { 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'real.png', 'image/png');
    const fPng = upOk.body && upOk.body.filename;
    assert(upOk.statusCode === 200 && upOk.body && upOk.body.success === true, `真实 PNG 上传成功（status=${upOk.statusCode}）`);
    assert(!!fPng && listUploads().includes(fPng), '真实 PNG 文件保留在 uploads/');
    await sleep(300);

    // 3b. 伪 webp（RIFF + AAAA）→ 400 且 uploads/ 无残留
    const upFake = await httpUpload(port, { 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, FAKE_WEBP_BUFFER, 'fake.webp', 'image/webp');
    assert(upFake.statusCode === 400, `伪 webp（RIFF+AAAA）被拒（HTTP 400，实际 status=${upFake.statusCode}）`);
    assert(listUploads().length === 1 && listUploads()[0] === fPng, '伪 webp 被拒后 uploads/ 无残留（仅剩真实 PNG）');

    // 3c. 坏 PNG 头（仅 4 字节签名）→ 400 且 uploads/ 无残留
    const upBadPng = await httpUpload(port, { 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' }, BAD_PNG_BUFFER, 'bad.png', 'image/png');
    assert(upBadPng.statusCode === 400, `坏 PNG 头被拒（HTTP 400，实际 status=${upBadPng.statusCode}）`);
    assert(listUploads().length === 1 && listUploads()[0] === fPng, '坏 PNG 头被拒后 uploads/ 无残留（仅剩真实 PNG）');

    // ===== 阶段 4：超大文件提前拦截（>100MB 不收集入内存，直接 413） =====
    console.log('\n[阶段4] 超大文件上传拦截（>100MB）:');

    // 4a. 构造 101MB 文件体（超出 MAX_FILE_SIZE=100MB）：data 收集阶段应提前标记超限并丢弃后续数据，
    //     'end' 时直接 413；文件不得落盘、uploads/ 不得新增残留
    //     （本机内存充足（约 16GB 空闲）时 101MB 分配可行；若在内存受限环境运行可跳过此阶段）
    {
      const upOversize = await httpUpload(
        port,
        { 'X-Bug-Id': BUG_ID, 'X-Task-Id': TASK_ID, 'X-Client-Id': 'client-a' },
        Buffer.alloc(101 * 1024 * 1024),
        'huge.bin',
        'image/png'
      );
      console.log(`  [信息] 101MB 上传响应 status=${upOversize.statusCode}`);
      assert(upOversize.statusCode === 413, `101MB 超大文件被拒（HTTP 413，实际 status=${upOversize.statusCode}）`);
      assert(upOversize.body && upOversize.body.success === false, '413 响应体含 success=false');
      assert(listUploads().length === 1 && listUploads()[0] === fPng, '超大文件上传后 uploads/ 无残留（仅剩之前真实 PNG）');
    }
  } finally {
    if (clientA) clientA.close();
    if (clientB) clientB.close();
    if (httpServer) httpServer.close();
    await sleep(200);
    try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  }

  console.log(`\n=== 校验防护测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试脚本异常:', err);
  try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(1);
});
