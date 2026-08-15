# 任务清单 — 多人协同任务/Bug 管理工具

> 局域网多人实时协同的任务/Bug 清单工具。纯 Web 版（Node.js）与 Windows 便携 exe（Electron）双形态。
> 代码最后更新：**2026-08-15** ｜ 最新产物：`pack/任务清单.exe`（便携单文件，总分卡片 + 搜索/排序 + 状态动效 + 牌堆多图 + 数据备份/导出导入）

---

## ⚡ 30 秒速览（TL;DR）

| 项 | 内容 |
|---|---|
| 是什么 | 局域网多人协同：多项目、多任务、多状态、截图上传、双层备注、实时同步 |
| 技术栈 | Node.js + ws + Vue3 + Element Plus（/vendor/ 本地化）+ Electron |
| 怎么跑 | `npm start` → 浏览器开 `http://局域网IP:3050`（3050–3070 自动探测） |
| 数据在哪 | **`D:\Bug清单\{用户名}\data.json`**（不在项目目录！根目录 `data.json` 是旧种子文件） |
| 桌面版 | `npm run electron` 调试；`npm run build` 打包 → `pack/任务清单.exe` |
| 分发 | 直接把 `pack/任务清单.exe` 发给同事，双击即用（win-unpacked/ 为免安装文件夹版） |

**三条最关键的事实：**
1. **同步模型**：任何修改 → WebSocket 广播 → 全员实时一致。三层防循环：`originClientId` 过滤 → `isLocalChange` 标记 → 新旧值比对。
2. **持久化**：`data.json` 原子写入（tmp + rename）+ Promise 队列锁；数据目录默认 `D:\Bug清单\{用户名}`（环境变量 `BUGLIST_DATA_ROOT` 可覆盖）。
3. **文档滞后于代码**：`docs/archive/HANDOFF.md`、`docs/archive/project-summary.md`（均为 7/7 旧版，已归档）都已过时——多项目、备注、备份、启动模式选择、更名"任务清单"等均未入档。**以本文 + 代码为准**（过时点见文末）。

---

## 🧭 术语映射（界面 ↔ 代码 ↔ 数据）

> 界面在 2026-08 起采用「项目 / 任务」两层叫法，代码与数据结构仍沿用早期命名 `task / bug`，二者一一对应。

| 界面叫法 | 含义 | 代码 / 数据字段 |
|---|---|---|
| **项目** | 顶部标签栏的层级（新建项目 / 删除项目） | `task`（server.js `data.tasks[]`） |
| **任务** | 列表中的条目（新增任务 / 删除该任务） | `bug`（`task.bugs[]`） |
| 项目备注 | 标签栏（项目）上的备注 | `task.notes[]` |
| 任务备注 | 列表条目（任务）上的备注 | `bug.notes[]` |

- 例：`handleCreateTask` = 新建项目；`addBug` = 新增任务；`deleteBug` = 删除该任务。
- 界面文案与代码函数名保持此映射，改需求时对照本表即可。

---

## 🔍 检索钩子（想查什么 → 去哪看）

