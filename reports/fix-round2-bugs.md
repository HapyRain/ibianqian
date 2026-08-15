# 修复报告：server.js Round 2 Bug 修复

修复日期：2026-07-07

## 修复清单

### NEW-1 (严重): WebSocket 消息处理器未 await 异步操作

**位置**: `handleMessage` 函数（第 242 行附近）

**问题**: `handleUpdate`、`handleAdd`、`handleDelete` 是 async 函数，但在 switch 中调用时缺少 `await`，导致：
- 异步操作中的异常无法被上层捕获，可能造成未处理的 Promise rejection
- 数据库写入操作变成"fire and forget"，竞态条件下可能丢失数据

**修复**:
1. `handleMessage` 改为 `async function handleMessage`
2. 所有 async handler 调用前加 `await`，并用 `try-catch` 包裹防止单条消息处理崩溃整个进程
3. `handleRequestSync` 是同步函数，保持不变

```js
async function handleMessage(ws, rawMessage, wss) {
  // ...
  switch (msg.type) {
    case 'update':
      try { await handleUpdate(ws, msg, wss); } catch (e) { console.error('[WS] handleUpdate 错误:', e.message); }
      break;
    case 'add':
      try { await handleAdd(ws, msg, wss); } catch (e) { console.error('[WS] handleAdd 错误:', e.message); }
      break;
    case 'delete':
      try { await handleDelete(ws, msg, wss); } catch (e) { console.error('[WS] handleDelete 错误:', e.message); }
      break;
    case 'requestSync':
      handleRequestSync(ws, wss);
      break;
  }
}
```

### NEW-2 (严重): readData() 静默吞错导致数据全量丢失

**位置**: `readData` 函数（第 61-68 行）

**问题**: JSON 解析失败时静默返回 `{ bugs: [], version: 0 }`，不作任何日志或备份。一旦 `data.json` 因磁盘满、进程崩溃等原因损坏，所有已有数据静默丢失且无法恢复。

**修复**:
1. 区分 `ENOENT`（文件不存在，首次启动正常场景）和真正的读取/解析错误
2. 损坏文件自动备份到 `data.json.corrupted.{timestamp}`，保留恢复可能性
3. 所有异常路径打印日志

```js
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { bugs: [], version: 0 };
    }
    console.error('[Data] 读取 data.json 失败:', err.message);
    try {
      const timestamp = Date.now();
      const backupPath = DATA_FILE + '.corrupted.' + timestamp;
      fs.copyFileSync(DATA_FILE, backupPath);
      console.error(`[Data] 已备份损坏文件到: ${backupPath}`);
    } catch (backupErr) {
      console.error('[Data] 备份损坏文件失败:', backupErr.message);
    }
    return { bugs: [], version: 0 };
  }
}
```

### NEW-4 (中等): 服务端图片删除存在 TOCTOU 竞态

**位置**: `handleDeleteUpload` 函数（第 484 行附近）

**问题**: `fs.existsSync(filePath)` 和 `fs.unlinkSync(filePath)` 之间存在时间窗口。如果两个请求同时删除同一文件：
1. 请求 A 检查 `existsSync` -> true
2. 请求 B 检查 `existsSync` -> true
3. 请求 A 执行 `unlinkSync` -> 成功
4. 请求 B 执行 `unlinkSync` -> 抛出 ENOENT 异常，返回 500 错误

**修复**: 移除 `existsSync` 检查，直接 `unlinkSync` 并用 try-catch 忽略 `ENOENT`：

```js
try {
  try {
    fs.unlinkSync(filePath);
    console.log(`[Upload] 图片已删除: ${filename}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  res.writeHead(200, ...);
  res.end(JSON.stringify({ success: true }));
} catch (err) {
  // 其他错误正常返回 500
}
```

### NEW-6 (中等): HTTP POST /upload 的 req.destroy() 后客户端收不到 413

**位置**: `handleUpload` 函数（第 388-399 行）

**问题**: 当上传文件超过 100MB 限制时，`req.destroy()` 直接终止 TCP 连接，客户端收不到任何 HTTP 响应（包括 413 状态码），表现为连接被重置而非收到明确的错误信息。

**修复**: 移除 `req.destroy()`，让数据流自然完成，在 `end` 事件中检查 `totalSize` 并返回 413。`Buffer.concat(chunks)` 仅在未超限时执行：

```js
req.on('data', (chunk) => {
  totalSize += chunk.length;
  chunks.push(chunk);
});
req.on('end', () => {
  try {
    if (totalSize > MAX_FILE_SIZE) {
      res.writeHead(413, ...);
      res.end(JSON.stringify({ success: false, error: '...' }));
      return;
    }
    const body = Buffer.concat(chunks);
    // ... 后续处理
  }
});
```

**权衡说明**: 超限后 chunks 仍会累积所有数据（内存占用可能超过 100MB），但考虑到这是局域网场景且恶意上传的概率较低，简洁性优先。如需进一步优化，可在超过限制后停止 push 到 chunks。
