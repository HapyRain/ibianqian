# 任务清单前端体验改版 · 实施计划（2026-08-14）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已批准的设计文档（`docs/specs/2026-08-14-ux-redesign.md`）完成前端体验改版：暖调纸面无纯白换肤、扑克牌堆多图查看器、删除/新增/上传/备注按钮四态与连贯动画、任务栏多行、备注多图（含数据迁移与协议扩展）。

**Architecture:** 纯 CSS 变量换肤 + 原生 JS/Vue 动画，零新依赖。关键架构决策：**用自定义行列表替换 el-table**——表格行的坍塌/覆盖/聚光/生长动画在 el-table 的虚拟定位下无法可靠实现，自定义行（div+flex）可完全掌控动画与四栏响应式；Element Plus 仅保留对话框/输入/下拉/气泡等交互组件。

**Tech Stack:** Vue 3 + Element Plus（CDN）、手写 CSS（Tokens）、原生 Web Animations/CSS transition、Node.js + ws 服务端（备注多图协议）、集成测试 test-*.js。

**执行顺序约束：** Task 3（列表重构）必须先于 Task 4/5（动画都作用在自定义行上）；Task 1/2 可与 3 顺序任意，但建议按编号顺序执行。

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `public/style.css` | 重写（保留既有动画必要部分） | Tokens、行列表布局、牌堆、四态按钮、幕布、弹窗动画、响应式 |
| `public/index.html` | 重写模板主体 | 自定义行列表、牌堆、查看器 overlay、确认气泡、SVG 图标 |
| `public/app.js` | 大量修改 | 牌堆/查看器逻辑、删除全链路状态机、按钮四态、多图上传、拖拽落点 |
| `server.js` | 修改 | 备注多图：迁移、上传追加、updateNote.removeImage、DELETE 反查 note.images |
| `test-note-image.js` | 重写 | 多图语义全链路 |
| `electron/main.js`、`preload.js` | 不动 | — |

---

## Task 0: 基线

- [ ] 运行四套测试并记录：`node test-image-lifecycle.js`（25）、`node test-note-ownership.js`（12）、`node test-note-image.js`（38）、`node test-validation-guards.js`（28）——必须全绿，任何失败先停下排查。

---

## Task 1: Tokens 换肤 + 连接状态三态

**Files:** Modify `public/style.css`（:root 变量区）、`public/index.html`（连接指示器）

- [ ] **Step 1: 替换 :root 颜色变量**（style.css 顶部 `:root{}` 块整体替换）：

```css
:root {
  --bg: #EDEBE4;            /* 窗口背板 */
  --surface: #F7F5EF;       /* 面板/行 */
  --surface-hi: #FFFDF6;    /* 弹窗/气泡（米白，禁纯白） */
  --line: #E0DDD3;          /* 发丝线 */
  --line-soft: #E9E6DD;     /* 行分隔线 */
  --text: #2A2723;
  --text-2: #8A8577;
  --primary: #5E6AD2;
  --danger: #E5484D;
  --ok: #4CB782;
  --warn: #C9A227;
  --ok-dot: #34C77B;
  --conn-ing: #D9A23B;
}
```

- [ ] **Step 2: 全局映射**。grep style.css 中所有旧色值并替换（仅 :root 内的旧变量名 → 新变量名；**面板背景一律改用 var(--surface)/var(--surface-hi)，删除所有 #FFFFFF 与 #fff 背景**）。旧变量名对照：原 --text-primary→var(--text)、--text-secondary→var(--text-2)、原面板白→var(--surface)、弹窗白→var(--surface-hi)。保留 --el-fill-color-light 等 Element Plus 内部变量不动。

- [ ] **Step 3: 连接状态三态**。index.html 头部 `.connection-indicator` 内状态点改为三种 class（`conn-ok`/`conn-ing`/`conn-bad`），绑定现有 `connectionStatus`（connected/connecting/disconnected 映射）；style.css 追加：

```css
.status-dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.connection-indicator.connected .status-dot{background:var(--ok-dot);box-shadow:0 0 0 3px rgba(52,199,123,.22);animation:connPulse 1.8s ease-in-out infinite}
.connection-indicator.connecting .status-dot{background:var(--conn-ing);box-shadow:0 0 0 3px rgba(217,162,59,.25);animation:connBlink 1s step-end infinite}
.connection-indicator.disconnected .status-dot{background:var(--danger);box-shadow:0 0 0 3px rgba(229,72,77,.28)}
.connection-indicator.disconnected .status-text{color:var(--danger)}
@keyframes connPulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes connBlink{0%,100%{opacity:1}50%{opacity:.35}}
```

- [ ] **Step 4: 验证**：`node --check` 不适用 CSS；手工打开 `npm run electron` 检查背板/面板已无纯白、三种连接状态点正确显示（可用 resetStartupMode 触发 disconnected）。

---

## Task 2: SVG 图标体系

**Files:** Modify `public/index.html`

- [ ] **Step 1**: 将 12 个选定图标（设计文档 3.2 节，24×24、1.8px 圆头、stroke="currentColor"）以 `<svg>` 内联替换现有对应位置的旧图形/emoji：
  - 截图占位 `+` → 图标 01（图片山日）；预览按钮 → 02（相框对焦）；上传菜单按钮 → 04（上传）；预览弹窗关闭 → 09（关闭）；行删除按钮 → 08（垃圾桶）；清单图标（标题旁）→ 11（清单）；新增任务按钮 → 12（新增）；启动对话框服务器/客户端按钮 → 16/17（服务器/显示器）；名字输入旁 → 18（用户）；备份标识 → 19（保存）；备注按钮 → 现有气泡图形按同规范重绘（1.8px 圆头、无填充）。
