> ⚠️ 归档文档（2026-07-18 归档）：内容已过时，仅供历史参考，勿按此操作。
> 当前权威入口：项目根 README.md（其「知识索引」章节列有本文档的过时点说明）。

# Bug清单 — 项目交接文档

## 一、项目概览

局域网多人协作 Bug 跟踪工具。技术栈：

| 层 | 技术 |
|---|------|
| 后端 | Node.js + ws (WebSocket) |
| 前端 | Vue 3 + Element Plus (CDN) |
| 桌面 | Electron (electron-builder 打包) |
| 同步 | WebSocket 实时广播 (端口 3050-3070) |
| 数据 | data.json (JSON 文件，Promise 队列加锁写入) |
| 上传 | multipart/form-data 手动解析，存 uploads/ 目录 |

**工作流程：** 主机运行 exe（自动启服务端），其他人连主机 IP，所有操作实时广播同步。

## 二、关键文件

```
server.js           — HTTP + WebSocket 服务端（~670 行）
public/index.html   — Vue 3 模板
public/app.js       — Vue 3 应用逻辑（~810 行）
public/style.css    — 样式（~730 行）
electron/main.js    — Electron 主进程（~210 行）
electron-builder.yml— 打包配置
build/7za-proxy.exe — 7za 代理（解压软链接问题修复）
build/setup-7za-proxy.js — postinstall 自动安装代理
build/7za-wrapper.cs — C# 代理源码
```

## 三、打包命令

```bash
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win portable --config electron-builder.yml
```

输出：`release/Bug清单.exe`（75MB 便携单文件）

## 四、踩过的坑与修复

### 坑 1：winCodeSign 下载 / 解压失败

**现象：** electron-builder 打 portable 包时卡在 winCodeSign 下载，或 7z 解压报 `Cannot create symbolic link` 返回 exit code 2。

**根因：**
- GitHub 被墙，下载超时（国内镜像 `npmmirror.com` 可解决）
- winCodeSign 的 7z 压缩包内含 2 个 macOS 软链接（`libcrypto.dylib` / `libssl.dylib`），Windows 无创建软链接权限
- 7za CLI 返回 exit code 2，electron-builder 误判失败，反复重试
- 每次重试生成不同随机缓存 key，无法预填充

**解决：** 编写 C# 代理 exe（4KB），替换 `node_modules/7zip-bin/win/x64/7za.exe`。
- 原始文件重命名为 `7za_real.exe`
- 代理运行真正的 7za，始终返回 exit code 0
- 已固化到 `build/7za-proxy.exe`，`npm install` 后自动应用（postinstall 脚本）

### 坑 2：便携版 ENOTDIR 崩溃

**现象：** 打包后首次运行报 `ENOTDIR, not a directory`，`fs.mkdirSync` 失败。

**根因：** asar 打包后 `__dirname` 指向只读归档，`data.json` 和 `uploads/` 写入 asar 内部会失败。

**解决：** `server.js` 检测 asar 模式，数据文件放到 exe 同目录：
```js
const isPackaged = __dirname.endsWith('.asar') || !__dirname.includes('node_modules');
const DATA_ROOT = process.env.BUGLIST_DATA_ROOT
  || (isPackaged ? path.dirname(process.execPath) : __dirname);
```
同时 `/uploads/` URL 路由单独指向 `DATA_ROOT/uploads/`（asar 外）。

### 坑 3：便携版数据存到临时目录

**现象：** 便携版 exe 运行后，数据存到临时目录而不是 exe 旁边，关闭后数据丢失。

**根因：** electron-builder 便携版是 7z 自解压格式。运行时解压到 `%TEMP%`，`process.execPath` 指向临时目录的 `electron.exe`，不是原始 exe。

**解决：** electron-builder 便携版启动时设置 `PORTABLE_EXECUTABLE_FILE` 环境变量。在 `electron/main.js` 中读取并传给 `server.js`：
```js
const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
if (portableExe) {
  process.env.BUGLIST_DATA_ROOT = path.dirname(portableExe);
}
```

### 坑 4：Vue 3.5 生产版模板编译错误 #39

**现象：** 打包后打开空白页，DevTools 报：
```
vue.global.prod.js:7 Uncaught SyntaxError: https://vuejs.org/error-reference/#compiler-39
```

