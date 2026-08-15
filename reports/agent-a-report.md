# Agent A (服务端开发) 开发报告

## 任务完成概览

| 任务 | 状态 | 说明 |
|------|------|------|
| T1.1 项目初始化与 package.json | 完成 | 创建 package.json，npm install 成功 |
| T1.2 server.js 开发 | 完成 | 330 行，包含全部 6 个功能模块 |

## 文件清单

### 1. `d:\Project\ibianqian\package.json`

- 项目名: `ibianqian-buglist`
- 唯一依赖: `ws@^8.16.0`
- 启动脚本: `npm start` (node server.js) / `npm run dev` (node --watch)
- npm install 结果: 成功安装 1 个包，0 个漏洞

### 2. `d:\Project\ibianqian\server.js` (330 行)

按逻辑区块分为以下 6 个模块：

#### 模块 1: 配置常量
- 端口范围: `3000` ~ `3020`
- 绑定地址: `0.0.0.0` (INADDR_ANY，确保局域网可访问)
- 数据文件: `data.json`，临时文件: `.data.tmp`
- 静态文件目录: `public/`

#### 模块 2: Promise 队列文件锁
- `acquireLock()` / `release()` 模式
- 基于 Promise 链式队列，无外部依赖
- 确保并发写入操作串行化

#### 模块 3: 数据持久化
- `readData()`: 读取 data.json，文件不存在时返回 `{ bugs: [], version: 0 }`
- `updateData(transformFn)`: 
  - 获取锁 → 读取数据 → 执行 transform → version+1 → 原子写入 (.tmp → rename) → 释放锁
  - transformFn 原地修改 data 并返回 change 描述对象
  - 原子写入保证数据文件永不损坏

#### 模块 4: HTTP 静态文件服务
- 基于 Node.js 内置 `http` 模块
- MIME 类型映射: html/css/js/json/png/svg/ico/woff 等
- 根路径 `/` 映射到 `index.html`
- 目录遍历防护: `path.resolve` + `startsWith` 校验
- 正确的 404/500 错误处理

#### 模块 5: WebSocket 服务
- 使用 `ws` 库，`new WebSocketServer({ server })` 共用 HTTP 实例
- 每个连接生成唯一 `clientId`（`crypto.randomUUID()`）
- 新连接立即发送全量同步 `{ type: "fullSync", data, version }`
- 消息处理: `update`, `add`, `delete`, `requestSync`
- `handleAdd`: 客户端生成完整 bug 对象（含 UUID），服务端做幂等去重后写入
- `broadcastClientCount`: 在线人数广播工具函数
- 广播时附带 `originClientId`，客户端据此过滤自己的消息

#### 模块 6: 端口探测启动
- 从 3000 开始逐个尝试
- `EADDRINUSE` 时自动 +1 重试
- 超过 3020 仍未可用则退出
- 启动成功后打印 `http://0.0.0.0:PORT` 及所有局域网 IP

### 3. `d:\Project\ibianqian\node_modules/` (自动生成)

- 包含 `ws` 及其依赖，共 2 个包

## 验证结果

### 启动测试
```
$ node server.js
服务器已启动: http://0.0.0.0:3000
局域网访问地址:
  http://192.168.0.120:3000
```
- 监听地址: `0.0.0.0:3000` (通过)
- 局域网 IP 检测: `192.168.0.120` (通过)

### 代码质量
- 无语法错误，Node.js 直接运行成功
- Promise 锁机制经过逻辑验证，保证并发写入安全
- 原子写入 (.tmp → rename) 保证数据文件不损坏
- WebSocket 挂载在 http.Server 上，与 HTTP 共用端口

## 避坑清单验证

| 避坑项 | 实现 | 状态 |
|--------|------|------|
| 监听地址 `0.0.0.0` | `httpServer.listen(port, '0.0.0.0', ...)` | 通过 |
| WebSocket 挂载到 http.Server | `new WebSocketServer({ server: httpServer })` | 通过 |
| 原子写入 | `writeFileSync(.tmp)` + `renameSync(.tmp, data.json)` | 通过 |
| version 递增 | `data.version = (data.version \|\| 0) + 1` (每次写操作) | 通过 |
| originClientId 过滤 | 广播消息包含 `originClientId`，由客户端过滤 | 通过 |

## 备注

- `data.json` 为延迟创建，仅在首次写操作时生成（首次读返回默认空数据）
- 服务端不内置初始 demo 数据，由前端或用户首次操作生成
- 330 行略超 300 行估算，系完整注释、错误处理及 `broadcastClientCount` 工具函数所致，功能无冗余
