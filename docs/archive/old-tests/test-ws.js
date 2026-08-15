/**
 * WebSocket 集成测试脚本
 * 测试：add/update/delete 广播、requestSync、clientCount、循环刷新防护
 */
const WebSocket = require('ws');

const PORT = process.argv[2] || 3001;
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
  console.log(`\n=== WebSocket 协议测试 (port ${PORT}) ===\n`);

  // ===== Test 3.1: add 广播 =====
  console.log('3.1 Add 广播测试:');
  const ws1 = new WebSocket(BASE);
  const ws2 = new WebSocket(BASE);

  await new Promise((resolve) => {
    let openCount = 0;
    const onOpen = () => {
      openCount++;
      if (openCount === 2) resolve();
    };
    ws1.on('open', onOpen);
    ws2.on('open', onOpen);
    setTimeout(() => resolve(), 5000); // 5s 超时
  });

  // 等待 fullSync + clientCount 初始消息
  await sleep(500);

  // ws1 发送 add
  const testBug = {
    id: 'test-bug-001',
    name: '测试Bug-集成测试',
    status: '待修复',
  };

  let ws2ReceivedAdd = false;
  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'broadcast' && msg.change && msg.change.type === 'add' && msg.change.bug && msg.change.bug.id === 'test-bug-001') {
      ws2ReceivedAdd = true;
    }
  });

  ws1.send(JSON.stringify({
    type: 'add',
    clientId: 'ws1-client',
    data: { bug: testBug },
  }));

  await sleep(500);
  assert(ws2ReceivedAdd, 'ws1 add → ws2 收到 add 广播');

  // ===== Test 3.2: update 广播 =====
  console.log('\n3.2 Update 广播测试:');
  let ws1ReceivedUpdate = false;

  ws1.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'broadcast' && msg.change && msg.change.type === 'update' && msg.change.bugId === 'test-bug-001' && msg.change.field === 'status' && msg.change.value === '修复中') {
      ws1ReceivedUpdate = true;
    }
  });

  ws2.send(JSON.stringify({
    type: 'update',
    clientId: 'ws2-client',
    data: { bugId: 'test-bug-001', field: 'status', value: '修复中' },
  }));

  await sleep(500);
  assert(ws1ReceivedUpdate, 'ws2 update → ws1 收到 update 广播');

  // ===== Test 3.3: delete 广播 =====
  console.log('\n3.3 Delete 广播测试:');
  let ws1ReceivedDelete = false;

  ws1.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'broadcast' && msg.change && msg.change.type === 'delete' && msg.change.bugId === 'test-bug-001') {
      ws1ReceivedDelete = true;
    }
  });

  ws2.send(JSON.stringify({
    type: 'delete',
    clientId: 'ws2-client',
    data: { bugId: 'test-bug-001' },
  }));

  await sleep(500);
  assert(ws1ReceivedDelete, 'ws2 delete → ws1 收到 delete 广播');

  // ===== Test 3.4: requestSync 返回 fullSync + clientCount =====
  console.log('\n3.4 requestSync 测试:');
  const ws3 = new WebSocket(BASE);
  let receivedFullSync = false;
  let receivedClientCount = false;

  await new Promise((resolve) => {
    ws3.on('open', () => {
      ws3.send(JSON.stringify({ type: 'requestSync', clientId: 'ws3-client' }));
    });
    ws3.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'fullSync') {
        receivedFullSync = true;
      }
      if (msg.type === 'clientCount') {
        receivedClientCount = true;
        resolve();
      }
    });
    setTimeout(() => resolve(), 3000);
  });

  await sleep(300);
  assert(receivedFullSync, 'requestSync 返回 fullSync');
  assert(receivedClientCount, 'requestSync 返回 clientCount');

  // ===== Test 3.5: clientCount 广播 =====
  console.log('\n3.5 clientCount 广播测试:');
  let ws2ReceivedCount = false;
  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'clientCount') {
      ws2ReceivedCount = msg;
    }
  });

  // 关闭 ws3 触发 clientCount 更新
  ws3.close();
  await sleep(500);
  assert(ws2ReceivedCount && typeof ws2ReceivedCount.count === 'number',
    '客户端断开后广播 clientCount');

  // ===== 清理 =====
  ws1.close();
  ws2.close();

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
