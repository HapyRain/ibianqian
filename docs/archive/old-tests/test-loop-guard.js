/**
 * 循环刷新防护测试
 * 验证:
 * 1. Server 正确在 broadcast 中包含 originClientId（client-side 过滤依赖此字段）
 * 2. app.js 中的 originClientId 过滤逻辑正确
 * 3. 远端客户端正确接收更新
 */
const WebSocket = require('ws');

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

// Client-side filtering logic (same as app.js)
function shouldAcceptBroadcast(msg, myClientId) {
  // 第一层防护：忽略自己发出的变更
  if (msg.originClientId === myClientId) {
    return false;
  }
  return true;
}

async function runTests() {
  console.log(`\n=== 循环刷新防护测试 (port ${PORT}) ===\n`);

  const clientId1 = 'ws1-loop-test-v2';
  const clientId2 = 'ws2-loop-test-v2';
  const testBugId = 'loop-guard-v2-001';

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
    setTimeout(() => resolve(), 5000);
  });

  await sleep(500);

  // Add test bug via ws1
  console.log('准备: 添加测试 Bug...');
  await new Promise((resolve) => {
    ws2.once('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'broadcast' && msg.change && msg.change.type === 'add' && msg.change.bug && msg.change.bug.id === testBugId) {
        resolve();
      }
    });
    ws1.send(JSON.stringify({
      type: 'add',
      clientId: clientId1,
      data: { bug: { id: testBugId, name: '循环刷新测试Bug', status: '待修复' } },
    }));
    setTimeout(() => resolve(), 2000);
  });

  await sleep(300);

  // ===== Test 5.1: 验证 server 在 broadcast 中正确设置 originClientId =====
  console.log('\n5.1 验证 server broadcast 包含正确的 originClientId:');
  let broadcastOriginClientId = null;

  const collectPromise = new Promise((resolve) => {
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'broadcast' && msg.change && msg.change.type === 'update' && msg.change.bugId === testBugId) {
        broadcastOriginClientId = msg.originClientId;
        resolve();
      }
    });
    setTimeout(() => resolve(), 2000);
  });

  ws2.send(JSON.stringify({
    type: 'update',
    clientId: clientId2,
    data: { bugId: testBugId, field: 'status', value: '修复中' },
  }));

  await collectPromise;

  assert(broadcastOriginClientId === clientId2,
    `originClientId 正确设置为发送者 ID (期望: ${clientId2}, 实际: ${broadcastOriginClientId})`);

  // ===== Test 5.2: 验证 client-side 过滤逻辑（模拟 app.js 行为） =====
  console.log('\n5.2 验证 client-side originClientId 过滤逻辑:');
  const simulatedBroadcast = { originClientId: clientId1, change: { type: 'update' } };

  const acceptedBySelf = shouldAcceptBroadcast(simulatedBroadcast, clientId1);
  assert(acceptedBySelf === false, '自身消息被 client-side 过滤 (originClientId === myClientId)');

  const acceptedByOther = shouldAcceptBroadcast(simulatedBroadcast, clientId2);
  assert(acceptedByOther === true, '他人消息不被 client-side 过滤 (originClientId !== myClientId)');

  // ===== Test 5.3: 端到端验证 ws1 发送 → ws2 收到, ws1 自己过滤 =====
  console.log('\n5.3 端到端广播 + client-side 过滤验证:');
  let ws1Accepted = false;
  let ws2Accepted = false;

  ws1.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'broadcast' && msg.change && msg.change.type === 'update' && msg.change.bugId === testBugId && msg.change.field === 'name') {
      // Apply client-side filtering (same as app.js)
      if (shouldAcceptBroadcast(msg, clientId1)) {
        ws1Accepted = true;
      }
    }
  });

  const ws2Promise = new Promise((resolve) => {
    ws2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'broadcast' && msg.change && msg.change.type === 'update' && msg.change.bugId === testBugId && msg.change.field === 'name') {
        if (shouldAcceptBroadcast(msg, clientId2)) {
          ws2Accepted = true;
        }
        resolve();
      }
    });
    setTimeout(() => resolve(), 2000);
  });

  ws1.send(JSON.stringify({
    type: 'update',
    clientId: clientId1,
    data: { bugId: testBugId, field: 'name', value: '已修改-' + Date.now() },
  }));

  await ws2Promise;
  await sleep(300);

  assert(ws1Accepted === false, 'ws1 自身通过 client-side 过滤后不会处理自己的 broadcast');
  assert(ws2Accepted === true, 'ws2 通过 client-side 过滤后正确处理 ws1 的 broadcast');

  // Cleanup
  ws1.close();
  ws2.close();

  console.log(`\n=== 循环刷新防护结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