- [ ] **Step 2**: 所有图标 class 统一 `.icon`（width/height 跟随字体），颜色 `currentColor`；删除所有 emoji 图标（🖼、💬、✕ 文本等）。
- [ ] **Step 3: 验证**：浏览器过一遍所有按钮/占位图标渲染正常、无 emoji 残留（grep index.html `🖼|💬|✕|＋` 中文本类应仅剩语义必要处）。

---

## Task 3: 列表重构（el-table → 自定义行 + 四栏 + 响应式基础）

**Files:** Modify `public/index.html`（表格区）、`public/style.css`、`public/app.js`（rowClass/状态绑定）

- [ ] **Step 1: index.html 表格区整体替换**。删除 `<el-table>...</el-table>`（约 150-288 行区域），改为：

```html
<div class="bug-list" :class="{ 'bug-list-wide': isWideWindow }">
  <div
    v-for="bug in filteredAndSortedBugs"
    :key="bug.id"
    class="bug-row"
    :class="{ 'bug-row-spotlight': confirmBugId === bug.id, 'bug-row-dying': dyingBugId === bug.id, 'bug-row-covering': coveringBugId === bug.id }"
  >
    <div class="bug-cell bug-name" @dblclick="startEditName(bug)">
      <el-input v-if="editingBugId === bug.id" :model-value="bug.name" @update:model-value="bug.name = $event"
        size="small" placeholder="请输入任务名称" @blur="finishEditName(bug)" @keyup.enter="finishEditName(bug)" @keyup.escape="cancelEditName(bug)" />
      <span v-else class="name-text" :class="{ 'name-placeholder': !bug.name }">{{ bug.name || '双击编辑名称...' }}</span>
    </div>
    <div class="bug-cell bug-status">
      <el-select :model-value="bug.status" @update:model-value="onStatusChange(bug, $event)" size="small"
        :class="['status-select', 'status-select-' + getStatusClass(bug.status)]">
        <el-option v-for="opt in statusOptions" :key="opt" :label="opt" :value="opt" />
      </el-select>
    </div>
    <div class="bug-cell bug-shots" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop($event, bug.id)">
      <!-- Task 4 在此填入牌堆 -->
    </div>
    <div class="bug-cell bug-notes">
      <button class="btn-note" @click.stop="openBugNotesDialog(currentTaskId, bug.id)">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-8.5 8.5 8.5 8.5 0 01-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8z"/></svg>
        <span v-if="getBugNoteWriters(bug) > 0" class="notes-indicator" :class="'notes-indicator-' + Math.min(getBugNoteWriters(bug), 3)"></span>
      </button>
    </div>
    <div class="bug-cell bug-actions">
      <!-- Task 5 在此填入删除按钮 + 确认气泡 -->
    </div>
  </div>
  <div v-if="!filteredAndSortedBugs.length" class="empty-state">
    <p>暂无任务记录</p><p class="empty-hint">点击「新增任务」开始记录</p>
  </div>
</div>
```

- [ ] **Step 2: style.css 行布局**：

```css
.bug-list{display:flex;flex-direction:column;gap:7px;min-height:0}
.bug-row{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--line-soft);border-radius:11px;padding:9px 12px;min-height:44px;transition:height .32s cubic-bezier(.3,.9,.35,1), opacity .2s ease, box-shadow .2s ease}
.bug-row:hover{background:var(--surface-hi)}
.bug-name{flex:1;min-width:180px}
.bug-status{width:110px;flex:none}
.bug-shots{width:132px;flex:none}
.bug-notes{width:56px;flex:none}
.bug-actions{width:96px;flex:none;display:flex;justify-content:flex-end}
.bug-list-wide .bug-status{width:130px}.bug-list-wide .bug-shots{width:150px}
```

- [ ] **Step 3: app.js 新状态**：`const isWideWindow = ref(false);`，mounted 里 `const upd=()=>{isWideWindow.value=window.innerWidth>=1200}; upd(); window.addEventListener('resize',upd);`；onUnmounted 移除监听。另注册 `confirmBugId=ref(null)`、`dyingBugId=ref(null)`、`coveringBugId=ref(null)`（Task 5 用，先声明）。

- [ ] **Step 4: 验证**：`node --check public/app.js`；手工：列表渲染、双击改名、状态下拉、筛选排序、备注按钮均正常；窗口拉宽 ≥1200px 四栏变宽、拉窄 <900px 无横向滚动（`.bug-list` 不溢出）。

---

## Task 4: 扑克牌堆 + 查看器连贯动画

**Files:** Modify `public/index.html`（bug-shots 区 + 查看器）、`public/app.js`、`public/style.css`

- [ ] **Step 1: 牌堆模板**（填入 Task 3 的 `.bug-shots`）：

```html
<div class="img-stack" v-if="(bug.images||[]).length">
  <div
    v-for="(img, i) in (bug.images||[]).slice(0, 4)"
    :key="img"
    class="img-stack-card"
    :style="stackCardStyle(i)"
    @click.stop="openPreview(bug, img, $event)"
  ><img :src="'//' + serverHost + '/uploads/' + encodeURIComponent(img)" alt="截图" /></div>
  <span class="img-stack-count">{{ (bug.images||[]).length }} 张</span>
</div>
<button v-else class="shot-add" @click.stop="triggerImageMenu($event, bug.id)">
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.6" cy="9.6" r="1.3"/><path d="M21 15.5l-4.8-4.8-4 4.1-3.2-3-6 5.2"/></svg>
</button>
<button v-if="(bug.images||[]).length" class="shot-add-more" @click.stop="triggerImageMenu($event, bug.id)">＋</button>
```

