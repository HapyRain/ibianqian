# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

「任务清单」——局域网多人协同清单工具（Node.js + ws + Vue 3 + Element Plus + Electron），无账号、无云、无构建步骤。权威开发文档是 **[DEVELOPMENT.md](DEVELOPMENT.md)**（术语映射 / 目录地图 / 功能清单 / 架构与数据流 / 避坑索引 / 时间线），本文件只提炼最关键的事实，细节请查它。

## 常用命令

```bash
npm start                  # 纯 Web 启动（打印局域网地址，3050–3070 自动探测）
npm run dev                # node --watch 热重载
npm run electron           # Electron 壳调试（内嵌同一个 server.js，托盘常驻）
npm run build              # electron-builder 打便携 exe → dist/任务清单.exe
npm test                   # 依次跑 6 个集成测试
node test/test-validation-guards.js   # 跑单个测试（test/test-*.js 都是独立 node 脚本）
```

没有 lint / formatter / 单元测试框架；测试是手写集成脚本（起真实 server + ws 客户端断言）。打包卡二进制下载时设 `ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`。

## 架构大图

**没有构建步骤**：前端是原生三件套（`public/index.html` + `app.js` + `style.css` + `themes.js`），Vue 3 与 Element Plus 通过 `/vendor/*` 路由直接映射到 `node_modules/`（离线本地化）。改 `public/` 下文件刷新即生效，无需任何编译。

- **`server.js`（~1820 行，单文件）**：HTTP + WebSocket 服务端合一，无框架、无数据库。入口 `startServer()`（底部直接执行；也 `module.exports` 供 Electron 与测试 require）。所有消息进 `handleMessage()` 分发。图片上传是手写 multipart 解析 + MIME 白名单 + 魔数校验。
- **`public/app.js`（~4000 行）**：Vue 3 应用逻辑（WS 客户端、身份、多图、备注、动画）。
- **`public/themes.js`**：13 套主题 + `buildThemeCss` 生成器（17 色变量 → 派生色 + Element Plus 联动）。
- **`electron/main.js`**：托盘、单实例锁、IPC；通过 `require('../server')` 内嵌同一个服务端。

**数据落点**：`D:\Bug清单\{用户名}\data.json` + `uploads/`（**不在项目目录**；根目录 `data.json` 是旧种子文件）。环境变量 `BUGLIST_DATA_ROOT` 可覆盖——测试全部靠它指向临时目录隔离。⚠️ server.js 在 **require 时**就计算 `DATA_ROOT`，所以测试必须在 `require('./server')` **之前**设 `BUGLIST_DATA_ROOT`。

## 术语映射（改需求必看）

界面 2026-08 起叫「项目 / 任务」，代码与数据沿用早期命名，一一对应：

| 界面 | 代码/数据字段 |
|---|---|
| 项目（顶部标签） | `task`（`data.tasks[]`），如 `handleCreateTask` = 新建项目 |
| 任务（列表条目） | `bug`（`task.bugs[]`），如 `addBug` = 新增任务 |

## 关键机制

- **同步模型**：任何修改 → 服务端写盘 → WS 广播 → 全员一致。三层防循环：`originClientId` 过滤 → `isLocalChange` 标记 → 新旧值比对。WS 消息类型见 DEVELOPMENT.md「架构与数据流」。
- **持久化**：Promise 队列锁 + 原子写入（tmp → rename）；`transformFn` 返回 null 则不写盘不涨版本号。
- **端口探测**：`EADDRINUSE` 自动 +1，上限 3070；起始端口可被 `BUGLIST_PORT` 覆盖（自动化验证用）。
- **字段归一化**：`handleAdd` / 导入用 `{ ...bug }` 展开入库——非法字段会被原样带进 data.json，新增字段必须**显式归一化**（合法写入规范值，非法则 `delete normalizedBug.xxx`），参照 `assignee` / `deadline` 的既有范式。
- **验证脚本**：spawn 服务后必须 try/finally kill 子进程，否则残留进程占住 3050 端口，后续验证连到旧进程得出假结果。

## 易踩的坑（完整版见 DEVELOPMENT.md「避坑索引」）

- **自闭合自定义元素**：Vue HTML 模板里 `<el-input />` 解析失败，必须写成闭合标签。
- **动效**：禁用「双 requestAnimationFrame」起跳（可能同帧执行 → 瞬移）；一律用强制回流 FLIP（钉回旧位置 → `void document.body.offsetHeight` → 再上过渡）；absolute 飞行用 `position:fixed` + 显式视口坐标。
- **文档滞后**：`docs/` 目录本地维护不入库，`docs/archive/` 下一律视为过时；以 DEVELOPMENT.md + 代码为准。
