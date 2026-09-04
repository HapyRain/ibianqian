/**
 * 备注归属权限集成测试（针对当前协议 + 修复后的正确行为）
 *
 * 覆盖目标行为（备注权限：只有备注所有者本人可以删除/修改自己的备注）：
 *  - 客户端 A 添加任务级备注和 bug 级备注；
 *  - 客户端 B 尝试 deleteNote / deleteBugNote 删除 A 的备注 → 服务端拒绝
 *    （note.clientId !== msg.clientId → 不写盘、不广播），备注仍在、B 收不到 delete 广播；
 *  - 备注所有者 A 自己删除 → 成功、备注消失、广播给所有客户端；
 *  - 加分项：B 尝试 updateNote / updateBugNote 修改 A 的备注 → 拒绝、内容不变。
 *
 * 注意：本测试断言的是【修复后】的正确行为。在服务端修复完成前运行，
 * 「B 删除 A 备注被拒绝」和「B 未收到 delete 广播」相关断言会失败（这是预期中的）。
 *
 * 运行方式：node test-note-ownership.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠️ 必须在 require('../server') 之前设置数据目录（server.js 在 require 时计算 DATA_ROOT）
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'buglist-note-'));
process.env.BUGLIST_DATA_ROOT = DATA_ROOT;

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
        count(pred) { return messages.filter(pred).length; },
      });
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function isDeleteNoteBroadcast(msg, noteId) {
  return !!msg && msg.type === 'broadcast' && !!msg.change &&
    msg.change.type === 'deleteNote' && msg.change.noteId === noteId;
}

function isDeleteBugNoteBroadcast(msg, noteId) {
  return !!msg && msg.type === 'broadcast' && !!msg.change &&
    msg.change.type === 'deleteBugNote' && msg.change.noteId === noteId;
}

async function runTests() {
  console.log('\n=== 备注归属权限测试 ===\n');

  let httpServer = null;
  let clientA = null;
  let clientB = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${DATA_ROOT}`);

    clientA = await connectWS(port, 'client-A');
    clientB = await connectWS(port, 'client-B');
    await sleep(400); // 等待 fullSync / clientCount

    const TASK_ID = 'task-note-owner';
    const BUG_ID = 'bug-note-001';

    // ===== 阶段 0：A 建任务 + 建 bug =====
    console.log('\n[阶段0] A 建任务 + 建 bug:');
    clientA.send({ type: 'createTask', clientId: 'client-A', data: { task: { id: TASK_ID, name: '备注归属任务' } } });
    await sleep(300);
    clientA.send({ type: 'add', clientId: 'client-A', data: { taskId: TASK_ID, bug: { id: BUG_ID, name: '备注Bug', status: '待修复' } } });
    await sleep(300);

    // ===== 阶段 1：A 添加任务级 + bug 级备注 =====
    console.log('\n[阶段1] A 添加备注（任务级 + bug 级）:');
    clientA.send({ type: 'addNote', clientId: 'client-A', data: { taskId: TASK_ID, note: { id: 'note-task-1', clientId: 'client-A', content: 'A的任务备注', updatedAt: Date.now() } } });
    await sleep(300);
    clientA.send({ type: 'addBugNote', clientId: 'client-A', data: { taskId: TASK_ID, bugId: BUG_ID, note: { id: 'note-bug-1', clientId: 'client-A', content: 'A的Bug备注', updatedAt: Date.now() } } });
    await sleep(300);

    const data1 = readData();
    const task1 = data1.tasks.find(t => t.id === TASK_ID);
    const noteT1 = task1 && task1.notes && task1.notes.find(n => n.id === 'note-task-1');
    const noteB1 = task1 && task1.bugs && task1.bugs[0] && task1.bugs[0].notes && task1.bugs[0].notes.find(n => n.id === 'note-bug-1');
    assert(!!noteT1 && noteT1.clientId === 'client-A', 'A 添加任务级备注后 data.json 中存在该备注');
    assert(!!noteB1 && noteB1.clientId === 'client-A', 'A 添加 bug 级备注后 data.json 中存在该备注');

    // ===== 阶段 2：B 尝试删除 A 的备注（任务级 + bug 级）→ 应被拒绝 =====
    console.log('\n[阶段2] B 尝试删除 A 的备注（应被拒绝）:');
    const bDelTaskBefore = clientB.count((m) => isDeleteNoteBroadcast(m, 'note-task-1'));
    const bDelBugBefore = clientB.count((m) => isDeleteBugNoteBroadcast(m, 'note-bug-1'));

    clientB.send({ type: 'deleteNote', clientId: 'client-B', data: { taskId: TASK_ID, noteId: 'note-task-1' } });
    clientB.send({ type: 'deleteBugNote', clientId: 'client-B', data: { taskId: TASK_ID, bugId: BUG_ID, noteId: 'note-bug-1' } });
    await sleep(500);

    const data2 = readData();
    const task2 = data2.tasks.find(t => t.id === TASK_ID);
    const noteT2 = task2.notes.find(n => n.id === 'note-task-1');
    const noteB2 = task2.bugs[0].notes.find(n => n.id === 'note-bug-1');
    assert(!!noteT2, 'B 尝试删除 A 的任务级备注被拒绝（data.json 中备注仍在）');
    assert(!!noteB2, 'B 尝试删除 A 的 bug 级备注被拒绝（data.json 中备注仍在）');
    assert(clientB.count((m) => isDeleteNoteBroadcast(m, 'note-task-1')) === bDelTaskBefore,
      'B 删除 A 任务级备注被拒后，B 未收到对应 deleteNote 广播');
    assert(clientB.count((m) => isDeleteBugNoteBroadcast(m, 'note-bug-1')) === bDelBugBefore,
      'B 删除 A 的 bug 级备注被拒后，B 未收到对应 deleteBugNote 广播');

    // ===== 阶段 3（加分项）：B 尝试修改 A 的备注内容 → 应被拒绝 =====
    console.log('\n[阶段3] B 尝试修改 A 的备注（应被拒绝）:');
    clientB.send({ type: 'updateNote', clientId: 'client-B', data: { taskId: TASK_ID, noteId: 'note-task-1', content: 'B篡改的任务备注', updatedAt: Date.now() } });
    clientB.send({ type: 'updateBugNote', clientId: 'client-B', data: { taskId: TASK_ID, bugId: BUG_ID, noteId: 'note-bug-1', content: 'B篡改的Bug备注', updatedAt: Date.now() } });
    await sleep(500);

    const data3 = readData();
    const task3 = data3.tasks.find(t => t.id === TASK_ID);
    const noteT3 = task3.notes.find(n => n.id === 'note-task-1');
    const noteB3 = task3.bugs[0].notes.find(n => n.id === 'note-bug-1');
    assert(!!noteT3 && noteT3.content === 'A的任务备注', 'B 修改 A 的任务级备注被拒绝（内容不变）');
    assert(!!noteB3 && noteB3.content === 'A的Bug备注', 'B 修改 A 的 bug 级备注被拒绝（内容不变）');

    // ===== 阶段 4：A 删除自己的备注（任务级）→ 成功 + 广播 =====
    console.log('\n[阶段4] A 删除自己的任务级备注（应成功 + 广播）:');
    const bDelTaskBefore2 = clientB.count((m) => isDeleteNoteBroadcast(m, 'note-task-1'));
    clientA.send({ type: 'deleteNote', clientId: 'client-A', data: { taskId: TASK_ID, noteId: 'note-task-1' } });
    await sleep(500);

    const task4 = readData().tasks.find(t => t.id === TASK_ID);
    assert(!(task4.notes || []).some(n => n.id === 'note-task-1'), 'A 删除自己的任务级备注成功（data.json 中备注消失）');
    assert(clientB.count((m) => isDeleteNoteBroadcast(m, 'note-task-1')) === bDelTaskBefore2 + 1,
      'A 删除任务级备注后 B 收到 deleteNote 广播');

    // ===== 阶段 5：A 删除自己的备注（bug 级）→ 成功 + 广播 =====
    console.log('\n[阶段5] A 删除自己的 bug 级备注（应成功 + 广播）:');
    const bDelBugBefore2 = clientB.count((m) => isDeleteBugNoteBroadcast(m, 'note-bug-1'));
    clientA.send({ type: 'deleteBugNote', clientId: 'client-A', data: { taskId: TASK_ID, bugId: BUG_ID, noteId: 'note-bug-1' } });
    await sleep(500);

    const task5 = readData().tasks.find(t => t.id === TASK_ID);
    assert(!((task5.bugs[0].notes) || []).some(n => n.id === 'note-bug-1'), 'A 删除自己的 bug 级备注成功（data.json 中备注消失）');
    assert(clientB.count((m) => isDeleteBugNoteBroadcast(m, 'note-bug-1')) === bDelBugBefore2 + 1,
      'A 删除 bug 级备注后 B 收到 deleteBugNote 广播');
  } finally {
    if (clientA) clientA.close();
    if (clientB) clientB.close();
    if (httpServer) httpServer.close();
    await sleep(200);
    try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  }

  console.log(`\n=== 备注归属权限测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试脚本异常:', err);
  try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(1);
});