- [ ] **Step 2: style.css 牌堆**（抽卡 hover，第 1 张最上层）：

```css
.img-stack{position:relative;width:116px;height:66px}
.img-stack-card{position:absolute;top:2px;left:0;width:52px;height:62px;border-radius:8px;overflow:hidden;border:1px solid rgba(42,39,35,.18);box-shadow:0 2px 6px rgba(42,39,35,.16);background:var(--surface-hi);transition:transform .26s cubic-bezier(.3,1.7,.45,1), box-shadow .2s ease}
.img-stack-card img{width:100%;height:100%;object-fit:cover}
.img-stack-card:hover{transform:translateY(-9px) rotate(0deg) scale(1.05);z-index:20;box-shadow:0 12px 22px rgba(42,39,35,.3)}
.img-stack-count{position:absolute;right:-2px;bottom:-2px;background:var(--primary);color:#fff;border-radius:999px;font-size:10px;padding:2px 7px;z-index:21}
.shot-add{width:52px;height:62px;border:1px dashed var(--line);border-radius:8px;background:transparent;color:var(--text-2);cursor:pointer}
.shot-add-more{position:absolute;right:-2px;bottom:-2px;background:var(--primary);color:#fff;border:none;border-radius:999px;font-size:12px;padding:2px 8px;cursor:pointer;z-index:21}
```

- [ ] **Step 3: app.js `stackCardStyle(i)`**（第 1 张最上层：rotate [-5,-1,3,7]°，left [2,18,34,50]px，z [4,3,2,1]）：

```js
function stackCardStyle(i){
  const rot=[-5,-1,3,7][i]||0, left=[2,18,34,50][i]||0, z=[4,3,2,1][i]||1;
  return { left:left+'px', transform:'rotate('+rot+'deg)', zIndex:z };
}
```

- [ ] **Step 4: 查看器替换 el-dialog 为自定义 overlay**（index.html 删除旧 `imagePreviewVisible` 的 el-dialog，改为）：

```html
<div class="pv-zoom" ref="pvZoom"><img :src="previewImageUrl" alt=""></div>
<div class="pv-viewer" :class="{open: imagePreviewVisible}" @click.self="closePreview">
  <div class="pv-stage" :class="{ready: previewStageReady}">
    <div class="pv-slide" :style="{ transform: 'translateX(-' + previewIndex * 100 + '%)' }">
      <div class="pv-slide-item" v-for="(img,i) in previewImages" :key="img">
        <img :src="'//' + serverHost + '/uploads/' + encodeURIComponent(img)" alt="截图预览">
      </div>
    </div>
    <button class="pv-arrow l" :disabled="previewIndex<=0" @click="previewPrev">‹</button>
    <button class="pv-arrow r" :disabled="previewIndex>=previewImages.length-1" @click="previewNext">›</button>
    <button class="pv-x" @click="closePreview">✕</button>
    <div class="pv-tip" v-if="previewImages.length">{{ previewIndex+1 }} / {{ previewImages.length }}</div>
  </div>
</div>
```

- [ ] **Step 5: style.css 查看器**（v2/v3 demo 全套 + 关闭按钮永远可见）：

```css
.pv-zoom{position:fixed;z-index:998;border-radius:10px;overflow:hidden;box-shadow:0 12px 40px rgba(42,39,35,.35);transition:left .26s cubic-bezier(.2,.8,.2,1), top .26s cubic-bezier(.2,.8,.2,1), width .26s cubic-bezier(.2,.8,.2,1), height .26s cubic-bezier(.2,.8,.2,1);display:none;background:#2A2723}
.pv-zoom img{width:100%;height:100%;object-fit:cover}
.pv-viewer{position:fixed;inset:0;z-index:999;background:rgba(28,26,23,.88);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .26s ease}
.pv-viewer.open{opacity:1;pointer-events:auto}
.pv-stage{width:min(720px,86vw);height:min(520px,72vh);position:relative;border-radius:14px;overflow:hidden;box-shadow:0 16px 60px rgba(0,0,0,.5);opacity:0;transform:scale(.965);transition:opacity .16s ease, transform .16s ease}
.pv-stage.ready{opacity:1;transform:scale(1)}
.pv-slide{position:absolute;inset:0;display:flex;transition:transform .26s cubic-bezier(.2,.8,.2,1)}
.pv-slide-item{min-width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#2A2723}
.pv-slide-item img{max-width:100%;max-height:100%;object-fit:contain}
.pv-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;border:none;font-size:20px;cursor:pointer;transition:all .18s ease}
.pv-arrow:hover:not(:disabled){background:rgba(255,255,255,.3);transform:translateY(-50%) scale(1.08)}
.pv-arrow:disabled{opacity:.3;cursor:default}
.pv-arrow.l{left:14px}.pv-arrow.r{right:14px}
.pv-x{position:absolute;top:12px;right:12px;width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;border:none;font-size:17px;cursor:pointer;transition:all .18s ease}
.pv-x:hover{background:rgba(255,255,255,.32);transform:rotate(90deg)}
.pv-tip{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,.5);border-radius:999px;padding:4px 14px;font-size:12px}
```

