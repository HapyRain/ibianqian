> ⚠️ 归档文档（2026-07-18 归档）：内容已过时，仅供历史参考，勿按此操作。
> 当前权威入口：项目根 README.md（其「知识索引」章节列有本文档的过时点说明）。

# Bug 清单 - 多人协同 项目代码汇总文档

**生成日期**: 2026-07-07

---

## 项目概述

**一句话描述**: 一款支持局域网多人实时协同的 Bug 清单管理工具，基于 Node.js + Vue 3 + Element Plus 构建，可作为 Web 服务运行或打包为 Windows 便携 exe 桌面应用。

**技术栈**: Node.js + ws + Vue 3 + Element Plus + Electron

**核心功能列表**:

| 编号 | 功能 | 分类 |
|------|------|------|
| 1 | Bug CRUD（新增、编辑名称、切换状态、删除） | 原始功能 |
| 2 | WebSocket 实时广播同步（多人在线协同编辑） | 原始功能 |
| 3 | data.json 文件持久化（原子写入 + Promise 队列锁） | 原始功能 |
| 4 | 服务器地址记忆 + 连接失败提示（UX 改进 1） | UX 改进 |
| 5 | 单实例检测 Electron 桌面壳（UX 改进 2） | UX 改进 |
| 6 | Bug 图片上传 — 点击 / 拖拽 / Ctrl+V 粘贴（UX 改进 3） | UX 改进 |
| 7 | 状态颜色强化 — el-tag 彩色标签（UX 改进 4） | UX 改进 |
| 8 | 状态排序 + 筛选按钮组（UX 改进 5） | UX 改进 |

---

## 架构总览

### 整体架构图

```
+------------------------------------------------------------------+
|                        LAN (局域网)                                |
|                                                                   |
|  +------------+  +------------+  +------------+                   |
|  | 客户端 A    |  | 客户端 B    |  | 客户端 C    |                   |
|  | (浏览器 /   |  | (浏览器 /   |  | (浏览器 /   |                   |
|  |  Electron)  |  |  Electron)  |  |  Electron)  |                   |
|  | Vue 3 App   |  | Vue 3 App   |  | Vue 3 App   |                   |
|  +------+------+  +------+------+  +------+------+                   |
|         |                |                |                          |
|         |   WebSocket    |                |                          |
|         +----------------+----------------+                          |
|                          |                                           |
|                +---------+---------+                                 |
|                |  Node.js 服务端    |                                 |
|                |  server.js        |                                 |
|                |  0.0.0.0:3050     |                                 |
|                |  HTTP + WS 同端口  |                                 |
|                +---------+---------+                                 |
|                          |                                           |
|                +---------+---------+                                 |
|                |    data.json      |                                 |
|                |  (Promise队列锁)   |                                 |
|                |  + uploads/ 目录   |                                 |
|                +-------------------+                                 |
+------------------------------------------------------------------+
```

### 核心机制

| 机制 | 说明 |
|------|------|
| **端口范围** | 3050-3070，自动探测（EADDRINUSE 时 +1 重试） |
| **绑定地址** | `0.0.0.0`（INADDR_ANY），支持局域网内所有设备访问 |
| **HTTP + WS 同端口** | `http.createServer` + `WebSocketServer({ server })` 共用同一 `http.Server` 实例 |
| **数据同步** | 客户端修改 → `{ type: "update/add/delete" }` 发送至服务端 → 服务端广播 `{ type: "broadcast" }` → 其他客户端接收并更新本地数据 |
| **文件锁** | Promise 队列互斥锁，`acquireLock()` 返回 release 函数；读写 data.json 全部串行化 |
| **原子写入** | `fs.writeFileSync(.data.tmp)` → `fs.renameSync(.data.tmp, data.json)` |
| **断线重连** | 指数退避 + 随机抖动：`min(1000 * 2^n, 30000) + random(0~1000)` ms |
| **三层循环防护** | 第一层 originClientId 过滤（服务端广播时标记，客户端忽略自己的消息）、第二层 isLocalChange 标志（双重保险，本地操作期间忽略远程消息）、第三层值比对（新旧值相同时跳过更新） |
| **Electron 桌面壳** | 内嵌 WebSocket 服务、系统托盘（关闭隐藏、双击显示、置顶开关、退出）、单实例锁 |

