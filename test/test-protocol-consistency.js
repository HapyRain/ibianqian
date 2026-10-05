/**
 * WS 协议一致性静态契约测试（不起服务，仿 test-template-guard.js 的静态检查思路）
 *
 * 双向比对两组契约，任何差异即失败：
 *  A. 客户端发送侧 ↔ 服务端接收侧
 *     - server.js：WS_HANDLERS 对象字面量的全部键（服务端可处理的消息类型）
 *     - public/app.js：所有 sendMessage({ type: '...' }) 字面量（客户端发送的消息类型）
 *  B. 服务端广播侧 ↔ 客户端处理侧
 *     - server.js：作为 change.type 广播的全部类型字面量
 *     - public/app.js：handleBroadcast 函数体内 switch 的全部 case
 *
 * 提取方式与假设（宁可少抓不可误报，来源假设逐条注明）：
 *  - WS_HANDLERS：花括号配平截取对象字面量体；键用 "标识符:" 匹配。假设：该字面量内
 *    全部为 "消息类型: 裸函数标识符" 形式，值中不含冒号（已核对当前实现）。
 *  - 发送侧：只锚定 sendMessage({ type: '...' 字面量形态。假设（已核对当前实现）：
 *    app.js 所有出站消息都经 sendMessage 且 type 为字面量（sendUpdate/sendAdd/sendDelete
 *    内联构造；ws.send 仅出现在 sendMessage 实现内部与断线重连 pendingQueue 重放，
 *    无第三种 type 来源）；ElMessageBox 的 type:'warning' 不是 sendMessage 首参属性，不会误抓。
 *  - 服务端 change 类型：抓取 server.js 全部 type: '...' 字面量，剔除信封消息类型
 *    （broadcast / fullSync / clientCount —— 是 WS 消息外壳而非 change.type）与内部哨兵
 *    __import__（仅用于驱动写盘 + 版本递增；导入走 fullSync 广播，绝不作为 change 下发）。
 *    已人工核对当前 server.js 的全部 type:' 字面量均为上述两类；未来若出现新的非 change
 *    字面量，应归入下方两个剔除集合并注明，而不是放宽断言。
 *  - handleBroadcast：花括号配平截取函数体。假设：函数体内仅一个 switch、
 *    字符串模板中不含花括号（已核对当前实现）。
 *  - 每组集合抓取后先做"最小规模"哨兵检查（>= 10 个类型）：提取逻辑失效（源码结构
 *    变更导致抓空）时显式失败，绝不静默通过。
 */
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// --- 断言计数（静态测试不起服务，不引入 helpers 的 mkdtemp 副作用，本地实现同款输出） ---
let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { console.log(`  [PASS] ${name}`); passed++; }
  else { console.log(`  [FAIL] ${name}`); failed++; }
}