- [ ] **Step 6: app.js 查看器逻辑改造**（替换现有 openPreview/closePreview）：

```js
const previewStageReady = ref(false);
const pvZoom = ref(null);
let pvOriginRect = null, pvTimer = null;

async function openPreview(bug, filename, evt) {
  if (!bug || !Array.isArray(bug.images) || !bug.images.length) return;
  previewImages.value = [...bug.images];
  const idx = filename ? bug.images.indexOf(filename) : 0;
  previewIndex.value = idx === -1 ? 0 : idx;
  previewImageUrl.value = '//' + serverHost.value + '/uploads/' + encodeURIComponent(previewImages.value[previewIndex.value]);
  // 从点击的卡片 rect 展开放大（demo v2 同款时序）
  const cardEl = evt && evt.currentTarget;
  pvOriginRect = cardEl ? cardEl.getBoundingClientRect() : null;
  const zoom = pvZoom.value;
  if (zoom && pvOriginRect) {
    const r = pvOriginRect;
    zoom.style.display = 'block';
    zoom.style.left = r.left + 'px'; zoom.style.top = r.top + 'px';
    zoom.style.width = r.width + 'px'; zoom.style.height = r.height + 'px';
    zoom.querySelector('img').src = previewImageUrl.value;
    imagePreviewVisible.value = true; // 背景与放大同步开始变黑
    previewStageReady.value = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      zoom.style.left = '50%'; zoom.style.top = '50%';
      zoom.style.transform = 'translate(-50%,-50%)';
      zoom.style.width = 'min(720px,86vw)'; zoom.style.height = 'min(520px,72vh)';
      pvTimer = setTimeout(() => {
        if (!imagePreviewVisible.value) return;
        previewStageReady.value = true;
        zoom.style.display = 'none';
      }, 270);
    }));
  } else {
    imagePreviewVisible.value = true;
    previewStageReady.value = true;
  }
}
function closePreview() {
  clearTimeout(pvTimer);
  const zoom = pvZoom.value;
  if (zoom && pvOriginRect) {
    const r = pvOriginRect;
    previewStageReady.value = false;
    imagePreviewVisible.value = false; // 背景同步淡出
    zoom.style.display = 'block';
    zoom.style.left = '50%'; zoom.style.top = '50%';
    zoom.style.transform = 'translate(-50%,-50%)';
    zoom.style.width = 'min(720px,86vw)'; zoom.style.height = 'min(520px,72vh)';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      zoom.style.left = r.left + 'px'; zoom.style.top = r.top + 'px';
      zoom.style.transform = 'none';
      zoom.style.width = r.width + 'px'; zoom.style.height = r.height + 'px';
      setTimeout(() => { zoom.style.display = 'none'; }, 280);
    }));
  } else {
    imagePreviewVisible.value = false;
  }
}
```

- [ ] **Step 7: 验证**：`node --check public/app.js`；手工：同 bug 三张图堆叠、第 1 张最上层、抽卡 hover、点第 3 张精准停在 3/3、背景同步变黑、←/→、× 与点背景关闭缩回原位；单图 bug 也正常（无牌堆时用占位按钮）。

---

## Task 5: 删除全链路（四态 + 蓄怒 + 保险 + 渐隐黑 + 覆盖删除）

**Files:** Modify `public/index.html`（bug-actions 区 + 全局 scrim）、`public/app.js`、`public/style.css`

- [ ] **Step 1: 模板**（bug-actions 内）：

```html
<button class="btn-del" :class="{angry: angryBugId===bug.id}" @mousedown="onDelDown(bug)" @mouseup="onDelUp(bug, $event)">
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>删除
</button>
<span class="del-confirm" :class="{show: confirmBugId===bug.id}">
  <span>确认删除本条？</span>
  <button class="ok" @click="confirmDeleteBug(bug)">确认删除</button>
  <button class="no" @click="confirmBugId=null; hideDelScrim()">取消</button>
</span>
```

body 末尾（`.pv-viewer` 之后）加：`<div class="del-scrim" :class="{show: confirmBugId!==null}" @click="confirmBugId=null; hideDelScrim()"></div>`

- [ ] **Step 2: style.css 四态 + 蓄怒 + 气泡 + 幕布 + 行状态**：