| 你想找… | 位置 |
|---|---|
| 启动 / 打包 / 分发命令 | [快速启动](#快速启动) |
| 某功能在哪个文件哪段代码 | [目录地图](#目录地图) + [功能清单](#功能清单) |
| 同步协议 / 消息类型 / 数据格式 | [架构与数据流](#架构与数据流) |
| 遇到过的坑（7za / asar / ENOTDIR…） | [避坑索引](#避坑索引) |
| 某轮需求或 Bug 修复的来龙去脉 | [知识索引 reports/](#知识索引-reports) |
| 历史产物 / 版本演进 | [产物与时间线](#产物与时间线) |

---

## 🚀 快速启动

```bash
npm install          # postinstall 会自动装 7za 代理（build/setup-7za-proxy.js）
npm start            # 纯 Web：起服务，打印局域网访问地址
npm run dev          # node --watch 热重载
npm run electron     # Electron 壳（内嵌服务器，托盘常驻）
npm run build        # electron-builder 打便携 exe → pack/任务清单.exe
```

- 打包若卡在二进制下载，先设国内镜像：`ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`（详见 `docs/archive/HANDOFF.md` 第三节）。
- 首次启动会弹**模式选择**：服务器（本机存数据）或客户端（填主机 IP:端口 连接）。
- 关闭窗口 = 最小化到托盘（不退出）；托盘右键可置顶 / 退出；单实例运行。

---

## 🗂 目录地图

| 文件 | 规模 | 职责 | 关键入口 |
|---|---|---|---|
| `server.js` | ~1740 行 | HTTP + WS 服务端、文件锁、持久化、图片上传 API、导出/导入、备份/快照、端口探测 | `startServer()`、`handleMessage()` |
| `public/index.html` | ~610 行 | Vue3 单页模板：启动模式对话框、项目标签栏、任务列表卡片（搜索条+筛选+排序）、备注/粘贴/预览弹窗、小火箭 | 启动对话框、任务列表卡片 |
| `public/app.js` | ~3300 行 | Vue3 应用逻辑：WS 客户端、身份、多图、备注、备份、搜索、排序、状态动效、手动 FLIP/飞出动画 | `connectWebSocket()`、`handleMessage()` |
| `public/style.css` | ~2040 行 | 手写样式（CSS 变量 + 响应式 + 动效） | — |
| `public/themes.js` | ~90 行 | 主题 CSS 生成器（`buildThemeCss`）；主题列表暂空（配色方案待定，实装后在此定义） | `buildThemeCss` |
| `public/tuner.html` | — | 在线调色台（开发辅助，`/tuner.html`）：iframe 实时预览 + 主题点选（列表暂空待配色）/ 高级微调 / 复制导出 | — |
| `electron/main.js` | ~250 行 | 托盘、单实例锁、窗口管理、IPC（get-local-ip / write-backup） | `app.whenReady`（213 行） |
| `electron/preload.js` | 9 行 | contextBridge 暴露 `electronAPI` | — |
| `electron-builder.yml` | 19 行 | portable 打包配置，默认输出 `pack814/`；打 `pack/` 用 CLI 覆盖 `--config.directories.output=pack` | — |
| `build/` | — | 7za 代理（C# 源码 + exe + postinstall 脚本）、icon.ico | 坑 1 的固化修复 |
| `D:\Bug清单\{用户名}\` | — | **运行时数据目录**：`data.json` + `uploads/`（图片） | — |
| `test-*.js` 共 5 个测试 | — | 集成测试（多图生命周期 / 备注权限 / 备注图片 / 校验防护 / 模板自闭合防线），临时数据目录隔离 | `npm test` |
| `docs/smoke-checklist-2026-08-15.md` | — | **打包前手工验收清单**（A~I 共 9 组：布局/状态排序/搜索/多图/删除/备注/数据安全/回顶/回归底线） | 打包前逐项打勾 |
| `reports/` | — | 各轮开发/修复/UX 需求报告（见知识索引） | — |
| `pack/` | — | 当前打包输出：`任务清单.exe`（便携单文件）+ `win-unpacked/`（文件夹版） | — |
| `docs/archive/` | — | 已归档的过时文档（HANDOFF、project-summary） | — |

---

## ✨ 功能清单

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 多项目管理 | 项目标签栏：新建 / 重命名 / 切换 / 删除（至少保留 1 个，删项目连带清理其下所有图片；重命名重名时提示不拦截） | app.js `createTask/switchTask/deleteTask`；server.js `handleCreateTask` 等 |
| 任务 CRUD | 列表条目（任务）：双击名称内联编辑、状态下拉、删除（长按蓄怒确认） | app.js `addBug/startEditName/deleteBug` |
| 三态状态 | 待修复 / 修复中 / 已完成，彩色胶囊 + 专属动效（呼吸点 / 扳手拧螺栓 / 电池充电），筛选按钮组带计数 | app.js `onStatusChange/filteredAndSortedBugs`；style.css 状态胶囊 |
| 组内排序 | 筛选栏末尾排序开关：**倒序**（新任务在最前，默认）/ 正序（新任务在最后），切换时行平滑滑位，偏好存本机（`buglist_sort_desc`） | app.js `sortDesc/toggleSort`；排序依据 `bug.statusChangedAt` |
| 状态变更动画 | 全部视图：行滑到目标组内位置（手动 FLIP，视口内匀速 + 出屏弹射）；筛选视图：行飞向目标 tag 缩小被吸收，目标计数闪烁 | app.js `flipRowsWithRects` / `flyRowToTag` / `flashStatus` |
| 多图截图 | 点击 / 拖拽 / Ctrl+V 粘贴 / 整行拖放，支持多选与多张追加，**单条上限 6 张**（前端拦截，非服务端硬约束），单张删除，预览翻页 | app.js `handleImageUpload/deleteImage/openPreview` |
| 备注图片 | 项目级/任务级备注可附图（两步式提交），作者可删图，删备注自动清理图片 | app.js `addNoteWithImage/attachNoteImage/updateNoteImage` |
| 项目拖拽排序 | 标签拖动重排，偏好存本机 localStorage（`buglist_task_order`），不影响他人 | app.js `orderedTasks/onTaskDrop/onTaskDropToEnd` |
| 用户身份 | 稳定 clientId（Electron 用 MAC 哈希、浏览器持久化 uuid）+ 显示名，备注显示作者名 | app.js 身份模块；electron `get-mac-id` |
| 主题切换 | 功能保留（头部调色盘按钮 + 面板），**配色方案待定**——菜单暂不提供选择，讨论定稿后实装；选择存本机 localStorage（`buglist_theme`），不参与服务端同步 | themes.js（`buildThemeCss` 已就绪，主题列表暂空） |
| 服务端数据备份 | 每次写盘节流轮转备份到 `backups/data-*.json`（保留 20 份）；删除类操作前自动快照 `pre-delete-*.json`（保留 5 份） | server.js `backupDataFile` / `snapshotBeforeDelete` |
| 导出 / 导入 | 头部 ⋮ 菜单：导出 JSON 备份（浏览器下载）；导入 JSON 覆盖（服务端写盘 + 全量广播），引用缺失的图片会提示 | server.js `handleExportData` / `handleImportData`；app.js `exportData` / `onImportFileSelect` |
| 离线补发 | 断线期间的操作暂存本地队列（上限 50 条），重连后先补发再全量同步 | app.js `pendingQueue` |
| 搜索过滤 | 工具栏按任务名称实时过滤（纯前端，与状态筛选叠加） | app.js `searchText` / `filteredAndSortedBugs` |
| 体验改版 | 总分卡片布局（工具栏+列表一体）、暖调纸面多主题、连接三态呼吸点、SVG 图标体系、扑克牌堆多图查看器（抽卡/精准展开/缩回）、删除全链路（蓄怒+保险+覆盖删除）、新增/上传/备注按钮四态、项目栏多行+落点高亮、备注多图、响应式四栏 | Task 1-9（见 docs/specs/ 与 docs/plans/） |
| 双层备注 | 项目级备注 + 任务级备注，按 clientId 着色区分作者；**默认只读，点「修改」展开编辑**（含上传图片），删除需二次确认，修改后时间刷新 + 「（已修改）」标记 | app.js `openNotesDialog/openBugNotesDialog`、`editingTaskNoteId` 等 |
| 小火箭回顶 | 右下角常驻火箭按钮：hover 点火预热，点击发射动画 + 平滑回顶 | app.js `launchRocket`；style.css `.rocket-btn` |
| 实时同步 | fullSync（连接时全量）+ broadcast（增量），在线人数 | server.js `handleRequestSync/broadcast` |
| 断线重连 | 指数退避 + 随机抖动（`min(1000·2ⁿ, 30s)+rand`） | app.js `scheduleReconnect` |
| 服务器地址记忆 | localStorage 记忆 + 连接失败提示 | app.js `onServerChange` |
| 客户端本地备份 | Electron 客户端每 30s + 连接/断开时，把数据备份到 `D:\Bug清单\pc\{IP}\data.json` | app.js `startBackupTimer`；main.js `write-backup` |
| 启动模式选择 | 服务器 / 客户端两种启动入口 | index.html 19–58 行 |

---

## 🔧 架构与数据流

```
客户端(浏览器/Electron) ──WS──▶ server.js(0.0.0.0:3050~3070) ──▶ D:\Bug清单\{用户}\data.json
        ▲                          │  Promise 队列锁 + 原子写入(tmp→rename)
        └────────── broadcast ◀────┘  originClientId + version
图片：POST/DELETE /api/upload ── multipart 手写解析 + MIME 白名单 + 魔数校验（100MB 上限）
依赖：/vendor/* 路由映射到 node_modules/（离线化）
```

**数据 schema**：`{ version, tasks: [{ id, name, bugs: [{ id, name, status, statusChangedAt, images[], completedAt?, notes[] }], notes[] }] }`
（`tasks[]` = 界面上的「项目」，`bugs[]` = 界面上的「任务」，见[术语映射](#-术语映射界面--代码--数据)；
`bug.statusChangedAt` = 状态变更时间（组内排序依据）；`note.createdAt/updatedAt` = 创建/修改时间（"已修改"判断）；
旧 `bug.image` 字段自动迁移为 `images` 数组，迁移前自动留 `data.json.backup-*` 备份）

**WS 消息类型**：`update / add / delete`（任务）、`removeImage`（删除单张图）、`createTask / updateTask / deleteTask`（项目）、`addNote / updateNote / deleteNote`（项目备注，备注可含 image 字段）、`addBugNote / updateBugNote / deleteBugNote`（任务备注）、`requestSync → fullSync`、`clientCount`。

**关键机制**：
- 端口自适应：`EADDRINUSE` 时 +1，最大 3070（`startServer` 1062 行）。
- 无变化不写盘不涨版本号（`transformFn` 返回 null 时跳过，server.js 168 行）。
- 状态置"已完成"自动记录 `completedAt`，改回则删除（server.js 259–269 行）。
- 图片上传由服务端直接写 data.json 并广播，不依赖客户端 WS（server.js 823–878 行）；bug 不存在时自动创建。

---

## ⚠️ 避坑索引

| 关键词 | 坑 | 详情 |
|---|---|---|
| 7za / winCodeSign / 软链接 | electron-builder 下载/解压失败 → C# 代理 exe 固化修复 | `docs/archive/HANDOFF.md` 坑 1 |
| ENOTDIR / asar 只读 | 打包后写 asar 内部失败 → 数据放 exe 同级 | `docs/archive/HANDOFF.md` 坑 2（代码已再演进，见下） |
| 便携版数据丢失 | 7z 自解压到 %TEMP% → 曾用 PORTABLE_EXECUTABLE_FILE 定位 | `docs/archive/HANDOFF.md` 坑 3（**代码已移除该方案**，现统一 `D:\Bug清单\{用户名}`） |
| 空白页 #39 | Vue 3.5 生产版 el-select 插槽硬错误 → 改 CSS 上色 | `docs/archive/HANDOFF.md` 坑 4 |
| Device or resource busy | 杀毒软件锁 exe → 换输出目录 | `docs/archive/HANDOFF.md` 坑 5 |
| 自闭合自定义元素 | Vue HTML 模板 `<el-input />` 会解析失败 → 必须闭合标签 | `docs/archive/HANDOFF.md` 坑 6 |
| MIME 绕过 / 大小失控 / 数据损坏 / TOCTOU | 上传与持久化安全修复 | `docs/archive/HANDOFF.md` 第五节表格 |
| 双 rAF 瞬移 | CSS 过渡若靠"双 requestAnimationFrame"起跳，两帧可能同帧执行 → 浏览器没记到起始状态 → 过渡不触发 = 瞬移 | 动效一律用「强制回流 FLIP」：钉回旧位置 → `void document.body.offsetHeight` → 再上过渡 |
| absolute 无 top 跳顶 | absolute 不设 `top` 时，静态位置会跳到 flex 容器顶部 → 飞行/移动起点错（行先瞬移到顶再飞） | 用 `position:fixed` + 显式 `left/top`（真实视口坐标）钉住再动 |
| transform 不改 paint 顺序 | `transform` 移动不改变绘制层级，长距离移动的行会按 DOM 顺序被其他行遮挡 | 动画期间给"位移最大的主角行"临时高 z-index（999）+ 投影，结束后复位 |
| position:sticky 载入偏移 | 页面容器带入场动画（translateY）+ sticky 吸顶层叠加，首载会先错位再弹回 | 入场动画只用纯 opacity 或去掉；吸顶层若引入布局抖动，直接移除 |

---

## 📚 知识索引（reports/）

| 文档 | 内容 | 新鲜度 |
|---|---|---|
| `docs/archive/project-summary.md` | 旧版详细代码汇总（架构图/区块行号） | ⚠️ 已归档（7/7 旧版，功能过时，架构可参考） |
| `reports/ux-improvement-plan.md` | UX 改进方案（5 需求 + 并行策略 + 验收） | ⚠️ 需求均已实现 |
| `reports/req1~req5-*.md` | 地址记忆 / 单实例 / 图片上传 / 状态颜色 / 筛选排序 各轮报告 | ✅ 已实现 |
| `reports/fix-*.md`、`agent-*-report.md`、`integration-test-report.md` | 各轮 Bug 修复与集成测试记录 | ✅ 历史记录 |
| `docs/archive/HANDOFF.md` | 交接文档（打包命令、六大坑、产物） | ⚠️ 已归档（7/7 旧版，**打包/数据目录/功能过时**，见下） |
| `docs/archive/plan.md` | 立项计划（架构图、任务分解、验收清单） | ⚠️ 已归档（7/2 旧版，端口 3000 系、阶段划分过时） |

> 📦 **归档位置**：`docs/archive/` —— 该目录下的文档一律视为过时，仅供查历史。

**HANDOFF.md 已知过时点**（原文件已归档至 `docs/archive/`）：
1. server.js 597 行 → 现 ~1100 行；前端三件套行数全部翻倍。
2. 数据目录：原"exe 旁边" → 现 `D:\Bug清单\{用户名}`（`PORTABLE_EXECUTABLE_FILE` 逻辑已删除，仅剩注释）。
3. 产品名 Bug清单 → **任务清单**；产物目录 `pack15/` 而非 `release/`。
4. 无多项目 / 备注 / 本地备份 / 启动模式选择等新功能描述。

---

## 📦 产物与时间线

| 日期 | 产物/事件 |
|---|---|
| 07-02 | `plan.md` 立项（现归档于 `docs/archive/`；Web 版 + Electron 两阶段） |
| 07-07 | 阶段一/二完成，HANDOFF 交接（现归档于 `docs/archive/`）；`dist/`（Bug清单 1.0.0.exe，已删） |
| 07-14 | 多任务（tasks）+ 双层备注等大改版；`release/`、`pack10/`（Bug清单.exe，均已删） |
| 07-18 | 启动模式选择 + 客户端本地备份；更名 **任务清单**；`pack14/`（更名后首版，已删）、`pack15/`（保留） |
| 08-14 | 多图/备注图片/身份/拖拽排序等 6 项改版；`pack814/`（新版产物） |
| 08-15 | 前端体验改版：总分卡片布局、搜索 + 组内排序（正序/倒序）、状态胶囊动效（呼吸/扳手螺栓/电池充电）、牌堆 6 张、查看器删除、删除动画重写、备注查看/编辑 + 删除确认 + 已修改标记、小火箭回顶、数据备份 + 导出/导入 + 离线补发、术语「项目/任务」；主题配色待定；测试 28/25/51/12 + 模板防线全绿 |

> 旧产物目录（dist/release/pack10-14）与 pack.zip 已于 2026-07-18 清理删除；`pack15/`、`pack814/` 为历史产物，当前输出 `pack/`。
