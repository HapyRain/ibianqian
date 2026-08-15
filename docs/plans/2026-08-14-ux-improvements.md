# 任务清单 UX 改进实施计划（6 项使用反馈）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实用户 6 项使用反馈：启动对话框可退出、任务拖拽排序（本地缓存）、备注图片上传、bug 多图、用户身份（名字+稳定 id），并保持"先改数据、后删文件"与权限模型不变。

**Architecture:** 服务端继续作为数据与图片文件生命周期的唯一所有者；客户端偏好（任务顺序、身份）全部存 localStorage、不进 data.json；备注作者名随备注对象存储（authorName 字段）透传广播，无需服务端注册表。多图改造为破坏性协议变更，与测试同步演进。

**Tech Stack:** Node.js + ws（server.js）、Vue 3 + Element Plus CDN（public/app.js、index.html、style.css）、Electron（electron/main.js、preload.js）、集成测试（test-*.js，进程内 startServer + 临时 BUGLIST_DATA_ROOT）。

**决策点（已按推荐方案锁定，实现前请用户确认）：**
1. 身份 id：Electron 用 MAC 哈希（sha256 前 16 位，不泄露原始 MAC）；纯浏览器回退 localStorage 持久化 uuid。**不用 IP**（会变）。
2. 备注图片：两段式提交（同一次点击内：先传图后建备注 / 或对已有备注直接关联），避免孤儿文件与悬空引用。
3. 旧数据兼容：`bug.image`(string) 自动迁移为 `bug.images`(array)；旧备注无 authorName 时显示短 id 兜底。

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `server.js` | 修改 | 上传端点增加 note 关联分支；新增 removeImage 消息；migrateData 兼容 image→images；删除路径清理多图/备注图；handleUpdate 白名单收敛 |
| `public/app.js` | 修改 | 对话框取消/配置保护、身份加载、任务排序缓存、备注图片流程、多图 UI 逻辑 |
| `public/index.html` | 修改 | 启动对话框关闭按钮+名字输入；任务 tab 拖拽；备注缩略图+图片按钮；bug 多缩略图；预览翻页 |
| `public/style.css` | 修改 | 拖拽态样式、缩略图布局、名字输入样式（少量） |
| `electron/main.js` + `electron/preload.js` | 修改 | IPC `get-mac-id`（哈希后返回） |
| `test-image-lifecycle.js` | 重写 | 适配多图语义（追加/removeImage/删除清理） |
| `test-validation-guards.js` | 修改 | `update image=null` 断言改为"被拒"（白名单收敛后 image 字段废弃） |
| `test-note-image.js` | 新增 | 备注图片生命周期 + 权限 |

---

## Task 0: 基线确认

**Files:** 无改动

- [ ] **Step 1: 跑通现有测试，记录基线**

Run:
```
node test-image-lifecycle.js   # 期望 11 通过 / 0 失败
node test-note-ownership.js    # 期望 12 通过 / 0 失败
node test-validation-guards.js # 期望 25 通过 / 0 失败
```
Expected: 全部 exit 0。任何失败先停下排查（说明工作区已有回归）。

---

## Task 1: 启动模式对话框可退出 + 配置保护

**Files:**
- Modify: `public/app.js`（resetStartupMode、新增 cancelStartup、hasSavedPrefs）
- Modify: `public/index.html:19-58`（对话框右上角关闭按钮）

**背景：** `resetStartupMode()` 当前立即 `localStorage.removeItem('buglist_mode')` 和 `removeItem('buglist_server_host')`（误点即丢配置）；对话框无退出路径，overlay 全屏遮挡。

- [ ] **Step 1: 修改 `public/app.js` 的 resetStartupMode（不再删除任何 localStorage，只弹窗）**

```js
function resetStartupMode() {
  disconnectReason.value = null; // 重置模式后清掉旧的断线原因文案
  // 不再删除 localStorage 中的模式/地址：误点"重新选择启动模式"不应丢配置。
  // 仅在用户确认新模式/新地址时（confirmClientMode / confirmServerMode）才覆盖。
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  showStartupDialog.value = true;
  startupMode.value = null;
  startupAddressInput.value = (function () {
    try { return localStorage.getItem('buglist_server_host') || ''; } catch (e) { return ''; }
  })();
  connectionStatus.value = 'disconnected';
}
```

- [ ] **Step 2: 在 `public/app.js` 中新增取消函数与"是否可关闭"计算**

```js
/** 是否已有保存的模式偏好（首次启动无偏好时不允许关闭对话框，否则无法进入） */
const hasSavedPrefs = computed(() => {
  try { return !!localStorage.getItem('buglist_mode'); } catch (e) { return false; }
});

/** 关闭启动对话框，回到清单页并恢复原有连接 */
function cancelStartup() {
  showStartupDialog.value = false;
  startupMode.value = null;
  startupAddressInput.value = '';
  connectWebSocket(); // serverHost.value 未被改动，自动连回原服务器
}
```

在 setup 末尾的 return 对象中补导出：`hasSavedPrefs, cancelStartup`。

- [ ] **Step 3: `public/index.html` 对话框加右上角关闭按钮**

在 `.startup-dialog` 内、`<h2 class="startup-title">` 之前插入：

```html
<button
  v-if="hasSavedPrefs"
  class="startup-close-btn"
  @click="cancelStartup"
  title="返回清单"
  type="button"
>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
</button>
```