```css
.btn-del{border:1px solid #EDC9C4;background:var(--surface-hi);color:var(--danger);border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:transform .24s cubic-bezier(.3,1.4,.5,1), box-shadow .24s ease, background .18s ease}
.btn-del .icon{width:14px;height:14px}
.btn-del:hover{transform:translateY(-1px) skewX(-1deg);box-shadow:0 3px 10px rgba(229,72,77,.25), 0 0 0 3px rgba(229,72,77,.08);background:#FEF7F6}
.btn-del:active{transition-duration:.09s;transform:scale(.97) skewX(1deg);animation:delShakeHold .16s linear infinite;box-shadow:inset 0 0 10px rgba(229,72,77,.28), 0 0 0 4px rgba(229,72,77,.12)}
.btn-del.angry{animation:delAngryColor .55s ease forwards, delShakeAngry .22s linear infinite}
.btn-del.burst{animation:delShakeBurst .42s cubic-bezier(.36,.07,.19,.97)}
.btn-del.burst::after{content:'';position:absolute;inset:-4px;border-radius:12px;border:2px solid rgba(229,72,77,.55);animation:delRing .42s ease-out forwards}
@keyframes delShakeHold{0%{transform:scale(.97) skewX(1deg) translate(0,0)}25%{transform:scale(.97) skewX(1deg) translate(.8px,-.7px)}50%{transform:scale(.97) skewX(-1deg) translate(-.8px,.6px)}75%{transform:scale(.97) skewX(1deg) translate(.6px,.7px)}100%{transform:scale(.97) skewX(1deg) translate(0,0)}}
@keyframes delAngryColor{0%{background:#FEF7F6;color:var(--danger);border-color:#EDC9C4}45%{background:#F3C464;color:#7A4A12;border-color:#E3B04F}100%{background:var(--danger);color:#fff;border-color:var(--danger)}}
@keyframes delShakeAngry{0%{transform:scale(.97) translate(0,0) rotate(0)}20%{transform:scale(.97) translate(1.3px,-1.1px) rotate(-1.3deg)}40%{transform:scale(.97) translate(-1.5px,1px) rotate(1.3deg)}60%{transform:scale(.97) translate(1.2px,.9px) rotate(-1deg)}80%{transform:scale(.97) translate(-1px,-.9px) rotate(1deg)}100%{transform:scale(.97) translate(0,0) rotate(0)}}
@keyframes delShakeBurst{0%{transform:translate(0,0) rotate(0)}15%{transform:translate(-2.4px,1.2px) rotate(-1.6deg)}30%{transform:translate(2.2px,-1px) rotate(1.4deg)}45%{transform:translate(-1.8px,-.8px) rotate(-1.1deg)}60%{transform:translate(1.4px,.8px) rotate(.8deg)}75%{transform:translate(-.8px,0) rotate(-.4deg)}100%{transform:translate(0,0) rotate(0)}}
@keyframes delRing{0%{opacity:.9;transform:scale(.9)}100%{opacity:0;transform:scale(1.35)}}
.del-confirm{display:inline-flex;align-items:center;gap:8px;background:var(--surface-hi);border:1px solid var(--line);border-radius:10px;padding:6px 9px;box-shadow:0 6px 18px rgba(42,39,35,.16);font-size:12px;color:var(--text);margin-left:8px;opacity:0;transform:translateY(4px) scale(.96);transition:all .2s cubic-bezier(.3,1.4,.5,1);pointer-events:none;position:relative;z-index:70}
.del-confirm.show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.del-confirm .ok{background:var(--danger);color:#fff;border:none;border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer}
.del-confirm .no{background:transparent;border:1px solid var(--line);color:var(--text-2);border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer}
.del-scrim{position:fixed;inset:0;z-index:65;pointer-events:none;background:rgba(28,26,23,.5);opacity:0;transition:opacity .24s ease}
.del-scrim.show{opacity:1;pointer-events:auto}
.bug-row-spotlight{position:relative;z-index:66;border-radius:10px;box-shadow:0 0 0 4px rgba(255,255,255,.65), 0 4px 18px rgba(42,39,35,.28)}
.bug-row-dying{animation:rowRedFlash .16s ease}
.bug-row-covering{position:relative;z-index:5;box-shadow:0 -8px 14px rgba(42,39,35,.16)}
@keyframes rowRedFlash{0%{background:rgba(229,72,77,0)}30%{background:rgba(229,72,77,.14)}100%{background:rgba(229,72,77,0)}}
```

- [ ] **Step 3: app.js 状态机**：

```js
const confirmBugId = ref(null);
const dyingBugId = ref(null);
const coveringBugId = ref(null);
const angryBugId = ref(null);
let delPressTimer = null, delPressRect = null;

function onDelDown(bug){
  angryBugId.value = bug.id;
  const btn = event.currentTarget;
  delPressRect = btn.getBoundingClientRect();
  clearTimeout(delPressTimer);
  delPressTimer = setTimeout(() => { if (angryBugId.value === bug.id) btn.classList.add('angry'); }, 700);
}
function onDelUp(bug, e){
  clearTimeout(delPressTimer);
  const wasAngry = angryBugId.value === bug.id;
  angryBugId.value = null;
  // 松手位置判定（扳机保险）
  let inside = false;
  if (delPressRect && typeof e.clientX === 'number') {
    inside = e.clientX >= delPressRect.left - 3 && e.clientX <= delPressRect.right + 3 && e.clientY >= delPressRect.top - 3 && e.clientY <= delPressRect.bottom + 3;
  }
  if (!inside) return; // 删除终止
  const btn = e.currentTarget;
  btn.classList.add('burst');
  setTimeout(() => btn.classList.remove('burst'), 440);
  confirmBugId.value = bug.id; // 触发渐隐黑幕 + 行聚光
}
function hideDelScrim(){ /* 由模板绑定直接置 null */ }

function confirmDeleteBug(bug){
  const task = currentTask.value;
  if (!task) return;
  confirmBugId.value = null;   // 幕布渐亮
  dyingBugId.value = bug.id;   // 红光一闪 + 高度坍塌
  coveringBugId.value = nextBugIdOf(bug); // 下面一行获得"盖子"投影
  const rowEl = rowElementOf(bug.id);
  const h = rowEl ? rowEl.offsetHeight : 44;
  if (rowEl) {
    rowEl.style.height = h + 'px';      // 必须钉死像素（auto→0 无过渡）
    rowEl.getBoundingClientRect();
    rowEl.style.height = '0px';
  }
  setTimeout(() => {
    const task2 = currentTask.value;
    const idx = (task2 && task2.bugs) ? task2.bugs.findIndex(b => b.id === bug.id) : -1;
    if (idx !== -1) task2.bugs.splice(idx, 1);
    sendDelete(bug.id);
    dyingBugId.value = null;
    coveringBugId.value = null;
  }, 340); // 文字被完全压住后才真正删除（demo v10 时序）
}
function nextBugIdOf(bug){
  const list = filteredAndSortedBugs.value;
  const i = list.findIndex(b => b.id === bug.id);
  return i !== -1 && list[i + 1] ? list[i + 1].id : null;
}
function rowElementOf(id){ return document.querySelector('.bug-row[data-bug-id="' + id + '"]'); }
```

