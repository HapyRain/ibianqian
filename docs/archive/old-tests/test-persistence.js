/**
 * 数据持久化集成测试
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = 3002; // use a new port to avoid conflicts
const BASE = `ws://localhost:${PORT}`;
const DATA_FILE = path.join(__dirname, 'data.json');
const TMP_FILE = path.join(__dirname, '.data.tmp');

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
  // Clean up old data
  try { fs.unlinkSync(DATA_FILE); } catch (e) {}
  try { fs.unlinkSync(TMP_FILE); } catch (e) {}

  // Kill any existing process on PORT
  try { execSync(`taskkill /F /FI "LISTENING eq ${PORT}" 2>nul`, { stdio: 'ignore' }); } catch (e) {}

  console.log(`\n=== 数据持久化测试 ===\n`);

  // ===== Phase 1: Start server =====
  console.log('Phase 1: 启动服务器...');
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Override port for this test instance
  // Actually, let's just use the default port startup
  let actualPort = PORT;
  let serverOutput = '';

  await new Promise((resolve) => {
    server.stdout.on('data', (data) => {
      serverOutput += data.toString();
      console.log('  [SERVER]', data.toString().trim());
      if (serverOutput.includes('服务器已启动')) {
        // Extract port
        const match = serverOutput.match(/:(\d+)/);
        if (match) actualPort = parseInt(match[1]);
        resolve();
      }
    });
    server.stderr.on('data', (data) => {
      console.error('  [SERVER ERR]', data.toString().trim());
    });
    setTimeout(() => resolve(), 5000);
  });

  console.log(`  实际端口: ${actualPort}`);
  const actualBase = `ws://localhost:${actualPort}`;

  // ===== Phase 2: Add bugs via WebSocket =====
  console.log('\nPhase 2: 通过 WebSocket 添加 Bug...');
  const ws = new WebSocket(actualBase);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
  });

  // Drain initial messages
  await sleep(500);
  // Clear message buffer
  let pendingMessages = [];
  ws.on('message', (raw) => {
    pendingMessages.push(JSON.parse(raw.toString()));
  });

  const bugs = [
    { id: 'persist-001', name: '持久化测试Bug-1', status: '待修复' },
    { id: 'persist-002', name: '持久化测试Bug-2', status: '修复中' },
    { id: 'persist-003', name: '持久化测试Bug-3', status: '已完成' },
  ];

  for (const bug of bugs) {
    ws.send(JSON.stringify({
      type: 'add',
      clientId: 'persist-test-client',
      data: { bug },
    }));
  }

  await sleep(1000);

  // ===== Phase 3: Check data.json =====
  console.log('\nPhase 3: 检查 data.json...');
  assert(fs.existsSync(DATA_FILE), 'data.json 文件已创建');

  let fileContent;
  try {
    fileContent = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    assert(false, `data.json 解析失败: ${e.message}`);
    fileContent = {};
  }

  assert(fileContent.bugs && fileContent.bugs.length === 3, `data.json 包含 3 条 Bug (实际: ${fileContent.bugs ? fileContent.bugs.length : 0})`);
  assert(fileContent.version !== undefined, 'data.json 包含 version 字段');
  assert(fileContent.version >= bugs.length, `version >= ${bugs.length} (实际: ${fileContent.version})`);

  // Check bug content
  if (fileContent.bugs) {
    const bug1 = fileContent.bugs.find(b => b.id === 'persist-001');
    assert(bug1 && bug1.name === '持久化测试Bug-1' && bug1.status === '待修复', 'Bug 数据内容正确');
  }

  let versionBeforeRestart = fileContent.version || 0;

  // ===== Phase 4: Kill server =====
  console.log('\nPhase 4: 关闭服务器...');
  ws.close();
  await sleep(500);
  server.kill('SIGTERM');
  await sleep(1000);
  assert(server.killed || server.exitCode !== null, '服务器进程已终止');

  // ===== Phase 5: Restart server =====
  console.log('\nPhase 5: 重启服务器...');
  const server2 = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let server2Output = '';
  let actualPort2 = PORT;

  await new Promise((resolve) => {
    server2.stdout.on('data', (data) => {
      server2Output += data.toString();
      console.log('  [SERVER2]', data.toString().trim());
      if (server2Output.includes('服务器已启动')) {
        const match = server2Output.match(/:(\d+)/);
        if (match) actualPort2 = parseInt(match[1]);
        resolve();
      }
    });
    server2.stderr.on('data', (data) => {
      console.error('  [SERVER2 ERR]', data.toString().trim());
    });
    setTimeout(() => resolve(), 5000);
  });

  const actualBase2 = `ws://localhost:${actualPort2}`;

  // ===== Phase 6: Verify data restored =====
  console.log('\nPhase 6: 验证数据恢复...');
  const ws2 = new WebSocket(actualBase2);

  await new Promise((resolve, reject) => {
    ws2.on('open', resolve);
    ws2.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
  });

  let fullSyncData = null;
  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'fullSync') {
      fullSyncData = msg;
    }
  });

  // Request sync
  ws2.send(JSON.stringify({ type: 'requestSync', clientId: 'verify-client' }));
  await sleep(500);

  assert(fullSyncData !== null, '重启后 requestSync 返回 fullSync');
  if (fullSyncData && fullSyncData.data) {
    assert(fullSyncData.data.bugs && fullSyncData.data.bugs.length === 3,
      `重启后数据完整恢复 (实际: ${fullSyncData.data.bugs ? fullSyncData.data.bugs.length : 0} 条)`);
    assert(fullSyncData.data.version === versionBeforeRestart,
      `version 持久化正确 (期望: ${versionBeforeRestart}, 实际: ${fullSyncData.data.version})`);
  }

  // ===== Phase 7: Verify version increments =====
  console.log('\nPhase 7: 验证 version 递增...');
  ws2.send(JSON.stringify({
    type: 'update',
    clientId: 'verify-client',
    data: { bugId: 'persist-001', field: 'status', value: '已完成' },
  }));

  await sleep(500);

  const dataAfterUpdate = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  assert(dataAfterUpdate.version === versionBeforeRestart + 1,
    `version 正确递增 (期望: ${versionBeforeRestart + 1}, 实际: ${dataAfterUpdate.version})`);

  // Cleanup
  ws2.close();
  server2.kill('SIGTERM');
  await sleep(500);

  console.log(`\n=== 数据持久化结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