- [ ] **Step 4: `public/style.css` 加关闭按钮样式（绝对定位右上角）**

```css
.startup-dialog { position: relative; }
.startup-close-btn {
  position: absolute; top: 12px; right: 12px;
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: transparent; color: #909399; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.startup-close-btn:hover { background: #f2f3f5; color: #303133; }
.startup-close-btn svg { width: 16px; height: 16px; }
```

- [ ] **Step 5: 验证**

Run: `node --check public/app.js`
Expected: 无输出、exit 0。
手工冒烟（Electron 或浏览器）：进入清单页 → 点头部刷新图标 → 对话框出现且右上角有 × → 点 × → 回到清单页且自动重连成功；再进对话框选"作为客户端"，地址输入框已预填上次保存的地址。

---

## Task 2: 身份系统（稳定 clientId + 显示名 + 备注作者名）

**Files:**
- Modify: `electron/main.js`（IPC get-mac-id）
- Modify: `electron/preload.js`（暴露 getMacId）
- Modify: `public/app.js`（身份加载/生成、clientId 来源、addNote/addBugNote 带 authorName、备注渲染兜底）
- Modify: `public/index.html`（启动对话框名字输入、备注作者显示）

**背景：** 当前 `const clientId = uuid();`（app.js 约 39 行）每次页面加载重新生成 → 刷新后自己的历史备注不再识别为"我"、别人看到的作者 id 每次变。修复：id 持久化（Electron 走 MAC 哈希、浏览器走 localStorage uuid），显示名随备注对象存储。

- [ ] **Step 1: `electron/main.js` 增加 IPC（哈希后返回，不泄露原始 MAC）**

在 `ipcMain.handle('write-backup', ...)` 之后添加（文件顶部需 `const crypto = require('crypto');`）：

```js
// IPC：获取稳定的设备 id（多网卡取排序后首个，sha256 哈希取前 16 位，不泄露原始 MAC）
ipcMain.handle('get-mac-id', () => {
  try {
    const ifs = os.networkInterfaces();
    const macs = [];
    for (const name of Object.keys(ifs)) {
      for (const iface of ifs[name]) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac.toLowerCase());
        }
      }
    }
    if (!macs.length) return null;
    macs.sort();
    return crypto.createHash('sha256').update(macs.join(',')).digest('hex').slice(0, 16);
  } catch (e) {
    return null;
  }
});
```

- [ ] **Step 2: `electron/preload.js` 暴露 API**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  writeBackup: (serverIp, data) => ipcRenderer.invoke('write-backup', { serverIp, data }),
  getMacId: () => ipcRenderer.invoke('get-mac-id'),
});
```

（若现有 preload 已是此结构，只补 `getMacId` 一行。）

- [ ] **Step 3: `public/app.js` 身份模块（替换 `const clientId = uuid();`）**

原 `const clientId = uuid();`（约 39 行）改为：

```js
// ==================== 用户身份（本地持久化，不进服务器数据） ====================
const IDENTITY_KEY = 'buglist_identity';
let identity = null;
try {
  identity = JSON.parse(localStorage.getItem(IDENTITY_KEY));
  if (!identity || !identity.clientId) identity = null;
} catch (e) { identity = null; }
/** 显示名（响应式，供启动对话框输入） */
const displayName = ref(identity?.displayName || '');

/** 确保存在稳定 clientId：Electron 用 MAC 哈希，浏览器回退持久化 uuid */
async function ensureClientId() {
  if (identity && identity.clientId) return identity.clientId;
  let cid = null;
  if (window.electronAPI?.getMacId) {
    try { cid = await window.electronAPI.getMacId(); } catch (e) { cid = null; }
  }
  if (!cid) cid = clientId; // 保留同步占位 uuid
  clientId = cid;
  identity = { clientId: cid, displayName: '' };
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch (e) { /* 忽略 */ }
  return cid;
}

let clientId = identity?.clientId || randomUUID();
// 同步占位保证 shortClientId 等渲染安全（clientId 永不为 null）；
// 首次进入时由 ensureClientId 以 MAC 派生值替换，替换发生在任何连接建立之前（initStartup/confirm* 均先 await）
```

**注意：** 原 `const clientId = uuid();`（约 39 行）整体替换为上述身份模块；`shortClientId` 计算属性（约 158 行）无需改动（clientId 永不为 null）。

- [ ] **Step 4: 备注带作者名**

`addNote(content)` 与 `addBugNote(content)` 的 note 对象加 `authorName: displayName.value.trim() || null`：

```js
const note = {
  id: randomUUID(),
  clientId: clientId,
  content: content.trim(),
  updatedAt: Date.now(),
  authorName: displayName.value.trim() || null,
};
```

（服务端 `handleAddNote`/`handleAddBugNote` 均 `push({ ...note })` 全量透传，**服务端零改动**。）

- [ ] **Step 5: 启动流程接入身份（异步补全 clientId + 名字输入）**

`initStartup` 改为 async，并在各确认函数前先 `await ensureClientId()`：

```js
async function initStartup() {
  await ensureClientId();
  const savedMode = localStorage.getItem('buglist_mode');
  // ... 原分支逻辑不变（server / client / 首次弹窗）
}
```

`confirmServerMode` 与 `confirmClientMode` 开头加：

```js
displayName.value = displayName.value.trim();
if (!displayName.value) { ElementPlus.ElMessage.warning('请先填写你的名字'); return; }
identity = { clientId: clientId, displayName: displayName.value };
try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch (e) { /* 忽略 */ }
```

同时把两个函数改为 async 并在最前面 `await ensureClientId();`。模板中两个确认按钮加 `:disabled="!displayName.trim()"`。

- [ ] **Step 6: `public/index.html` 启动对话框加名字输入**

在 `.startup-mode-buttons` 之后插入：

```html
<div class="startup-name-row">
  <label class="startup-input-label">你的名字（用于备注署名）</label>
  <input
    class="startup-address-input"
    v-model="displayName"
    placeholder="例如：张三"
    maxlength="20"
  />
