# AGENTS.md

「任务清单」——局域网多人协同清单工具。单文件 Node 服务端 + 原生前端，**没有构建步骤**。深度文档以 `DEVELOPMENT.md` 为权威；本文件只记容易踩错、且光看文件名猜不到的事实。

## 命令

```bash
npm start              # 起服务（端口 3050–3070 自动探测；BUGLIST_PORT 覆盖起始端口）
npm run dev            # node --watch 热重载
npm test               # 14 个集成套件 && 串联顺序跑，任一失败即中断（非 0 退出）
node test/test-xxx.js  # 单跑一个套件（每个 test/test-*.js 都是独立 node 脚本）
npm run electron       # Electron 壳调试（内嵌同一个 server.js）
npm run build          # 打便携 exe → dist/bianqian-<版本>-win-x64.exe
```

- **没有 lint / formatter / typecheck**（仓库无任何对应配置）——别去找，也别发明。
- 改 `public/` 下文件刷新浏览器即生效；Vue 3 / Element Plus 经 `/vendor/*` 直接映射 `node_modules/`（离线本地化），无需编译。
- 改了 WS 消息类型要两端同步：`test/test-protocol-consistency.js` 静态校验 server.js ↔ app.js 发送/广播/处理双向一致，漏一端会挂。
- `test/test-ai-gateway.js` 与 `test/test-ai-intake.js` 覆盖 AI 网关与需求介入；改 `ai-gateway.js`、`/api/ai/*` 或 `bug.aiTrace` 后必跑。
- 打包卡在二进制下载时设 `ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`。

## 术语映射（读代码前必看）

界面叫法 ≠ 代码命名，一一对应：

| 界面 | 代码/数据字段 |
|---|---|
| 项目（顶部标签栏） | `task`（`data.tasks[]`） |
| 任务（列表条目） | `bug`（`task.bugs[]`） |

例：`handleCreateTask` = 新建项目，`addBug` = 新增任务，`deleteBug` = 删除任务。

## 数据与测试隔离

- 运行时数据在 **`D:\Bug清单\{用户名}\data.json` + `uploads/`**（不在项目目录；根目录 `data.json` 是旧种子文件）。`BUGLIST_DATA_ROOT` 可覆盖。
- `DATA_ROOT` 在 **require server.js 时**即计算——设 `BUGLIST_DATA_ROOT` 必须在 require 之前。测试同理：**先 `require('./helpers')`（其副作用设置 env），后 `require('../server')`，顺序不能反**（见 `test/helpers.js` 头部注释）。
- 测试套件全部用临时 `BUGLIST_DATA_ROOT` 隔离，不碰真实数据。
- 手写验证脚本 spawn 服务后必须 `try/finally` kill 子进程：残留进程占住 3050 端口会让后续验证连到旧进程、得出假结果（排查：`netstat -ano | findstr ":305"`）。

## 写路径与同步（改 server.js / app.js 前必知）

- 同步防循环三层：`originClientId` 过滤 → `isLocalChange` 标记 → 新旧值比对。任何修改 → 服务端写盘 → WS 广播全员。
- `handleAdd` 用 `{ ...bug }` 展开入库：**新增字段必须显式归一化**（合法写规范值，非法 `delete normalizedBug.xxx`），只加白名单不处理等于没拦截（参照 `assignee` / `deadline` 的既有范式）。
- 无变化不写盘不涨版本号（`transformFn` 返回 null 跳过）。

## 前端约定（与默认习惯不同）

- Vue HTML 模板里**自定义元素不能自闭合**：`<el-input />` 解析失败，必须写成 `<el-input></el-input>`（`test/test-template-guard.js` 是防线）。
- 动效**禁用「双 requestAnimationFrame」起跳**（可能同帧执行 → 瞬移）：一律用强制回流 FLIP——钉回旧位置 → `void document.body.offsetHeight` → 再上过渡。absolute 飞行用 `position:fixed` + 显式视口坐标。

## 文档效力

- `DEVELOPMENT.md` 是权威开发文档；`CHANGELOG.md` 记版本级变更。
- `docs/` 目录本地维护**不入库**（克隆后看不到属正常）；`docs/archive/` 下的文档一律视为**过时**——以 DEVELOPMENT.md + 代码为准。

## CI

push / PR 到 `main` → ubuntu + windows × Node 18/20 跑 `npm ci` + `npm test`（设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`）；另有 Windows 打包冒烟 job 跑 `npm run build`。本地改动后至少跑 `npm test` 再提交。
