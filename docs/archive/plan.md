> ⚠️ 归档文档（2026-07-18 归档）：内容已过时，仅供历史参考，勿按此操作。
> 当前权威入口：项目根 README.md（其「知识索引」章节列有本文档的过时点说明）。

# 多人协同 Bug 清单工具 -- 完整实施计划

## 项目概述

一款支持局域网多人实时协同的 Bug 清单管理工具。阶段一为纯 Web 版（Node.js + Vue3），阶段二为 Electron 桌面应用。核心体验：两列表格（Bug 名称 + 状态下拉），任意用户修改即通过 WebSocket 广播给所有局域网客户端同步更新。

---

## 一、总体架构设计

### 1.1 系统架构图

```
┌──────────────────────────────────────────────────────┐
│                    LAN (局域网)                       │
│                                                      │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐         │
│  │ 客户端 A  │   │ 客户端 B  │   │ 客户端 C  │         │
│  │ (浏览器)  │   │ (浏览器)  │   │ (浏览器)  │         │
│  │ Vue3 App │   │ Vue3 App │   │ Vue3 App │         │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘         │
│       │              │              │                │
│       │   WebSocket  │              │                │
│       └──────────────┼──────────────┘                │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  Node.js 服务端 │                      │
│              │  server.js    │                       │
│              │  :3000 (0.0.0.0)│                     │
│              │  ws + HTTP    │                       │
│              └───────┬───────┘                       │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │   data.json   │                       │
│              │  (文件锁保护)   │                       │
│              └───────────────┘                       │
└──────────────────────────────────────────────────────┘
```

### 1.2 数据流

```
用户编辑单元格
    │
    ▼
Vue 响应式数据变更 (标记为本地修改)
    │
    ▼
发送 WebSocket 消息给服务端 { type: "update", bugId, field, value, clientId }
    │
    ▼
服务端接收 → 获取文件锁 → 读取 data.json → 更新数据 → 写回 data.json → 释放锁
    │
    ▼
服务端广播给所有客户端 (包含 originClientId)
    │
    ▼
各客户端接收 → 检查 originClientId !== 自己的 → 只更新远程变更 → 避免循环刷新
```

---

## 二、文件结构

```
D:\Project\ibianqian\
├── server.js                 # 【阶段一核心】单文件 Node.js 服务端
├── package.json              # 项目配置与依赖
├── data.json                 # 持久化数据（运行时自动生成）
├── plan.md                   # 本计划文档
│
├── public/                   # 前端静态资源（服务端直接 serve）
│   ├── index.html            # 单页 HTML 入口
│   ├── app.js                # Vue 3 应用逻辑 + WebSocket 客户端
│   └── style.css             # 手写 CSS（全中文界面）
│
├── electron/                 # 【阶段二】Electron 桌面壳
│   ├── main.js               # Electron 主进程（内嵌 WebSocket 服务）
│   └── preload.js            # 预加载脚本
│
├── build/                    # 构建资源
│   └── icon.ico              # 应用图标
│
└── electron-builder.yml      # Electron 打包配置
```

---

## 三、阶段一：Web 版详细设计

### 3.1 server.js -- 服务端（单文件）

内部按职责分为以下逻辑区块：

1. **配置与常量区**
   - 端口起始值 `INITIAL_PORT = 3000`，最大尝试 `MAX_PORT = 3020`
   - 绑定地址 `BIND_ADDR = '0.0.0.0'`
   - 数据文件路径、锁文件路径

2. **文件锁模块**
   - 基于 Promise 队列的互斥锁
   - `acquireLock()` / `releaseLock()`
   - 单进程 Node.js 下 Promise 队列锁完全足够

3. **数据持久化模块**
   - `readData()` / `writeData(data)`
   - **原子写入**：先写 `.tmp` 文件，再 `fs.renameSync()` 重命名
   - 默认数据结构：`{ "bugs": [], "version": 0 }`

4. **HTTP 静态文件服务**
   - Node.js 内置 `http` 模块
   - MIME 类型映射，根路径返回 `index.html`

5. **WebSocket 服务**
   - 使用 `ws` 库，共用 `http.Server` 实例
   - 每个连接分配唯一 `clientId`（`crypto.randomUUID()`）
   - 连接时发送全量同步 `{ type: "fullSync" }`
   - 消息处理：`update` / `add` / `delete` / `requestSync`

6. **端口探测启动**
   - `EADDRINUSE` 时端口 +1 重试

### 3.2 消息协议

```typescript
// 客户端 → 服务端
interface ClientMessage {
  type: 'update' | 'add' | 'delete' | 'requestSync';
  clientId: string;
  data?: {
    bugId?: string;
    field?: 'name' | 'status';
    value?: string;
  };
}

// 服务端 → 客户端
interface ServerMessage {
  type: 'fullSync' | 'broadcast';
  originClientId?: string;
  data?: { bugs: Bug[] };
  change?: { type, bugId, field, value };
  version: number;
}
```