/** 从 startMarker 之后的第一个 '{' 起做花括号配平，返回花括号内文本（不含首尾花括号） */
function extractBracedBlock(text, startMarker) {
  const anchor = text.indexOf(startMarker);
  if (anchor === -1) return null;
  const open = text.indexOf('{', anchor);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const matchTypes = (text, re) => [...text.matchAll(re)].map(m => m[1]);
const diffSets = (a, b) => [...a].filter(x => !b.has(x));
const fmtSet = (set) => [...set].sort().join(', ');

// ===== 提取 =====

// 1. server.js WS_HANDLERS 键（服务端接收侧）
const handlersBlock = extractBracedBlock(serverSrc, 'const WS_HANDLERS');
let wsHandlerTypes = new Set();
assert(!!handlersBlock, 'server.js 中定位到 WS_HANDLERS 对象字面量（提取前提）');
if (handlersBlock) {
  wsHandlerTypes = new Set(matchTypes(handlersBlock, /([A-Za-z_$][\w$]*)\s*:/g));
}

// 2. app.js 发送侧（sendMessage 字面量形态）
const sendTypes = new Set(matchTypes(appSrc, /sendMessage\(\s*\{\s*type:\s*'([A-Za-z0-9_-]+)'/g));

// 3. server.js 广播 change 类型（全部 type:' 字面量 - 信封 - 内部哨兵）
const ENVELOPE_TYPES = new Set(['broadcast', 'fullSync', 'clientCount']);
const INTERNAL_CHANGE_TYPES = new Set(['__import__']);
const serverChangeTypes = new Set(matchTypes(serverSrc, /type:\s*'([A-Za-z0-9_-]+)'/g));
for (const t of ENVELOPE_TYPES) serverChangeTypes.delete(t);
for (const t of INTERNAL_CHANGE_TYPES) serverChangeTypes.delete(t);

// 4. app.js handleBroadcast switch case（客户端处理侧）
const broadcastBlock = extractBracedBlock(appSrc, 'function handleBroadcast(msg)');
let appHandledTypes = new Set();
assert(!!broadcastBlock, 'app.js 中定位到 handleBroadcast 函数体（提取前提）');
if (broadcastBlock) {
  appHandledTypes = new Set(matchTypes(broadcastBlock, /case\s+'([A-Za-z0-9_-]+)'/g));
}

// ===== 契约断言 =====
console.log('\n=== WS 协议一致性静态检查 ===\n');
console.log(`  [信息] 服务端 WS_HANDLERS（${wsHandlerTypes.size}）: ${fmtSet(wsHandlerTypes)}`);
console.log(`  [信息] 客户端发送侧（${sendTypes.size}）: ${fmtSet(sendTypes)}`);
console.log(`  [信息] 服务端广播 change 类型（${serverChangeTypes.size}）: ${fmtSet(serverChangeTypes)}`);
console.log(`  [信息] 客户端 handleBroadcast 处理（${appHandledTypes.size}）: ${fmtSet(appHandledTypes)}`);

// 哨兵：提取失效（抓空/抓过少）必须显式失败，防止契约检查静默退化为恒真
assert(wsHandlerTypes.size >= 10, `WS_HANDLERS 提取到足够消息类型（${wsHandlerTypes.size} >= 10）`);
assert(sendTypes.size >= 10, `发送侧提取到足够消息类型（${sendTypes.size} >= 10）`);
assert(serverChangeTypes.size >= 10, `服务端 change 类型提取到足够类型（${serverChangeTypes.size} >= 10）`);
assert(appHandledTypes.size >= 10, `handleBroadcast 提取到足够类型（${appHandledTypes.size} >= 10）`);

// 契约 A：发送侧 ↔ 接收侧 双向一致
const extraSent = diffSets(sendTypes, wsHandlerTypes);
const missingSent = diffSets(wsHandlerTypes, sendTypes);
assert(extraSent.length === 0,
  extraSent.length === 0
    ? '契约A(→)：app.js 发送的每个类型服务端都有 WS_HANDLERS 注册'
    : `app.js 发送了服务端未注册的类型: ${extraSent.join(', ')}`);
assert(missingSent.length === 0,
  missingSent.length === 0
    ? '契约A(←)：WS_HANDLERS 注册的每个类型客户端都会发送（无死代码注册）'
    : `服务端注册了客户端从不发送的类型: ${missingSent.join(', ')}`);

// 契约 B：广播侧 ↔ 处理侧 双向一致
const extraBc = diffSets(serverChangeTypes, appHandledTypes);
const missingBc = diffSets(appHandledTypes, serverChangeTypes);
assert(extraBc.length === 0,
  extraBc.length === 0
    ? '契约B(→)：服务端广播的每个 change.type 客户端 handleBroadcast 都能处理'
    : `服务端广播了客户端未处理的 change.type: ${extraBc.join(', ')}`);
assert(missingBc.length === 0,
  missingBc.length === 0
    ? '契约B(←)：handleBroadcast 的每个 case 服务端都会广播（无死分支）'
    : `客户端处理了服务端从不广播的 change.type: ${missingBc.join(', ')}`);

console.log(`\n=== WS 协议一致性静态检查结果: ${passed} 通过, ${failed} 失败 ===\n`);
process.exit(failed > 0 ? 1 : 0);