</div>
```

- [ ] **Step 7: 备注作者渲染兜底（index.html 两处：约 318 行任务备注、约 372 行条目备注）**

```html
{{ note.authorName || (note.clientId === clientId ? '我' : note.clientId.substring(0, 8)) }}
```

- [ ] **Step 8: 验证**

Run: `node --check public/app.js`、`node --check electron/main.js`、`node --check electron/preload.js`
Expected: 全部 exit 0。

---

## Task 3: 任务拖拽排序（本地缓存，不影响他人）

**Files:**
- Modify: `public/app.js`（orderedTasks、拖拽状态与 handler）
- Modify: `public/index.html:91-124`（tabs 用 orderedTasks + draggable）

**设计：** 顺序偏好存 `localStorage['buglist_task_order']`（taskId 数组）。显示时"已知顺序的在前、未知（远端新增）追加尾部"；排序变化不发 WS、不写 data.json，服务端零改动。

- [ ] **Step 1: `public/app.js` 新增排序状态与计算属性（放在 tasks 声明之后）

```js
/** 本地任务顺序偏好（仅本机生效，不同步到服务器） */
const TASK_ORDER_KEY = 'buglist_task_order';
const taskOrder = ref((function () {
  try {
    const arr = JSON.parse(localStorage.getItem(TASK_ORDER_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
})());

/** 按本地偏好排序后的任务列表（未知任务追加尾部） */
const orderedTasks = computed(() => {
  const order = taskOrder.value;
  const known = tasks.value
    .filter(t => order.includes(t.id))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const unknown = tasks.value.filter(t => !order.includes(t.id));
  return [...known, ...unknown];
});

/** 把当前显示顺序写回 localStorage（自动剔除已删除任务） */
function persistTaskOrder() {
  const live = orderedTasks.value.map(t => t.id)
    .filter(id => tasks.value.some(t => t.id === id));
  taskOrder.value = live;
  try { localStorage.setItem(TASK_ORDER_KEY, JSON.stringify(live)); } catch (e) { /* 忽略 */ }
}
```

- [ ] **Step 2: 拖拽状态与 handler（同文件）**

```js
/** 拖拽中的任务 id（HTML5 原生拖拽，无第三方依赖） */
const dragTaskId = ref(null);

function onTaskDragStart(task) { dragTaskId.value = task.id; }
function onTaskDragEnd() { dragTaskId.value = null; }
function onTaskDrop(targetId) {
  const from = dragTaskId.value;
  dragTaskId.value = null;
  if (!from || from === targetId) return;
  const order = orderedTasks.value.map(t => t.id);
  const fromIdx = order.indexOf(from);
  let toIdx = order.indexOf(targetId);
  if (fromIdx === -1) return;
  order.splice(fromIdx, 1);
  toIdx = order.indexOf(targetId); // 移除后重算
  order.splice(toIdx, 0, from);
  taskOrder.value = order;
  persistTaskOrder();
}
```

- [ ] **Step 3: `public/index.html` tabs 渲染改用 orderedTasks 并启用拖拽**

```html
<div
  v-for="task in orderedTasks"
  :key="task.id"
  class="task-tab"
  :class="{ 'task-tab-active': currentTaskId === task.id, 'task-tab-dragging': dragTaskId === task.id }"
  draggable="true"
  @dragstart="onTaskDragStart(task)"
  @dragend="onTaskDragEnd"
  @dragover.prevent
  @drop.prevent="onTaskDrop(task.id)"
  @click="switchTask(task.id)"
>
```

- [ ] **Step 4: `deleteTask` 后清理顺序缓存**

在 `deleteTask` 内 `tasks.value.splice(index, 1)` 之后加 `persistTaskOrder();`。

- [ ] **Step 5: 导出与样式**

return 对象补 `orderedTasks, dragTaskId, onTaskDragStart, onTaskDragEnd, onTaskDrop`；`style.css` 加：

```css
.task-tab { user-select: none; }
.task-tab-dragging { opacity: 0.4; }
```

- [ ] **Step 6: 验证**

Run: `node --check public/app.js`
Expected: exit 0。
手工冒烟：3 个任务 → 拖拽重排 → 刷新页面顺序保持；另一客户端不受影响（其任务顺序不变）。

---

## Task 4: 备注图片上传（任务级 + 条目级）

**Files:**
- Modify: `server.js`（handleUpload 增 note 关联分支；handleDeleteNote/handleDeleteBugNote 清理 note.image 文件；handleUpdateNote/handleUpdateBugNote 支持 image=null 移除）
- Modify: `public/app.js`（提交带图备注两步式；备注图片删除；远程应用 image 字段）
- Modify: `public/index.html`（备注缩略图 + 选择图片按钮 + 复用大图预览弹窗）
- Test: 新增 `test-note-image.js`

**设计（稳健两步式，一次点击内完成）：**
- 新备注：点击"添加备注"→（有图时）先 `POST /api/upload` 带 `X-Note-Id`（客户端预生成 noteId）+`X-Task-Id` → 服务端此时找不到 note → 只存文件、回 filename → 客户端随即 `addNote` 携带 `image` 字段 → note 同步到所有人。若 addNote 失败可重试（note.id 幂等）；极端孤儿文件风险已评估可接受（断线瞬间放弃提交才会发生，LAN 工具可容忍）。
- 已有备注（作者本人）：用同样的上传路径，note 已存在 → 服务端关联 `note.image`、替换时清理旧文件并广播。
- 移除备注图：作者发 `updateNote` 带 `data.image = null`。

- [ ] **Step 1: `server.js` handleUpload 增加 note 关联分支**

在现有 `if (bugId) { ... }` 之前插入（读取新请求头）：

```js
      const noteId = req.headers['x-note-id'];
      const bugNoteId = req.headers['x-bug-note-id'];
```

在 `if (bugId)` 块之前加 note 分支。**互斥规则（2026-08-14 实现时修正）**：note 路径优先于 bug 路径——`if (noteId || bugNoteId) { ... }`，原 bug 图片分支改 `else if (bugId) { ... }`。理由：条目备注上传同时携带 X-Bug-Id 与 X-Bug-Note-Id，若条件写成 `!bugId && (noteId || bugNoteId)` 会把条目备注图误走 bug 图片路径（覆盖 bug.image）。X-Bug-Id 在 note 分支内仅用于定位 bug。

```js
      if (noteId || bugNoteId) {
        broadcastResult = await updateData((data) => {
          const resolvedTaskId = taskId || data.tasks[0]?.id;
          if (!resolvedTaskId) return null;
          const task = data.tasks.find(t => t.id === resolvedTaskId) || data.tasks[0];
          if (!task) return null;
          let note = null;
          let changeType = 'updateNote';
          if (noteId) {
            note = (task.notes || []).find(n => n.id === noteId);
          } else {
            changeType = 'updateBugNote';
            const bug = task.bugs.find(b => b.id === bugId);
            note = bug && (bug.notes || []).find(n => n.id === bugNoteId);
          }
          if (!note) return null; // note 尚未创建：只存文件，由随后的 addNote 携带 filename 关联
          replacedImage = typeof note.image === 'string' ? note.image : null;
          note.image = safeFilename;
          if (changeType === 'updateNote') {
            return { type: 'updateNote', taskId: resolvedTaskId, noteId: noteId, image: safeFilename };
          }
          return { type: 'updateBugNote', taskId: resolvedTaskId, bugId, noteId: bugNoteId, image: safeFilename };
        });
      }
```

**重要：** 把现有孤儿清理判定（当前为 `if (!bugId || !broadcastResult || !broadcastResult.change) { 清理 + 400 }`）重构为三分支：

```js
      const hasAnyAssocHeader = !!(bugId || noteId || bugNoteId);
      // 分支 1：无任何关联请求头 → 纯孤儿，清理文件 + 400
      if (!hasAnyAssocHeader) {
        try { fs.unlinkSync(filePath); console.log(`[Upload] 已清理孤儿文件: ${safeFilename}`); }
        catch (e) { if (e.code !== 'ENOENT') console.error(`[Upload] 清理孤儿文件失败: ${safeFilename}`, e.message); }
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '缺少 X-Bug-Id / X-Note-Id / X-Bug-Note-Id 请求头', filename: safeFilename }));
        return;
      }
      // 分支 2：仅 X-Bug-Id（无 note 头）且数据未关联成功（如 tasks 为空）→ 孤儿，清理 + 400
      if (bugId && !noteId && !bugNoteId && (!broadcastResult || !broadcastResult.change)) {
        try { fs.unlinkSync(filePath); console.log(`[Upload] 已清理孤儿文件: ${safeFilename}`); }
        catch (e) { if (e.code !== 'ENOENT') console.error(`[Upload] 清理孤儿文件失败: ${safeFilename}`, e.message); }
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '上传未关联到任何任务条目（服务器数据为空）', filename: safeFilename }));
        return;
      }
      // 分支 3：note 路径且 change 为 null（note 尚未创建）→ 保留文件，200 成功（由随后 addNote 携带 filename 关联）
      // 其余（关联成功）→ 继续正常 200 成功响应