### 3.3 前端三件套

- **index.html**：CDN 引入 Vue 3 + Element Plus + 中文语言包
- **app.js**：Vue 3 应用，数据绑定、表格编辑、WebSocket 客户端、重连逻辑
- **style.css**：手写 CSS，约 200-300 行，全中文界面，hover/点击动效

### 3.4 避免循环刷新的三层防护

| 层级 | 机制 | 位置 |
|------|------|------|
| 第一层 | `originClientId` 过滤 | 服务端广播 + 客户端检查 |
| 第二层 | `isLocalChange` 标记 | 客户端操作前后 |
| 第三层 | 新旧值比较 `oldValue === newValue` | 客户端更新前 |

---

## 四、阶段二：Electron 桌面应用设计

### 4.1 关键变化

- 服务端内嵌：Electron 主进程启动时自动启动 WebSocket 服务
- 渲染进程通过 `http://localhost:PORT` 加载页面
- 窗口关闭 → 隐藏到托盘而非退出
- 使用 `electron-builder` portable 目标打包单 exe

### 4.2 核心实现要点

**托盘常驻**：
```javascript
app.isQuitting = false;
mainWindow.on('close', (event) => {
  if (!app.isQuitting) {
    event.preventDefault();
    mainWindow.hide();
  }
});
```

**窗口置顶**：
```javascript
mainWindow.setAlwaysOnTop(true/false);
```

**打包配置**：
```yaml
win:
  target: portable
portable:
  artifactName: Bug清单.exe
```

---

## 五、子任务分解与并行策略

### 5.1 任务总览

```
阶段一：Web 版
├── T1.1 项目初始化与 package.json ────── 0.5h
├── T1.2 server.js 开发 ──────────────── 4h   } Agent A
├── T1.3 前端 UI 开发 ───────────────── 3h   } Agent B (并行)
├── T1.4 WebSocket 客户端与同步逻辑 ──── 2.5h } Agent C
├── T1.5 集成测试与 Bug 修复 ────────── 1.5h } Agent C

阶段二：Electron 桌面应用
├── T2.1 server.js 适配重构 ──────────── 0.5h }
├── T2.2 Electron 主进程开发 ─────────── 2h   }
├── T2.3 系统托盘与窗口管理 ──────────── 1.5h } Agent D
├── T2.4 前端离线化改造 ──────────────── 0.5h }
├── T2.5 打包配置与单 exe 构建 ───────── 1h   }
└── T2.6 Electron 集成测试 ──────────── 0.5h }
```

### 5.2 Agent 分工

| Agent | 任务 | 工作量 | 并行 |
|-------|------|--------|------|
| **Agent A: 服务端** | T1.1 + T1.2 | 4.5h | 可与 B 并行 |
| **Agent B: 前端 UI** | T1.3 | 3h | 可与 A 并行 |
| **Agent C: 客户端集成** | T1.4 + T1.5 | 4h | 依赖 A+B |
| **Agent D: Electron 桌面壳** | T2.1-2.6 | 6h | 依赖阶段一完成 |

---

## 六、关键技术决策与避坑要点

### 6.1 0.0.0.0 绑定
必须绑定 `0.0.0.0`（`INADDR_ANY`），不能是 `127.0.0.1` 或 `localhost`。
```javascript
server.listen(port, '0.0.0.0', callback);
```

### 6.2 文件锁（原子写入）
```javascript
// Promise 队列互斥锁 + 原子重命名
fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
fs.renameSync(tmpFile, DATA_FILE);
```

### 6.3 断线重连（指数退避 + 随机抖动）
```javascript
const delay = Math.min(baseDelay * Math.pow(2, attempts), 30000) + Math.random() * 1000;
```

### 6.4 端口自动适配
`EADDRINUSE` 时自动 +1，直到 `MAX_PORT`。

### 6.5 HTTP + WS 共用端口
```javascript
const server = http.createServer(handler);
const wss = new WebSocketServer({ server }); // 注意是 server 不是 port
```

### 6.6 Electron 打包
- 使用 `electron-builder` 的 `portable` 目标
- 单 exe 文件，预计 80-120MB

---

## 七、验收清单

### 阶段一
- [ ] `npm start` 一键启动，监听 `0.0.0.0:3000`
- [ ] 局域网多设备浏览器同时访问
- [ ] 两列表格，名称可编辑，状态下拉三选项
- [ ] 任意客户端修改实时同步（< 500ms）
- [ ] 不会循环刷新
- [ ] 断线重连后数据恢复
- [ ] data.json 持久化正常
- [ ] 全中文界面，CSS 动效流畅

### 阶段二
- [ ] 双击 exe 直接运行
- [ ] 关闭窗口最小化到托盘（非退出）
- [ ] 双击托盘恢复窗口
- [ ] 托盘右键菜单：显示/置顶/退出
- [ ] 局域网协同功能正常
- [ ] 单 exe 可复制到其他 Windows 电脑运行