---

## 文件清单

| 文件 | 行数 | 功能 | 关键模块 |
|------|------|------|----------|
| `server.js` | 597 | WebSocket 服务器 + HTTP 静态文件服务 + 图片上传 API | 配置常量、文件锁、数据持久化、WebSocket 消息处理、HTTP 静态文件服务、图片上传端点、端口自适应 |
| `public/index.html` | 234 | Vue 3 单页模板 | 头部标题栏、工具栏（筛选按钮+新增+记录数）、表格（名称+状态+截图+操作）、文件选择器、大图预览对话框、底部信息栏 |
| `public/app.js` | 810 | Vue 3 应用核心逻辑 | 响应式数据、WebSocket 客户端（指数退避重连）、三层循环防护、地址记忆+断连提示、排序筛选、图片上传（三种方式）、Bug CRUD、生命周期管理 |
| `public/style.css` | 711 | 自定义样式 | CSS 变量、布局、连接指示器、状态下拉、筛选按钮、图片上传区域、响应式、动画 |
| `electron/main.js` | 199 | Electron 主进程 | 单实例锁、系统托盘、窗口管理、内嵌服务器 |
| `electron/preload.js` | 9 | 预加载脚本 | contextBridge 暴露 electronAPI |
| `package.json` | 21 | 依赖与脚本 | npm scripts、生产依赖 / 开发依赖 |
| `electron-builder.yml` | 19 | 打包配置 | portable 目标、ASAR 打包、产物命名 |
| `plan.md` | 286 | 完整实施计划 | 架构设计、子任务分解、Agent 分工、关键技术决策 |
| `reports/ux-improvement-plan.md` | 159 | UX 改进方案 | 5 个改进需求、预估改动量、并行策略、验收清单 |

### server.js（597 行）

入口文件，既是 WebSocket 信令服务器，也是 HTTP 静态文件服务，同时提供图片上传/删除 API。

**逻辑区块**:

| 区块 | 行号范围 | 职责 |
|------|----------|------|
| 配置常量 | 11-17 | `INITIAL_PORT`=3050, `MAX_PORT`=3070, `BIND_ADDR`='0.0.0.0', `DATA_FILE`, `TMP_FILE`, `PUBLIC_DIR`, `UPLOADS_DIR` |
| MIME 类型映射 | 28-41 | 12 种 MIME 类型：html/css/js/json/png/jpg/jpeg/gif/svg/ico/woff/woff2 |
| Promise 队列文件锁 | 46-56 | `acquireLock()` 返回 release 回调，所有写操作串行化 |
| 数据持久化 | 60-90 | `readData()` 同步读取 data.json；`updateData(transformFn)` 原子写入（获取锁 → 读取 → transform → 写 .tmp → rename → 释放锁） |
| 辅助工具 | 94-129 | `getLocalIPs()` 获取局域网 IP 列表；`broadcast(wss, message)` 全量广播；`sendTo(ws, message)` 单播；`broadcastClientCount(wss)` 广播在线人数 |
| WebSocket 消息处理 | 133-234 | `handleUpdate` / `handleAdd` / `handleDelete` / `handleRequestSync` → `handleMessage` 分发 |
| HTTP 静态文件服务 | 238-257 | `serveStaticFile(res, filePath)` 读取并响应静态文件 |
| 图片上传 MIME 白名单 + 魔数校验 | 260-442 | `ALLOWED_MIME_TYPES`（6 种图片格式）；`detectMagicMime(buffer)` 魔数检测；`isSafeFilename(name)` 路径穿越防护；`parseMultipart(buffer, boundary)` 手动解析 multipart/form-data；`handleUpload(req, res)` 图片上传端点；`handleDeleteUpload(req, res, filename)` 图片删除端点（双重路径穿越防护） |
| HTTP 路由分发 | 444-501 | `createHttpHandler()` 返回请求处理函数：POST/DELETE /api/upload, GET /vendor/*（node_modules 映射）, 静态文件（含路径穿越防护） |
| 端口探测启动 | 505-597 | `_createServer(port)` 创建 HTTP + WS 服务；`startServer(initialPort)` 端口自适应循环（3050→3070）；`module.exports` 导出 + 直接运行自动启动 |

**关键设计要点**:

- 文件锁基于 Promise 队列而非回调，保证并发写安全
- `updateData` 使用 transform pattern：接收函数在锁内执行，返回 change 描述对象用于广播
- 图片上传手动解析 multipart，不依赖第三方库（如 multer）
- 图片安全采用 MIME 白名单 + 文件头魔数双校验
- 路径穿越防护同时使用 `isSafeFilename` + `startsWith` 双重校验

### public/index.html（234 行）

Vue 3 单页面应用的 HTML 模板，通过 CDN（映射至 /vendor/）引入依赖。

**页面结构**:

| 区域 | 行号范围 | 功能 |
|------|----------|------|
| 头部标题栏 | 16-38 | 应用标题 + 服务器地址输入框 + 连接状态指示器（圆点+状态文字） + 在线人数 |
| 工具栏 | 42-59 | 筛选按钮组（全部 + 三状态 + 数量） + 新增 Bug 按钮 + 记录数 |
| 表格 | 62-200 | Bug 名称列（双击编辑 / el-input 内联编辑） + 状态列（el-select 自定义彩色 el-tag trigger） + 截图列（缩略图 + 拖拽上传 + 删除按钮 + loading 遮罩） + 操作列（el-popconfirm 删除确认） + 空状态 |
| 隐藏文件输入 | 202-209 | `<input type="file" accept="image/*">` 用于点击上传 |
| 大图预览对话框 | 212-214 | `el-dialog` + `<img>` 全宽展示 |
| 底部信息栏 | 217-221 | 数据版本号 + 客户端 ID（短格式） |

**依赖引入**（通过 /vendor/ 路由映射至 node_modules/）:

- `vue.global.prod.js` — Vue 3 生产构建
- `element-plus/dist/index.css` — Element Plus 样式
- `element-plus/dist/index.full.min.js` — Element Plus 完整包
- `element-plus/dist/locale/zh-cn.min.js` — 中文语言包

### public/app.js（810 行）

Vue 3 应用核心逻辑文件，使用 IIFE 包裹避免全局变量污染。

**逻辑模块**:

| 模块 | 行号范围 | 职责 |
|------|----------|------|
| 响应式数据定义 | 12-91 | `bugs`, `clientId`, `connectionStatus`, `disconnectReason`, `dataVersion`, `onlineCount`, `statusOptions`, `STATUS_ORDER`, `editingBugId`, `statusFilter`, `serverHost`, `currentImageBugId`, `imagePreviewVisible`, `uploadingBugId` 等 |
| 计算属性 | 93-131 | `shortClientId`, `statusText`（连接失败时显示红色错误提示）, `filteredAndSortedBugs`（先筛选后排序，同状态稳定排序）, `statusCounts` |
| WebSocket 连接管理 | 134-214 | `connectWebSocket()` 建立连接（protocol 自动判断 ws/wss）；`scheduleReconnect()` 指数退避重连（base 1s, max 30s, +random jitter） |
| 消息收发 | 216-280 | `sendMessage` / `sendUpdate` / `sendAdd` / `sendDelete` → `handleMessage` 分发 → `handleFullSync` / `handleBroadcast`（三层防护） |
| 远程消息处理 | 280-370 | `handleBroadcast`（originClientId 过滤 + isLocalChange 双保险）→ `handleRemoteAdd`（去重检查）/ `handleRemoteUpdate`（新旧值比较）/ `handleRemoteDelete`（同步清理图片文件） |
| 服务器地址切换 | 372-409 | `disconnect()` 断开 + 清理重连定时器；`onServerChange()` 持久化到 localStorage → 重置防抖 → 重连 |
| Bug CRUD 操作 | 411-526 | `onStatusChange` / `startEditName` / `finishEditName` / `cancelEditName` / `addBug`（自动进入编辑模式）/ `deleteBug`（同步清理图片） |
| 图片上传（三种方式） | 528-704 | `handleImageUpload(file, bugId)` 核心入口（删除旧图 → POST multipart → 更新本地 + 广播）；`triggerFileInput` 点击上传；`onFileSelect` 文件选择回调；`onDragOver/onDragLeave/onDrop` 拖拽上传（带 CSS 类切换）；`onPaste` Ctrl+V 粘贴（检查 editingBugId + 只处理第一张图片）；`deleteImage` 删除图片；`openPreview/closePreview` 大图预览 |
| 生命周期管理 | 726-745 | `onMounted` 连接 WebSocket + 注册全局 paste 监听；`onUnmounted` 清理 paste 监听 + 重连定时器 + WebSocket 连接 |
| 应用导出与挂载 | 749-810 | 返回 template 引用对象 → `app.use(ElementPlus, { locale: ElementPlusLocaleZhCn })` → `app.mount('#app')` |

**三层循环防护**:

| 层级 | 机制 | 说明 | 代码位置 |
|------|------|------|----------|
| 第一层 | `originClientId === clientId` 过滤 | 服务端广播时在消息中标记 `originClientId`，客户端收到广播后检查该字段，若与自身 `clientId` 相同则忽略，避免将自己的变更当作远程消息处理 | `handleBroadcast` 行 301 |
| 第二层 | `isLocalChange` 标志 | 双重保险：本地执行 CRUD 操作期间设置 `isLocalChange = true`，操作完成后重置为 `false`。`handleBroadcast` 检查该标志，若为 `true` 则直接跳过，防止本地操作期间收到的远程消息干扰当前操作 | `handleBroadcast` 行 306 |
| 第三层 | `bug[field] === value` 新旧值比较 | 在处理远程更新时，先比较 Bug 当前字段值是否已等于目标值，若相同则跳过更新，避免不必要的 DOM 重渲染和无意义的广播回环 | `handleRemoteUpdate` 行 351 |

### public/style.css（711 行）

手写 CSS，全中文界面，包含丰富的交互动效。

**样式模块**:

| 模块 | 行号范围 | 说明 |
|------|----------|------|
| CSS 变量 | 7-29 | 背景色、文字色、边框色、状态三色（pending/fixing/done）、阴影、圆角、过渡曲线 |
| 基础重置 | 31-53 | box-sizing, 字体栈, 背景色, 行高 |
| 应用容器 | 55-61 | 最大宽度 900px, 居中, fadeIn 动画 |
| 头部标题栏 | 63-96 | flex 布局, 标题样式, 右侧信息区 |
| 连接状态指示器 | 97-145 | `.status-dot`（10px 圆点, connecting 脉冲动画, connected 绿色发光, disconnected 红色）；`.disconnect-reason` 红色高亮 |
| 服务器地址输入 | 147-180 | 紧凑输入框样式, focus 蓝色边框 + 阴影 |
| 工具栏 | 182-200 | 筛选按钮组 + 操作按钮行 |
| 筛选按钮 | 202-232 | 非激活态灰色, hover 蓝色高亮, 激活态 primary 色 |
| 表格容器 | 234-293 | 卡片阴影, 行 hover 动效（scale 1.01 + 阴影）, 名称单元格（编辑态高亮）, 状态下拉 |
| 状态样式 | 296-360 | 状态下拉选择器, 触发器标签, 选项圆点, 行内标签（三色） |
| 按钮动效 | 362-396 | hover scale(1.05), active scale(0.95), 文本按钮样式, 弹出确认框 |
| 空状态 | 391-413 | 大图标 + 提示文字 |
| 底部信息栏 | 415-430 | 居中, 版本号 + 客户端 ID |
| 响应式 | 432-492 | 768px 断点（标题栏纵向排列）, 480px 断点（隐藏计数/缩小字体） |
| 滚动条美化 | 493-518 | Webkit 6px 圆角半透明 + Firefox scrollbar-width thin |
| 表格覆盖 | 520-546 | Element Plus 表头样式, 单元格内边距, 边框线轻量化 |
| 图片上传区域 | 551-658 | 缩略图容器（48x48 虚线边框, hover 蓝色高亮）, 拖拽高亮, 缩略图样式, 删除按钮（hover 显现 + 缩放）, 上传中 loading 遮罩 + spinner |
| 关键帧动画 | 660-693 | `fadeIn`（淡入 + 上移 8px）, `slideUp`（上移 16px）, `pulse`（缩放透明度呼吸）, `spin`（360 旋转） |
| 打印样式 | 695-711 | 隐藏工具栏/底部/固定列 |

### electron/main.js（199 行）

Electron 主进程，内嵌 WebSocket 服务 + 系统托盘管理。

**逻辑模块**:

| 模块 | 行号范围 | 职责 |
|------|----------|------|
| 初始化设置 | 7-23 | `Menu.setApplicationMenu(null)` 去掉默认菜单栏；全局引用 `mainWindow` / `tray`；退出标志 `app.isQuitting` |
| 托盘图标生成 | 27-38 | `createTrayIcon()` 纯内存生成 16x16 蓝色（RGBA）图标 |
| 系统托盘 | 40-94 | `createTray()` 创建托盘（双击显示窗口）；`updateTrayMenu()` 右键菜单（显示窗口 / 窗口置顶 checkbox / 退出） |
| 创建主窗口 | 98-143 | `createWindow(port)` 900x600 窗口, 最小 600x400, preload.js, contextIsolation, 关闭→隐藏到托盘, 置顶状态变化→更新托盘菜单 |
| 单实例锁 | 147-161 | `requestSingleInstanceLock()` 拒绝第二个实例；`second-instance` 事件恢复已有窗口 |
| 应用启动 | 166-181 | `app.whenReady()` → `startServer(3050)` → `createWindow(port)` → `createTray()` |
| 应用退出 | 183-199 | `before-quit` 设置退出标志；`window-all-closed` 不自动退出（由托盘控制）；`activate` macOS Dock 恢复 |

### electron/preload.js（9 行）

最小化预加载脚本，通过 `contextBridge.exposeInMainWorld` 向渲染进程暴露 `window.electronAPI = { isElectron: true }`。上下文隔离（contextIsolation: true）下渲染进程通过此对象判断运行环境。

### package.json（21 行）

| 字段 | 值 | 说明 |
|------|-----|------|
| `name` | `ibianqian-buglist` | 项目名称 |
| `version` | `1.0.0` | 版本号 |
| `main` | `electron/main.js` | Electron 入口（同时也是 npm start 类型标识） |
| `scripts.start` | `node server.js` | 开发模式 - 纯 Web 服务器 |
| `scripts.dev` | `node --watch server.js` | 开发模式 - 文件变更自动重启 |
| `scripts.electron` | `electron .` | Electron 桌面应用（需先 npm start 或自动内嵌服务） |
| `scripts.build` | `electron-builder --win portable --config electron-builder.yml` | 打包单 exe |

**生产依赖**: `element-plus ^2.9.0`, `vue ^3.5.0`, `ws ^8.16.0`
**开发依赖**: `electron ^33.0.0`, `electron-builder ^25.0.0`

### electron-builder.yml（19 行）

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `appId` | `com.ibianqian.buglist` | 应用唯一标识 |
| `productName` | `Bug清单` | 安装后显示名称 |
| `directories.output` | `dist` | 构建产物输出目录 |
| `directories.buildResources` | `build` | 构建资源（图标等） |
| `files` | `server.js, public/**/*, electron/**/*, package.json, node_modules/**/*, data.json` | 打包包含的文件 |
| `win.target` | `portable` | Windows 便携版（单 exe） |
| `win.icon` | `build/icon.ico` | 应用图标 |
| `portable.artifactName` | `Bug清单.exe` | 产物文件名 |
| `asar` | `true` | 使用 ASAR 归档 |

---

## 数据模型

```json
{
  "bugs": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "name": "登录页面样式错乱",
      "status": "待修复",
      "image": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_screenshot.png"
    }
  ],
  "version": 42
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string (UUID v4)` | 唯一标识，由 `crypto.randomUUID()` 生成 |
| `name` | `string` | Bug 名称（可为空字符串，支持双击编辑） |
| `status` | `"待修复" \| "修复中" \| "已完成"` | 三种状态之一，默认 "待修复" |
| `image` | `string \| null` | 上传图片的文件名（格式 `{uuid}_{原文件名}`），无图片时为 null |
| `version` | `number` | 数据版本号，每次写入递增，用于客户端追踪数据变更 |

**排序顺序**: 修复中(0) → 待修复(1) → 已完成(2)，同状态保持原始插入顺序。

---

## WebSocket 协议

### 消息类型

| 方向 | type | 说明 | 数据结构 |
|------|------|------|----------|
| 客户端 → 服务端 | `update` | 更新 Bug 字段 | `{ type, clientId, data: { bugId, field, value } }` |
| 客户端 → 服务端 | `add` | 新增 Bug | `{ type, clientId, data: { bugId, bug } }` |
| 客户端 → 服务端 | `delete` | 删除 Bug | `{ type, clientId, data: { bugId } }` |
| 客户端 → 服务端 | `requestSync` | 请求全量同步 | `{ type, clientId }` |
| 服务端 → 客户端 | `fullSync` | 全量数据下发 | `{ type: "fullSync", data: { bugs, version }, version }` |
| 服务端 → 客户端 | `broadcast` | 广播其他客户端变更 | `{ type: "broadcast", originClientId, change: { type, bugId, field?, value?, bug? }, version }` |
| 服务端 → 客户端 | `clientCount` | 在线客户端数 | `{ type: "clientCount", count }` |

### 连接生命周期

```
客户端连接 → 服务端发送 fullSync + clientCount → 广播 clientCount 给所有客户端
客户端发送消息 → 服务端 updateData → broadcast 给所有其他客户端
客户端断开 → 广播 clientCount 给所有客户端
```

### 广播过滤规则

- `broadcast` 消息中 `originClientId` 匹配的消息会被客户端忽略（避免自身变更回显）
- 服务端广播时遍历所有 `readyState === 1`（OPEN）的连接

---

## HTTP API

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| `GET` | `/` | 首页 | 返回 `public/index.html` |
| `GET` | `/vendor/*` | 第三方库 | 映射至 `node_modules/`，如 `/vendor/vue/dist/vue.global.prod.js` |
| `GET` | `/uploads/:filename` | 图片访问 | 静态文件服务，路径穿越防护 |
| `POST` | `/api/upload` | 图片上传 | multipart/form-data，返回 `{ success: true, filename }` |
| `DELETE` | `/api/upload/:filename` | 图片删除 | 双重路径穿越防护，返回 `{ success: true }` |
| `OPTIONS` | `/api/*` | CORS 预检 | 返回 204，CORS 头 |
| `GET` | `/*` | 其他静态文件 | `public/` 目录下的静态资源，路径穿越防护 |

---

## 安全措施

| 措施 | 实现位置 | 说明 |
|------|----------|------|
| 路径穿越防护（文件名） | `server.js` L286-291 `isSafeFilename()` | 检查 `..`、`/`、`\`、空字符串、长度 > 255 |
| 路径穿越防护（目录） | `server.js` L492-497, L423-428 | `path.resolve` + `path.normalize` + `startsWith` 双重校验（public 目录和 uploads 目录分别校验） |
| MIME 白名单 | `server.js` L262-269 | 允许 png / jpeg / gif / webp / bmp / svg+xml。优先使用客户端声明的 `declaredMime`，若为空则 fallback 到文件头魔数检测结果 `magicMime`；SVG 为文本格式无固定魔数，跳过魔数校验；兜底逻辑要求 `declaredMime` 和 `magicMime` 至少有一个在白名单中才放行 |
| 魔数校验 | `server.js` L272-283 | 读文件头字节与已知魔数对比（PNG: 89504E47, JPEG: FFD8FF, GIF: 47494638, WebP: 52494646, BMP: 424D） |
| WebSocket originClientId 过滤 | `app.js` L301-302 | 客户端忽略自己发出的广播消息 |
| Vendor 路由隔离 | `server.js` L479-489 | 独立路径前缀 `/vendor/` 映射至 `node_modules/`，与 public 静态资源使用相同的 `path.resolve` + `startsWith` 模式进行路径隔离，仅基准目录不同（`node_modules` vs `public`） |
| Electron contextIsolation | `electron/main.js` L110 | 渲染进程与主进程隔离，通过 preload.js 暴露最小化 API |

---

## 运行方式

```bash
# 开发模式 — 纯 Web 服务（端口 3050）
npm start

# 开发模式 — 文件变更自动重启
npm run dev

# Electron 桌面应用（内嵌 WebSocket 服务）
npm run electron

# 打包 Windows 便携 exe
npm run build
```

**启动后的访问地址**:

- 本机: `http://localhost:3050`
- 局域网其他设备: `http://{服务器IP}:3050`（控制台会打印所有可用 IP）

**端口自适应**: 3050 被占用时自动尝试 3051, 3052, ..., 直到 3070。所有端口均不可用时抛出异常退出。

---

## 验收清单

| 编号 | 检查项 | 状态 |
|------|--------|------|
| 1 | 地址记忆: 刷新/重启后恢复上次输入的服务器地址 | [ ] |
| 2 | 连接失败提示: 保存的地址连不上时，状态指示器变红 + 显示中文提示，不静默重连 | [ ] |
| 3 | 连接恢复: 用户手动修改地址重连成功后，指示器恢复绿色 + "已连接" | [ ] |
| 4 | 防抖: 5 秒内重复 onclose 不产生新提示，手动重连时重置 | [ ] |
| 5 | 单实例: 双击 exe 两次只有 1 个窗口 + 1 个托盘图标 | [ ] |
| 6 | 图片点击上传: 点击缩略图区域打开文件选择器，上传后缩略图显示、广播同步、点击弹大图 | [ ] |
| 7 | 图片拖拽上传: 拖拽图片到缩略图区域，拖入时边框高亮，松手后上传 | [ ] |
| 8 | 图片 Ctrl+V 粘贴: 编辑模式下 Ctrl+V 粘贴剪贴板图片自动关联到当前 Bug；非编辑模式下提示先双击编辑 | [ ] |
| 9 | 图片无大小限制: 大图可正常上传，不做压缩 | [ ] |
| 10 | 图片删除清理: 删除 Bug 时同步删除服务端图片文件 | [ ] |
| 11 | 颜色: 三种状态显示为彩色标签，点击可切换 | [ ] |
| 12 | 排序: 修复中(最高) > 待修复(中) > 已完成(最低) | [ ] |
| 13 | 筛选: 按钮组切换过滤，显示各状态数量，过渡动效 | [ ] |
| 14 | `npm start` 一键启动，监听 `0.0.0.0:3050` | [ ] |
| 15 | 局域网多设备浏览器同时访问 | [ ] |
| 16 | 任意客户端修改实时同步（< 500ms） | [ ] |
| 17 | 不会循环刷新 | [ ] |
| 18 | 断线重连后数据恢复 | [ ] |
| 19 | data.json 持久化正常 | [ ] |
| 20 | 全中文界面，CSS 动效流畅 | [ ] |
| 21 | 双击 exe 直接运行（打包后） | [ ] |
| 22 | 关闭窗口最小化到托盘（非退出） | [ ] |
| 23 | 双击托盘恢复窗口 | [ ] |
| 24 | 托盘右键菜单：显示/置顶/退出 | [ ] |
| 25 | 单 exe 可复制到其他 Windows 电脑运行 | [ ] |

---

## 注意事项

| 类别 | 要点 | 说明 |
|------|------|------|
| **HTML5 解析器** | 自定义元素必须显式闭合 | `<el-input></el-input>` 不能写成 `<el-input />`，后者会导致后续模板解析错误 |
| **Vue 3** | scoped slot 变量不能 v-model | 必须使用 `:model-value` + `@update:model-value` 替代 `v-model` |
| **端口范围** | 3050-3070 | 生产环境中 `plan.md` 原定 3000-3020 已更新为 3050-3070 |
| **单实例锁** | 打包后生效 | `requestSingleInstanceLock()` 在开发环境 `electron .` 两次不会触发第二个实例的 `app.quit()`，仅在打包后生效。需打包后验证 |
| **Windows 路径** | startsWith 大小写 | `path.join(UPLOADS_DIR, filename).startsWith(UPLOADS_DIR)` 在 Windows 上大小写不敏感，但字符串 `startsWith` 是大小写敏感的。已通过 `path.normalize` + `path.resolve` 统一格式规避 |
| **SVG 魔数校验** | SVG 跳过二进制校验 | SVG 是文本格式无固定魔数，`detectMagicMime` 返回 null 时跳过魔数校验，仅依赖 MIME 白名单 |
| **WebSocket onclose 防抖** | 5 秒窗口 | 避免浏览器在短时间触发多次 onclose 导致 UI 闪烁 |
| **图片文件清理** | 远程删除同步清理 | 当其他客户端删除 Bug 时，本地也会 DELETE 对应图片文件，防止文件残留 |
| **大图片内存** | 无压缩无大小限制 | 适用于局域网场景（图片通常 < 50MB），缩略图通过 CSS object-fit 缩放，原图按需加载 |
