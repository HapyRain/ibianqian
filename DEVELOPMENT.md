# 任务清单 · 开发文档

> 面向继续开发维护的人。作品集向的 README（品牌 / 亮点 / 快速开始）见仓库根 [README.md](README.md)。
> `docs/` 为本地维护文档（验收清单 / 归档 / 规格 / 迭代建议），**不入库**（需求方约定）；本文档引用它们时均为本地路径。

---

## ⚡ 30 秒速览（TL;DR）

| 项 | 内容 |
|---|---|
| 是什么 | 局域网多人协同：多项目、多任务、多状态、截图上传、双层备注、实时同步 |
| 技术栈 | Node.js + ws + Vue3 + Element Plus（/vendor/ 本地化）+ Electron |
| 怎么跑 | `npm start` → 浏览器开 `http://局域网IP:3050`（3050–3070 自动探测；`BUGLIST_PORT` 可覆盖起始端口） |
| 数据在哪 | **`D:\Bug清单\{用户名}\data.json`**（不在项目目录！根目录 `data.json` 是旧种子文件；`BUGLIST_DATA_ROOT` 可覆盖） |
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
| `server.js` | ~1770 行 | HTTP + WS 服务端、文件锁、持久化、图片上传 API、导出/导入、备份/快照、端口探测（`BUGLIST_PORT` 可覆盖起始端口） | `startServer()`、`handleMessage()` |
| `public/index.html` | ~640 行 | Vue3 单页模板：启动模式对话框、项目标签栏、任务列表卡片（搜索条+筛选+排序）、新增任务"下一步"面板（deadline/备注）、备注/粘贴/预览弹窗、小火箭 | 启动对话框、任务列表卡片 |
| `public/app.js` | ~3600 行 | Vue3 应用逻辑：WS 客户端、身份、多图、备注、备份、搜索、排序、状态动效、手动 FLIP/飞出动画、负责人 hover、deadline 面板 + 工时评估、深夜彩蛋 | `connectWebSocket()`、`handleMessage()` |
| `public/style.css` | ~2180 行 | 手写样式（CSS 变量 + 响应式 + 动效） | — |
| `public/themes.js` | ~510 行 | **13 套成品主题（6 浅 7 深）** + 主题 CSS 生成器（`buildThemeCss`：17 色变量 + rgb/color-mix 派生 + `deriveNotePalette` 主题和谐色板 + Element Plus 联动 + 主题专属装饰） | `BUGLIST_THEMES` / `buildThemeCss` |
| `public/tuner.html` | — | **主题展厅 / 在线调色台**（开发辅助，`/tuner.html`）：iframe 完整预览 13 套主题（含星云/纸纹/代码雨等专属元素）+ 17 色色板详情 + 高级微调 + 复制导出主题对象 | — |
| `build/icon.ico` | 164KB | **应用图标 7 档**（256/128/64/48/32/24/16，用户设计图 fufu.png 转制），electron-builder 打包用 | — |
| `public/favicon.ico` | 9.6KB | 浏览器标签页图标（48/32/16） | — |
| `image/fufu.png` | — | 应用图标源图（用户设计，730×742，供衍生） | — |
| `electron/main.js` | ~260 行 | 托盘（应用图标）、单实例锁、窗口管理（窗口图标）、IPC（get-local-ip / write-backup） | `app.whenReady` |
| `electron/preload.js` | 9 行 | contextBridge 暴露 `electronAPI` | — |
| `electron-builder.yml` | 19 行 | portable 打包配置，默认输出 `pack814/`；打 `pack/` 用 CLI 覆盖 `--config.directories.output=pack` | — |
| `build/` | — | 7za 代理（C# 源码 + exe + postinstall 脚本）、icon.ico | 坑 1 的固化修复 |
| `D:\Bug清单\{用户名}\` | — | **运行时数据目录**：`data.json` + `uploads/`（图片） | — |
| `test-*.js` 共 5 个测试 | — | 集成测试（多图生命周期 / 备注权限 / 备注图片 / 校验防护 / 模板自闭合防线），临时数据目录隔离 | `npm test` |
| `docs/smoke-checklist-2026-08-15.md` | — | **打包前手工验收清单**（A~L 共 12 组：布局/状态排序/负责人/deadline/深夜彩蛋/搜索/多图/删除/备注/数据安全/回顶/回归底线）；**本地文档，不入库**（见 .gitignore） | 打包前逐项打勾 |
| `reports/` | — | 各轮开发/修复/UX 需求报告（见知识索引） | — |
| `pack/` | — | 当前打包输出：`任务清单.exe`（便携单文件）+ `win-unpacked/`（文件夹版） | — |
| `docs/` | — | 本地文档目录（验收清单/归档/规格/迭代建议）：**本地维护，不入库**（需求方约定）；README 中所有 `docs/` 引用均指本地文件 | — |

---

## ✨ 功能清单

| 功能 | 说明 | 实现位置 |
|---|---|---|
| 多项目管理 | 项目标签栏：新建 / 重命名 / 切换 / 删除（至少保留 1 个，删项目连带清理其下所有图片；重命名重名时提示不拦截） | app.js `createTask/switchTask/deleteTask`；server.js `handleCreateTask` 等 |
| 任务 CRUD | 列表条目（任务）：双击名称内联编辑、状态下拉、删除（长按蓄怒确认） | app.js `addBug/startEditName/deleteBug` |
| 新增任务"下一步"面板（deadline / 备注） | 回车确认标题后引出小面板询问「设置 deadline / 添加备注」（勾选即展开对应输入，跳过/确定收场）：**deadline 选时间后双落库**——① `bug.deadline` 结构化时间戳字段（update 广播，未来逾期/排序可用）② 自动代发一条备注「该任务启用 deadline：YYYY-MM-DD HH:mm」（借备注按钮标识传播，不常驻首页）；**「此刻」= 工时评估**（deadline 不可能=现在）：点此刻弹「请评估所需工时 🌙」选 1-5 天 → 自动算当前时间+N 天填好（内置此刻按钮已隐藏，改用自定义入口）；备注勾选则直接发一条备注；面板/浮层/展开/收场动画统一 0.25s 同缓动 | app.js `openNextStep/confirmNextStep/pushBugNote/openHoursPicker`；server.js `handleUpdate`（deadline 白名单） |
| 三态状态 | 待修复 / 修复中 / 已完成，彩色胶囊 + **圆环体系图标**（待修复=空心圆环、修复中=缺口弧+端点、已完成=圆环+对勾，抽象非实物有设计感）；**静默常态**（图标不动，避免多行重复动画噪音），**状态变化瞬间播一次**（圆环落定/弧转半圈/对勾描边）后归于安静；筛选按钮组带计数 | app.js `onStatusChange/filteredAndSortedBugs`；style.css 状态胶囊 |
| 深夜彩蛋 | **状态正向推进**（待修复→修复中 / 修复中→已完成）且当前时间在 **20:00-次日 05:00** 之间时，右上角弹一句安慰/励志语录（emoji 开头，随机 6 条；复用 ElMessage 小提示样式，无系统图标，4.5s 自动消失、主题联动、不打断操作；只在本端操作时触发，广播回来不重复弹） | app.js `maybeLateNightCheer` |
| 组内排序 | 筛选栏末尾排序开关：**倒序**（新任务在最前，默认）/ 正序（新任务在最后），切换时行平滑滑位，偏好存本机（`buglist_sort_desc`） | app.js `sortDesc/toggleSort`；排序依据 `bug.statusChangedAt` |
| 状态变更动画 | 全部视图：行滑到目标组内位置（手动 FLIP，视口内匀速 + 出屏弹射）；筛选视图：行飞向目标 tag 缩小被吸收，目标计数闪烁 | app.js `flipRowsWithRects` / `flyRowToTag` / `flashStatus` |
| 多图截图 | 点击 / 拖拽 / Ctrl+V 粘贴 / 整行拖放，支持多选与多张追加，**单条上限 6 张**（前端拦截，非服务端硬约束），单张删除，预览翻页；**图片区**：牌堆左侧「＋」按钮（无数量徽标——缩略图本就看不全），牌堆宽度随图片数自适应（右缘对齐最后一张卡片）；**uploads 图片长缓存**（文件名唯一不可变 → `Cache-Control: immutable` 一年，二次打开秒开）；**查看器黑屏等图**：打开/翻页先纯黑，图片下载完成（预加载 onload）后一次性放出完整图，杜绝"缩略图放大版→清晰"的闪烁 | app.js `handleImageUpload/deleteImage/openPreview`；server.js `serveStaticFile` |
| 备注图片 | 项目级/任务级备注可附图（两步式提交），作者可删图，删备注自动清理图片 | app.js `addNoteWithImage/attachNoteImage/updateNoteImage` |
| 项目拖拽排序 | 标签拖动重排，偏好存本机 localStorage（`buglist_task_order`），不影响他人；**切换项目时面板方向感知滑入**（新项目在有序列表右侧→从右滑入，左侧→从左滑入，0.3s 一次性动画，播完静止） | app.js `orderedTasks/onTaskDrop/onTaskDropToEnd`、`switchTask` |
| 用户身份 | 稳定 clientId（Electron 用 MAC 哈希、浏览器持久化 uuid）+ 显示名，备注显示作者名 | app.js 身份模块；electron `get-mac-id` |
| 负责人（assignee） | **新增任务自动归属**：谁新建的就是谁的（`{ clientId, name }` 随任务数据同步广播）；**hover 浮出**——平时行上零显示（不"公示"，小团队收敛），悬停行时名称上方淡入小标签（边框/淡底 = 当前主题派生和谐色板 `deriveNotePalette(primary)`，随主题联动、颜色即人，与备注作者色点同源）；名字未填时显示「我」/ clientId 前 8 位（兜底同备注）；**只读不可改**（转交留待后续）；存量任务无 assignee 不显示；导入/导出 JSON 归一化保留 | app.js `addBug` / `assigneeLabel` / `getNoteColor`；themes.js `deriveNotePalette`；server.js `handleAdd` / `normalizeBugForImport` |
| 主题切换 | **13 套成品主题（6 浅 7 深）点选即换肤**：暖纸面（默认）/冷灰纸面/豆沙绿/晨雾淡紫/羊皮纸/樱粉晨雾 + One Dark/GitHub Dark/暖棕夜灯/星空蓝/蔷薇暮色/赛博朋克/黑客帝国；**全元素联动**（按钮/状态胶囊/删除蓄怒动画/Element Plus 组件随主题换色，无割裂）；主题带专属质感（星空蓝星云+流星、羊皮纸/冷灰纸面/豆沙绿纸纹、赛博朋克网格+霓虹、黑客帝国代码雨）；**切换带暗色幕布过渡**（纯暗色幕布淡入 → 换肤 → 淡出，全程 ≈1s 有始有终）；**菜单文字统一颜色**（主题名留白，点进去才揭晓配色，保留探知欲）；选择存本机 localStorage（`buglist_theme`），不参与服务端同步 | themes.js（`BUGLIST_THEMES` + `buildThemeCss`） |
| 应用图标 | 用户设计图（`image/fufu.png`，730×742）本地转多尺寸：`build/icon.ico` 7 档（256/128/64/48/32/24/16，electron-builder 打包用）+ `public/favicon.ico` 3 档（浏览器标签页）；**Electron 托盘与窗口图标也使用 favicon.ico**（原托盘为内存生成色块）；非方形已适配为正方形（LANCZOS） | `build/icon.ico`、`public/favicon.ico`、`electron/main.js` |
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

**数据 schema**：`{ version, tasks: [{ id, name, bugs: [{ id, name, status, statusChangedAt, images[], completedAt?, assignee?, deadline?, notes[] }], notes[] }] }`
（`tasks[]` = 界面上的「项目」，`bugs[]` = 界面上的「任务」，见[术语映射](#术语映射界面--代码--数据)；
`bug.statusChangedAt` = 状态变更时间（组内排序依据）；`bug.assignee` = 负责人 `{ clientId, name|null }`（新增即归属，随广播同步）；
`bug.deadline` = 截止时间戳（毫秒，新增时经"下一步"面板设置，结构化字段 + 备注双重呈现；update 白名单可设可清 null）；
`note.createdAt/updatedAt` = 创建/修改时间（"已修改"判断）；
旧 `bug.image` 字段自动迁移为 `images` 数组，迁移前自动留 `data.json.backup-*` 备份）

**WS 消息类型**：`update / add / delete`（任务）、`removeImage`（删除单张图）、`createTask / updateTask / deleteTask`（项目）、`addNote / updateNote / deleteNote`（项目备注，备注可含 image 字段）、`addBugNote / updateBugNote / deleteBugNote`（任务备注）、`requestSync → fullSync`、`clientCount`。

**关键机制**：
- 端口自适应：`EADDRINUSE` 时 +1，最大 3070（`startServer`；`BUGLIST_PORT` 可覆盖起始端口）。
- 无变化不写盘不涨版本号（`transformFn` 返回 null 时跳过）。
- 状态置"已完成"自动记录 `completedAt`，改回则删除。
- 图片上传由服务端直接写 data.json 并广播，不依赖客户端 WS；bug 不存在时自动创建。

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
| 展开对象带脏字段 | `handleAdd` 用 `{ ...bug }` 展开入库——非法字段（如 assignee 传了字符串）会被**原样带进 data.json**，只做"不写入"等于没拦截 | 字段归一化必须显式处理：合法则写入规范值，否则 `delete normalizedBug.xxx`（assignee/deadline 归一化范式） |
| spawn 残留进程占端口 | 开发验证脚本 spawn 服务后若异常退出，子进程可能残留并占住端口（3050），后续验证连到旧进程得出假结果 | 验证脚本 try/finally 保证 kill；异常后用 `netstat -ano | findstr ":305"` 查 PID 清理 |

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
1. server.js 597 行 → 现 ~1770 行；前端三件套行数全部翻倍。
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
| 08-15 | 前端体验改版：总分卡片布局、搜索 + 组内排序（正序/倒序）、状态胶囊动效（呼吸/扳手螺栓/电池充电）、牌堆 6 张、查看器删除、删除动画重写、备注查看/编辑 + 删除确认 + 已修改标记、小火箭回顶、数据备份 + 导出/导入 + 离线补发、术语「项目/任务」；测试 28/25/51/12 + 模板防线全绿 |
| 08-15 | **主题实装**：13 套成品主题（6 浅 7 深）——10 位子 Agent 并行设计 + 程序化验收（对比度/纯白纯黑/字段合法性）后合入；全元素联动换肤（按钮/状态胶囊/删除蓄怒动画/Element Plus），星空蓝含星云闪烁+毛玻璃新玩法；调色台升级为主题展厅（/tuner.html） |
| 08-15 | 主题增量：星空蓝星星优化（减少变大变柔、闪烁收窄、语法保守化）+ 流星；冷灰纸面加纸纹；新增 樱粉晨雾/蔷薇暮色（唯美粉）/赛博朋克（网格+霓虹） |
| 08-15 | 主题调整：删除 墨玉绿；新增 黑客帝国（三列代码雨 + 淡网格 + 霓虹绿 glow） |
| 08-15 | 主题切换动效（暗色幕布 + 面板渐隐关闭）、状态图标圆环体系（静默/变化瞬间反馈）、图片区简化（＋左侧 + 自适应宽度）、查看器黑屏等图 + uploads 长缓存、项目切换方向滑入、备注弹窗防御修复、**应用图标实装**（fufu.png → 多尺寸 ICO）、主题菜单文字统一颜色——**主题/图标定稿** |
| 08-16 | **负责人（assignee）**：新增任务自动归属（clientId + 名字快照，随广播同步）、**hover 浮出**（平时行上零显示，悬停淡入个人色小标签——小团队收敛，不"公之于众"）、只读不可改；服务端 handleAdd 归一化（非法值显式删除）+ 导入导出保留；**个人色板随主题派生**（deriveNotePalette：primary 色相旋转 6 色，饱和度压 ≤70% 防荧光，备注作者色点同源联动）；9 项端到端验证全过（add 广播/旧客户端兼容/脏数据防御/fullSync/导出/导入） |
| 08-16 | **deadline（0.3 前置）**：回车确认标题后引出「下一步」小面板（deadline / 备注询问，跳过/确定；动画统一 0.25s）；deadline 选时间**双落库**——结构化字段 `bug.deadline`（update 白名单新增，可设可清 null）+ 自动代发备注「该任务启用 deadline：…」（借备注标识传播，不常驻首页不压人）；服务端归一化（非法值删除）+ 导入导出保留；8 项端到端验证全过；server.js 新增 `BUGLIST_PORT` 环境变量（自动化验证用独立端口） |
| 08-16 | **深夜彩蛋**：状态正向推进 + 20:00-05:00 弹安慰语录（6 条 emoji 文案定稿，ElMessage 小提示无图标，4.5s 自动消失）——0.3 前的收尾彩蛋 |
| 08-16 | deadline 交互迭代：「此刻」按钮改为**工时评估**（deadline 不可能=现在；弹「请评估所需工时 🌙」选 1-5 天 → 自动算当前时间+N 天填好；内置此刻按钮隐藏）；**0.2.1 定稿**（0.3 前置小点先行发布）：负责人 hover 归属 + deadline 工时评估 + 深夜彩蛋 + 主题和谐色板 |

> 旧产物目录（dist/release/pack10-14）与 pack.zip 已于 2026-07-18 清理删除；`pack15/`、`pack814/` 为历史产物，当前输出 `pack/`。
