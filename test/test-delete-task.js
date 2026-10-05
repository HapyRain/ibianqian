/**
 * deleteTask 任务级删除集成测试
 *
 * 覆盖目标行为（先改数据、后删文件；快照只 在真正删除前 打）：
 *  1. 正常删除：任务连同其下 bug 从 data.json 移除，bug 关联图片文件被服务端从 uploads/ 清理；
 *     其他客户端收到 deleteTask 广播；删除前生成 pre-delete-* 快照（恰好 +1）
 *  2. 删除不存在的任务：数据/版本/快照数/广播数全部不变（不产生垃圾快照挤占轮转）
 *  3. data 缺 taskId 的畸形消息：同样无副作用
 *  4. 至少保留一个任务的防线：删到只剩 1 个任务时拒绝（任务保留、无快照、无广播）
 *
 * 备注（task.notes / bug.notes）图片随宿主清理（collectNoteImages）：删除带备注图片的任务
 * 时，条目级/任务级备注引用的图片文件一并清理，不留孤儿文件（与 handleDelete 同规则）。
 *
 * 运行方式：node test-delete-task.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { startServer } = require('../server');
const {
  DATA_ROOT, UPLOADS_DIR, assert, sleep, waitFor, readData, listUploads, countBroadcasts,
  connectWS, httpUpload, PNG_BUFFER, teardown, getCounts, onFatal,
} = H;

const TASK1 = 'task-dt-1';
const TASK2 = 'task-dt-2';
const TASK3 = 'task-dt-3';

function writeSeed() {
  const mkBug = (id) => ({ id, name: `Bug-${id}`, status: '待修复', statusChangedAt: 1, images: [], notes: [] });
  fs.writeFileSync(H.DATA_FILE, JSON.stringify({
    version: 1,
    tasks: [
      { id: TASK1, name: '任务一', notes: [], bugs: [mkBug('bug-dt-1')] },
      { id: TASK2, name: '任务二', notes: [], bugs: [mkBug('bug-dt-2')] },
      { id: TASK3, name: '任务三', notes: [], bugs: [mkBug('bug-dt-3')] },
    ],
  }, null, 2), 'utf-8');
}

/** backups/ 下 pre-delete-* 快照数量（目录不存在按 0） */
function preDeleteCount() {
  try { return fs.readdirSync(path.join(DATA_ROOT, 'backups')).filter(f => f.startsWith('pre-delete-')).length; }
  catch (e) { return 0; }
}

const getTask = (id) => readData().tasks.find(t => t.id === id);