**根因：** `<el-select>` 中使用 `<template #default>` 自定义触发器（彩色标签），同时 `<el-option>` 作为直接子元素。Vue 3.5 生产版将此视为"多余子元素"，忽略 drop 选项，导致页面崩溃。开发版只是 warning，生产版是 hard error。

**解决：** 移除 `<el-select>` 的 `#default` 插槽，改用在 `el-select` 上动态绑定 CSS class，用 CSS 给触发器上色：
```html
<el-select :class="['status-select', 'status-select-' + getStatusClass(scope.row.status)]">
```
```css
.status-select-status-pending .el-select__wrapper { background-color: var(--color-pending-bg); }
.status-select-status-fixing .el-select__wrapper { background-color: var(--color-fixing-bg); }
.status-select-status-done .el-select__wrapper { background-color: var(--color-done-bg); }
```

### 坑 5：文件锁无法覆盖（杀毒软件）

**现象：** 第二次打包时 `rm -rf dist` 报 `Device or resource busy`，electron-builder 一直等解锁。

**根因：** Windows Defender 在扫描刚生成的 exe，锁定了文件。

**解决：** 换输出目录（`electron-builder.yml` 中 `directories.output: release`），或先杀进程再删。

### 坑 6：Vue scoped slot / 自定义元素语法

**已知注意事项：** Vue 3 HTML 模板中，自定义元素（Element Plus 组件）不能使用自闭合 `<el-input />`，必须写 `></el-input>`。HTML5 parser 会把自闭合的自定义元素当作未闭合标签。

## 五、其他已修复的严重 Bug

| Bug | 描述 | 修复 |
|-----|------|------|
| 图片上传失败 | 先删旧图再上传，上传失败导致 image 指向不存在的文件 | 先上传成功再删旧图 |
| MIME 绕过 | `declaredMime=null` 跳过白名单校验 | `effectiveMime = declaredMime \|\| magicMime` |
| 版本号空涨 | no-op 更新也递增 version | transformFn 返回 null 时跳过 |
| tmp 残留 | rename 失败后 `.data.tmp` 未清理 | write 前后都 try-catch clean |
| 文件无大小限制 | 服务端可被撑爆 | 100MB 上限，超限返回 413 |
| 未处理 rejection | async handler 未 await → Node 15+ 进程崩溃 | handleMessage 改为 async + try-catch |
| 数据损坏丢失 | readData 吞所有错误返回空数据 | 区分 ENOENT vs 损坏，备份到 `data.json.corrupted.{ts}` |
| TOCTOU 竞争 | existsSync→unlinkSync 之间文件可能被删 | 直接 try-catch unlinkSync |

## 六、缓存说明

electron-builder 下载的二进制工具缓存在：
```
%LOCALAPPDATA%\electron-builder\Cache\
├── winCodeSign\winCodeSign-2.6.0\   (5.6MB)
├── nsis\nsis-3.0.4.1\               (1.3MB)
└── nsis\nsis-resources-3.4.1\       (731KB)
```
使用国内镜像 `npmmirror.com` 下载速度很快（<1s），缓存会复用，不用重复下载。

## 七、electron-builder.yml 当前配置

```yaml
appId: com.ibianqian.buglist
productName: Bug清单
directories:
  output: release          # 输出到 release/ 避开 dist/ 被锁
  buildResources: build
files:
  - server.js
  - public/**/*
  - electron/**/*
  - package.json
  - node_modules/**/*
  - data.json
win:
  target: portable
portable:
  artifactName: Bug清单.exe
extraResources: []
asar: true
```

## 八、可用产物

| 路径 | 说明 |
|------|------|
| `release/Bug清单.exe` | 75MB 便携单文件（给同事发这个） |
| `release/win-unpacked/` | 文件夹版（也可直接压缩分发，无便携版数据目录问题） |
| `release/data.json` | 运行数据（随 exe 分发时带上初始数据） |
| `release/uploads/` | 上传的图片（自动创建） |

## 九、使用方式

1. 主机运行 `Bug清单.exe`（自动启服务 + 打开浏览器窗口）
2. 主机查看局域网 IP
3. 同事运行软件，顶部输入框填主机 IP 回车
4. 所有人实时同步
5. 关闭窗口 → 最小化到托盘（不退出），右键托盘可退出
6. 只允许单实例运行
