/**
 * requestSync 全量同步基础集成测试
 *
 * 覆盖目标行为：
 *  1. 连接时 fullSync 形状：{ type, data: { tasks[], version }, version }，且
 *     data.tasks[].bugs/notes、bug.statusChangedAt（迁移补全）等字段齐全（按实际实现核对）
 *  2. requestSync 返回与连接时 fullSync 完全一致的数据（同盘数据，逐字段深比对），
 *     version 与磁盘 data.json 一致
 *  3. 500ms 限速：同一连接 500ms 内连发两条 requestSync 只处理一次（全量帧只多一帧），
 *     且窗口过后再次 requestSync 正常放行（限速是窗口而非永久丢弃）
 *  4. requestSync 除 fullSync 外还伴随一条 clientCount——handleRequestSync 形参已对齐
 *     统一调用约定 handler(ws, msg, _wss)（曾误声明 (ws, _wss) 致 _wss 实绑到 msg、
 *     countOpenClients 抛 TypeError，clientCount 从未随 requestSync 发出），此处做正控断言
 *
 * 运行方式：node test-sync-basics.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const H = require('./helpers');
const { startServer } = require('../server');
const {
  assert, sleep, waitFor, readData, connectWS, teardown, getCounts, onFatal,
} = H;

function writeSeed() {
  fs.writeFileSync(H.DATA_FILE, JSON.stringify({
    version: 7,
    tasks: [{
      id: 'task-sync-1',
      name: '同步任务',
      notes: [{ id: 'note-sync-1', clientId: 'seed-client', content: '任务级备注', createdAt: 100, updatedAt: 200, images: [] }],
      bugs: [{
        id: 'bug-sync-1',
        name: '同步Bug',
        status: '修复中',
        statusChangedAt: 300,
        images: [],
        notes: [{ id: 'bnote-sync-1', clientId: 'seed-client', content: '条目备注', createdAt: 100, updatedAt: 200, images: [] }],
      }],
    }],
  }, null, 2), 'utf-8');
}

/** fullSync 形状断言（字段核对按 server.js sendFullSync / readData 实际实现） */
function assertSyncShape(sync, label) {
  assert(!!sync && sync.type === 'fullSync', `${label}：消息 type 为 fullSync`);
  assert(!!sync && sync.data && Array.isArray(sync.data.tasks), `${label}：data.tasks 为数组`);
  assert(!!sync && typeof sync.data.version === 'number' && typeof sync.version === 'number' && sync.version === sync.data.version,
    `${label}：顶层 version 与 data.version 一致且为数字`);
  const task = sync && sync.data.tasks[0];
  assert(!!task && typeof task.id === 'string' && typeof task.name === 'string'
    && Array.isArray(task.bugs) && Array.isArray(task.notes),
    `${label}：task 含 id/name/bugs[]/notes[] 字段`);
  const bug = task && task.bugs[0];
  assert(!!bug && typeof bug.id === 'string' && typeof bug.name === 'string' && typeof bug.status === 'string'
    && Array.isArray(bug.images) && Array.isArray(bug.notes) && typeof bug.statusChangedAt === 'number',
    `${label}：bug 含 id/name/status/images[]/notes[]/statusChangedAt（迁移补全）字段`);
  const note = task && task.notes[0];
  const bnote = bug && bug.notes[0];
  assert(!!note && typeof note.content === 'string' && typeof note.clientId === 'string'
    && typeof note.createdAt === 'number' && typeof note.updatedAt === 'number' && Array.isArray(note.images),
    `${label}：任务级备注含 id/content/clientId/createdAt/updatedAt/images[] 字段`);
  assert(!!bnote && typeof bnote.content === 'string' && Array.isArray(bnote.images),
    `${label}：条目级备注含 content/images[] 字段`);
}