```

（note 路径下 `!change` 时**绝不清理文件**——这是两步式提交的关键。）

- [ ] **Step 2: `server.js` handleDeleteNote / handleDeleteBugNote 清理备注图片**

参照 handleDelete 现有闭包模式（先改数据、后删文件）：transform 内 splice 前记录 `deletedNoteImage = typeof note.image === 'string' ? note.image : null;`，`if (result.change)` 广播后 best-effort unlink（ENOENT 容忍，日志前缀 `[Note]`）。

- [ ] **Step 3: `server.js` handleUpdateNote / handleUpdateBugNote 支持 image=null**

```js
async function handleUpdateNote(ws, msg, _wss) {
  const { taskId, noteId, content, updatedAt } = msg.data || {};
  const imageValue = msg.data && msg.data.image;
  if (!taskId || !noteId) return;
  if (content === undefined && imageValue !== null) return;

  let removedNoteImage = null;
  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task || !task.notes) return null;
    const note = task.notes.find(n => n.id === noteId);
    if (!note) return null;
    if (note.clientId !== msg.clientId) return null;
    if (content !== undefined) { note.content = content; note.updatedAt = updatedAt || Date.now(); }
    if (imageValue === null && typeof note.image === 'string') {
      removedNoteImage = note.image;
      note.image = null;
    }
    return { type: 'updateNote', taskId, noteId, content: note.content, updatedAt: note.updatedAt, image: imageValue };
  });

  if (result.change) {
    broadcast(_wss, { type: 'broadcast', originClientId: msg.clientId, change: result.change, version: result.version });
    if (removedNoteImage) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, removedNoteImage)); console.log(`[Note] 已清理备注图片: ${removedNoteImage}`); }
      catch (e) { if (e.code !== 'ENOENT') console.error(`[Note] 清理备注图片失败: ${removedNoteImage}`, e.message); }
    }
  }
}
```

`handleUpdateBugNote` 做镜像修改（note 查找走 `findBugAndNote`，change 为 `{ type:'updateBugNote', taskId, bugId, noteId, ... }`）。

- [ ] **Step 4: `public/app.js` 备注提交两步式**

任务备注新增：

```js
/** 待提交的备注图片文件（本地暂存，提交时才上传） */
const pendingNoteFile = ref(null);
const pendingNoteFileUrl = ref('');

function onChooseNoteImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingNoteFile.value = file;
  pendingNoteFileUrl.value = URL.createObjectURL(file);
  event.target.value = '';
}
function clearPendingNoteImage() {
  if (pendingNoteFileUrl.value) URL.revokeObjectURL(pendingNoteFileUrl.value);
  pendingNoteFile.value = null;
  pendingNoteFileUrl.value = '';
}

/** 添加备注（可选携带图片）：一次点击内完成"传图 → 建备注" */
async function addNoteWithImage(content) {
  const task = notesDialogTask.value;
  if (!task || !content.trim()) return;
  let image = null;
  const file = pendingNoteFile.value;
  if (file) {
    const noteId = randomUUID();
    const formData = new FormData();
    formData.append('file', file);
    try {
      const resp = await fetch(apiUrl('/api/upload'), {
        method: 'POST',
        headers: { 'X-Note-Id': noteId, 'X-Task-Id': task.id, 'X-Client-Id': clientId },
        body: formData,
      });
      const r = await resp.json();
      if (!r.success) { ElementPlus.ElMessage.error('备注图片上传失败: ' + (r.error || '未知错误')); return; }
      image = r.filename;
    } catch (err) {
      ElementPlus.ElMessage.error('备注图片上传失败');
      return;
    }
  }
  addNote(content, image);
  clearPendingNoteImage();
  newNoteContent.value = '';
}
```

`addNote(content, image)` 签名扩展：note 对象加 `...(image ? { image } : {})`，其余不变；`addBugNote` 及条目备注面板镜像一套（`pendingBugNoteFile` 等，上传头 `X-Bug-Note-Id` + `X-Bug-Id` + `X-Task-Id`）。

**注意：** 上传与 addNote 是两个通道；noteId 由客户端预生成并同时用于上传头和随后 addNote 的 note.id（保证服务端后续"替换图"能定位到同一条 note）。修改 `addNote` 使其接受外部 id：`addNote(content, image, noteId)`，未传时内部生成。

- [ ] **Step 5: 远程备注 image 应用与删除**

```js
function handleRemoteUpdateNote(change) {
  const task = tasks.value.find(t => t.id === change.taskId);
  if (!task || !task.notes) return;
  const note = task.notes.find(n => n.id === change.noteId);
  if (note) {
    if (change.content !== undefined) { note.content = change.content; note.updatedAt = change.updatedAt; }
    if (change.image !== undefined) note.image = change.image; // null 表示移除
  }
}
```

`handleRemoteUpdateBugNote` 镜像。作者删除备注图片：`updateNoteImage(noteId)` 发 `{ type:'updateNote', data:{ taskId, noteId, image: null } }`（bug 级同理）。

- [ ] **Step 6: `public/index.html` 备注 UI**

任务备注弹窗 note-new 区域（约 344-357 行）改造：

```html
<div class="note-new">
  <div v-if="pendingNoteFileUrl" class="note-image-preview-row">
    <img :src="pendingNoteFileUrl" class="note-thumb" alt="待上传图片" />
    <el-button size="small" text type="danger" @click="clearPendingNoteImage">移除图片</el-button>
  </div>
  <el-input v-model="newNoteContent" type="textarea" :rows="2" placeholder="写备注..." @keydown="onTaskNoteNewKeydown($event)" />
  <div class="note-new-actions">
    <input type="file" accept="image/*" style="display:none" ref="noteFileInput" @change="onChooseNoteImage" />
    <el-button size="small" @click="noteFileInput.click()">上传图片</el-button>
    <span class="note-hint">Enter 发送 · Shift+Enter 换行</span>
    <el-button type="primary" size="small" @click="addNoteWithImage(newNoteContent)" :disabled="!newNoteContent.trim()">添加备注</el-button>
  </div>
