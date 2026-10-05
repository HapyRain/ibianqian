/**
 * completedAt / statusChangedAt 时间锚点集成测试
 *
 * 覆盖目标行为（handleUpdate field=status 分支）：
 *  1. 状态切到「已完成」时 completedAt 被写入（YYYY-MM-DD HH:mm:ss 格式字符串），
 *     广播 change 携带 completedAt 与重打后的 statusChangedAt
 *  2. 状态切走（已完成 → 待修复）时 completedAt 被清除（字段删除），
 *     广播 change.completedAt = null 通知客户端删除
 *  3. statusChangedAt 在每次状态变更时被服务器重打（对比变更前后值，严格递增；
 *     每次转换前 sleep 60ms 保证 Date.now() 严格单调，消除毫秒内抖动）
 *  4. 中间态（待修复 → 修复中）同样重打 statusChangedAt 且不产生 completedAt
 *
 * 运行方式：node test-completed-at.js
 * 隔离：通过 BUGLIST_DATA_ROOT 指向临时目录，绝不触碰真实 D:\Bug清单 数据。
 */
// ⚠️ 先 require helpers（副作用设置 BUGLIST_DATA_ROOT），再 require server —— 顺序不可反
const fs = require('fs');
const H = require('./helpers');
const { startServer } = require('../server');
const {
  DATA_FILE, assert, sleep, waitFor, readData, connectWS, teardown, getCounts, onFatal,
} = H;

const COMPLETED_AT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const TASK_ID = 'task-ca-1';
const BUG_ID = 'bug-ca-1';

function writeSeed() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    version: 1,
    tasks: [{
      id: TASK_ID, name: '时间锚点任务', notes: [],
      bugs: [{ id: BUG_ID, name: '锚点Bug', status: '待修复', statusChangedAt: 1000, images: [], notes: [] }],
    }],
  }, null, 2), 'utf-8');
}

const getBug = () => readData().tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
/** 等待磁盘上 bug 状态变为指定值（状态写盘完成的确定性信号） */
const waitStatus = (status) => waitFor(() => getBug()?.status === status, 5000);
/** B 收到的最新 update 广播 */
const lastUpdateBc = (client) => client.messages
  .filter(m => m.type === 'broadcast' && m.change && m.change.type === 'update').pop();

async function runTests() {
  console.log('\n=== completedAt / statusChangedAt 时间锚点测试 ===\n');

  writeSeed();
  let httpServer = null;
  let clientA = null;
  let clientB = null;
  try {
    const started = await startServer(3050);
    httpServer = started.httpServer;
    const { port } = started;
    console.log(`服务器已启动: ws://localhost:${port}，数据目录: ${H.DATA_ROOT}`);

    clientA = await connectWS(port, '操作方A');
    clientB = await connectWS(port, '监听方B');
    await waitFor(() => clientA.messages.some(m => m.type === 'fullSync') && clientB.messages.some(m => m.type === 'fullSync'));

    // ===== 1. 待修复 → 修复中：重打 statusChangedAt，不产生 completedAt =====
    console.log('\n[阶段1] 待修复 → 修复中（重打 statusChangedAt，无 completedAt）:');
    await sleep(60); // 与种子值 1000 拉开毫秒差，保证严格递增可判定
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'status', value: '修复中' } });
    assert(!!(await waitStatus('修复中')), '状态切换为「修复中」生效');
    const bug1 = getBug();
    const s1 = bug1.statusChangedAt;
    assert(typeof s1 === 'number' && s1 > 1000, `statusChangedAt 被服务器重打（1000 → ${s1}）`);
    assert(!('completedAt' in bug1), '非完成态不产生 completedAt 字段');
    assert(!!(await waitFor(() => lastUpdateBc(clientB) && lastUpdateBc(clientB).change.value === '修复中', 3000)),
      '监听方 B 收到「修复中」update 广播');
    const bc1 = lastUpdateBc(clientB);
    assert(bc1.change.statusChangedAt === s1 && bc1.change.completedAt === undefined,
      '「修复中」广播携带重打的 statusChangedAt 且无 completedAt');

    // ===== 2. 修复中 → 已完成：写入 completedAt =====
    console.log('\n[阶段2] 修复中 → 已完成（写入 completedAt）:');
    await sleep(60);
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'status', value: '已完成' } });
    assert(!!(await waitStatus('已完成')), '状态切换为「已完成」生效');
    const bug2 = getBug();
    const s2 = bug2.statusChangedAt;
    assert(typeof s2 === 'number' && s2 > s1, `statusChangedAt 再次重打且严格递增（${s1} → ${s2}）`);
    assert(typeof bug2.completedAt === 'string' && COMPLETED_AT_RE.test(bug2.completedAt),
      `completedAt 被写入且为 YYYY-MM-DD HH:mm:ss 格式（实际=${bug2.completedAt}）`);
    assert(!!(await waitFor(() => lastUpdateBc(clientB) && lastUpdateBc(clientB).change.value === '已完成', 3000)),
      '监听方 B 收到「已完成」update 广播');
    const bc2 = lastUpdateBc(clientB);
    assert(bc2.change.completedAt === bug2.completedAt && bc2.change.statusChangedAt === s2,
      '「已完成」广播携带 completedAt 与重打后的 statusChangedAt');

    // ===== 3. 已完成 → 待修复：清除 completedAt =====
    console.log('\n[阶段3] 已完成 → 待修复（清除 completedAt，广播 completedAt=null）:');
    await sleep(60);
    clientA.send({ type: 'update', clientId: 'client-a', data: { taskId: TASK_ID, bugId: BUG_ID, field: 'status', value: '待修复' } });
    assert(!!(await waitStatus('待修复')), '状态切回「待修复」生效');
    const bug3 = getBug();
    const s3 = bug3.statusChangedAt;
    assert(typeof s3 === 'number' && s3 > s2, `statusChangedAt 第三次重打且严格递增（${s2} → ${s3}）`);
    assert(!('completedAt' in bug3), '切走后 completedAt 字段被彻底清除');
    assert(!!(await waitFor(() => lastUpdateBc(clientB) && lastUpdateBc(clientB).change.value === '待修复', 3000)),
      '监听方 B 收到「待修复」update 广播');
    const bc3 = lastUpdateBc(clientB);
    assert(bc3.change.completedAt === null, `切走广播 completedAt=null 通知客户端删除（实际=${JSON.stringify(bc3.change.completedAt)}）`);

    // ===== 4. 往返后数据形态复核（data.json 中无残留） =====
    console.log('\n[阶段4] 往返后落盘形态复核:');
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const rawBug = raw.tasks.find(t => t.id === TASK_ID).bugs.find(b => b.id === BUG_ID);
    assert(!('completedAt' in rawBug) && rawBug.statusChangedAt === s3,
      '落盘数据中无 completedAt 残留且 statusChangedAt 为最终值');
  } finally {
    await teardown(httpServer, clientA, clientB);
  }

  const { passed, failed } = getCounts();
  console.log(`\n=== completedAt / statusChangedAt 时间锚点测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(onFatal);
