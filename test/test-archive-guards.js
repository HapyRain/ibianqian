/**
 * 归档防线集成测试（spec 2026-09-03 第 7/10 节）
 *
 * 覆盖目标行为：
 *  1. 归档行锁死：archived 行的 name/status/deadline update 一律拒绝（不写盘不广播）
 *  2. 删除防线：已完成（含已归档）任务不可删除；待修复任务可删（正控）
 *  3. 归档状态机：archived=true 仅当 status=已完成且未归档；=false 仅当已归档；非布尔拒绝
 *  4. 导入归一化：archived=true 但 status≠已完成 → 删标记；合法则保留 archived+archivedAt
 *  5. createTask 兜底名：空名落库为「新项目」（与客户端占位统一）
 *
 * 运行方式：node test-archive-guards.js
 * 隔离：BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据；
 *       运行结束（含异常路径）在 finally 中关闭服务并清理该临时目录。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const http = require('http');
const path = require('path');
const H = require('./helpers');
const { startServer } = require('../server');
const { DATA_ROOT, DATA_FILE, assert, sleep, readData, connectWS, teardown, onFatal } = H;

// assert/sleep/readData 见 helpers

/** 按 id 查找 bug（不依赖数组索引：删除防线缺失的红灯阶段索引会漂移，红/绿两阶段都必须稳定断言） */
function findBug(bugId) {
  for (const t of readData().tasks) {
    const bug = (t.bugs || []).find(b => b.id === bugId);
    if (bug) return bug;
  }
  return null;
}

function writeSeed() {
  // 三条任务：已完成未归档 / 已完成已归档 / 待修复
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    version: 1,
    tasks: [{
      id: 'task-arch-1',
      name: '归档测试',
      notes: [],
      bugs: [
        { id: 'bug-done', name: '已完成任务', status: '已完成', statusChangedAt: 1 },
        { id: 'bug-done-arch', name: '已完成已归档', status: '已完成', statusChangedAt: 1, archived: true, archivedAt: 1000 },
        { id: 'bug-todo', name: '待修复任务', status: '待修复', statusChangedAt: 1 },
      ],
    }],
  }));
}

// connectWS 见 helpers

function httpPostJson(port, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const req = http.request({
      host: 'localhost', port, path: apiPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** 发送 WS 消息并等待服务端处理（写盘 + 广播窗口） */
async function sendAndSettle(client, obj) {
  client.messages.length = 0;
  client.send(obj);
  await sleep(200);
}

async function main() {
  writeSeed();
  let httpServer = null;
  let A = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    A = await connectWS(port, 'A');

    // ---- 1. 归档行锁死 ----
    await sendAndSettle(A, { type: 'update', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done-arch', field: 'name', value: '改名' } });
    assert(findBug('bug-done-arch')?.name === '已完成已归档', '归档行 update name 被拒绝');

    await sendAndSettle(A, { type: 'update', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done-arch', field: 'status', value: '待修复' } });
    assert(findBug('bug-done-arch')?.status === '已完成', '归档行 update status 被拒绝');

    await sendAndSettle(A, { type: 'update', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done-arch', field: 'deadline', value: 999 } });
    assert(findBug('bug-done-arch')?.deadline === undefined, '归档行 update deadline 被拒绝');

    // ---- 2. 删除防线 ----
    await sendAndSettle(A, { type: 'delete', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done-arch' } });
    assert(readData().tasks[0].bugs.length === 3, '已归档任务不可删除');

    await sendAndSettle(A, { type: 'delete', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done' } });
    assert(readData().tasks[0].bugs.length === 3, '已完成未归档任务不可删除');

    // ---- 3. 归档状态机 ----
    await sendAndSettle(A, { type: 'update', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done', field: 'archived', value: 'true' } });
    assert(findBug('bug-done')?.archived === undefined, 'archived 非布尔值被拒绝');

    await sendAndSettle(A, { type: 'update', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-todo', field: 'archived', value: true } });
    assert(findBug('bug-todo')?.archived === undefined, '非已完成任务归档被拒绝');

    A.messages.length = 0;
    await sendAndSettle(A, { type: 'update', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done', field: 'archived', value: true } });
    const doneBug = findBug('bug-done');
    assert(doneBug?.archived === true && typeof doneBug?.archivedAt === 'number', '已完成任务归档生效（archived+archivedAt 落库）');
    const archBroadcast = A.messages.find(m => m.type === 'broadcast' && m.change && m.change.field === 'archived');
    assert(!!archBroadcast && archBroadcast.change.value === true && typeof archBroadcast.change.archivedAt === 'number', '归档广播带 archivedAt 伴生字段');

    await sendAndSettle(A, { type: 'update', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-done', field: 'archived', value: false } });
    const restored = findBug('bug-done');
    assert(restored?.archived === undefined && restored?.archivedAt === undefined, '恢复归档生效（两字段均清除）');

    // ---- 4. 删除正控（待修复可删） ----
    await sendAndSettle(A, { type: 'delete', clientId: 'A', data: { taskId: 'task-arch-1', bugId: 'bug-todo' } });
    assert(readData().tasks[0].bugs.length === 2, '待修复任务可正常删除（正控）');

    // ---- 5. 导入归一化 ----
    const imp = await httpPostJson(port, '/api/import', {
      version: 1,
      tasks: [{
        id: 'task-imp', name: '导入项目', notes: [],
        bugs: [
          { id: 'b1', name: '脏归档', status: '待修复', archived: true, archivedAt: 1 },
          { id: 'b2', name: '合法归档', status: '已完成', archived: true, archivedAt: 123 },
          { id: 'b3', name: '普通任务', status: '待修复' },
        ],
      }],
    });
    assert(imp.success === true, '导入接口成功');
    const impBugs = readData().tasks.find(t => t.id === 'task-imp').bugs;
    assert(impBugs[0].archived === undefined, '导入归一化：非已完成的 archived 标记被删除');
    assert(impBugs[1].archived === true && impBugs[1].archivedAt === 123, '导入归一化：合法归档保留 archived+archivedAt');
    assert(impBugs[2].archived === undefined, '导入归一化：无归档字段的任务不受影响');

    // ---- 6. createTask 兜底名 ----
    await sendAndSettle(A, { type: 'createTask', clientId: 'A', data: { task: { id: 'task-empty', name: '' } } });
    assert(readData().tasks.find(t => t.id === 'task-empty').name === '新项目', 'createTask 空名兜底为「新项目」');

    const { passed, failed } = H.getCounts();
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } finally {
    await teardown(httpServer, A);
  }
  process.exit(H.exitCode());
}

main().catch(onFatal);