模板行根 div 增加 `:data-bug-id="bug.id"`（Task 3 Step 1 的 bug-row 上）。`coveringBugId` 由 nextBugIdOf 计算——**不得对该行叠加 transform**（布局回流已上移，双重移动会回弹，设计文档红线 ②）。

- [ ] **Step 4: 验证**：`node --check public/app.js`；手工四场景：快速点击（直出确认）；长按 1s 变红后拖出按钮松手（终止）；长按原地松手（走流程）；确认后行被下面一行平滑盖掉、无跳位回弹。删除后数据与文件清理沿用现有服务端逻辑（无服务端改动）。

---

## Task 6: 新增 / 上传 / 备注按钮四态与结果动画

**Files:** Modify `public/index.html`（工具栏 + 备注弹窗）、`public/app.js`、`public/style.css`

- [ ] **Step 1: 新增按钮（垒上）**。工具栏"新增任务"按钮加 class `btn-add`，style.css：

```css
.btn-add{display:inline-flex;align-items:center;gap:6px;background:var(--primary);color:#fff;border:none;border-radius:10px;padding:9px 18px;font-size:13px;cursor:pointer;box-shadow:0 1px 3px rgba(94,106,210,.35);transition:transform .24s cubic-bezier(.3,1.4,.5,1), box-shadow .22s ease}
.btn-add:hover{transform:translateY(-3px);box-shadow:0 10px 20px rgba(94,106,210,.35)}
.btn-add:active{transition-duration:.09s;transform:translateY(2px);box-shadow:0 1px 2px rgba(94,106,210,.28)}
.btn-add:active .icon{transform:rotate(90deg)}
.btn-add .icon{transition:transform .22s cubic-bezier(.3,1.4,.5,1)}
.btn-add.land{animation:addLand .34s cubic-bezier(.3,1.3,.5,1)}
@keyframes addLand{0%{transform:translateY(2px)}45%{transform:translateY(-1.5px)}100%{transform:translateY(0)}}
.bug-row.row-enter{animation:rowGrow .3s cubic-bezier(.3,1.2,.4,1)}
@keyframes rowGrow{from{max-height:0;opacity:0;transform:translateY(-4px)}to{max-height:60px;opacity:1;transform:translateY(0)}}
```

app.js `addBug()`：push 后给新行加 class（用 `bug.id` 匹配 `:class="{ 'row-enter': enteringBugId === bug.id }"`，`enteringBugId=ref(null)`，addBug 置位、300ms 后清空）；`createTask` 按钮同款（class 复用）。

- [ ] **Step 2: 上传按钮（托举发射）**。截图区"上传"菜单项与触发按钮（shot-add/shot-add-more/粘贴/菜单项）统一 class `btn-upload`（含 ↑ 图标，用图标 04），style.css：

```css
.btn-upload{display:inline-flex;align-items:center;gap:6px;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer;transition:transform .24s cubic-bezier(.3,1.4,.5,1), box-shadow .22s ease}
.btn-upload .icon{transition:transform .18s ease}
.btn-upload:hover{transform:translateY(-2px);box-shadow:0 6px 14px rgba(42,39,35,.15)}
.btn-upload:hover .icon{transform:translateY(-1.5px)}
.btn-upload:active{transition-duration:.08s;transform:translateY(2px) scale(.97);box-shadow:0 1px 2px rgba(42,39,35,.12)}
.btn-upload:active .icon{transform:translateY(2px)}
.btn-upload.launch{animation:upLaunch .34s cubic-bezier(.3,1.3,.5,1)}
.btn-upload.launch .icon{animation:arrFly .3s ease-out forwards}
@keyframes upLaunch{0%{transform:translateY(2px)}45%{transform:translateY(-4px)}100%{transform:translateY(0)}}
@keyframes arrFly{0%{transform:translateY(2px);opacity:1}100%{transform:translateY(-9px);opacity:0}}
```

app.js `handleImageUpload` 成功、本地 push 图片后：给当前上传按钮加 `launch`（通过 `uploadingBugId` 所在按钮或全局 class 标记 `uploadLaunchTick=ref(0)` 配合 `:class`），340ms 后清除；同时给新进牌堆的那张卡加"落入"动画：`newCardId=ref(null)`，模板第一张卡 `:class="{ 'card-drop': newCardId === img }"`，样式：

```css
.img-stack-card.card-drop{animation:cardDrop .42s cubic-bezier(.3,1.4,.5,1)}
@keyframes cardDrop{0%{transform:translateY(-46px) scale(.85);opacity:0}60%{opacity:1}100%{transform:translateY(0) scale(1)}}
```

- [ ] **Step 3: 备注按钮（便签翘角展开）**。行内 `.btn-note` 与任务标签栏备注按钮统一 class `btn-note`，style.css：