</div>
```

备注条目（约 314-341 行）在 `.note-content` 上方加缩略图（作者本人额外显示"删除图片"小按钮，调 `updateNoteImage`）：

```html
<img
  v-if="note.image"
  class="note-thumb"
  :src="'//' + serverHost + '/uploads/' + encodeURIComponent(note.image)"
  @click="previewImageUrl = '//' + serverHost + '/uploads/' + encodeURIComponent(note.image); imagePreviewVisible = true"
  alt="备注图片"
/>
```

条目备注弹窗镜像（`bugNotesVisible` 区块）。样式：`.note-thumb { max-width: 120px; max-height: 120px; border-radius: 6px; cursor: zoom-in; }`。

**注意：** 弹窗 `@close` 处补 `clearPendingNoteImage()`（两个弹窗各自）。

- [ ] **Step 7: 新增 `test-note-image.js`（根目录，风格照 test-image-lifecycle.js）**

覆盖：① A 上传图+addNote（image 字段）→ data.json note.image=filename、uploads 有文件、B 收到含 image 的 addNote 广播；② A 对已有备注再传图 → note.image 替换、旧文件清理、B 收到 updateNote(image) 广播；③ A 发 updateNote image=null → note.image 为 null、文件清理；④ B 试图更新/删 A 的备注图被拒（clientId 校验）；⑤ A 删除整条备注 → 图片文件被清理。断言数 ≥ 15，最后 `process.exit(failed>0?1:0)`。

- [ ] **Step 8: 验证**

Run: `node --check server.js && node --check public/app.js && node test-note-image.js`
Expected: 新测试全过；`test-image-lifecycle.js`/`test-note-ownership.js` 仍全过（本任务不改 bug 图路径）。

---

## Task 5: bug 多图改造（迁移 + 协议 + UI + 测试适配）

**Files:**
- Modify: `server.js`（migrateData 兼容；handleUpload bug 分支改追加 + change 类型 addImage；新增 removeImage 消息与分发；handleDelete/handleDeleteTask 清理 images 数组；handleUpdate 白名单收敛为 ['name','status'] 并删除 image 清理逻辑）
- Modify: `public/app.js`（images 数组、sendRemoveImage、handleRemoteAddImage/handleRemoteRemoveImage、上传成功后本地追加、多图预览、handleImageUpload 不再依赖单 image）
- Modify: `public/index.html`（多缩略图网格、每张删除按钮、multiple 选择、预览翻页）
- Rewrite: `test-image-lifecycle.js`
- Modify: `test-validation-guards.js`（image=null 断言改为被拒）

- [ ] **Step 1: `server.js` migrateData 增加 image→images 迁移（含一次性迁移备份）**

在 migrateData 的 task 循环内加（同时在文件顶部附近加模块级标志 `let imageMigrationBackedUp = false;`）：

```js
    // 旧格式：bug.image 字符串 → images 数组
    data.tasks.forEach(t => (t.bugs || []).forEach(b => {
      if (typeof b.image === 'string') {
        if (!imageMigrationBackedUp) {
          // 首次迁移前留一份保险备份（仅一次，best-effort）
          imageMigrationBackedUp = true;
          try {
            fs.copyFileSync(DATA_FILE, `${DATA_FILE}.backup-${Date.now()}`);
            console.log('[Data] 已备份迁移前数据: data.json.backup-*');
          } catch (e) {
            console.error('[Data] 迁移备份失败:', e.message);
          }
        }
        b.images = [b.image]; delete b.image;
      }
      if (!Array.isArray(b.images)) b.images = [];
    }));
```

- [ ] **Step 1b: 验证迁移**（本任务完成后统一测，见 Step 10）

- [ ] **Step 2: `server.js` handleUpload bug 分支改追加**

transform 内 bug 已存在分支改为：

```js
          if (!Array.isArray(bug.images)) bug.images = [];
          bug.images.push(safeFilename);
          return { type: 'addImage', taskId: resolvedTaskId, bugId, filename: safeFilename };