async function runTests() {
  console.log('\n=== deleteTask 任务级删除测试 ===\n');

  writeSeed();
  let httpServer = null;
  let clientA = null;
  let clientB = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${DATA_ROOT}`);

    clientA = await connectWS(port, '操作方A');
    clientB = await connectWS(port, '监听方B');
    await waitFor(() => clientA.messages.some(m => m.type === 'fullSync') && clientB.messages.some(m => m.type === 'fullSync'));

    // 前置：给 task-dt-1 / task-dt-2 的 bug 各关联一张图片（正控上传）
    const up1 = await httpUpload(port, { 'X-Bug-Id': 'bug-dt-1', 'X-Task-Id': TASK1, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'dt-1.png', 'image/png');
    assert(up1.statusCode === 200 && up1.body && up1.body.success === true, `bug-dt-1 关联图片上传成功（status=${up1.statusCode}）`);
    const img1 = up1.body && up1.body.filename;
    const up2 = await httpUpload(port, { 'X-Bug-Id': 'bug-dt-2', 'X-Task-Id': TASK2, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'dt-2.png', 'image/png');
    assert(up2.statusCode === 200 && up2.body && up2.body.success === true, `bug-dt-2 关联图片上传成功（status=${up2.statusCode}）`);
    const img2 = up2.body && up2.body.filename;
    await waitFor(() => (getTask(TASK1)?.bugs[0].images || []).length === 1 && (getTask(TASK2)?.bugs[0].images || []).length === 1);

    // 前置：给 TASK1 的条目级/任务级备注各关联一张图（验证 collectNoteImages 随宿主清理不留孤儿）
    const upN1 = await httpUpload(port, { 'X-Note-Id': 'note-dt-bug', 'X-Task-Id': TASK1, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'dt-note-bug.png', 'image/png');
    assert(upN1.statusCode === 200 && upN1.body && upN1.body.success === true, '前置：条目级备注图片暂存上传成功');
    const imgN1 = upN1.body && upN1.body.filename;
    clientA.send({ type: 'addBugNote', clientId: 'client-a', data: { taskId: TASK1, bugId: 'bug-dt-1', note: { id: 'note-dt-bug', clientId: 'client-a', content: '条目备注', images: [imgN1] } } });
    const upN2 = await httpUpload(port, { 'X-Note-Id': 'note-dt-task', 'X-Task-Id': TASK1, 'X-Client-Id': 'client-a' }, PNG_BUFFER, 'dt-note-task.png', 'image/png');
    assert(upN2.statusCode === 200 && upN2.body && upN2.body.success === true, '前置：任务级备注图片暂存上传成功');
    const imgN2 = upN2.body && upN2.body.filename;
    clientA.send({ type: 'addNote', clientId: 'client-a', data: { taskId: TASK1, note: { id: 'note-dt-task', clientId: 'client-a', content: '任务备注', images: [imgN2] } } });
    await waitFor(() => (getTask(TASK1)?.bugs[0].notes || []).some(n => n.id === 'note-dt-bug' && (n.images || []).includes(imgN1))
      && (getTask(TASK1)?.notes || []).some(n => n.id === 'note-dt-task' && (n.images || []).includes(imgN2)));

    // 基线采样前先等四条广播都送达 B（广播与写盘异步，直接采样会抖动）
    await waitFor(() => countBroadcasts(clientB) >= 4);
    const bcBaseline = countBroadcasts(clientB); // 含两次上传的 addImage 广播 + addBugNote/addNote 各一条
    assert(bcBaseline === 4, `前置广播基线（addImage ×2 + addBugNote/addNote 各 1，实际=${bcBaseline}）`);
    assert(preDeleteCount() === 0, '前置：尚无任何 pre-delete 快照（上传不算删除）');

    // ===== 1. 正常删除 task-dt-1 =====
    console.log('\n[阶段1] 正常删除（任务 + bug + 图片文件 + 快照 + 广播）:');
    clientA.send({ type: 'deleteTask', clientId: 'client-a', data: { taskId: TASK1 } });
    const deleted1 = await waitFor(() => !getTask(TASK1));
    assert(deleted1, 'deleteTask 后 task-dt-1 从 data.json 移除');
    assert(img1 && !fs.existsSync(path.join(UPLOADS_DIR, img1)), 'task-dt-1 下 bug 的图片文件被服务端清理');
    assert(imgN1 && !fs.existsSync(path.join(UPLOADS_DIR, imgN1)), '条目级备注引用的图片随任务删除被清理（不留孤儿）');
    assert(imgN2 && !fs.existsSync(path.join(UPLOADS_DIR, imgN2)), '任务级备注引用的图片随任务删除被清理（不留孤儿）');
    assert(img2 && fs.existsSync(path.join(UPLOADS_DIR, img2)), '其他任务的图片文件不受影响');
    assert(preDeleteCount() === 1, '真正删除前生成恰好 1 份 pre-delete 快照');
    const gotBc = await waitFor(() => countBroadcasts(clientB) >= bcBaseline + 1, 3000);
    assert(gotBc && clientB.messages.some(m => m.type === 'broadcast' && m.change && m.change.type === 'deleteTask' && m.change.taskId === TASK1),
      '监听方 B 收到 deleteTask 广播（taskId 匹配）');

    // ===== 2. 删除不存在的任务：全不变 =====
    console.log('\n[阶段2] 删除不存在的任务（不产生快照、无广播、版本不变）:');
    const verAfter1 = readData().version;
    const bcAfter1 = countBroadcasts(clientB);
    clientA.send({ type: 'deleteTask', clientId: 'client-a', data: { taskId: 'task-dt-nonexistent' } });
    await sleep(400); // 等待服务端处理窗口；断言"一切不变"
    assert(readData().tasks.length === 2, '不存在任务的删除被拒：任务数不变');
    assert(readData().version === verAfter1, '不存在任务的删除被拒：版本号不变（未写盘）');
    assert(preDeleteCount() === 1, '不存在任务的删除不产生快照（pre-delete 仍为 1 份）');
    assert(countBroadcasts(clientB) === bcAfter1, '不存在任务的删除不产生广播');

    // ===== 2b. 畸形消息：data 缺 taskId =====
    console.log('\n[阶段2b] 畸形消息 data={} （缺 taskId）:');
    clientA.send({ type: 'deleteTask', clientId: 'client-a', data: {} });
    await sleep(400);
    assert(readData().tasks.length === 2 && readData().version === verAfter1 && preDeleteCount() === 1,
      '缺 taskId 的 deleteTask 无任何副作用（数据/版本/快照均不变）');

    // ===== 3. 再删一个 → 只剩 1 个任务 =====
    console.log('\n[阶段3] 第二次正常删除 task-dt-2:');
    clientA.send({ type: 'deleteTask', clientId: 'client-a', data: { taskId: TASK2 } });
    const deleted2 = await waitFor(() => !getTask(TASK2));
    assert(deleted2, 'deleteTask 后 task-dt-2 从 data.json 移除');
    assert(img2 && !fs.existsSync(path.join(UPLOADS_DIR, img2)), 'task-dt-2 下 bug 的图片文件被服务端清理');
    assert(listUploads().length === 0, 'uploads/ 已清空（两张图均随任务删除被清理）');
    assert(preDeleteCount() === 2, '第二次删除前再打 1 份快照（共 2 份）');
    await waitFor(() => countBroadcasts(clientB) >= bcAfter1 + 1);
    assert(clientB.messages.some(m => m.type === 'broadcast' && m.change && m.change.type === 'deleteTask' && m.change.taskId === TASK2),
      '监听方 B 收到 task-dt-2 的 deleteTask 广播');

    // ===== 4. 至少保留一个任务的防线 =====
    console.log('\n[阶段4] 最后一个任务拒绝删除:');
    const verAfter2 = readData().version;
    const bcAfter2 = countBroadcasts(clientB);
    clientA.send({ type: 'deleteTask', clientId: 'client-a', data: { taskId: TASK3 } });
    await sleep(400);
    const lastTask = getTask(TASK3);
    assert(!!lastTask && lastTask.name === '任务三' && lastTask.bugs.length === 1,
      '只剩 1 个任务时 deleteTask 被拒：task-dt-3 连同其 bug 完整保留');
    assert(readData().version === verAfter2, '最后任务删除被拒：版本号不变（未写盘）');
    assert(preDeleteCount() === 2, '最后任务删除被拒：不产生快照（防线预检先于快照）');
    assert(countBroadcasts(clientB) === bcAfter2, '最后任务删除被拒：不产生广播');
  } finally {
    await teardown(httpServer, clientA, clientB);
  }

  const { passed, failed } = getCounts();
  console.log(`\n=== deleteTask 任务级删除测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(onFatal);