```css
.btn-note{display:inline-flex;align-items:center;gap:4px;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:7px 10px;font-size:12px;cursor:pointer;transition:transform .24s cubic-bezier(.3,1.4,.5,1), box-shadow .22s ease}
.btn-note:hover{transform:translateY(-2px) rotate(-1.3deg);box-shadow:0 6px 12px rgba(42,39,35,.14)}
.btn-note:active{transition-duration:.08s;transform:translateY(1px) rotate(0) scale(.97)}
.btn-note.peel{animation:peelBack .3s cubic-bezier(.3,1.4,.5,1)}
@keyframes peelBack{0%{transform:translateY(1px) rotate(0) scale(.97)}55%{transform:translateY(-1.5px) rotate(.8deg) scale(1.01)}100%{transform:translateY(0) rotate(0) scale(1)}}
```

两个备注 el-dialog 加 `class="sheet-dialog"`，style.css：

```css
.sheet-dialog{background:var(--surface-hi);border-radius:14px;box-shadow:0 16px 60px rgba(42,39,35,.25)}
.sheet-dialog .el-dialog__body{background:transparent}
```

app.js `openNotesDialog/openBugNotesDialog` 打开前给触发按钮加 `peel`（300ms 清除）。el-dialog 自带遮罩淡入即满足；面板展开感由 `sheet-dialog` 的打开动画补充（Element Plus dialog 有默认 transition，可用自定义类覆盖 `dialog-fade` 的 transform-origin 为按钮位置——若复杂度超预期，保持默认淡入+scale，手工冒烟验收时确认可接受）。

- [ ] **Step 4: 验证**：`node --check public/app.js`；手工按 3.5/3.6/3.7 节体验三个按钮四态与到达效果。

---

## Task 7: 任务栏多行 + 拖拽落点高亮

**Files:** Modify `public/style.css`、`public/index.html`（任务标签栏）、`public/app.js`

- [ ] **Step 1: 多行**。`.task-tabs-scroll` 改为 `display:flex;flex-wrap:wrap;gap:7px;`（去掉横向滚动相关 overflow-x 规则）；`.task-tab` 保持抽卡 hover（复用现有 `translateY(-2px)` 微调为设计规范）。

- [ ] **Step 2: 落点高亮**。app.js 增加：

```js
const dragOverTaskId = ref(null); // 插入目标（拖到其前方）
function onTaskDragOver(task, e){
  e.preventDefault();
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const before = e.clientX < rect.left + rect.width / 2;
  el.classList.toggle('drop-before', before);
  el.classList.toggle('drop-after', !before);
  dragOverTaskId.value = task.id;
}
```

模板：`.task-tab` 增加 `@dragover="onTaskDragOver(task, $event)"`、`:class` 追加 `{'task-tab-drop': dragOverTaskId===task.id}`；`@drop.prevent.stop` 改为调用新 `onTaskDropAt(task, $event)`：

```js
function onTaskDropAt(targetTask, e){
  e.preventDefault();
  const from = dragTaskId.value;
  dragTaskId.value = null;
  dragOverTaskId.value = null;
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const before = e.clientX < rect.left + rect.width / 2;
  el.classList.remove('drop-before','drop-after');
  if (!from || from === targetTask.id) { persistTaskOrder(); return; }
  const order = orderedTasks.value.map(t => t.id);
  const fromIdx = order.indexOf(from);
  if (fromIdx === -1) return;
  order.splice(fromIdx, 1);
  let toIdx = order.indexOf(targetTask.id);
  if (!before) toIdx += 1; // 插入后半区 = 放到目标后面
  order.splice(toIdx, 0, from);
  taskOrder.value = order;
  persistTaskOrder();
}
```

容器级 `onTaskDropToEnd` 保留（拖到行尾空白 → 移到最后）。style.css：

```css
.task-tab{position:relative}
.task-tab.drop-before::before,.task-tab.drop-after::after{content:'';position:absolute;top:4px;bottom:4px;width:2px;border-radius:1px;background:var(--primary)}
.task-tab.drop-before::before{left:-4px}
.task-tab.drop-after::after{right:-4px}
```

- [ ] **Step 3: 验证**：`node --check public/app.js`；手工：8 个任务窄窗口成多行、无横向滚动；拖拽时目标前后半区分别出现左侧/右侧竖线，松手落位正确、可拖到最末、远程任务不影响本机顺序缓存。

---

## Task 8: 备注多图（协议 + 迁移 + UI + 测试）

**Files:** Modify `server.js`、`public/app.js`、`public/index.html`、`public/style.css`；Rewrite `test-note-image.js`

- [ ] **Step 1: server.js 迁移**。migrateData 增加（模块级 `let noteImagesMigrated = false;`，仿 imageMigrationBackedUp）：

```js
    // 旧格式：note.image 字符串 → images 数组（含一次性备份，与 bug 图迁移共用备份时机亦可）
    data.tasks.forEach(t => {
      ((t.notes) || []).forEach(n => {
        if (typeof n.image === 'string') {
          if (!noteImagesMigrated) {
            noteImagesMigrated = true;
            try { fs.copyFileSync(DATA_FILE, `${DATA_FILE}.backup-note-${Date.now()}`); console.log('[Data] 已备份备注图迁移前数据'); } catch (e) { console.error('[Data] 备注图迁移备份失败:', e.message); }
          }
          n.images = [n.image]; delete n.image;
        }
        if (!Array.isArray(n.images)) n.images = [];
      });
      (t.bugs || []).forEach(b => ((b.notes) || []).forEach(n => {
        if (typeof n.image === 'string') { n.images = [n.image]; delete n.image; }
        if (!Array.isArray(n.images)) n.images = [];
      }));
    });
```

