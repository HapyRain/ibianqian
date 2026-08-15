# 协议匹配修复报告

## 修复日期
2026-07-02

## 修改文件
- `server.js`（仅服务端，客户端无需修改）

---

## 问题 1（严重）：add 消息协议不匹配 — 已修复

**症状**：客户端发送完整 bug 对象 `{ bugId, bug }`，但服务端只读取 `bugName` 字符串并自行生成 UUID，导致源客户端与服务端存储的 UUID 不一致。后续 update/delete 请求使用源客户端 UUID，服务端找不到对应记录。

**修复**：`handleAdd` 函数改为接受客户端传来的完整 `bug` 对象，使用客户端的 UUID，并增加防重复检查。

```javascript
// 修复前
const { bugName } = msg.data || {};
// 然后服务端自己 newBug = { id: crypto.randomUUID(), name: bugName, status: '待处理' }

// 修复后
const { bug } = msg.data || {};
if (!bug || !bug.id) return;
// 直接使用客户端的 bug 对象，包含客户端生成的 id
```

---

## 问题 2：状态枚举不一致 — 已修复

**症状**：服务端 `handleAdd` 中默认状态为 `'待处理'`，但客户端状态选项是 `['待修复', '修复中', '已完成']`。

**修复**：服务端不再自行构造 bug 对象，而是直接使用客户端传来的完整 bug 对象（其中 `status: '待修复'`），状态枚举自然一致。

---

## 问题 3：缺少客户端计数广播 — 已修复

**症状**：服务端未追踪在线客户端数，未广播 `clientCount` 消息，客户端 `onlineCount` 始终为默认值 `1`。

**修复**：
1. 新增 `broadcastClientCount(wss)` 函数（行 116-122），统计 `readyState === 1` 的客户端数并广播。
2. 新连接建立时广播在线人数（行 289）。
3. 连接关闭时广播在线人数（行 295-297）。
4. `handleRequestSync` 现在同时发送 `clientCount` 给请求同步的客户端（行 198-202）。

---

## 变更清单

| 位置 | 变更类型 | 说明 |
|------|----------|------|
| `handleAdd` (行 148-167) | 重写 | 接受客户端完整 bug 对象，使用客户端 UUID，增加防重复 |
| `broadcastClientCount` (行 116-122) | 新增 | 统计在线客户端数并广播 |
| `handleRequestSync` (行 190-203) | 修改 | 签名增加 `wss` 参数，额外发送 `clientCount` |
| `handleMessage` 中 `requestSync` 分支 (行 224) | 修改 | 调用时传入 `wss` |
| `wss.on('connection')` (行 276-302) | 修改 | 新增 `broadcastClientCount(wss)` 调用和 `ws.on('close')` 处理器 |

## 验证结果

- 服务器启动成功，HTTP 200 响应正常
- 客户端 `public/app.js` 与修复后的服务端协议一致，无需修改
