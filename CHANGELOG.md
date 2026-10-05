# 更新日志

本项目所有值得注意的变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增
- **GitHub Actions CI**：push / PR 到 `main` 时在 ubuntu + windows × Node 18.x/20.x 矩阵跑 `npm ci` + `npm test`，另有 Windows 打包冒烟 job 跑 `npm run build`；所有 job `timeout-minutes: 30`。
- **窗口状态持久化**：记住上次的窗口位置/大小/最大化/置顶（存 `userData/window-state.json`，启动时校验在屏内，无效回退 900×600 居中）。
- **server.js 安全与稳定加固（一批）**：WS 畸形帧守卫（null/数组/非 JSON/未知 type 直接忽略不崩进程）；上传/删除/静态服务/导入缺图统计统一过 `resolveUploadPath`（isSafeFilename + resolve 前缀双保险，拒绝 `..\..\` 穿越读写删任意文件）；uploads 响应加 CSP sandbox + nosniff 防存储型 XSS；**data.json 损坏只读保护**（自动备份 `.corrupted.*` 后拒绝一切写入，绝不以空数据覆盖真实数据）；**跨进程实例锁** `data.lock`（防双开互相覆盖 data.json）；写盘 tmp → fsync → rename（rename 被占用 50ms 重试一次）；WS 心跳清理半开连接；requestSync 同连接 500ms 限速；删除类操作先确认目标存在再打快照（防垃圾快照挤占轮转）；消息字段校验（id 必须非空字符串、name/content 长度上限、status 白名单、备注按 schema 白名单入库）；删除任务/条目时备注引用的图片随宿主清理（不留孤儿文件）；移除 CORS 通配头（同源部署，收紧跨站读取面）。
- **前端 UI 迭代**：启动对话框两步式（先选模式再填名字/地址，可返回重选）；搜索框内联化（筛选栏右侧胶囊式，主题自适应）；浏览器端 clientId 按标签页隔离（sessionStorage，旧共享 id 仅由第一个升级的标签页一次性继承）；requestSync 在途去重；删除/归档动画期间定格项目 id 并二次复核（防切项目/全量同步竞态发错目标）；拖放多图批量上传；IME 组合输入中的 Enter 不再误提交备注；断线 5 秒防抖只抑制提示、不再吞掉重连排定。

### 修复
- **客户端备份路径穿越**：`write-backup` 的目录名（来自渲染进程的服务器地址）清洗后仍可含 `..` / 路径分隔符，现拒绝非法输入；备份根目录从硬编码 `D:\Bug清单\pc` 改为 `userData/backups/pc`（**旧目录中的历史备份不自动迁移，请手动搬移**）。
- **7za 代理构建链**：postinstall（`build/setup-7za-proxy.js`）补上真实的编译步骤——用 Windows 自带 .NET Framework csc 现场编译 `build/7za-wrapper.cs`（此前全新 clone 上代理 exe 缺失且无人编译，改名备份后原 7za.exe 直接丢失）；csc 不可用或编译失败时自动还原原版 `7za.exe` 并跳过代理，保证 electron-builder 仍可打包。
- Electron 壳：内嵌服务器尊重 `BUGLIST_PORT` 环境变量（此前写死 3050）；端口 3050–3070 全忙等启动失败时弹错误对话框（打包 exe 无控制台，静默退出用户只见闪退）；渲染进程崩溃自动重载（避免白屏挂死）。
- server.js：`handleRequestSync` 形参错位（`(ws, _wss)` 实绑到 msg）导致 requestSync 后伴随的 `clientCount` 从未发出；历史数据 version 存成字符串时 `||` 拼接而非递增；导入/导出路由 `startsWith` 前缀误命中（如 `/api/exportxxx`）；畸形百分号编码请求（`GET /uploads/%`）未捕获 URIError 可崩进程。

### 变更
- 集成测试从 6 套件 133 项断言扩到 **12 套件 260 项断言**：新增崩溃加固 / deleteTask / requestSync 全量同步 / 导出导入 / completedAt 时间锚点 / WS 协议一致性静态契约六个套件，`test/helpers.js` 增加 `waitFor` 轮询等待（替代固定大 sleep，降低 CI flake）。
- 打包输出目录统一为 `dist/`（原 `pack814/`）；便携产物名改为 `bianqian-${version}-win-${arch}.exe`，随 `package.json` 版本号同步；从分发产物中移除遗留的根目录 `data.json`。
- 仓库结构调整：测试脚本归入 `test/`（共用工具抽到 `test/helpers.js`），`image/` 按用途拆分（产品截图 → `assets/screenshots/`，图标源图 → `build/icon-src.png`）。
- `package-lock.json` 元数据同步（version 1.0.0 → 0.3.0 + license/engines，依赖树零漂移），`npm ci` 的校验口径与 `package.json` 一致。
- 移除本地自签代码证书（非商签、无公信任锚，价值不及泄露面）。
- 仓库清理：移除 `reports/` 一次性开发报告目录、`build/7za-proxy.exe`（postinstall 重生成），并从跟踪中剔除 `data.json`；`.dsh/`（Agent 本地配置）补回 `.gitignore`。

## [0.3.0] - 2026-09-03

### 新增
- **归档体系**：已完成任务禁止删除、只能归档——删除按钮换成归档、面板底部扑克牌堆、展开只读、原地恢复；服务端白名单 + 状态机 + `test-archive-guards.js` 覆盖。
- 新建项目本地先行两步式（临时项不广播、确认才落库）。
- 删除项目二次确认对话框。
- 吸顶区让位自绘标题栏（`--titlebar-h` 单一事实源）+ 吸顶投影。

### 变更
- 小火箭改条件显隐（滚动过阈值才浮现、回顶/近底即隐、发射后自动收起）。
- 768px 断点全流体化：`header-right` 靠右紧凑、按钮文字平滑收起、离散断点覆盖改 `clamp`。
- 最小窗口 600×530，启动弹窗 `clamp` 流体适配。

## [0.2.1] - 2026-08-16

### 新增
- **负责人（assignee）**：新增任务自动归属，hover 浮出个人色小标签（随主题派生 `deriveNotePalette`），只读。
- **deadline**：新增「下一步」面板，选时间双落库（结构化字段 + 自动备注），「此刻」改工时评估。
- **深夜彩蛋**：正向推进状态且处于 20:00–05:00 时弹安慰语录。

## [0.2.0] - 2026-08-15

### 新增
- 13 套成品主题（6 浅 7 深），全元素联动换肤 + 主题专属质感 + 暗色幕布过渡。
- 应用图标实装（fufu.png → 多尺寸 ICO / favicon）。

### 变更
- 状态图标改圆环体系（静默常态、变化瞬间一次反馈）。
- 图片与查看器重构（＋左侧入口、自适应牌堆宽度、黑屏等图、uploads 长缓存）。

## [0.1.0] - 2026-07

### 新增
- 多项目 / 双层备注 / 身份 / 拖拽排序 / 导出导入 / 离线补发。
- 数据备份与快照、端口自动探测、启动模式选择。

### 安全
- 上传与持久化加固（MIME 白名单 + 魔数校验 + TOCTOU 防护 + 原子写入 + 队列锁）。
