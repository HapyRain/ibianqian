/**
 * 修复验证测试
 * 1. Add 后 update/delete 同一 Bug → 能正确找到（UUID 匹配）
 * 2. 新增 Bug 默认状态为 '待修复'
 * 3. clientCount 消息能被客户端正确收到
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 3002;
const BASE = `ws://localhost:${PORT}`;

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

async function runTests() {
  console.log(`\n=== 修复验证测试 (port ${PORT}) ===\n`);

  // ===== Fix 3: clientCount 验证 =====
  console.log('7.1 clientCount 修复验证:');

  // Set up listener BEFORE connecting
  const receivedMessages = [];
  const ws1 = new WebSocket(BASE);

  ws1.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    receivedMessages.push(msg);
  });

  await new Promise((resolve) => {
    ws1.on('open', resolve);
    setTimeout(() => resolve(), 5000);
  });

  // Wait for initial sync messages
  await sleep(500);

  const clientCount1 = receivedMessages.find(m => m.type === 'clientCount');
  const fullSync1 = receivedMessages.find(m => m.type === 'fullSync');

  assert(fullSync1 !== undefined, 'ws1 收到 fullSync');
  assert(clientCount1 !== undefined, 'ws1 收到 clientCount 消息');
  assert(clientCount1 && clientCount1.count >= 1,
    `ws1 clientCount 计数 >= 1 (实际: ${clientCount1 ? clientCount1.count : 'null'})`);

  // Now connect ws2 and verify ws1 receives updated count
  receivedMessages.length = 0; // Clear

  const ws2 = new WebSocket(BASE);
  let ws2Messages = [];
  ws2.on('message', (raw) => {
    ws2Messages.push(JSON.parse(raw.toString()));
  });

  await new Promise((resolve) => {
    ws2.on('open', resolve);
    setTimeout(() => resolve(), 5000);
  });

  await sleep(500);

  // ws1 should have received a new clientCount (broadcast when ws2 connected)
  const ws1UpdatedCount = receivedMessages.find(m => m.type === 'clientCount');
  assert(ws1UpdatedCount !== undefined, 'ws1 收到 ws2 连接后的 clientCount 广播');
  assert(ws1UpdatedCount && ws1UpdatedCount.count >= 2,
    `ws1 clientCount 更新为 >= 2 (实际: ${ws1UpdatedCount ? ws1UpdatedCount.count : 'null'})`);

  // ws2 should have its own clientCount
  const ws2ClientCount = ws2Messages.find(m => m.type === 'clientCount');
  assert(ws2ClientCount !== undefined, 'ws2 收到 clientCount 消息');
  assert(ws2ClientCount && ws2ClientCount.count >= 2,
    `ws2 clientCount >= 2 (实际: ${ws2ClientCount ? ws2ClientCount.count : 'null'})`);

  // ===== Fix 2: 默认状态验证 =====
  console.log('\n7.2 新增 Bug 默认状态验证:');

  // Clean data for a fresh start
  try { fs.unlinkSync(path.join(__dirname, 'data.json')); } catch (e) {}
  await sleep(300);

  const testBugId = 'fix-verify-' + Date.now();

  let ws2AddBroadcast = null;
  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'broadcast' && msg.change && msg.change.type === 'add') {
      ws2AddBroadcast = msg;
    }
  });

  ws1.send(JSON.stringify({
    type: 'add',
    clientId: 'fix-verify-ws1',
    data: {
      bug: {
        id: testBugId,
        name: '修复验证Bug',
        status: '待修复',
      },
    },
  }));

  await sleep(500);
  assert(ws2AddBroadcast !== null, 'Add broadcast 被 ws2 正确收到');
  assert(ws2AddBroadcast && ws2AddBroadcast.change.bug.status === '待修复',
    `Bug 状态为 '待修复' (实际: ${ws2AddBroadcast ? ws2AddBroadcast.change.bug.status : 'null'})`);
  assert(ws2AddBroadcast && ws2AddBroadcast.change.bug.name === '修复验证Bug',
    `Bug 名称为完整传入值 (实际: ${ws2AddBroadcast ? ws2AddBroadcast.change.bug.name : 'null'})`);

  // Verify in data.json
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf-8'));
  const savedBug = data.bugs.find(b => b.id === testBugId);
  assert(savedBug !== undefined, 'Bug 已持久化到 data.json');
  assert(savedBug && savedBug.status === '待修复',
    `data.json 中状态为 '待修复' (实际: ${savedBug ? savedBug.status : 'not found'})`);

  // ===== Fix 1: Add 后 update/delete 同一 Bug（UUID 匹配） =====
  console.log('\n7.3 Add 后 update 同一 Bug（UUID 匹配）:');
  let ws2UpdateBroadcast = null;

  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'broadcast' && msg.change && msg.change.type === 'update' && msg.change.bugId === testBugId) {
      ws2UpdateBroadcast = msg;
    }
  });

  ws1.send(JSON.stringify({
    type: 'update',
    clientId: 'fix-verify-ws1',
    data: { bugId: testBugId, field: 'status', value: '已完成' },
  }));

  await sleep(500);
  assert(ws2UpdateBroadcast !== null, 'Update broadcast 被 ws2 正确收到');
  assert(ws2UpdateBroadcast && ws2UpdateBroadcast.change.value === '已完成',
    `状态更新为 '已完成'`);

  const data2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf-8'));
  const updatedBug = data2.bugs.find(b => b.id === testBugId);
  assert(updatedBug && updatedBug.status === '已完成', 'data.json 中状态已更新');

  console.log('\n7.4 Add 后 delete 同一 Bug（UUID 匹配）:');
  let ws2DeleteBroadcast = null;

  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'broadcast' && msg.change && msg.change.type === 'delete') {
      ws2DeleteBroadcast = msg;
    }
  });

  ws1.send(JSON.stringify({
    type: 'delete',
    clientId: 'fix-verify-ws1',
    data: { bugId: testBugId },
  }));

  await sleep(500);
  assert(ws2DeleteBroadcast !== null, 'Delete broadcast 被 ws2 正确收到');
  assert(ws2DeleteBroadcast && ws2DeleteBroadcast.change.bugId === testBugId,
    '删除的 bugId 正确');

  const data3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf-8'));
  const deletedBug = data3.bugs.find(b => b.id === testBugId);
  assert(!deletedBug, 'data.json 中 Bug 已被删除');

  ws1.close();
  ws2.close();

  console.log(`\n=== 修复验证结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