async function runTests() {
  console.log('\n=== requestSync 全量同步基础测试 ===\n');

  writeSeed();
  let httpServer = null;
  let clientA = null;
  let clientB = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${H.DATA_ROOT}`);

    clientA = await connectWS(port, '同步方A');
    const initialSync = await waitFor(() => clientA.messages.find(m => m.type === 'fullSync'));
    assert(!!initialSync, '连接后收到初始 fullSync');

    // ===== 1. 连接时 fullSync 形状 =====
    console.log('\n[阶段1] 连接时 fullSync 形状（字段核对）:');
    assertSyncShape(initialSync, '初始 fullSync');
    assert(initialSync.data.version === 7, '初始 fullSync 版本为预置的 7');
    await waitFor(() => clientA.messages.some(m => m.type === 'clientCount' && m.count === 1), 3000);
    assert(clientA.messages.some(m => m.type === 'clientCount' && m.count === 1), '连接后收到 clientCount（count=1）');

    // ===== 2. requestSync 与连接时数据一致 =====
    console.log('\n[阶段2] requestSync 返回与连接时形状一致的数据:');
    clientB = await connectWS(port, '旁观方B');
    await waitFor(() => clientB.messages.some(m => m.type === 'fullSync'));
    const ccBefore = clientA.messages.filter(m => m.type === 'clientCount').length;
    clientA.send({ type: 'requestSync', clientId: 'client-a' });
    const synced = await waitFor(() => clientA.messages.filter(m => m.type === 'fullSync').length >= 2, 3000);
    assert(!!synced, 'requestSync 后收到第二个 fullSync');
    const sync2 = clientA.messages.filter(m => m.type === 'fullSync')[1];
    assertSyncShape(sync2, 'requestSync fullSync');
    assert(JSON.stringify(sync2.data) === JSON.stringify(initialSync.data),
      'requestSync 的 data 与连接时 fullSync 逐字段一致（无写盘发生）');
    assert(sync2.data.version === readData().version, 'requestSync 的 version 与磁盘 data.json 一致');
    // requestSync 伴随 clientCount（形参对齐修复的正控断言；此刻 A+B 两连接在线）
    const gotCc = await waitFor(() => clientA.messages.filter(m => m.type === 'clientCount').length >= ccBefore + 1, 3000);
    assert(!!gotCc && clientA.messages.filter(m => m.type === 'clientCount').pop().count === 2,
      'requestSync 后伴随 clientCount 且人数正确（A+B=2）');

    // ===== 3. 500ms 限速：窗口内第二条被忽略、窗口后恢复 =====
    console.log('\n[阶段3] requestSync 500ms 限速:');
    // 阶段 2 的 requestSync 刚设置过 _lastSyncAt：先等出窗口，保证阶段 3 从干净状态开始
    await sleep(600);
    const baseCount = clientA.messages.filter(m => m.type === 'fullSync').length; // = 2
    const t0 = Date.now();
    clientA.send({ type: 'requestSync', clientId: 'client-a' });
    clientA.send({ type: 'requestSync', clientId: 'client-a' }); // 与上一条同窗口连发
    const firstArrived = await waitFor(() => clientA.messages.filter(m => m.type === 'fullSync').length >= baseCount + 1, 3000);
    assert(!!firstArrived, '连发两条后第一条 requestSync 正常返回 fullSync');
    // 等满 600ms（> 500ms 窗口）：若第二条未被限速，此刻必然也已到达
    const elapsed = Date.now() - t0;
    if (elapsed < 650) await sleep(650 - elapsed);
    const windowCount = clientA.messages.filter(m => m.type === 'fullSync').length;
    assert(windowCount === baseCount + 1, `500ms 窗口内第二条 requestSync 被忽略（全量帧恰好多 1 帧，实际=${windowCount - baseCount}）`);
    // 窗口过后再发：恢复正常放行（证明限速是滑动窗口而非永久丢弃）
    clientA.send({ type: 'requestSync', clientId: 'client-a' });
    const recovered = await waitFor(() => clientA.messages.filter(m => m.type === 'fullSync').length >= baseCount + 2, 3000);
    assert(!!recovered, '窗口过后第三次 requestSync 正常返回 fullSync（限速可恢复）');
    const finalCount = clientA.messages.filter(m => m.type === 'fullSync').length;
    assert(finalCount === baseCount + 2, `窗口后单次 requestSync 恰好新增 1 帧（实际=${finalCount - baseCount}）`);
    assert(finalCount >= 4 && clientA.messages.filter(m => m.type === 'fullSync')[finalCount - 1].data.version === readData().version,
      '最新 fullSync 版本与磁盘一致');
  } finally {
    await teardown(httpServer, clientA, clientB);
  }

  const { passed, failed } = getCounts();
  console.log(`\n=== requestSync 全量同步基础测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(onFatal);