```

自动创建 bug 分支：`const newBug = { id: bugId, name: '', status: '待修复', images: [safeFilename] };`，返回同型 change。**删除** replacedImage 记录与广播后旧图清理（多图下上传不再替换）。

- [ ] **Step 3: `server.js` 新增 removeImage 消息**

```js
async function handleRemoveImage(ws, msg, _wss) {
  const { taskId, bugId, filename } = msg.data || {};
  if (!taskId || !bugId || typeof filename !== 'string') return;
  let removed = null;
  const result = await updateData((data) => {
    const { bug } = findBugInTasks(data.tasks, taskId, bugId);
    if (!bug || !Array.isArray(bug.images)) return null;
    const idx = bug.images.indexOf(filename);
    if (idx === -1) return null;
    bug.images.splice(idx, 1);
    removed = filename;
    return { type: 'removeImage', taskId, bugId, filename };
  });
  if (result.change) {
    broadcast(_wss, { type: 'broadcast', originClientId: msg.clientId, change: result.change, version: result.version });
    try { fs.unlinkSync(path.join(UPLOADS_DIR, removed)); console.log(`[Image] 已清理图片: ${removed}`); }
    catch (e) { if (e.code !== 'ENOENT') console.error(`[Image] 清理图片失败: ${removed}`, e.message); }
  }
}
```

handleMessage 的 switch 加 `case 'removeImage': try { await handleRemoveImage(ws, msg, _wss); } catch (e) { console.error('[WS] handleRemoveImage 错误:', e.message); } break;`。

- [ ] **Step 4: `server.js` handleDelete / handleDeleteTask 清理全部图片**

handleDelete：闭包 `deletedImages = Array.isArray(bug.images) ? [...bug.images] : [];`，广播后 forEach unlink。handleDeleteTask：收集所有 bug 的 images 展平进 deletedImages。替换现有单文件逻辑。

- [ ] **Step 5: `server.js` handleUpdate 白名单收敛**

`['name','status','image']` → `['name','status']`；删除 transform 中 `field === 'image'` 的 oldImage 记录与广播后清理块（图片生命周期改由 upload/removeImage 管理）。

- [ ] **Step 6: `public/app.js` 多图逻辑**

- `handleImageUpload` 成功后：`if (!Array.isArray(bug.images)) bug.images = []; bug.images.push(result.filename);`（替代 `bug.image = result.filename`）；删除对 `bug.image` 的读取（`openPreview`、`deleteBug` 等所有 `bug.image` 引用改为 images 数组逻辑）。
- 新增：

```js
function sendRemoveImage(bugId, filename) {
  sendMessage({ type: 'removeImage', clientId, data: { taskId: currentTaskId.value, bugId, filename } });
}
function handleRemoteAddImage(taskId, bugId, filename) {
  const task = tasks.value.find(t => t.id === taskId);
  const bug = task && task.bugs.find(b => b.id === bugId);
  if (bug) {
    if (!Array.isArray(bug.images)) bug.images = [];
    if (!bug.images.includes(filename)) bug.images.push(filename);
  }
}
function handleRemoteRemoveImage(taskId, bugId, filename) {
  const task = tasks.value.find(t => t.id === taskId);
  const bug = task && task.bugs.find(b => b.id === bugId);
  if (bug && Array.isArray(bug.images)) {
    const i = bug.images.indexOf(filename);
    if (i !== -1) bug.images.splice(i, 1);
  }
}
function deleteImage(bug, filename) {
  if (!bug || !filename) return;
  // 本地先移除 + 通知服务端（服务端写盘成功后清理文件）
  const i = (bug.images || []).indexOf(filename);
  if (i !== -1) bug.images.splice(i, 1);
  sendRemoveImage(bug.id, filename);
}
```

- handleBroadcast switch 加 `case 'addImage': handleRemoteAddImage(msg.change.taskId, msg.change.bugId, msg.change.filename); break;` 与 `case 'removeImage': ...`。
- 多图预览：`previewImages = ref([]); previewIndex = ref(0);` `openPreview(bug, filename)` 记录数组与下标；弹窗加"上一张/下一张"按钮（`previewIndex>0` / `<length-1` 时显示）。
- 文件选择支持多文件：`onFileSelect` 遍历 `event.target.files` 逐个 `handleImageUpload`；`input accept="image/*"` 加 `multiple`。

- [ ] **Step 7: `public/index.html` 截图列多缩略图**

```html
<div class="image-cell" :class="{ 'has-image': (scope.row.images || []).length > 0 }">
  <div v-for="(img, i) in (scope.row.images || [])" :key="img" class="image-thumb-wrap">
    <img :src="'//' + serverHost + '/uploads/' + encodeURIComponent(img)" class="bug-thumbnail" @click.stop="openPreview(scope.row, img)" alt="截图" />
    <el-button size="small" circle type="danger" :icon="'Close'" class="image-delete-btn" @click.stop="deleteImage(scope.row, img)" />
  </div>
  <span v-if="!(scope.row.images || []).length" class="image-placeholder" @click.stop="triggerImageMenu($event, scope.row.id)">+</span>
  <el-button v-if="(scope.row.images || []).length" size="small" type="primary" text @click.stop="triggerImageMenu($event, scope.row.id)">＋ 添加</el-button>
</div>
```

预览弹窗：

```html
<el-dialog v-model="imagePreviewVisible" title="截图预览" width="80%" @close="closePreview">
  <img :src="previewImageUrl" style="width: 100%; display: block;" alt="截图预览" />
  <template #footer>
    <el-button :disabled="previewIndex <= 0" @click="previewPrev">上一张</el-button>
    <span v-if="previewImages.length > 1">{{ previewIndex + 1 }} / {{ previewImages.length }}</span>
    <el-button :disabled="previewIndex >= previewImages.length - 1" @click="previewNext">下一张</el-button>
  </template>