- [ ] **Step 2: server.js 上传 note 分支改追加**。note 分支 transform：note 存在时 `if (!Array.isArray(note.images)) note.images = []; note.images.push(safeFilename);`，change 改为 `{ type:'updateNote'|'updateBugNote', ..., images: [...note.images] }`；note 未创建仍 return null 暂存（addNote 携带 images 关联）。

- [ ] **Step 3: server.js updateNote/updateBugNote 支持 removeImage**：

```js
    const removeImage = msg.data && msg.data.removeImage;
    // transform 内（content 处理之后）：
    if (typeof removeImage === 'string' && Array.isArray(note.images)) {
      const ri = note.images.indexOf(removeImage);
      if (ri !== -1) { note.images.splice(ri, 1); removedNoteImages.push(removeImage); }
    }
    return { type: 'updateNote', taskId, noteId, content: note.content, updatedAt: note.updatedAt, images: [...(note.images || [])] };
```

闭包数组 `removedNoteImages` 在广播后 forEach unlink（ENOENT 容忍）。原 `image: null` 分支删除。handleUpdateBugNote 镜像。

- [ ] **Step 4: server.js handleDeleteNote/handleDeleteBugNote 清理全部图片**（deletedNoteImage 单值 → `deletedNoteImages = [...(note.images||[])]`，forEach unlink）。handleDeleteUpload 反查扩展：note.images / bugNote.images 命中 → splice + 返回 updateNote/updateBugNote change（images 快照）。

- [ ] **Step 5: 客户端多图**。app.js：note 渲染处 `note.image` 全部改 `(note.images||[])`；`addNoteWithImage` 扩展为多文件循环上传（pendingNoteFiles 数组，逐张 X-Note-Id=同一 noteId 暂存 → 收集 filenames → addNote(content, images, noteId)）；`attachNoteImage` 保持（追加单张）；`updateNoteImage(noteId)` 改为 `sendMessage({type:'updateNote', data:{taskId, noteId, removeImage: filename}})`；handleRemoteUpdateNote 应用 `change.images !== undefined → note.images = change.images`；index.html 备注条目内嵌牌堆（复用 .img-stack 缩小版 `.note-stack`，44×60、抽卡 hover、点击进查看器 `openPreview` 通用化：支持传入 images 数组来源）。

- [ ] **Step 6: 重写 test-note-image.js**（多图语义，≥20 断言）：① 两张图暂存 + addNote(images:[f1,f2]) → note.images=[f1,f2]、uploads 两文件、B 收到含 images 的 addNote 广播；② 第三张直接关联 → images 追加、B 收到 updateNote(images 快照)；③ updateNote removeImage=f1 → images=[f2,f3]、f1 文件清理、B 收到快照广播；④ B 越权 removeImage 被拒（images 不变、无广播）；⑤ deleteNote → 剩余文件全部清理；⑥ 条目级镜像关键路径；⑦ 旧格式迁移冒烟：构造 note.image 字符串数据 → 启动后 images 数组 + backup-note 文件生成；⑧ DELETE 端点反查备注图。保留临时目录/startServer/assert 风格，`process.exit(failed>0?1:0)`。

- [ ] **Step 7: 验证**：`node --check server.js`、`node --check public/app.js`、`node --check test-note-image.js`；四套测试全过（image-lifecycle 25 / note-ownership 12 / note-image 新断言数 / validation-guards 28——validation-guards 若断言了 note.image 单字段则同步适配）。

---

## Task 9: 全量回归 + 手工冒烟 + 打包

- [ ] **Step 1**: 四套测试全绿 + `node --check` 全部改动文件。
- [ ] **Step 2**: 手工冒烟清单（`npm run electron`）：六条既有清单（身份/对话框/排序/备注图/多图/署名）全过 + 新增四条：① 三态连接点（断网/重连观察红绿切换）；② 牌堆抽卡→精准展开→同步变黑→缩回；③ 删除四场景（快点/长按拖出/长按原地/覆盖无回弹）；④ 窄窗任务栏多行 + 宽窗四栏定宽。
- [ ] **Step 3**: `npm run build`（需完整权限，输出 pack814/任务清单.exe），README 功能清单补"新版体验改版"行与日期；分发顺序不变（主机先升级迁移 → 同事全换新包）。

---

## Self-Review

**1. Spec coverage**：设计文档 3.1-3.9 逐条映射——3.1→Task1、3.2→Task2、3.3→Task4、3.4→Task5、3.5-3.7→Task6、3.8→Task7、3.9→Task8；4 响应式→Task3/9；6 协议→Task8。✅
**2. Placeholder scan**：关键代码均给出完整实现（含两条红线：px 钉死高度、禁叠加 transform）；Task6 Step3 的 dialog 打开动画标注了验收标准与降级路径，非占位。✅
**3. Type consistency**：`confirmBugId/dyingBugId/coveringBugId/angryBugId/previewStageReady/pvZoom` 等命名在模板与 JS 一致；`images` 数组贯穿 note 与 bug；`removeImage` 字段三处（updateNote/updateBugNote/反查）对齐。✅
**4. 风险**：列表重构（Task3）是最大变更面，已置于 Task4/5 之前并单独验收；el-table 移除后 `row-key`/`fixed` 等特性不再需要，无功能回退（排序为前端 computed、无表格内排序功能）。
