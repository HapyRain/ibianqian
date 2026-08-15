# Agent B -- T1.3 前端 UI 开发报告

## 完成时间
2026-07-02

## 交付清单

| 文件 | 路径 | 大小 | 状态 |
|------|------|------|------|
| index.html | `public/index.html` | ~4KB | 已完成 |
| app.js | `public/app.js` | ~6KB | 已完成 |
| style.css | `public/style.css` | ~4KB (~280行) | 已完成 |

## 详细说明

### 1. index.html

- 单 HTML 文件，CDN 引入 Vue 3 (global prod)、Element Plus CSS/JS、Element Plus 中文语言包
- `<meta charset="UTF-8">`，viewport 自适应
- 页面标题：Bug 清单 - 多人协同
- 根容器 `<div id="app">`
- 完整的模板结构：头部标题栏、工具栏（新增按钮 + 记录数）、Bug 表格（名称列、状态列、操作列）、底部信息栏（版本号、客户端 ID）
- 使用 Element Plus 组件：`el-table`, `el-table-column`, `el-input`, `el-select`, `el-option`, `el-button`, `el-popconfirm`
- 空状态模板：暂无 Bug 时显示引导提示
- 名称列支持双击编辑（`dblclick` 进入，`blur`/`enter` 保存，`escape` 取消）

### 2. app.js -- Vue 3 应用核心逻辑

#### 数据结构
完全按计划文档定义：
- `bugs`: `ref([])` -- 响应式 Bug 列表
- `clientId`: `crypto.randomUUID()` -- 本客户端唯一 ID
- `ws`: WebSocket 实例
- `isLocalChange`: 本地变更标记
- `reconnectTimer` / `reconnectAttempts`: 重连状态
- `connectionStatus`: `ref('connecting')`
- `statusOptions`: `['待修复', '修复中', '已完成']`
- `editingBugId`: 跟踪正在编辑名称的 Bug ID

#### WebSocket 连接
- 自动连接 `ws://${location.host}`
- 连接成功发送 `requestSync`
- 连接状态驱动 UI 连接指示器

#### 断线重连 -- 指数退避 + 随机抖动
```javascript
const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000) + Math.random() * 1000;
```
- 最大延迟 30 秒 + 1 秒随机抖动
- 防止惊群效应

#### 消息处理 -- 三层循环刷新防护
1. **服务端广播层**：`originClientId === clientId` 直接忽略
2. **本地标记层**：`isLocalChange` 标记双保险
3. **值比较层**：`bug[field] === value` 时跳过更新

消息类型处理：
- `fullSync`：全量替换 `bugs` 数组并更新 `dataVersion`
- `broadcast`：按 `change.type` 分发到 `handleRemoteAdd` / `handleRemoteUpdate` / `handleRemoteDelete`
- `clientCount`：更新在线客户端计数

#### Bug 操作
- `addBug()`：本地先 push，再发 WS，然后自动进入编辑模式
- `deleteBug()`：本地先 splice，再发 WS，使用 `el-popconfirm` 确认
- `onStatusChange(bug, newStatus)`：设置 `isLocalChange=true`，更新状态，发送 WS
- `startEditName(bug)` / `finishEditName(bug)` / `cancelEditName(bug)`：名称编辑流程，含光标聚焦和选中文本

#### 生命周期
- `onMounted`：启动 WebSocket 连接
- `onUnmounted`：清理定时器和 WebSocket（设置 `onclose=null` 避免触发重连）

#### Element Plus 安装
```javascript
app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
```
全中文界面（分页、确认框、下拉框等文字均为中文）。

### 3. style.css -- 手写 CSS（~280 行）

#### 设计系统
- CSS 变量定义柔和配色方案（背景 `#f5f7fa`、文字 `#303133`/`#909399`、状态三色 `#e6a23c`/`#409eff`/`#67c23a`）
- 圆角 `8px`，过渡 `0.25s cubic-bezier(0.4, 0, 0.2, 1)`

#### 布局
- 居中容器 `max-width: 900px`，padding `24px 20px 40px`
- 头部标题栏 flex 布局，左右分布
- 底部信息栏居中，版本号 + 客户端 ID

#### 连接状态指示器
- 圆点 + 文字组合
- 连接中：橙色 + pulse 动画
- 已连接：绿色 + 发光效果（`box-shadow: 0 0 6px rgba(103, 194, 58, 0.5)`）
- 断开：红色

#### 表格行 hover 动效
```css
transform: scale(1.01);
box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
```
- 轻微放大 + 阴影增强，带平滑过渡
- hover 时背景微变

#### 状态下拉颜色
- 下拉选项带彩色圆点标记（`status-tag-dot`）
- 预留行内标签样式（`status-label-inline`，三态不同背景色）

#### 按钮动效
- hover：`scale(1.05)`
- active：`scale(0.95)`
- 文本按钮 hover 带背景色变化

#### 编辑态输入框
- 聚焦时蓝色边框 + 外发光 `box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2)`

#### 响应式
- `768px` 断点：头部纵向排列，调整间距
- `480px` 断点：隐藏部分次要元素，字体缩小

#### 滚动条美化
- Webkit 和 Firefox 均覆盖
- 6px 宽度，半透明滑块，hover 加深

#### 动画关键帧
- `fadeIn`：淡入 + 上移（应用于容器）
- `slideUp`：上滑进入（应用于表格）
- `pulse`：缩放闪烁（应用于连接中状态指示器）

#### 打印样式
- 隐藏工具栏、底部栏、固定列
- 移除阴影

## 验收标准对照

| 标准 | 状态 |
|------|------|
| CDN 引入 Vue 3 + Element Plus + 中文语言包 | 通过 |
| 两列表格：Bug 名称可编辑，状态下拉三选项 | 通过 |
| 操作列：删除按钮（含确认弹窗） | 通过 |
| 连接状态指示器（绿/黄/红圆点 + pulse 动画） | 通过 |
| 断线重连（指数退避 + 随机抖动） | 通过 |
| 三层循环刷新防护（originClientId + isLocalChange + 值比较） | 通过 |
| 表格行 hover 动效（scale + shadow） | 通过 |
| 按钮 hover/active 动效 | 通过 |
| 全中文界面 | 通过 |
| 响应式适配 | 通过 |
| 滚动条美化 | 通过 |
| ~200-300 行手写 CSS | 通过（~280行） |

## 备注

1. 前端依赖服务端实现 `fullSync`、`broadcast`、`requestSync`、`add`、`update`、`delete` 消息类型处理，以及 WebSocket 在 `/` 路径监听。
2. status-label-inline 样式已定义但当前使用 el-select 内联编辑，该样式保留供后续切换显示模式使用。
3. 客户端 ID 使用 `crypto.randomUUID()`，需要 HTTPS 或 localhost 环境（所有现代浏览器在 localhost 下均支持）。
4. 无外部构建依赖，浏览器直接加载即可运行。