</el-dialog>
```

（`previewPrev/previewNext` 切换 `previewIndex` 并更新 `previewImageUrl`。）

- [ ] **Step 8: 重写 `test-image-lifecycle.js`（多图语义）**

新断言：① 上传 A → bug.images=[A]、文件在；② 再上传 B → images=[A,B]、两个文件都在（不再"替换清理"）；③ removeImage A → images=[B]、A 文件被清理；④ 删 bug → B 文件被清理、bug 消失；⑤ update field='image' → 被拒（白名单收敛，data 不变、无广播）。保留临时目录/startServer/多客户端监听风格，`process.exit(failed>0?1:0)`。

- [ ] **Step 9: `test-validation-guards.js` 适配**

把"update image=null 仍生效"一节改为：发 `update field='image' value=null` → 断言 data.json 中 bug 无 image 字段变化（images 不变）、监听方收不到广播、名称为"update field=image 被拒（白名单收敛）"。

- [ ] **Step 5b: `server.js` handleDeleteUpload 反查引用（混版本窗口兜底）**

背景：旧版客户端删图流程是"先 DELETE 文件、后发 update image=null"；新版白名单拒绝 image 更新后，若 DELETE 端点只删文件，会留下"文件已删、data.json 仍引用"的永久破图。改造：DELETE 端点先反查所有任务中引用该 filename 的 bug 并移除引用（走 updateData，先改数据），广播 removeImage，再删文件。

把 `handleDeleteUpload(req, res, filename)` 函数体改为（保留原有两重路径穿越校验）：

```js
function handleDeleteUpload(req, res, filename) {
  // 路径穿越防护（原有两重校验保持不动）
  if (!isSafeFilename(filename)) { res.writeHead(400, ...); res.end(...); return; }
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!filePath.startsWith(UPLOADS_DIR)) { res.writeHead(403, ...); res.end(...); return; }

  (async () => {
    try {
      // 先改数据：反查引用该文件的 bug 并移除 images 中的该文件名
      const result = await updateData((data) => {
        let found = null;
        for (const t of data.tasks) {
          for (const b of t.bugs || []) {
            if (Array.isArray(b.images) && b.images.includes(filename)) {
              b.images.splice(b.images.indexOf(filename), 1);
              found = { taskId: t.id, bugId: b.id };
              break;
            }
          }
          if (found) break;
        }
        if (!found) return null;
        return { type: 'removeImage', taskId: found.taskId, bugId: found.bugId, filename };
      });

      // 后删文件（无引用时是纯清理，ENOENT 容忍）
      try {
        fs.unlinkSync(filePath);
        console.log(`[Upload] 图片已删除: ${filename}`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      // 有引用变更则广播（originClientId 用特殊值，使所有客户端都应用）
      if (result && result.change) {
        broadcast(_wss, {
          type: 'broadcast',
          originClientId: '__delete_upload__',
          change: result.change,
          version: result.version,
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error('[Upload] 删除失败:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '删除失败' }));
    }
  })();
}
```

- [ ] **Step 5c: 验证 DELETE 端点反查**（并入 test-image-lifecycle.js 重写：新增断言"直接 DELETE /api/upload/:filename → data.json 引用被移除 + 文件删除 + 收到 removeImage 广播"）

- [ ] **Step 10: 验证**

Run:
```
node --check server.js
node --check public/app.js
node test-image-lifecycle.js
node test-note-ownership.js
node test-note-image.js
node test-validation-guards.js
```
Expected: 全部 exit 0。

---

## Task 6: 全量回归 + 手工冒烟

- [ ] **Step 1:** 依次运行全部测试（Task 5 Step 10 命令集），记录结果。
- [ ] **Step 2:** 手工冒烟清单（Electron 运行 `npm run electron`）：
  1. 首次启动 → 选模式 → 填名字 → 进入；刷新页面 → 不再要求填名字；自己的旧备注显示为"我"且可编辑/删除（刷新后依然）。
  2. 头部刷新图标 → 对话框出现 → × 关闭 → 清单页自动重连。
  3. 5 个任务拖拽重排 → 刷新保持；另一客户端顺序不受影响。
  4. 备注弹窗：选图+输入 → 添加备注 → 本人与他人客户端都看到缩略图；删图、删备注后图片文件同步清理。
  5. 同一条 bug 连续上传 3 张图 → 3 缩略图；预览翻页；删其中 1 张 → 其余客户端同步移除且文件清理；删 bug → 全部图片文件清理。
  6. 两个不同电脑（或用第二浏览器 + 手动改名字）互相发备注 → 显示各自名字而非 id。
- [ ] **Step 3:** 若全部通过 → 按需 `npm run build` 出新便携包（输出 pack15/任务清单.exe），并更新 README 功能清单小节（多图、备注图片、身份、任务排序四行）。

### 上线顺序（团队分发）

1. 主机先运行新版 exe：data.json 自动迁移（image→images）并生成 `data.json.backup-*`；主机确认数据完整、图片可见。
2. 同事全部更换新 exe。混版本窗口内：旧客户端看不到多图属预期（升级即恢复）；旧客户端的删图操作由"DELETE 端点反查引用"（Task 5 Step 5b）兜底，不会产生悬空引用破图。
3. 不建议删除任何旧 data.json——迁移就地完成，删除会丢数据。

---

## Self-Review

**1. Spec coverage：** 6 项反馈逐条映射——① Task 1；②③ Task 3；④（备注图）Task 4；⑤（多图）Task 5；⑥（身份）Task 2。✅

**2. Placeholder scan：** 所有逻辑步骤均含可执行代码；UI 模板给出完整片段；条目备注面板的镜像改动已在 Task 4 Step 4/6 明确列出（pendingBugNoteFile、X-Bug-Note-Id 头）。✅

**3. Type consistency：** `note.image`（Task 4）与 `bug.images`（Task 5）命名一致贯穿；change 类型 `addImage`/`removeImage`/`updateNote(image)`/`updateBugNote(image)` 在服务端 transform、广播、客户端 handleRemote* 三处对齐；`authorName`/`displayName`/IDENTITY_KEY 在 Task 2 内一致。✅

**已知取舍（计划内已说明）：** 备注图"传图后建备注"存在极端断线孤儿文件风险（LAN 可容忍）；身份配置仅存本机，但备注作者名需随备注对象存进 data.json（否则他人无法看到名字）；MAC 派生 id 在纯浏览器环境回退 localStorage uuid。
