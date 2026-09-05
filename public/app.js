/**
 * 任务清单 - 多人协同
 * Vue 3 应用核心逻辑
 * 包含：数据绑定、表格编辑、WebSocket 客户端、断线重连
 */
(function () {
  const { createApp, ref, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

  // ==================== UUID 兼容 ====================
  function randomUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback (非 https 或旧浏览器)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /** 一次性 class 动效：加 cls，ms 后移除播完静止（动效仅 JS 触发） */
  function pulse(el, cls, ms) {
    if (!el) return;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }

  const app = createApp({
    setup() {
      // ==================== Electron 自绘标题栏（窗口控制） ====================
      /** 是否 Electron 桌面版（浏览器版不渲染标题栏） */
      const isElectron = !!window.electronAPI?.windowControls;
      /** 窗口是否置顶（标题栏图钉激活态；与托盘菜单双向同步） */
      const winAlwaysOnTop = ref(false);
      /** 窗口是否最大化（标题栏图标切换） */
      const winMaximized = ref(false);

      if (isElectron) {
        const wc = window.electronAPI.windowControls;
        wc.onAlwaysOnTopChange((v) => { winAlwaysOnTop.value = v; });
        wc.onMaximizedChange((v) => { winMaximized.value = v; });
        wc.getAlwaysOnTop().then((v) => { winAlwaysOnTop.value = !!v; });
      }
      function winMinimize() { window.electronAPI?.windowControls?.minimize(); }
      function winMaximizeToggle() { window.electronAPI?.windowControls?.maximizeToggle(); }
      function winClose() { window.electronAPI?.windowControls?.close(); }
      function toggleAlwaysOnTop() {
        const wc = window.electronAPI?.windowControls;
        if (!wc) return;
        wc.setAlwaysOnTop(!winAlwaysOnTop.value).then((v) => { winAlwaysOnTop.value = !!v; });
      }

      // ==================== 主题（10 套成品，仅本机生效，localStorage 持久化） ====================
      const themes = window.BUGLIST_THEMES || [];
      const THEME_KEY = 'buglist_theme';
      const themeId = ref((function () {
        try {
          const saved = localStorage.getItem(THEME_KEY);
          if (saved && themes.some(t => t.id === saved)) return saved;
        } catch (e) { /* 忽略 */ }
        return themes.length ? themes[0].id : '';
      })());
      /** 主题选择面板可见性 */
      const themeMenuVisible = ref(false);
      /** 主题面板退场中（渐隐关闭，不直接消失） */
      const themeMenuLeaving = ref(false);
      /** 主题面板 fixed 坐标（点击按钮时按按钮位置计算，右缘对齐） */
      const themeMenuX = ref(0);
      const themeMenuY = ref(0);

      // ==================== 更多菜单（设置 / 导出 / 导入） ====================
      const moreMenuVisible = ref(false);
      const moreMenuX = ref(0);
      const moreMenuY = ref(0);
      /** 隐藏的导入文件选择器 */
      const importFileInput = ref(null);

      /**
       * 气泡面板共用开关逻辑（主题 / 更多菜单）：togglePopover 开关 + 按按钮位置记锚点（右缘对齐）；
       * fadeClose 渐隐关闭（播放退场动画后隐藏，避免直接消失突兀；仅有 .leaving 样式的面板使用）
       */
      function togglePopover(e, s, width) {
        if (s.leaving && s.leaving.value) return; // 退场动画期间忽略连点
        s.visible.value = !s.visible.value;
        if (s.visible.value && e && e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          s.x.value = Math.max(8, Math.round(r.right - width));
          s.y.value = Math.min(Math.round(r.bottom + 8), Math.max(8, window.innerHeight - 120));
        }
      }
      function fadeClose(s) {
        if (!s.visible.value || s.leaving.value) return;
        s.leaving.value = true;
        setTimeout(() => {
          s.visible.value = false;
          s.leaving.value = false;
        }, 200); // 与 .theme-popover.leaving 退场动画时长一致
      }
      const themeMenu = { visible: themeMenuVisible, leaving: themeMenuLeaving, x: themeMenuX, y: themeMenuY };
      const moreMenu = { visible: moreMenuVisible, x: moreMenuX, y: moreMenuY };
      function toggleThemeMenu(e) { togglePopover(e, themeMenu, 230); } // 面板宽 230px
      function closeThemeMenu() { fadeClose(themeMenu); }
      function toggleMoreMenu(e) { togglePopover(e, moreMenu, 190); } // 面板宽 190px
      function closeMoreMenu() { moreMenu.visible.value = false; }

      // ==================== 设置面板 + 快捷键（存本机 localStorage，不进服务器） ====================
      const SETTINGS_KEY = 'buglist_settings';
      /** 默认快捷键：Alt + 3 */
      const DEFAULT_SHORTCUT = { ctrl: false, alt: true, key: '3' };

      /** 读取本机快捷键设置 */
      function loadShortcut() {
        try {
          const raw = localStorage.getItem(SETTINGS_KEY);
          if (raw) {
            const s = JSON.parse(raw).shortcut;
            if (s && typeof s.key === 'string') {
              return { ctrl: !!s.ctrl, alt: !!s.alt, key: s.key };
            }
          }
        } catch (e) { /* 忽略脏数据 */ }
        return { ...DEFAULT_SHORTCUT };
      }

      /** 当前生效快捷键 */
      const shortcut = ref(loadShortcut());
      /** 设置面板可见 / 退场动画中 */
      const settingsVisible = ref(false);
      const settingsClosing = ref(false);
      /** 面板中的快捷键草稿（确认才生效） */
      const shortcutDraft = ref(null);
      /** 录制新快捷键中 */
      const shortcutRecording = ref(false);

      /** 快捷键显示文本：Ctrl + Alt + 3 */
      function shortcutLabel(s) {
        if (!s || !s.key) return '';
        const mods = [];
        if (s.ctrl) mods.push('Ctrl');
        if (s.alt) mods.push('Alt');
        return [...mods, s.key.toUpperCase()].join(' + ');
      }

      /** 快捷键 → Electron accelerator 文本（如 'Alt+3' / 'Control+Alt+3'），供 globalShortcut 注册 */
      function shortcutAccelerator(s) {
        if (!s || !s.key) return null;
        const mods = [];
        if (s.ctrl) mods.push('Control');
        if (s.alt) mods.push('Alt');
        return [...mods, s.key.toUpperCase()].join('+');
      }

      /** 把当前生效快捷键同步给 Electron 主进程（globalShortcut 注册窗口切换热键）；浏览器版为空操作 */
      async function syncShortcutToMain() {
        const wc = window.electronAPI?.windowControls;
        if (!wc?.setShortcut) return true;
        try {
          return await wc.setShortcut(shortcutAccelerator(shortcut.value));
        } catch (e) { return false; }
      }

      /** 打开设置面板 */
      function openSettings() {
        closeMoreMenu();
        shortcutDraft.value = { ...shortcut.value };
        settingsVisible.value = true;
      }

      /** 关闭设置面板（先播出场动画，animationend 后清状态） */
      function closeSettings() {
        if (!settingsVisible.value) return;
        settingsClosing.value = true;
      }

      function onSettingsAnimEnd() {
        if (settingsClosing.value) {
          settingsVisible.value = false;
          settingsClosing.value = false;
        }
      }

      /** 开关设置面板（快捷键触发） */
      function toggleSettings() {
        if (settingsVisible.value) closeSettings();
        else openSettings();
      }

      /** 开始录制新快捷键（桌面版先注销全局热键，避免录制过程中误触发窗口切换） */
      function startRecordShortcut() {
        shortcutRecording.value = true;
        window.electronAPI?.windowControls?.setShortcut?.(null);
      }

      /**
       * 录制按键捕获：仅允许 Ctrl / Alt（可组合 Ctrl+Alt）+ 一个字母或数字，最多 3 键；Esc 取消
       */
      function onRecordKeydown(e) {
        if (!shortcutRecording.value) return; // 非录制态不拦截任何按键
        e.preventDefault();
        e.stopPropagation();
        const k = e.key;
        if (k === 'Escape') {
          shortcutRecording.value = false;
          syncShortcutToMain(); // 取消录制 → 恢复注册当前生效快捷键
          return;
        }
        if (!/^[a-z0-9]$/i.test(k)) return; // 只认字母/数字
        const ctrl = e.ctrlKey, alt = e.altKey;
        if (!ctrl && !alt) return; // 必须搭配 Ctrl 或 Alt
        if (e.shiftKey || e.metaKey) return; // 仅 Ctrl/Alt 修饰
        shortcutDraft.value = { ctrl, alt, key: k.toLowerCase() };
        shortcutRecording.value = false;
      }

      /** 确认：写入生效快捷键 + 本机缓存 + 同步给主进程注册全局热键 */
      async function confirmSettings() {
        if (shortcutDraft.value) shortcut.value = { ...shortcutDraft.value };
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ shortcut: shortcut.value })); } catch (e) { /* 忽略 */ }
        const ok = await syncShortcutToMain();
        if (!ok) {
          ElementPlus.ElMessage.warning('该快捷键可能已被其他程序占用，注册失败，请换个组合键');
        }
        closeSettings();
      }

      /**
       * 快捷键监听（浏览器版）：匹配当前设置（Ctrl/Alt 精确 + 主键字母/数字，无 Shift/Meta）→ 开关设置面板
       * 桌面版（Electron）此处不做任何事：窗口 最小化↔还原 由主进程 globalShortcut 负责
       * 注：命名避开查看器 Esc 关闭用的 onGlobalKeydown（同名后定义会覆盖先定义，导致快捷键失效）
       */
      function onShortcutKeydown(e) {
        if (isElectron) return; // 桌面版窗口控制走主进程全局热键
        if (shortcutRecording.value) return; // 录制中由 onRecordKeydown 处理
        const s = shortcut.value;
        if (!s) return;
        if (!!e.ctrlKey !== !!s.ctrl) return;
        if (!!e.altKey !== !!s.alt) return;
        if (e.shiftKey || e.metaKey) return;
        if (e.key.toLowerCase() !== s.key.toLowerCase()) return;
        e.preventDefault();
        toggleSettings();
      }

      window.addEventListener('keydown', onShortcutKeydown);
      window.addEventListener('keydown', onRecordKeydown); // 录制时 onShortcutKeydown 被短路，此处统一捕获
      onUnmounted(() => {
        window.removeEventListener('keydown', onShortcutKeydown);
        window.removeEventListener('keydown', onRecordKeydown);
      });

      /**
       * 导出数据：拉取 /api/export 并下载 JSON 备份
       */
      async function exportData() {
        closeMoreMenu();
        try {
          const resp = await fetch(apiUrl('/api/export'));
          const data = await resp.json();
          const stamp = formatTimestamp(new Date()).replace(/[: ]/g, '-');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `任务清单备份-${stamp}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          ElementPlus.ElMessage.success('已导出数据备份（图片在服务端 uploads/ 目录）');
        } catch (err) {
          console.error('[Export] 导出失败:', err);
          ElementPlus.ElMessage.error('导出失败');
        }
      }

      /** 小火箭：点火发射动画 + 平滑回顶；动画播完再退场（suppressing 抑制期间滚动不重触发） */
      function launchRocket() {
        const btn = document.querySelector('.rocket-btn');
        if (btn && !btn.classList.contains('launching')) pulse(btn, 'launching', 1000);
        rocketSuppressing = true; // 回顶是上行，不抑制会立刻自触复现（spec 第 2 节）
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => {
          rocketSuppressing = false;
          rocketVisible.value = false; // 发射动画（0.95s）播完再播退场
        }, 1050);
      }

      /**
       * 选择导入文件：校验 JSON → 确认覆盖 → POST /api/import（服务端写盘并广播全量同步）
       */
      async function onImportFileSelect(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        closeMoreMenu();
        if (!file) return;
        let text;
        try {
          text = await file.text();
          JSON.parse(text); // 预解析校验
        } catch (err) {
          ElementPlus.ElMessage.error('文件不是有效的 JSON');
          return;
        }
        try {
          await ElementPlus.ElMessageBox.confirm('导入将覆盖当前全部数据（项目/任务/备注/状态），确定继续？', '导入数据', {
            type: 'warning',
            confirmButtonText: '覆盖导入',
            cancelButtonText: '取消',
          });
        } catch (err) { return; } // 用户取消
        try {
          const resp = await fetch(apiUrl('/api/import'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: text,
          });
          const r = await resp.json();
          if (r.success) {
            if (r.missingImages > 0) {
              ElementPlus.ElMessage.warning(`导入成功，但有 ${r.missingImages} 张图片未随数据导入（需手动复制服务端 uploads/ 目录）`);
            } else {
              ElementPlus.ElMessage.success('导入成功，数据已覆盖');
            }
          } else {
            ElementPlus.ElMessage.error('导入失败: ' + (r.error || '未知错误'));
          }
        } catch (err) {
          console.error('[Import] 导入失败:', err);
          ElementPlus.ElMessage.error('导入失败，请检查网络');
        }
      }

      /** 兜底固定色板（主题派生色板不可用时使用；正常由当前主题 primary 派生，随主题联动） */
      const FALLBACK_NOTE_COLORS = ['#e6a23c', '#409eff', '#67c23a', '#f56c6c', '#9b59b6', '#1abc9c'];
      /** 当前主题派生色板（applyTheme 时同步更新：负责人 hover 标签 / 备注作者色点共用） */
      let notePalette = null;

      /**
       * 应用主题：注入 <style id="theme-style">（CSS 变量 + 结构性覆盖），立即生效并持久化选择
       */
      function applyTheme(id) {
        const t = themes.find(x => x.id === id);
        if (!t) return;
        themeId.value = id;
        try { localStorage.setItem(THEME_KEY, id); } catch (e) { /* 忽略 */ }
        if (typeof window.buildThemeCss !== 'function') return;
        let st = document.getElementById('theme-style');
        if (!st) { st = document.createElement('style'); st.id = 'theme-style'; document.head.appendChild(st); }
        st.textContent = window.buildThemeCss(t);
        // 同步 JS 侧主题和谐色板（与 buildThemeCss 同源派生）：负责人/备注作者色随主题联动
        if (typeof window.deriveNotePalette === 'function' && t.vars && t.vars.primary) {
          notePalette = window.deriveNotePalette(t.vars.primary);
        }
      }

      /** 改造幕布层（复用节点） */
      let rebuildLayer = null;
      let rebuildTimers = [];

      /**
       * 主题切换 + 暗色幕布过渡：幕布淡入 → 幕布最浓时换肤（零跳变）→ 幕布淡出
       * 全程 ≈1.05s，幕布期间挡点击，有始有终；相同主题不重播。
       */
      function applyThemeRebuild(id) {
        const t = themes.find(x => x.id === id);
        if (!t) return;
        closeThemeMenu();
        if (themeId.value === id) return; // 已是该主题，不重播过渡
        rebuildTimers.forEach(clearTimeout);
        rebuildTimers = [];
        if (!rebuildLayer) {
          rebuildLayer = document.createElement('div');
          rebuildLayer.id = 'theme-rebuild';
          rebuildLayer.className = 'theme-rebuild';
          document.body.appendChild(rebuildLayer);
        }
        rebuildLayer.classList.remove('show');
        void document.body.offsetHeight; // 强制回流，确保挂载动画必然重播（确定性优先）
        rebuildLayer.classList.add('show');
        rebuildTimers.push(setTimeout(() => {
          applyTheme(id);                    // 幕布全屏时换肤，视觉零跳变
          rebuildLayer.classList.remove('show');
        }, 520));
      }
      // setup 阶段立即应用已保存主题（早于首帧渲染，避免默认色闪烁；首载不过渡）
      applyTheme(themeId.value);

      // ==================== 响应式数据 ====================

      /** 所有任务列表 */
      const tasks = ref([]);

      /** 宽窗口标记（≥1200px 时行内列加宽，见 .bug-list-wide） */
      const isWideWindow = ref(false);

      /** 删除/落位确认高亮行 id（spotlight） */
      const confirmBugId = ref(null);

      /** 正在"消亡"（收起动画中）的行 id */
      const dyingBugId = ref(null);

      /** 正在"渐隐"（仅剩一行时淡出）的行 id */
      const fadingBugId = ref(null);

      // ==================== 滚动反馈（共用 rAF 节流监听：吸顶投影 + 小火箭显隐，spec 第 1/2 节） ====================
      const stickyStuck = ref(false);
      const rocketVisible = ref(false);
      let scrollRafId = 0;
      let lastScrollY = 0;
      let rocketSuppressing = false; // 发射回顶期间抑制显隐判定（平滑滚动是上行，防自触复现）
      let panelStickyEl = null;      // 吸顶区元素（onMounted 缓存）
      let titlebarH = 0;             // 自绘标题栏高度（onMounted 量一次 DOM 真实值：0/浏览器、含 Electron 36——与 --titlebar-h 同源，裁决③真正单一事实源）

      const ROCKET_PROGRESS = 0.2; // 滚动进度阈值 20%（退出线）
      const ROCKET_UP_ENTER = 0.04; // 上行"进入缓冲"：显示线 = ROCKET_PROGRESS + 本值（滞后/迟滞，消除临界点一闪而过）
      const ROCKET_MIN_Y = 120;    // 绝对下限：短内容瞄页脚不弹（spec 第 10 节裁决④）
      const SCROLL_EPSILON = 2;    // 方向判定容差（防滚轮抖动翻转）

      function onWinScroll() {
        if (scrollRafId) return;
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = 0;
          const y = window.scrollY;

          // 吸顶投影：吸顶区顶缘贴到标题栏下沿（titlebarH 于 onMounted 量自 DOM 真实高度，与 --titlebar-h 同源）
          if (panelStickyEl) {
            stickyStuck.value = panelStickyEl.getBoundingClientRect().top <= titlebarH + 1;
          }

          // 小火箭状态机：显示=上行 且 进度越过(20%+进入缓冲) 且 过绝对下限；隐藏=下行 或 退回20%以内 / 低于下限（滞后消除临界一闪而过）
          if (!rocketSuppressing) {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            const progress = max > 0 ? y / max : 0;
            const goingUp = y < lastScrollY - SCROLL_EPSILON;
            const goingDown = y > lastScrollY + SCROLL_EPSILON;
            // 进入(显示)线高于退出(隐藏)线 = 迟滞：上滑"预判"会回到 20% 顶区则不显示，避免临界点闪现一帧
            const showEdge = ROCKET_PROGRESS + ROCKET_UP_ENTER;
            if (goingUp && y > ROCKET_MIN_Y && progress > showEdge) {
              rocketVisible.value = true;
            } else if (goingDown || progress <= ROCKET_PROGRESS || y <= ROCKET_MIN_Y) {
              rocketVisible.value = false;
            }
          }
          lastScrollY = y;
        });
      }

      /** 刚插入、播放生长动画的行 id */
      const enteringBugId = ref(null);

      /** 刚上传成功、播放"落牌"动画的图片文件名（card-drop 由 Task 4 预留） */
      const newCardId = ref(null);

      /** 删除按住计时器 / 按下时的按钮矩形（松手扳机保险）/ 按钮元素（蓄怒 class 仅由 JS 控制） */
      let delPressTimer = null, delPressRect = null, delPressEl = null;

      /** 本次按下是否已被按钮自身的 mouseup 处理（窗口级 mouseup 兜底据此跳过） */
      let delUpHandled = false;

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

      /** 拖拽中的任务 id（HTML5 原生拖拽，无第三方依赖） */
      const dragTaskId = ref(null);

      function onTaskDragStart(task) { dragTaskId.value = task.id; }
      function onTaskDragEnd() {
        dragTaskId.value = null;
        clearDropHighlights(); // 拖拽结束兜底：清除任何残留落点高亮
      }

      /** 拖到标签栏空白处：把任务移到列表末尾 */
      function onTaskDropToEnd() {
        const from = dragTaskId.value;
        dragTaskId.value = null;
        if (!from) return;
        const order = orderedTasks.value.map(t => t.id);
        const fromIdx = order.indexOf(from);
        if (fromIdx === -1) return;
        order.splice(fromIdx, 1);
        order.push(from);
        taskOrder.value = order;
        persistTaskOrder();
      }

      /** 当前 dragover 悬停的任务 id（用于落点高亮） */
      const dragOverTaskId = ref(null);

      /** 拖拽经过某个标签：按鼠标 x 位置判定前半区/后半区并高亮 */
      function onTaskDragOver(task, e) {
        e.preventDefault();
        const el = e.currentTarget;
        const rect = el.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        el.classList.toggle('drop-before', before);
        el.classList.toggle('drop-after', !before);
        dragOverTaskId.value = task.id;
      }

      /** 清除全部落点高亮（悬停任务 id + 标签上的指示类） */
      function clearDropHighlights() {
        dragOverTaskId.value = null;
        document.querySelectorAll('.task-tab.drop-before,.task-tab.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
      }

      /** 拖拽离开标签：指针移入子元素不清理，否则清除落点高亮 */
      function onTaskDragLeave(e) {
        const el = e.currentTarget;
        if (e.relatedTarget && el.contains(e.relatedTarget)) return; // 指针移入子元素不清理
        clearDropHighlights();
      }

      /** 落在某个标签上：前半区 = 放到目标前面，后半区 = 放到目标后面 */
      function onTaskDropAt(targetTask, e) {
        e.preventDefault();
        const from = dragTaskId.value;
        dragTaskId.value = null;
        dragOverTaskId.value = null;
        const el = e.currentTarget;
        const rect = el.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        el.classList.remove('drop-before', 'drop-after');
        if (!from || from === targetTask.id) { persistTaskOrder(); return; }
        const order = orderedTasks.value.map(t => t.id);
        const fromIdx = order.indexOf(from);
        if (fromIdx === -1) return;
        order.splice(fromIdx, 1);
        let toIdx = order.indexOf(targetTask.id);
        if (!before) toIdx += 1; // 后半区 = 放到目标后面
        order.splice(toIdx, 0, from);
        taskOrder.value = order;
        persistTaskOrder();
      }

      /** 当前选中的任务 ID */
      const currentTaskId = ref(null);

      // ==================== 用户身份（本地持久化，不进服务器数据） ====================
      const IDENTITY_KEY = 'buglist_identity';
      let identity = null;
      try {
        identity = JSON.parse(localStorage.getItem(IDENTITY_KEY));
        if (!identity || !identity.clientId) identity = null;
      } catch (e) { identity = null; }
      /** 显示名（响应式，供启动对话框输入） */
      const displayName = ref(identity?.displayName || '');

      /** 身份版本号（clientId 被替换时自增，驱动 shortClientId 等重算） */
      const identityVersion = ref(0);

      /** 确保存在稳定 clientId：Electron 用 MAC 哈希，浏览器回退持久化 uuid */
      async function ensureClientId() {
        if (identity && identity.clientId) return identity.clientId;
        let cid = null;
        if (window.electronAPI?.getMacId) {
          try { cid = await window.electronAPI.getMacId(); } catch (e) { cid = null; }
        }
        if (!cid) cid = clientId; // 保留同步占位 uuid
        clientId = cid;
        identityVersion.value++;
        identity = { clientId: cid, displayName: '' };
        try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch (e) { /* 忽略 */ }
        return cid;
      }

      let clientId = identity?.clientId || randomUUID();
      // 同步占位保证 shortClientId 等渲染安全（clientId 永不为 null）；
      // 首次进入时由 ensureClientId 以 MAC 派生值替换，替换发生在任何连接建立之前

      /** WebSocket 实例 */
      let ws = null;

      /** 断线期间的待发消息队列（重连补发，上限 50 条） */
      let pendingQueue = [];

      /** 重连定时器 */
      let reconnectTimer = null;

      /** 重连次数 */
      let reconnectAttempts = 0;

      /** 连接状态：connecting | connected | disconnected */
      const connectionStatus = ref('connecting');

      /** 连接失败原因文案（非空时替换 statusText 显示） */
      const disconnectReason = ref(null);

      /** 上次 onclose 触发时间（防抖：5 秒内重复触发忽略） */
      let lastOnCloseTime = 0;

      /** 是否允许自动重连（首次加载为 false，用户手动改地址后置 true） */
      let allowReconnect = false;

      /** 数据版本号 */
      const dataVersion = ref(0);

      /** 在线客户端数 */
      const onlineCount = ref(1);

      /** 状态选项 */
      const statusOptions = ['待修复', '修复中', '已完成'];

      /** 状态排序映射：待修复(0) → 修复中(1) → 已完成(2)，已完成永远在最下面 */
      const STATUS_ORDER = { '待修复': 0, '修复中': 1, '已完成': 2 };

      /** 正在编辑名称的任务 ID */
      const editingBugId = ref(null);

      /** 状态筛选条件（默认"全部"即不筛选） */
      const statusFilter = ref('全部');

      /** 任务名称搜索关键字（纯前端过滤） */
      const searchText = ref('');

      /** 组内排序方向：true=倒序（新来的在前），false=正序（新来的在后）；仅本机生效 */
      const SORT_KEY = 'buglist_sort_desc';
      const sortDesc = ref((function () {
        try { return localStorage.getItem(SORT_KEY) === '1'; } catch (e) { return true; }
      })()); // 默认倒序：新任务默认在第一行（用户偏好）

      /**
       * 切换排序方向（正序/倒序），切换时手动 FLIP 让所有行平滑滑到新位置
       */
      function toggleSort() {
        sortDesc.value = !sortDesc.value;
        try { localStorage.setItem(SORT_KEY, sortDesc.value ? '1' : '0'); } catch (e) { /* 忽略 */ }
        const rows = Array.from(document.querySelectorAll('.bug-rows .bug-row'));
        const oldRects = captureRects(rows);
        nextTick(() => {
          flipRowsWithRects(rows, oldRects); // 行滑到新的组内位置（无跳变）
        });
      }

      /** 计数徽标闪烁的目标状态（行移动动画完成后触发） */
      const flashStatus = ref(null);
      let pendingFlashStatus = null;   // 最近一次状态变更的目标（供 watch 消费一次）
      let pendingFlashTimer = null;
      let countFlashTimer = null;

      /** 服务器地址（优先读 localStorage，fallback 当前 host） */
      const serverHost = ref(
        (function () {
          try {
            const saved = localStorage.getItem('buglist_server_host');
            if (saved) return saved;
          } catch (e) { /* 静默忽略 */ }
          return location.host;
        })()
      );

      // ==================== 启动模式选择 ====================

      /** 是否显示启动模式对话框 */
      const showStartupDialog = ref(false);

      /** 当前选择的模式: null | 'server' | 'client' */
      const startupMode = ref(null);

      /** 客户端模式下的地址输入 */
      const startupAddressInput = ref('');

      /** 当前页面 host（服务器模式下显示用，异步获取真实 IP 后更新） */
      const locationHost = ref(location.hostname);
      const locationPort = location.port;

      // ==================== 编辑状态 ====================

      /** 编辑前的名称（用于取消时恢复） */
      let editNameBackup = '';

      /** 图片上传：当前正在操作的任务 ID（用于文件选择器关联） */
      const currentImageBugId = ref(null);

      /** 大图预览对话框可见性 */
      const imagePreviewVisible = ref(false);

      /** 当前预览的图片集合（多图） */
      const previewImages = ref([]);

      /** 当前预览的图片索引 */
      const previewIndex = ref(0);

      /** 当前预览图片 URL：由 previewImages[previewIndex] 派生（模板直接渲染 previewImages，此值仅供预加载器） */
      const previewImageUrl = computed(() => '//' + serverHost.value + '/uploads/' + encodeURIComponent(previewImages.value[previewIndex.value]));

      /** 当前预览的图片归属 bug（牌堆预览才有；备注图预览为 null → 查看器不显示删除钮） */
      const previewBug = ref(null);

      /** 查看器内删除确认框可见性 */
      const previewDeleteVisible = ref(false);

      /** 隐藏文件输入框引用 */
      const fileInputRef = ref(null);

      /** 截图方式选择气泡 */
      const imageMenuVisible = ref(false);
      const imageMenuX = ref(0);
      const imageMenuY = ref(0);

      /** 粘贴截图对话框 */
      const pasteDialogVisible = ref(false);
      const pasteBlob = ref(null);
      const pastePreviewUrl = ref('');
      const pasteAreaRef = ref(null);
      const pasteTargetBugId = ref(null);

      /** 任务备注弹窗 */
      const notesDialogVisible = ref(false);
      const notesDialogTaskId = ref(null);
      const newNoteContent = ref('');

      /** 任务备注 - 待提交的备注图片文件列表（本地暂存多图，提交时逐张上传） */
      const pendingNoteFiles = ref([]);
      const pendingNoteFileUrls = ref([]);
      /** 任务备注 - 正在为已有备注附加图片的目标（null 表示"新备注待提交"模式） */
      const attachTargetNote = ref(null);
      /** 任务备注 - 隐藏文件输入框引用 */
      const noteFileInput = ref(null);

      /** 任务备注弹窗 */
      const bugNotesVisible = ref(false);
      const bugNotesTaskId = ref(null);
      const bugNotesBugId = ref(null);
      const newBugNoteContent = ref('');

      /** 条目备注 - 待提交的备注图片文件列表（本地暂存多图，提交时逐张上传） */
      const pendingBugNoteFiles = ref([]);
      const pendingBugNoteFileUrls = ref([]);
      /** 条目备注 - 正在为已有备注附加图片的目标（null 表示"新备注待提交"模式） */
      const attachTargetBugNote = ref(null);
      /** 条目备注 - 隐藏文件输入框引用 */
      const bugNoteFileInput = ref(null);

      // ==================== 计算属性 ====================

      /** 短客户端 ID（用于显示） */
      const shortClientId = computed(() => {
        identityVersion.value; // 读取以建立响应式依赖：clientId 替换后强制重算
        return clientId.substring(0, 8);
      });

      /** 当前任务对象 */
      const currentTask = computed(() => {
        return tasks.value.find(t => t.id === currentTaskId.value) || tasks.value[0];
      });

      /** 连接状态文字（连接失败时显示错误原因） */
      const statusText = computed(() => {
        if (disconnectReason.value) {
          return disconnectReason.value;
        }
        const map = {
          connecting: '正在连接...',
          connected: '已连接',
          disconnected: '连接断开',
        };
        return map[connectionStatus.value] || '未知';
      });

      /** 筛选并排序后的 任务列表（先筛选再排序，同状态保持原序） */
      const filteredAndSortedBugs = computed(() => {
        const bugs = currentTask.value?.bugs || [];
        let list = bugs.filter(b => !b.archived); // 归档行不进主列表/筛选/搜索/计数（spec 第 7 节）
        // 筛选
        if (statusFilter.value !== '全部') {
          list = list.filter(b => b.status === statusFilter.value);
        }
        // 搜索：任务名称包含关键字（不区分大小写）
        const kw = searchText.value.trim().toLowerCase();
        if (kw) {
          list = list.filter(b => (b.name || '').toLowerCase().includes(kw));
        }
        // 排序：待修复(0) → 修复中(1) → 已完成(2)；组内按 statusChangedAt（倒序=新的在前/正序=旧的在前），稳定排序
        return [...list].sort((a, b) => {
          const g = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
          if (g !== 0) return g;
          const ta = a.statusChangedAt || 0, tb = b.statusChangedAt || 0;
          return sortDesc.value ? tb - ta : ta - tb;
        });
      });

      /** 备注弹窗对应的任务 */
      const notesDialogTask = computed(() => {
        return tasks.value.find(t => t.id === notesDialogTaskId.value) || null;
      });

      /** 各状态任务数量（用于筛选按钮显示） */
      const statusCounts = computed(() => {
        const bugs = (currentTask.value?.bugs || []).filter(b => !b.archived); // 归档不计数（spec 第 7 节）
        const counts = { '全部': bugs.length };
        statusOptions.forEach(opt => {
          counts[opt] = bugs.filter(b => b.status === opt).length;
        });
        return counts;
      });

      // ==================== 归档体系（spec 第 7 节） ====================
      const archivedBugs = computed(() => {
        const bugs = currentTask.value?.bugs || [];
        return bugs.filter(b => b.archived).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0)); // 最新归档在顶卡
      });
      const archiveExpanded = ref(false); // 纯本地 UI 状态，不广播不同步
      const archiveFlash = ref(false);    // 归档入堆时堆计数闪烁

      function toggleArchive() { archiveExpanded.value = !archiveExpanded.value; }

      /** 归档：仅已完成（服务端防线同规则）；复用删除渐隐 220ms 后出列入堆 */
      function archiveBug(bug) {
        if (bug.status !== '已完成' || bug.archived === true) return;
        if (dyingBugId.value || fadingBugId.value) return; // 与删除动画互斥（同 confirmDeleteBug 守卫）
        const targetTaskId = currentTaskId.value; // 定格点击时所属项目，防 220ms 内切项目致广播发往错项目（审查#2）
        fadingBugId.value = bug.id;
        setTimeout(() => {
          fadingBugId.value = null;
          // 220ms 内可能经历 fullSync（bugs 换成 spread 副本）或切项目：按 id 在定格项目里重查活对象，避免写到孤儿（审查#1）
          const live = tasks.value.find(t => t.id === targetTaskId)?.bugs.find(b => b.id === bug.id);
          if (!live) return; // 原对象已失效（被删 / 项目消失）：放弃本地归档，服务端仍会广播权威态
          live.archived = true;
          live.archivedAt = Date.now();
          sendUpdate(live.id, 'archived', true, targetTaskId);
          archiveFlash.value = true;
          setTimeout(() => { archiveFlash.value = false; }, 700);
        }, 220);
      }

      /** 恢复：回主列表已完成组（statusChangedAt 不变，原位排序） */
      function restoreBug(bug) {
        if (bug.archived !== true) return;
        bug.archived = false;
        delete bug.archivedAt;
        sendUpdate(bug.id, 'archived', false);
      }

      // ==================== WebSocket 连接 ====================

      /**
       * 建立 WebSocket 连接
       */
      function connectWebSocket() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          return;
        }

        connectionStatus.value = 'connecting';
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${serverHost.value}`;

        try {
          ws = new WebSocket(url);
        } catch (err) {
          console.error('[WS] 创建连接失败:', err);
          scheduleReconnect();
          return;
        }

        ws.onopen = function () {
          console.log('[WS] 连接已建立');
          connectionStatus.value = 'connected';
          disconnectReason.value = null;
          allowReconnect = true;
          reconnectAttempts = 0;
          // 先补发离线期间的暂存消息（服务端依次处理），再请求全量同步拿最新状态
          if (pendingQueue.length) {
            const n = pendingQueue.length;
            console.log(`[WS] 补发 ${n} 条离线消息`);
            pendingQueue.forEach(m => ws.send(JSON.stringify(m)));
            pendingQueue = [];
            ElementPlus.ElMessage.info(`离线期间的 ${n} 条修改已同步`);
          }
          sendMessage({ type: 'requestSync', clientId });
        };

        ws.onmessage = function (event) {
          try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
          } catch (err) {
            console.error('[WS] 消息解析失败:', err);
          }
        };

        ws.onclose = function (event) {
          console.log('[WS] 连接关闭, code:', event.code);
          ws = null;

          // 断开时立即备份一次，确保最新数据不丢失
          doBackupNow();

          // 防抖：5 秒内重复触发忽略，避免提示闪烁
          const now = Date.now();
          if (now - lastOnCloseTime < 5000) {
            return;
          }
          lastOnCloseTime = now;

          connectionStatus.value = 'disconnected';

          if (!allowReconnect) {
            // 保存的地址连接失败：不静默重连，显示错误提示让用户手动修改地址
            disconnectReason.value = '连接失败，服务器端口可能已变更，请联系服务端确认地址';
          } else {
            scheduleReconnect();
          }
        };

        ws.onerror = function (err) {
          console.error('[WS] 连接错误:', err);
        };
      }

      /**
       * 指数退避重连（带随机抖动）
       */
      function scheduleReconnect() {
        if (reconnectTimer) return;

        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000) + Math.random() * 1000;
        reconnectAttempts++;
        console.log(`[WS] 将在 ${Math.round(delay)}ms 后重连（第 ${reconnectAttempts} 次）`);

        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWebSocket();
        }, delay);
      }

      /**
       * 发送 WebSocket 消息
       * 连接未就绪时暂存到待发队列（上限 50 条），重连成功后补发；
       * 手动切换服务器时（disconnect）清空队列，避免消息发到错误的目标。
       */
      function sendMessage(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        } else {
          if (pendingQueue.length < 50) {
            pendingQueue.push(msg);
            console.warn('[WS] 连接未就绪，消息已暂存待补发:', msg.type);
          } else {
            console.warn('[WS] 待发队列已满（50 条），丢弃消息:', msg.type);
          }
        }
      }

      /**
       * 发送更新消息
       */
      function sendUpdate(bugId, field, value, taskId = currentTaskId.value) {
        sendMessage({
          type: 'update',
          clientId,
          data: { taskId, bugId, field, value },
        });
      }

      /**
       * 发送新增消息
       */
      function sendAdd(bugId) {
        const bugs = currentTask.value?.bugs || [];
        const bug = bugs.find((b) => b.id === bugId);
        if (!bug) return;
        sendMessage({
          type: 'add',
          clientId,
          data: { taskId: currentTaskId.value, bug },
        });
      }

      /**
       * 发送删除消息
       */
      function sendDelete(bugId) {
        sendMessage({
          type: 'delete',
          clientId,
          data: { taskId: currentTaskId.value, bugId },
        });
      }

      // ==================== 消息处理 ====================

      /**
       * 处理服务端消息
       */
      function handleMessage(msg) {
        switch (msg.type) {
          case 'fullSync':
            handleFullSync(msg);
            break;
          case 'broadcast':
            handleBroadcast(msg);
            break;
          case 'clientCount':
            onlineCount.value = msg.count || 1;
            break;
          default:
            console.log('[WS] 未知消息类型:', msg.type);
        }
      }

      /**
       * 处理全量同步
       */
      function handleFullSync(msg) {
        archiveExpanded.value = false; // 全量同步收起归档展开（裁决⑥）
        if (msg.data && Array.isArray(msg.data.tasks)) {
          // 合并式应用：保留在途编辑的对象引用，避免输入框绑定对象被整体替换导致内容丢失
          const incomingTasks = msg.data.tasks;
          const localTasks = tasks.value;
          const merged = [];

          for (const t of incomingTasks) {
            const localTask = localTasks.find(lt => lt.id === t.id);
            if (!localTask) {
              // 本地不存在 → 用传入副本（bugs 深拷贝一层）
              merged.push({
                ...t,
                bugs: (t.bugs || []).map(b => ({ ...b })),
              });
              continue;
            }
            if (editingTaskId.value === t.id) {
              // 正在重命名该任务 → 保留本地 task 对象（输入框绑定对象不被替换）
              merged.push(localTask);
              continue;
            }
            // 其余情况：替换为传入副本，但其 bugs 中正在编辑名称的 bug 保留本地对象；
            // 备注弹窗打开中的任务保留本地 notes；条目备注弹窗打开中的 bug 保留本地对象
            const preserveTaskNotes = notesDialogVisible.value && notesDialogTaskId.value === t.id;
            const mergedBugs = (t.bugs || []).map(b => {
              const isEditingBug = b.id === editingBugId.value;
              const isBugNotesOpen = bugNotesVisible.value && bugNotesTaskId.value === t.id && bugNotesBugId.value === b.id;
              if (isEditingBug || isBugNotesOpen) {
                const localBug = localTask.bugs.find(lb => lb.id === b.id);
                return localBug || { ...b };
              }
              return { ...b };
            });
            merged.push({ ...t, bugs: mergedBugs, notes: preserveTaskNotes ? (localTask.notes || []) : t.notes });
          }

          tasks.value = merged;
        }
        // 恢复或设定 currentTaskId
        if (!currentTaskId.value || !tasks.value.find(t => t.id === currentTaskId.value)) {
          currentTaskId.value = tasks.value[0]?.id || null;
        }
        if (msg.version !== undefined) {
          dataVersion.value = msg.version;
        }
        console.log(`[WS] 全量同步完成，共 ${tasks.value.length} 个任务，当前任务: ${currentTask.value?.name || '无'}，版本 v${dataVersion.value}`);

        // 启动本地备份定时器（Electron 客户端每30s存一份到本地磁盘）
        startBackupTimer();
        // 连接成功后立即备份一次
        doBackupNow();
      }

      /**
       * 处理广播消息（其他客户端的变更）
       */
      function handleBroadcast(msg) {
        // 版本号先推进：即使广播来自自己（随后被 originClientId 过滤）或 change 为空，
        // 版本号也应与服务器保持一致，避免发起方本地版本号滞后
        if (msg.version !== undefined) {
          dataVersion.value = msg.version;
        }

        // 唯一防护：忽略自己发出的变更（广播是异步事件，不存在同步窗口内的本地标记，无需第二层检查）
        if (msg.originClientId === clientId) {
          console.log(`[WS] 忽略自己的广播: change=${JSON.stringify(msg.change)}`);
          return;
        }

        if (!msg.change) return;

        const { type, taskId, bugId, field, value, completedAt, statusChangedAt, archivedAt } = msg.change;
        console.log(`[WS] 收到广播: type=${type}, taskId=${taskId?.substring(0,8)}, bugId=${bugId}, field=${field}, value=${value}, completedAt=${completedAt}, 来源=${(msg.originClientId || '?').substring(0,8)}`);

        switch (type) {
          case 'add':
            handleRemoteAdd(msg);
            break;
          case 'update':
            handleRemoteUpdate(taskId, bugId, field, value, completedAt, statusChangedAt, archivedAt);
            break;
          case 'delete':
            handleRemoteDelete(taskId, bugId);
            break;
          case 'addImage':
            handleRemoteAddImage(msg.change.taskId, msg.change.bugId, msg.change.filename);
            break;
          case 'removeImage':
            handleRemoteRemoveImage(msg.change.taskId, msg.change.bugId, msg.change.filename);
            break;
          case 'createTask':
            handleRemoteCreateTask(msg.change);
            break;
          case 'updateTask':
            handleRemoteUpdateTask(msg.change);
            break;
          case 'deleteTask':
            handleRemoteDeleteTask(msg.change);
            break;
          case 'addNote':
            handleRemoteAddNote(msg.change);
            break;
          case 'updateNote':
            handleRemoteUpdateNote(msg.change);
            break;
          case 'deleteNote':
            handleRemoteDeleteNote(msg.change);
            break;
          case 'addBugNote':
            handleRemoteAddBugNote(msg.change);
            break;
          case 'updateBugNote':
            handleRemoteUpdateBugNote(msg.change);
            break;
          case 'deleteBugNote':
            handleRemoteDeleteBugNote(msg.change);
            break;
        }
      }

      /**
       * 广播定位公共路径：本地找不到 task（或 bug）＝状态漂移 → 请求全量同步并返回 null
       */
      function locateTask(taskId, who) {
        const task = tasks.value.find(t => t.id === taskId);
        if (!task) {
          console.log(`[WS] ${who}: taskId=${taskId?.substring(0, 8)} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
        }
        return task || null;
      }
      function locateBug(taskId, bugId, who) {
        const task = locateTask(taskId, who);
        if (!task) return null;
        const bug = task.bugs.find(b => b.id === bugId);
        if (!bug) {
          console.log(`[WS] ${who}: bugId=${bugId} 在 taskId=${taskId?.substring(0, 8)} 中未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return null;
        }
        return { task, bug };
      }

      /**
       * 处理远程新增
       */
      function handleRemoteAdd(msg) {
        const change = msg.change;
        if (!change || !change.bug || !change.taskId) return;
        const task = locateTask(change.taskId, 'handleRemoteAdd');
        if (!task) return;
        const newBug = { ...change.bug };
        // 检查是否已存在（防重复）
        if (!task.bugs.some(b => b.id === newBug.id)) {
          task.bugs.push(newBug);
        }
      }

      /**
       * 处理远程更新
       */
      function handleRemoteUpdate(taskId, bugId, field, value, completedAt, statusChangedAt, archivedAt) {
        const loc = locateBug(taskId, bugId, 'handleRemoteUpdate');
        if (!loc) return;
        const bug = loc.bug;

        // 第三层防护：新旧值相同时跳过
        if (bug[field] === value && completedAt === undefined && statusChangedAt === undefined && archivedAt === undefined) {
          console.log(`[WS] handleRemoteUpdate: bugId=${bugId} ${field} 值相同，跳过 (${value})`);
          return;
        }

        console.log(`[WS] handleRemoteUpdate: taskId=${taskId?.substring(0,8)}, bugId=${bugId}, ${field}=${value} (旧值=${bug[field]})`);
        bug[field] = value;
        if (field === 'status') triggerStatusIconAnim(bug);

        // 同步 completedAt 时间锚点
        if (completedAt !== undefined) {
          if (completedAt === null) {
            delete bug.completedAt;
          } else {
            bug.completedAt = completedAt;
          }
        }
        // 同步 statusChangedAt（组内排序依据：新来的往组末尾）
        if (statusChangedAt !== undefined) {
          bug.statusChangedAt = statusChangedAt;
        }
        // 同步 archivedAt（归档时间锚点；null = 恢复时删除，与归档/恢复字段配套广播）
        if (archivedAt !== undefined) {
          if (archivedAt === null) {
            delete bug.archivedAt;
          } else {
            bug.archivedAt = archivedAt;
          }
        }
      }

      /**
       * 处理远程删除
       */
      function handleRemoteDelete(taskId, bugId) {
        const task = tasks.value.find(t => t.id === taskId);
        if (!task) return;
        const index = task.bugs.findIndex(b => b.id === bugId);
        if (index !== -1) {
          // 图片文件由服务端在数据写盘成功后统一清理，这里只改本地状态
          task.bugs.splice(index, 1);
        }
      }

      /**
       * 处理远程新增图片（追加到 bug.images）
       */
      function handleRemoteAddImage(taskId, bugId, filename) {
        const loc = locateBug(taskId, bugId, 'handleRemoteAddImage');
        if (!loc) return;
        const bug = loc.bug;
        if (!Array.isArray(bug.images)) bug.images = [];
        if (!bug.images.includes(filename)) bug.images.push(filename);
      }

      /**
       * 处理远程移除单张图片
       */
      function handleRemoteRemoveImage(taskId, bugId, filename) {
        const loc = locateBug(taskId, bugId, 'handleRemoteRemoveImage');
        if (!loc) return;
        const bug = loc.bug;
        if (Array.isArray(bug.images)) {
          const i = bug.images.indexOf(filename);
          if (i !== -1) bug.images.splice(i, 1);
        }
      }

      // ==================== 任务级远程操作 ====================

      function handleRemoteCreateTask(change) {
        if (!change.task) return;
        if (!tasks.value.some(t => t.id === change.task.id)) {
          tasks.value.push({ ...change.task, bugs: [] });
        }
      }

      function handleRemoteUpdateTask(change) {
        // 防御：服务端只允许 name 字段且为字符串，客户端同样忽略非法变更
        if (change.field !== 'name' || typeof change.value !== 'string') return;
        const task = tasks.value.find(t => t.id === change.taskId);
        if (task) {
          task[change.field] = change.value;
        }
      }

      function handleRemoteDeleteTask(change) {
        const index = tasks.value.findIndex(t => t.id === change.taskId);
        if (index !== -1) {
          tasks.value.splice(index, 1);
          persistTaskOrder();
          // 如果当前选中的任务被删除了，切换到第一个
          if (currentTaskId.value === change.taskId) {
            currentTaskId.value = tasks.value[0]?.id || null;
          }
        }
      }

      // ==================== 远程备注操作 ====================

      function handleRemoteAddNote(change) {
        const task = locateTask(change.taskId, 'handleRemoteAddNote');
        if (!task) return;
        if (!task.notes) task.notes = [];
        if (!task.notes.some(n => n.id === change.note.id)) {
          task.notes.push({ ...change.note });
        }
      }

      function handleRemoteUpdateNote(change) {
        const task = tasks.value.find(t => t.id === change.taskId);
        if (!task || !task.notes) return;
        const note = task.notes.find(n => n.id === change.noteId);
        if (note) {
          if (change.content !== undefined) {
            note.content = change.content;
            note.updatedAt = change.updatedAt;
          }
          if (change.images !== undefined) note.images = change.images; // 多图快照替换（服务端广播完整数组）
        }
      }

      function handleRemoteDeleteNote(change) {
        const task = tasks.value.find(t => t.id === change.taskId);
        if (!task || !task.notes) return;
        const index = task.notes.findIndex(n => n.id === change.noteId);
        if (index !== -1) {
          task.notes.splice(index, 1);
        }
      }

      // ==================== 远程 任务备注操作 ====================

      function handleRemoteAddBugNote(change) {
        const loc = locateBug(change.taskId, change.bugId, 'handleRemoteAddBugNote');
        if (!loc) return;
        const bug = loc.bug;
        if (!bug.notes) bug.notes = [];
        if (!bug.notes.some(n => n.id === change.note.id)) {
          bug.notes.push({ ...change.note });
        }
      }

      function handleRemoteUpdateBugNote(change) {
        const task = tasks.value.find(t => t.id === change.taskId);
        if (!task) return;
        const bug = task.bugs.find(b => b.id === change.bugId);
        if (!bug || !bug.notes) return;
        const note = bug.notes.find(n => n.id === change.noteId);
        if (note) {
          if (change.content !== undefined) {
            note.content = change.content;
            note.updatedAt = change.updatedAt;
          }
          if (change.images !== undefined) note.images = change.images; // 多图快照替换（服务端广播完整数组）
        }
      }

      function handleRemoteDeleteBugNote(change) {
        const task = tasks.value.find(t => t.id === change.taskId);
        if (!task) return;
        const bug = task.bugs.find(b => b.id === change.bugId);
        if (!bug || !bug.notes) return;
        const index = bug.notes.findIndex(n => n.id === change.noteId);
        if (index !== -1) {
          bug.notes.splice(index, 1);
        }
      }

      // ==================== 服务器地址切换 ====================

      /**
       * 断开当前连接
       */
      function disconnect() {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectAttempts = 0;
        pendingQueue = []; // 手动切换服务器：清空待发队列，避免消息发到错误目标
        if (ws) {
          ws.onclose = null;
          ws.close();
          ws = null;
        }
      }

      /**
       * 服务器地址变更 → 持久化 → 断开旧连接 → 连接新服务器
       */
      function onServerChange(newHost) {
        if (!newHost || newHost === serverHost.value) return;
        serverHost.value = newHost;

        // 持久化到 localStorage
        try {
          localStorage.setItem('buglist_server_host', newHost);
        } catch (e) { /* 静默忽略 */ }

        // 重置防抖计数器，恢复自动重连逻辑
        lastOnCloseTime = 0;
        disconnectReason.value = null;
        allowReconnect = true;

        disconnect();
        connectWebSocket();
      }

      // ==================== 任务操作 ====================

      /**
       * 获取状态下拉选项的样式类
       */
      function getStatusClass(status) {
        if (status === '待修复') return 'status-pending';
        if (status === '修复中') return 'status-fixing';
        if (status === '已完成') return 'status-done';
        return '';
      }

      /**
       * 设置状态筛选条件
       */
      function setStatusFilter(filter) {
        statusFilter.value = filter;
      }

      /**
       * 筛选按钮激活态样式类
       */
      function filterStatusClass(filter) {
        return statusFilter.value === filter ? 'filter-active' : '';
      }

      /** 捕获当前列表中所有行的位置（FLIP 用） */
      function captureRects(rows) {
        const m = new Map();
        rows.forEach(r => m.set(r.dataset.bugId, r.getBoundingClientRect()));
        return m;
      }

      /**
       * 手动 FLIP：让行从旧位置滑到新位置，不依赖 Vue 过渡系统。
       * 匀速策略（"下楼"模型）：每层恒定 ROW_MS ms；一屏约 VISIBLE_LEVELS 行——
       * 移动 ≤ 一屏时全程匀速；移动 > 一屏时，可视部分匀速跑完（≈2.5s），
       * 出屏后的剩余距离在结束时瞬间到位（没人看得见，不影响观感）。
       * 钉回旧位置后强制回流提交中间状态（双 rAF 可能同帧执行导致无过渡=瞬移）。
       * @param {Element[]} rows 参与动画的行
       * @param {Map} oldRects 变更前捕获的位置
       */
      function flipRowsWithRects(rows, oldRects) {
        if (!rows || !rows.length) return;
        const ROW_MS = 60, MIN_MS = 200, VISIBLE_LEVELS = 10; // 可视匀速段 10 层 ≈ 0.6s，之后弹射到位
        const VH = window.innerHeight; // 视口高度：屏幕外行程瞬移，视口内行程匀速
        requestAnimationFrame(() => {
          // 量行高（用于"层数"换算）
          let totalH = 0, n = 0;
          rows.forEach(r => {
            if (!r.isConnected) return;
            const o = oldRects.get(r.dataset.bugId);
            if (!o) return;
            totalH += r.getBoundingClientRect().height;
            n++;
          });
          if (!n) return;
          const rowH = totalH / n + 7; // +7 = .bug-rows 的 gap
          const moves = [];
          rows.forEach(r => {
            if (!r.isConnected) return;
            const o = oldRects.get(r.dataset.bugId);
            if (!o) return;
            const nr = r.getBoundingClientRect();
            const dx = o.left - nr.left, dy = o.top - nr.top;
            if (!dx && !dy) return;
            const oldTop = o.top, newTop = nr.top;
            // 可视行程：行 top 在视口内的移动区间。
            // 向上移：视口底缘 → 终点（起点在屏幕外的部分先瞬移）
            // 向下移：起点 → 视口底缘（终点在屏幕外的部分后瞬移）
            let v0, v1;
            if (dy < 0) { v0 = Math.min(VH, oldTop); v1 = Math.max(0, newTop); }
            else { v0 = Math.max(0, oldTop); v1 = Math.min(VH, newTop); }
            // 匀速段封顶 3 层（≈1s），之后弹射到位——不拖时间
            const visTravel = Math.min(Math.abs(v1 - v0), VISIBLE_LEVELS * rowH);
            const animEnd = v0 + Math.sign(v1 - v0) * visTravel;
            const levels = Math.max(1, Math.round(visTravel / rowH));
            moves.push({ el: r, dx, dy, newTop, v0, animEnd, dur: Math.max(MIN_MS, levels * ROW_MS) });
          });
          if (!moves.length) return;
          // 找出位移最大的"主角"行（长距离移动的那一行）
          let mover = moves[0];
          moves.forEach(m => { if (Math.abs(m.dy) > Math.abs(mover.dy)) mover = m; });
          // 钉回旧位置 + 强制回流（提交中间状态，过渡才有起点）
          // 层级提升：只有"主角"给高 z-index（999），其余让位行保持普通层级——
          // 若所有行都给相同 z-index，它们之间仍按 DOM 顺序绘制，主角会被同组靠后的行盖住。
          moves.forEach(m => {
            m.el.style.transition = 'none';
            m.el.style.transform = 'translate(' + m.dx + 'px,' + m.dy + 'px)';
            if (m === mover) {
              m.el.style.position = 'relative';
              m.el.style.zIndex = '999';
              m.el.style.boxShadow = 'var(--shadow-hover)';
            }
          });
          void document.body.offsetHeight;
          // rAF 逐帧驱动：屏幕外行程瞬移，视口内行程匀速（恒定步速）
          const start = performance.now();
          function tick(now) {
            const t = now - start;
            let pending = false;
            moves.forEach(m => {
              if (!m.el.isConnected) return;
              const p = Math.min(1, t / m.dur);
              // 行的 top：结束帧弹射到位；中间在匀速段 [v0, animEnd] 匀速
              const top = p >= 1 ? m.newTop : m.v0 + (m.animEnd - m.v0) * p;
              const tx = m.dx * p;
              const ty = top - m.newTop;
              m.el.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
              if (p < 1) pending = true;
            });
            if (pending) {
              requestAnimationFrame(tick);
            } else {
              moves.forEach(m => {
                if (m.el.isConnected) {
                  m.el.style.transform = '';
                  m.el.style.transition = '';
                  m.el.style.position = '';
                  m.el.style.zIndex = '';
                  m.el.style.boxShadow = '';
                }
              });
            }
          }
          requestAnimationFrame(tick);
        });
      }

      /**
       * 筛选视图：行"被吸收"飞出——瞄准筛选栏对应状态 tag，目标点略靠下 30px + 缩小 + 淡出 + 高度收起，1s。
       * 1s 后再真正改状态（行被滤除时已透明缩小，移除不可感知）
       */
      function flyRowToTag(bug, rowEl, newStatus) {
        const r = rowEl.getBoundingClientRect();
        // 目标 = 目标状态 tag 按钮（按钮顺序：全部, 待修复, 修复中, 已完成 → 按序号取，不依赖属性）
        let dx = 0, dy = 0;
        const bar = document.querySelector('.filter-buttons');
        if (bar) {
          const btns = Array.from(bar.querySelectorAll('.el-button'));
          const idx = statusOptions.indexOf(newStatus); // 0=待修复 1=修复中 2=已完成
          const btn = btns[idx + 1];
          let bx, by;
          if (btn) {
            const b = btn.getBoundingClientRect();
            bx = b.left + b.width / 2;
            by = b.top + b.height / 2;
          } else {
            // 兜底：按序号在筛选栏内均匀分布（仍分三档横向位置）
            const br = bar.getBoundingClientRect();
            bx = br.left + (idx + 1) / (statusOptions.length + 1) * br.width;
            by = br.top + br.height / 2;
          }
          dx = bx - (r.left + r.width / 2);
          dy = by - (r.top + r.height / 2);
        } else {
          dy = -r.height - 20; // 没有筛选栏时向上飞出
        }
        dy += 30; // 目标点略靠下 30px（不必正中 tag，观感更自然）
        // 飞行：行留在文档流内，高度同步收起（槽位平滑闭合，下方行自然上移补位，无需 FLIP）
        // 视觉 = 行瞄准筛选栏下 30px + 缩小 + 淡出 + 槽位收拢，"被吸收"过程连贯无空洞
        const h = rowEl.offsetHeight;
        rowEl.style.height = h + 'px';           // 钉住初始高度（auto→0 无法过渡）
        rowEl.style.minHeight = '0px';
        rowEl.style.paddingTop = '0px';
        rowEl.style.paddingBottom = '0px';
        rowEl.style.borderTopWidth = '0px';
        rowEl.style.borderBottomWidth = '0px';
        rowEl.style.marginBottom = '-7px';       // 抵消 .bug-rows 的 gap，收起不留缝
        rowEl.style.overflow = 'hidden';
        rowEl.style.pointerEvents = 'none';
        rowEl.style.position = 'relative';
        rowEl.style.zIndex = '999'; // 飞行中浮到所有行之上（避免被下方补位行盖住）
        rowEl.style.boxShadow = 'var(--shadow-hover)';
        rowEl.style.transition = 'transform 1s cubic-bezier(.3,1.2,.4,1), opacity 1s ease, height 1s cubic-bezier(.3,1.2,.4,1), padding-top 1s ease, padding-bottom 1s ease, border-top-width 1s ease, border-bottom-width 1s ease';
        void rowEl.offsetHeight;                 // 强制回流：提交"初始高度 + 原位"状态
        rowEl.style.transformOrigin = '50% 50%';
        rowEl.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.15)';
        rowEl.style.opacity = '0';
        rowEl.style.height = '0px';
        // 1s 后：改状态（行被滤除，此时已透明且高度为 0，移除不可感知）→ 计数闪烁
        setTimeout(() => {
          pendingFlashStatus = newStatus;
          clearTimeout(pendingFlashTimer);
          pendingFlashTimer = setTimeout(() => { pendingFlashStatus = null; }, 800);
          bug.status = newStatus;
          bug.statusChangedAt = Date.now(); // 新来的往组末尾
          if (newStatus === '已完成') {
            bug.completedAt = formatTimestamp(new Date());
          } else if (bug.completedAt !== undefined) {
            delete bug.completedAt;
          }
          sendUpdate(bug.id, 'status', newStatus);
          if (rowEl.isConnected) {
            rowEl.style.height = '';
            rowEl.style.minHeight = '';
            rowEl.style.paddingTop = '';
            rowEl.style.paddingBottom = '';
            rowEl.style.borderTopWidth = '';
            rowEl.style.borderBottomWidth = '';
            rowEl.style.marginBottom = '';
            rowEl.style.overflow = '';
            rowEl.style.pointerEvents = '';
            rowEl.style.position = '';
            rowEl.style.zIndex = '';
            rowEl.style.boxShadow = '';
            rowEl.style.transition = '';
            rowEl.style.transformOrigin = '';
            rowEl.style.transform = '';
            rowEl.style.opacity = '';
          }
        }, 1000);
      }

      /**
       * 状态变更：
       * - 全部视图：立即改状态 + 手动 FLIP（行与其余行一起弹性滑到新位置，1s）
       * - 筛选视图：行飞向目标状态 tag 被吸收（平移+缩小+淡出，1s），完成后才改状态
       * - 计数闪烁：飞行/移动完成后，目标筛选徽标闪一下（"系统已收到操作"反馈）
       */
      /**
       * 状态图标变化瞬间的一次性动效（静默常态 + 变化反馈，播完静止）：
       * 给该行的 .status-sel-icon 加 .icon-anim，对应 CSS 动画只播一次（圆环落定/弧转半圈/对勾描边）
       */
      function triggerStatusIconAnim(bug) {
        nextTick(() => {
          const rowEl = rowElementOf(bug.id);
          if (!rowEl) return;
          const icon = rowEl.querySelector('.status-sel-icon');
          if (!icon) return;
          icon.classList.remove('icon-anim');
          void icon.offsetWidth; // 强制回流，确保动画必然重播（确定性优先）
          icon.classList.add('icon-anim');
        });
      }

      // ==================== 深夜彩蛋（0.3 收尾）：正向推进状态 + 20:00-05:00 → 弹一句安慰 ====================

      /** 深夜语录池（随机一条；emoji 开头，暖而不油） */
      const LATE_NIGHT_QUOTES = [
        '🌙 这么晚还在认真工作，你真的超棒！',
        '🌃 深夜赶工辛苦了，改完这一条就早点休息吧～',
        '⭐ 夜里走的一小步，都是明天的一大步。加油！',
        '✨ 凌晨的努力不会被辜负，加油！',
        '☕ 夜深了，喝口热水缓一缓，别太拼啦。',
        '🔥 深夜还能保持状态，这就是你的实力！',
      ];

      /**
       * 深夜彩蛋：状态正向推进（待修复→修复中 / 修复中→已完成）且当前时间在 20:00-次日 05:00 之间时，
       * 弹一句安慰/励志语录。复用 ElMessage 小提示样式（右上角、不打断操作、4.5s 自动消失、主题联动）。
       */
      function maybeLateNightCheer(oldStatus, newStatus) {
        const forward = (oldStatus === '待修复' && newStatus === '修复中') || (oldStatus === '修复中' && newStatus === '已完成');
        if (!forward) return;
        const hour = new Date().getHours();
        if (!(hour >= 20 || hour < 5)) return;
        const quote = LATE_NIGHT_QUOTES[Math.floor(Math.random() * LATE_NIGHT_QUOTES.length)];
        ElementPlus.ElMessage({
          message: Vue.h('div', { class: 'late-night-msg' }, quote),
          duration: 4500,
          showClose: false,
          offset: 50, // 距顶部 50px（75 上移 25）
          customClass: 'late-night-toast',
        });
      }

      function onStatusChange(bug, newStatus) {
        if (bug.status === newStatus) return;
        maybeLateNightCheer(bug.status, newStatus); // 深夜彩蛋（只在自己操作时触发，随广播不重复弹）

        // 筛选视图：飞向目标 tag
        const rowEl = rowElementOf(bug.id);
        if (statusFilter.value !== '全部' && rowEl) {
          flyRowToTag(bug, rowEl, newStatus);
          triggerStatusIconAnim(bug);
          return;
        }

        // 全部视图：手动 FLIP
        const rows = Array.from(document.querySelectorAll('.bug-rows .bug-row'));
        const oldRects = captureRects(rows);
        pendingFlashStatus = newStatus;
        clearTimeout(pendingFlashTimer);
        pendingFlashTimer = setTimeout(() => { pendingFlashStatus = null; }, 800);
        bug.status = newStatus;
        bug.statusChangedAt = Date.now(); // 新来的往组末尾
        triggerStatusIconAnim(bug);
        // 自动管理完成时间锚点
        if (newStatus === '已完成') {
          bug.completedAt = formatTimestamp(new Date());
        } else if (bug.completedAt !== undefined) {
          delete bug.completedAt;
        }
        sendUpdate(bug.id, 'status', newStatus);
        flipRowsWithRects(rows, oldRects);
      }

      // 状态计数变化 → 行飞出动画完成后闪烁对应筛选徽标（仅筛选视图；全部视图有移动动画，不闪）
      watch(statusCounts, () => {
        if (!pendingFlashStatus) return;
        if (statusFilter.value === '全部') { pendingFlashStatus = null; return; }
        const target = pendingFlashStatus;
        pendingFlashStatus = null;
        clearTimeout(countFlashTimer);
        countFlashTimer = setTimeout(() => {
          flashStatus.value = target;
          setTimeout(() => { if (flashStatus.value === target) flashStatus.value = null; }, 700);
        }, 100); // 行飞出（1s）在超时内完成后才真正改状态，闪烁紧随其后
      });

      /**
       * 开始编辑名称
       */
      function startEditName(bug) {
        editNameBackup = bug.name;
        editingBugId.value = bug.id;
        nextTick(() => {
          // 聚焦输入框（自定义行列表：.bug-name 单元格）
          const inputs = document.querySelectorAll('.bug-name .el-input__inner');
          inputs.forEach((input) => {
            input.focus();
            input.select();
          });
        });
      }

      /**
       * 完成编辑名称
       * @param {object} bug
       * @param {boolean} [openNext] 回车确认时 true：标题提交后引出"下一步"小面板（deadline / 备注询问）
       *                            blur 失焦提交不引（安静路径，用户已移开焦点）
       */
      function finishEditName(bug, openNext) {
        editingBugId.value = null;
        // 值无变化则跳过（含空标题直接回车：不提交也不引面板）
        if (bug.name === editNameBackup) return;
        sendUpdate(bug.id, 'name', bug.name);
        if (openNext && bug.name.trim()) openNextStep(bug);
      }

      /**
       * 取消编辑名称
       */
      function cancelEditName(bug) {
        bug.name = editNameBackup;
        editingBugId.value = null;
      }

      /**
       * 新增任务
       */
      function addBug() {
        const task = currentTask.value;
        if (!task) {
          ElementPlus.ElMessage.warning('请先创建项目');
          return;
        }

        // 负责人自动归属（0.3 体验小点）：谁新建的就是谁的；名字未填时只存 clientId（显示层兜底"我"/clientId 前缀，与备注作者一致）
        const assigneeName = displayName.value.trim();
        const newBug = {
          id: randomUUID(),
          name: '',
          status: '待修复',
          images: [],
          statusChangedAt: Date.now(), // 组内排序依据：新来的往组末尾
          assignee: { clientId: clientId, name: assigneeName || null },
        };

        task.bugs.push(newBug);

        // 发送新增消息
        sendAdd(newBug.id);

        // 行生长动画：标记新行播放 row-enter（Task 3 预留接线，320ms 后复位）
        enteringBugId.value = newBug.id;
        setTimeout(() => { enteringBugId.value = null; }, 320);

        // 新增任务按钮"垒上"动画（land 仅由 JS 控制；限定卡片列表头按钮，避免误中标签栏"新增项目"）
        pulse(document.querySelector('.bug-panel .btn-add-task'), 'land', 360);

        // 自动进入编辑模式
        nextTick(() => {
          startEditName(newBug);
        });
      }

      // ==================== 新增任务"下一步"小面板（0.3 体验小点：deadline / 备注询问） ====================

      /** 正在显示"下一步"面板的任务行 id（null = 无） */
      const nextStepBugId = ref(null);
      /** 面板：是否勾选 deadline（勾选展开时间选择器） */
      const nsDeadlineOn = ref(false);
      /** 面板：已选 deadline 时间戳（毫秒） */
      const nsDeadline = ref(null);
      /** 面板：是否勾选备注（勾选展开输入框） */
      const nsNoteOn = ref(false);
      /** 面板：备注文本 */
      const nsNoteText = ref('');
      /** 面板：出场动画进行中（关闭时先播动画再清状态） */
      const nsClosing = ref(false);
      /** 工时评估浮层：可见 / 出场动画中 */
      const nsHoursVisible = ref(false);
      const nsHoursClosing = ref(false);

      /** 打开"下一步"面板（重置状态；行内回车确认标题后调用） */
      function openNextStep(bug) {
        nsClosing.value = false;
        nsDeadlineOn.value = false;
        nsDeadline.value = null;
        nsNoteOn.value = false;
        nsNoteText.value = '';
        nextStepBugId.value = bug.id;
      }

      /** 关闭"下一步"面板：加出场动画类（0.25s），animationend 后清状态 */
      function closeNextStep() {
        if (nextStepBugId.value === null) return;
        nsClosing.value = true;
      }

      /** 面板出场动画结束（入场动画结束也会触发，但此时 nsClosing=false 不清理，安全） */
      function onNextStepAnimEnd() {
        if (nsClosing.value) {
          nextStepBugId.value = null;
          nsClosing.value = false;
        }
      }

      /**
       * 打开工时评估浮层（点"此刻"）：deadline 不可能等于现在，改为评估所需工时
       */
      function openHoursPicker() {
        nsHoursVisible.value = true;
      }

      /**
       * 选择所需天数：deadline = 当前时间 + N 天（保留钟点），自动填好并收起浮层
       * @param {number} days 1-5
       */
      function applyHoursDays(days) {
        nsDeadline.value = Date.now() + days * 24 * 60 * 60 * 1000;
        closeHoursPicker();
      }

      /** 收起工时评估浮层（先播出场动画，animationend 后清状态） */
      function closeHoursPicker() {
        if (!nsHoursVisible.value) return;
        nsHoursClosing.value = true;
      }

      /** 工时评估浮层出场动画结束（入场动画结束也会触发，nsHoursClosing=false 不清理，安全） */
      function onHoursAnimEnd() {
        if (nsHoursClosing.value) {
          nsHoursVisible.value = false;
          nsHoursClosing.value = false;
        }
      }

      /**
       * 面板"确定"：按勾选落库
       * - deadline 勾选且已选时间 → bug.deadline 结构化字段（update 广播，未来逾期/排序可用）+ 自动代发一条备注
       * - 备注勾选且有内容 → 发一条备注
       */
      function confirmNextStep(bug) {
        if (nsDeadlineOn.value && typeof nsDeadline.value === 'number') {
          bug.deadline = nsDeadline.value;
          sendUpdate(bug.id, 'deadline', nsDeadline.value);
          pushBugNote(bug, '该任务启用 deadline：' + formatTime(nsDeadline.value));
        }
        if (nsNoteOn.value && nsNoteText.value.trim()) {
          pushBugNote(bug, nsNoteText.value.trim());
        }
        closeNextStep();
      }

      // ==================== 删除全链路（按住蓄怒 → 松手确认 → 渐隐黑幕 → 覆盖删除） ====================

      /**
       * 删除按钮按下：缓存按钮元素与矩形；700ms 长按由 JS 加 angry 类；
       * 挂窗口级 mouseup 兜底（按钮外松手也能复位，防状态泄露）
       */
      function onDelDown(bug, e) {
        if (e.button !== 0) return; // 右键排除
        delPressEl = e.currentTarget;
        delPressRect = e.currentTarget.getBoundingClientRect();
        delUpHandled = false;
        clearTimeout(delPressTimer);
        delPressTimer = setTimeout(() => {
          if (delPressEl) delPressEl.classList.add('angry'); // 长按 700ms 蓄怒（仅 JS 控制）
        }, 700);
        window.addEventListener('mouseup', onDelWindowUp, { once: true });
        window.addEventListener('blur', onDelWindowUp);          // 失焦兜底（如 Alt-Tab，蓄怒不滞留）
        document.addEventListener('mouseleave', onDocMouseLeave); // 指针离窗兜底
      }

      /**
       * 删除按钮松开（按钮内）：先打标（窗口兜底据此跳过），再复位蓄怒态；
       * 若指针已滑出按钮矩形（±3px 容差）则终止删除（扳机保险）
       */
      function onDelUp(bug, e) {
        delUpHandled = true;
        cleanupDelPress(); // 清理只负责按压态，确认流程继续走完
        let inside = false;
        if (delPressRect && typeof e.clientX === 'number') {
          inside = e.clientX >= delPressRect.left - 3 && e.clientX <= delPressRect.right + 3 && e.clientY >= delPressRect.top - 3 && e.clientY <= delPressRect.bottom + 3;
        }
        if (!inside) return; // 删除终止（扳机保险）
        pulse(e.currentTarget, 'burst', 440);
        confirmBugId.value = bug.id; // 渐隐黑幕 + 行聚光
      }

      /**
       * 清理按压态：清计时器 + 去 angry + 置空按钮引用（幂等，各兜底路径复用）
       */
      function cleanupDelPress() {
        clearTimeout(delPressTimer);
        if (delPressEl) delPressEl.classList.remove('angry');
        delPressEl = null;
      }

      /**
       * 窗口级松手/失焦/离窗兜底：先移除三个兜底监听（防跨轮累积），
       * 若本次未被按钮自身处理，再清理按压态
       */
      function onDelWindowUp() {
        window.removeEventListener('mouseup', onDelWindowUp);
        window.removeEventListener('blur', onDelWindowUp);
        document.removeEventListener('mouseleave', onDocMouseLeave);
        if (delUpHandled) return; // 按钮已处理本次松手
        cleanupDelPress();
      }

      /**
       * 指针离开文档（窗口外）时触发兜底；relatedTarget 非空说明仍在页面内，忽略
       */
      function onDocMouseLeave(ev) {
        if (!ev.relatedTarget) onDelWindowUp();
      }

      /**
       * 取消删除确认（点击幕布或气泡内的取消按钮）
       */
      function cancelDeleteConfirm() { confirmBugId.value = null; }

      /** 按 data-bug-id 找到对应行元素 */
      function rowElementOf(id) { return document.querySelector('.bug-row[data-bug-id="' + id + '"]'); }

      /**
       * 确认删除：
       * - 多行：先钉死行高（height 无法从 auto 过渡），再切 dying 类 → 行高/内边距/边框
       *   同步收起，下方行在正常文档流中随之平滑上移覆盖，transitionend 后才移除，零跳变；
       * - 仅剩一行：切 fade 类直接渐隐。
       * 去掉固定 340ms 定时器 + 行内 height:0 的旧方案（过渡易被打断导致"收到一半瞬移"）。
       */
      function confirmDeleteBug(bug) {
        if (dyingBugId.value || fadingBugId.value) return; // 重入守卫：已有删除动画进行中
        const task = currentTask.value;
        if (!task) return;
        confirmBugId.value = null; // 幕布淡出

        // 仅剩一行（含筛选后可见仅一行）：渐隐淡出
        if (filteredAndSortedBugs.value.length <= 1) {
          fadingBugId.value = bug.id;
          finalizeDeleteAfter(bug, { prop: 'opacity', fallbackMs: 260 });
          return;
        }

        // 多行：钉死行高后切 dying 类触发收起（min-height:44px 会顶住坍塌，一并归零）
        const rowEl = rowElementOf(bug.id);
        if (rowEl) {
          const h = rowEl.offsetHeight;
          rowEl.style.height = h + 'px';
          rowEl.style.minHeight = '0px';
          rowEl.getBoundingClientRect(); // 强制回流，确保过渡从 h 起步
        }
        dyingBugId.value = bug.id;
        finalizeDeleteAfter(bug, { prop: 'height', fallbackMs: 340 });
      }

      /**
       * 监听删除动画结束（transitionend 只认目标属性），结束后移除行并同步；
       * fallbackMs 兜底：浏览器未触发 transitionend（prefers-reduced-motion / 异常中断）时强制完成。
       * finish 有 done 守卫，双路径只会执行一次。
       */
      function finalizeDeleteAfter(bug, { prop, fallbackMs }) {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const rowEl = rowElementOf(bug.id);
          if (rowEl) rowEl.removeEventListener('transitionend', onEnd);
          const task2 = currentTask.value;
          const idx = (task2 && task2.bugs) ? task2.bugs.findIndex(b => b.id === bug.id) : -1;
          if (idx !== -1) task2.bugs.splice(idx, 1);
          sendDelete(bug.id);
          dyingBugId.value = null;
          fadingBugId.value = null;
        };
        const onEnd = (e) => {
          // 只认目标行自身的属性过渡完成（子元素/其他属性的 transitionend 忽略）
          if (e.target !== rowElementOf(bug.id) || e.propertyName !== prop) return;
          finish();
        };
        const rowEl = rowElementOf(bug.id);
        if (rowEl) rowEl.addEventListener('transitionend', onEnd);
        setTimeout(finish, fallbackMs);
      }

      // ==================== 任务操作 ====================

      /** 正在编辑名称的任务 ID */
      const editingTaskId = ref(null);
      const editingTaskName = ref('');
      let renamingNewTask = null; // 新建项目两步式提交标记 { id, prevTaskId } | null（spec 第 4 节）

      /**
       * 新建项目（本地先行两步式，spec 第 4 节）：只在本地建临时项进入命名，
       * 确认非空才广播 createTask；临时项期间不广播、不写 currentTask 持久化（裁决⑤，中途关窗不留脏指针）
       */
      function createTask() {
        const prevTaskId = currentTaskId.value;
        const task = {
          id: randomUUID(),
          name: '',
          bugs: [],
        };
        tasks.value.push(task);
        currentTaskId.value = task.id;
        renamingNewTask = { id: task.id, prevTaskId };
        // 自动进入命名（placeholder 模式：空值 + 灰字「新项目」）
        nextTick(() => {
          startRenameTask(task, { placeholderMode: true });
        });
      }

      /**
       * 切换项目：方向感知的面板滑入（新项目在 orderedTasks 右侧 → 从右滑入；左侧 → 从左滑入）
       */
      function switchTask(taskId) {
        if (currentTaskId.value === taskId) return; // 点当前项目不重播
        archiveExpanded.value = false; // 切项目收起归档展开（裁决⑥）
        const ids = orderedTasks.value.map(t => t.id);
        const oldIdx = ids.indexOf(currentTaskId.value);
        const newIdx = ids.indexOf(taskId);
        currentTaskId.value = taskId;
        persistCurrentTask();
        if (oldIdx !== -1 && newIdx !== -1 && newIdx !== oldIdx) {
          swipeBugPanel(newIdx > oldIdx ? 'right' : 'left');
        }
      }

      /** 面板滑入动画：内容切换后 nextTick 加一次性动画类（强制回流保证必然重播，播完静止） */
      function swipeBugPanel(dir) {
        nextTick(() => {
          const panel = document.querySelector('.bug-panel');
          if (!panel) return;
          panel.classList.remove('swipe-right', 'swipe-left');
          void panel.offsetWidth; // 强制回流，确保动画必然重播（确定性优先）
          panel.classList.add(dir === 'right' ? 'swipe-right' : 'swipe-left');
        });
      }

      /**
       * 持久化当前任务 ID
       */
      function persistCurrentTask() {
        try {
          localStorage.setItem('buglist_current_task', currentTaskId.value);
        } catch (e) { /* 静默忽略 */ }
      }

      /**
       * 开始重命名任务（placeholderMode=新建项目命名：空值不 select，靠 placeholder 提示）
       * 修复：模板中输入框容器类名是 .task-tab-edit（index.html:157），旧选择器 .task-name-edit 一直匹配不到，
       *       导致聚焦/全选静默失效；此处更正为 .task-tab-edit input。
       */
      function startRenameTask(task, { placeholderMode = false } = {}) {
        editingTaskName.value = placeholderMode ? '' : task.name;
        editingTaskId.value = task.id;
        nextTick(() => {
          const input = document.querySelector('.task-tab-edit input');
          if (input) {
            input.focus();
            if (!placeholderMode) input.select();
          }
        });
      }

      /**
       * 完成重命名（Enter/失焦）。新建路径走两步式提交：非空→一条 createTask 广播（带最终名）；
       * 空名→本地丢弃临时项（等于从未发生）；老项目重命名逻辑原样保留
       */
      function finishRenameTask(task) {
        if (!task) return;
        const newName = editingTaskName.value.trim();
        editingTaskId.value = null;

        if (renamingNewTask && renamingNewTask.id === task.id) {
          const { prevTaskId } = renamingNewTask;
          renamingNewTask = null;
          if (!newName) {
            discardNewTask(task, prevTaskId);
            return;
          }
          task.name = newName;
          persistCurrentTask(); // 确认后才写持久化（裁决⑤）
          sendMessage({ type: 'createTask', clientId, data: { task: { id: task.id, name: task.name } } });
          return;
        }

        if (!newName || newName === task.name) return;
        const dup = tasks.value.some(t => t.id !== task.id && t.name === newName);
        if (dup) {
          ElementPlus.ElMessage.warning('已存在同名项目「' + newName + '」，仍将重命名');
        }
        task.name = newName;
        sendMessage({ type: 'updateTask', clientId, data: { taskId: task.id, field: 'name', value: newName } });
      }

      /** 丢弃未命名的本地临时项目：移除 + 还原当前项目（persist 值从未写过 temp id，无需清理） */
      function discardNewTask(task, prevTaskId) {
        const index = tasks.value.findIndex(t => t.id === task.id);
        if (index !== -1) tasks.value.splice(index, 1);
        currentTaskId.value = prevTaskId;
      }

      /**
       * 取消重命名（Esc）。新建路径同空名：本地丢弃临时项
       */
      function cancelRenameTask() {
        if (renamingNewTask && renamingNewTask.id === editingTaskId.value) {
          const task = tasks.value.find(t => t.id === renamingNewTask.id);
          const { prevTaskId } = renamingNewTask;
          renamingNewTask = null;
          editingTaskId.value = null;
          editingTaskName.value = '';
          if (task) discardNewTask(task, prevTaskId);
          return;
        }
        editingTaskId.value = null;
        editingTaskName.value = '';
      }

      /**
       * 删除项目（二次确认，spec 第 3 节；项目级删除豁免任务级"已完成不可删"防线——裁决①，
       * 有 ElMessageBox 确认 + 服务端删前快照兜底）
       */
      async function deleteTask(taskId) {
        if (tasks.value.length <= 1) {
          ElementPlus.ElMessage.warning('至少保留一个项目');
          return;
        }
        const task = tasks.value.find(t => t.id === taskId);
        if (!task) return;
        const bugCount = (task.bugs || []).length;
        try {
          await ElementPlus.ElMessageBox.confirm(
            `将删除项目「${task.name}」及其下 ${bugCount} 个任务（含已完成与已归档）、全部备注与图片。确定删除？`,
            '删除项目',
            { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
          );
        } catch (err) { return; } // 用户取消
        const index = tasks.value.findIndex(t => t.id === taskId);
        if (index !== -1) {
          tasks.value.splice(index, 1);
        }
        persistTaskOrder();
        if (currentTaskId.value === taskId) {
          currentTaskId.value = tasks.value[0]?.id || null;
        }
        // 图片文件由服务端 handleDeleteTask 在数据写盘成功后统一清理
        sendMessage({ type: 'deleteTask', clientId, data: { taskId } });
      }

      // ==================== 备注操作 ====================

      /**
       * 计算有多少个不同的人写过备注（任务级/条目级共用，传入带 notes 数组的对象）
       */
      function noteWriters(item) {
        if (!item || !item.notes || item.notes.length === 0) return 0;
        return new Set(item.notes.map(n => n.clientId)).size;
      }

      /**
       * 打开备注弹窗
       */
      function openNotesDialog(task, evt) {
        // 任务标签栏备注按钮"便签翘角"动画：用事件源精确定位被点击标签的按钮（peel 仅由 JS 控制，300ms 后移除）
        pulse(evt && evt.currentTarget, 'peel', 300);
        notesDialogTaskId.value = task.id;
        notesDialogVisible.value = true;
      }

      /** 任务备注 - 正在编辑的备注 id（null=查看模式） */
      const editingTaskNoteId = ref(null);
      let editTaskNoteBackup = '';

      /** 进入编辑：备份内容（取消可还原） */
      function startEditTaskNote(note) {
        if (note.clientId !== clientId) return;
        editTaskNoteBackup = note.content;
        editingTaskNoteId.value = note.id;
      }
      /** 确认编辑：保存并退出编辑态 */
      function confirmEditTaskNote(note) {
        editingTaskNoteId.value = null;
        updateNote(note.id, note.content);
      }
      /** 取消编辑：还原内容并退出编辑态 */
      function cancelEditTaskNote(note) {
        note.content = editTaskNoteBackup;
        editingTaskNoteId.value = null;
      }

      /**
       * 任务备注 - 编辑键盘事件（Enter 确认，Shift+Enter 换行）
       */
      function onTaskNoteEditKeydown(e, note) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          confirmEditTaskNote(note);
        }
      }

      /**
       * 任务备注 - 新增键盘事件（Enter 发送，Shift+Enter 换行）
       */
      function onTaskNoteNewKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          addNoteWithImage(newNoteContent.value);
        }
      }

      /**
       * 新增备注（可选携带多图）
       * @param {string} content
       * @param {string[]} [images] 已上传到服务端的图片文件名数组（无图时 null）
       * @param {string} [noteId] 预先指定的备注 id（有图时必须与上传时 X-Note-Id 一致）
       */
      function addNote(content, images, noteId) {
        const task = notesDialogTask.value;
        if (!task || !content.trim()) return;
        if (!task.notes) task.notes = [];

        const note = {
          id: noteId || randomUUID(),
          clientId: clientId,
          content: content.trim(),
          createdAt: Date.now(), // 创建时间锚点（判断"已修改"）
          updatedAt: Date.now(),
          authorName: displayName.value.trim() || null,
          ...(images && images.length ? { images } : {}),
        };
        task.notes.push(note);
        newNoteContent.value = '';
        sendMessage({ type: 'addNote', clientId, data: { taskId: task.id, note } });
      }

      /**
       * 添加备注（可选携带多图）：一次点击内完成"逐张传图 → 建备注"
       * 两步式：先逐张上传图片（同一 noteId，服务端暂存文件）→ 随即 addNote 携带 filenames 数组关联
       */
      async function addNoteWithImage(content) {
        const task = notesDialogTask.value;
        if (!task || !content.trim()) return;
        let images = null;
        let noteId = null;
        const files = pendingNoteFiles.value;
        if (files && files.length) {
          // 上限防御：单条备注最多 6 张图片（新备注 note.images 尚为空，按待传数量判定；>6 仅拦截超限，恰好 6 张放行）
          if (files.length > 6) {
            ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
            return;
          }
          noteId = randomUUID();
          const filenames = [];
          const uploadedFiles = [];   // 已成功上传的文件名：失败时逐张补偿删除，避免孤儿文件
          for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            try {
              const resp = await fetch(apiUrl('/api/upload'), {
                method: 'POST',
                headers: { 'X-Note-Id': noteId, 'X-Task-Id': task.id, 'X-Client-Id': clientId },
                body: formData,
              });
              const r = await resp.json();
              if (!r.success) {
                ElementPlus.ElMessage.error('备注图片上传失败: ' + (r.error || '未知错误'));
                // 两步式补偿：已传文件不会再关联备注，fire-and-forget 删除避免孤儿文件
                uploadedFiles.forEach(f => { fetch(apiUrl('/api/upload/' + encodeURIComponent(f)), { method: 'DELETE' }).catch(() => {}); });
                return;
              }
              filenames.push(r.filename);
              uploadedFiles.push(r.filename);
              // 孤儿风险说明：上传成功后若 addNote 失败（断线），服务端会暂存一个孤儿文件。
              // 局域网场景概率极低，此处仅做连接就绪检查并在断开时明确提示用户，不做重发队列。
              if (!ws || ws.readyState !== WebSocket.OPEN) {
                ElementPlus.ElMessage.warning('图片已上传，但连接已断开，备注未保存，请重连后重试');
                // 两步式补偿：连接已断，已传文件不会关联备注，补偿删除避免孤儿文件
                uploadedFiles.forEach(f => { fetch(apiUrl('/api/upload/' + encodeURIComponent(f)), { method: 'DELETE' }).catch(() => {}); });
                return;
              }
            } catch (err) {
              ElementPlus.ElMessage.error('备注图片上传失败');
              // 两步式补偿：本次中断，已传文件不会关联备注，补偿删除避免孤儿文件
              uploadedFiles.forEach(f => { fetch(apiUrl('/api/upload/' + encodeURIComponent(f)), { method: 'DELETE' }).catch(() => {}); });
              return;
            }
          }
          images = filenames;
        }
        addNote(content, images, noteId);
        clearPendingNoteImage();
        newNoteContent.value = '';
      }

      /**
       * 选择备注图片：有 attachTargetNote 时为已有备注附加图片（支持多选逐张附加），否则作为待提交图片暂存
       */
      function onChooseNoteImage(event) {
        const files = Array.from(event.target.files || []);
        if (!files.length) {
          // 取消选择：复位附加目标，避免下次误附加到旧备注
          attachTargetNote.value = null;
          return;
        }
        if (attachTargetNote.value) {
          // 已有备注：批量预判"已有数 + 本次选择数 > 6"整批拦截（attachNoteImage 内单张守卫保留作纵深）
          const note = attachTargetNote.value;
          if ((note.images || []).length + files.length > 6) {
            ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
            event.target.value = '';
            attachTargetNote.value = null;   // 与成功路径对称复位，避免拦截后误附加到旧备注
            return;
          }
          // 逐张附加（服务端追加并广播；本地因自身广播被过滤需手动 push）
          files.forEach(f => attachNoteImage(note, f));
          attachTargetNote.value = null;
        } else {
          // 新备注待提交模式：批量预判"待传数 + 本次选择数 > 6"拦截（未超限才 push）
          if (pendingNoteFiles.value.length + files.length > 6) {
            ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
            event.target.value = '';
            return;
          }
          // 多图逐张暂存（objectURL 与文件一一对应，避免泄漏）
          files.forEach(f => {
            pendingNoteFiles.value.push(f);
            pendingNoteFileUrls.value.push(URL.createObjectURL(f));
          });
        }
        event.target.value = '';
      }

      /** 移除一张待提交的备注图片（含释放对应 objectURL） */
      function removePendingNoteFile(index) {
        const urls = pendingNoteFileUrls.value;
        if (urls[index]) URL.revokeObjectURL(urls[index]);
        pendingNoteFiles.value.splice(index, 1);
        pendingNoteFileUrls.value.splice(index, 1);
      }

      /** 清除待提交的备注图片（含释放所有 objectURL） */
      function clearPendingNoteImage() {
        pendingNoteFileUrls.value.forEach(u => { if (u) URL.revokeObjectURL(u); });
        pendingNoteFiles.value = [];
        pendingNoteFileUrls.value = [];
      }

      /** 点击"＋图"：记录目标备注并触发文件选择 */
      function pickAttachImage(note) {
        attachTargetNote.value = note;
        noteFileInput.value.click();
      }

      /**
       * 为已有备注附加图片：上传 → 服务端追加关联并广播 → 本地手动追加
       * （自己的广播被 originClientId 过滤，需本地直接更新）
       */
      async function attachNoteImage(note, file) {
        if (!note || note.clientId !== clientId || !file) return;
        // 上限防御：单条备注最多 6 张图片
        if ((note.images || []).length >= 6) {
          ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
          return;
        }
        const taskId = notesDialogTaskId.value;
        const formData = new FormData();
        formData.append('file', file);
        try {
          const resp = await fetch(apiUrl('/api/upload'), {
            method: 'POST',
            headers: { 'X-Note-Id': note.id, 'X-Task-Id': taskId, 'X-Client-Id': clientId },
            body: formData,
          });
          const r = await resp.json();
          if (!r.success) { ElementPlus.ElMessage.error('图片上传失败: ' + (r.error || '未知错误')); return; }
          // 自己的广播被 originClientId 过滤，需本地手动 push（多图追加，不替换）
          if (!Array.isArray(note.images)) note.images = [];
          note.images.push(r.filename);
          ElementPlus.ElMessage.success('图片已添加');
        } catch (err) {
          ElementPlus.ElMessage.error('图片上传失败');
        }
      }

      /** 作者移除备注图片：本地先移除该文件名（自己的广播被 originClientId 过滤，需本地立即更新），再发 removeImage 让服务端校验归属并清理文件 */
      function updateNoteImage(noteId, filename) {
        const task = notesDialogTask.value;
        const note = task && task.notes && task.notes.find(n => n.id === noteId);
        if (note && Array.isArray(note.images)) {
          const i = note.images.indexOf(filename);
          if (i !== -1) note.images.splice(i, 1);
        }
        sendMessage({ type: 'updateNote', clientId, data: { taskId: notesDialogTaskId.value, noteId, removeImage: filename } });
      }

      /**
       * 更新备注
       */
      function updateNote(noteId, content) {
        const task = notesDialogTask.value;
        if (!task || !task.notes) return;
        const note = task.notes.find(n => n.id === noteId);
        if (!note || note.clientId !== clientId) return;
        note.content = content;
        note.updatedAt = Date.now();
        sendMessage({ type: 'updateNote', clientId, data: { taskId: task.id, noteId, content, updatedAt: note.updatedAt } });
      }

      /**
       * 删除备注（二次确认；删除后不可恢复）
       */
      function deleteNote(noteId) {
        const task = notesDialogTask.value;
        if (!task || !task.notes) return;
        const note = task.notes.find(n => n.id === noteId);
        // 归属防御：仅作者本人可删除（与服务端校验保持一致）
        if (!note || note.clientId !== clientId) return;
        ElementPlus.ElMessageBox.confirm('确定删除这条备注？删除后不可恢复。', '删除备注', {
          type: 'warning',
          confirmButtonText: '删除',
          cancelButtonText: '取消',
        }).then(() => {
          const idx = task.notes.findIndex(n => n.id === noteId);
          if (idx === -1) return;
          task.notes.splice(idx, 1);
          if (editingTaskNoteId.value === noteId) editingTaskNoteId.value = null;
          sendMessage({ type: 'deleteNote', clientId, data: { taskId: task.id, noteId } });
        }).catch(() => { /* 用户取消 */ });
      }

      /** 备注是否被修改过（updatedAt > createdAt，即飞书式的"已修改"标记） */
      function isNoteModified(note) {
        return !!(note && note.createdAt && note.updatedAt && note.updatedAt > note.createdAt + 1000);
      }

      /**
       * 根据 clientId 返回一个稳定的颜色（当前主题和谐色板；主题切换后颜色随之变化，与负责人 hover 标签同源）
       */
      function getNoteColor(clientId) {
        const palette = notePalette || FALLBACK_NOTE_COLORS;
        if (!clientId) return palette[0];
        let hash = 0;
        for (let i = 0; i < clientId.length; i++) {
          hash = ((hash << 5) - hash) + clientId.charCodeAt(i);
          hash |= 0;
        }
        return palette[Math.abs(hash) % palette.length];
      }

      /**
       * 负责人显示名（0.3）：优先存的名字快照；未填名字时自己显示"我"、他人显示 clientId 前 8 位（与备注作者兜底一致）
       */
      function assigneeLabel(bug) {
        const a = bug?.assignee;
        if (!a || !a.clientId) return '';
        if (a.name) return a.name;
        return a.clientId === clientId ? '我' : a.clientId.substring(0, 8);
      }

      // ==================== 任务备注操作 ====================

      /** 任务备注弹窗对应的任务 */
      const bugNotesTargetBug = computed(() => {
        const task = tasks.value.find(t => t.id === bugNotesTaskId.value);
        return task?.bugs?.find(b => b.id === bugNotesBugId.value) || null;
      });

      function openBugNotesDialog(taskId, bugId) {
        // 行内备注按钮"便签翘角"动画：按 data-bug-id 精确锁定被点击行的按钮（peel 仅由 JS 控制，300ms 后移除）
        pulse(rowElementOf(bugId)?.querySelector('.btn-note'), 'peel', 300);
        bugNotesTaskId.value = taskId;
        bugNotesBugId.value = bugId;
        bugNotesVisible.value = true;
      }

      /**
       * 发送一条任务级备注（公共路径：备注弹窗 / 新增任务"下一步"面板共用）
       * 本地立即追加 + WS addBugNote 广播；作者 = 当前用户；无图
       * @param {object} bug
       * @param {string} content
       */
      function pushBugNote(bug, content) {
        if (!bug || !content || !content.trim()) return;
        const task = currentTask.value;
        if (!task) return;
        if (!bug.notes) bug.notes = [];
        const note = {
          id: randomUUID(),
          clientId: clientId,
          content: content.trim(),
          createdAt: Date.now(), // 创建时间锚点（判断"已修改"）
          updatedAt: Date.now(),
          authorName: displayName.value.trim() || null,
        };
        bug.notes.push(note);
        sendMessage({ type: 'addBugNote', clientId, data: { taskId: task.id, bugId: bug.id, note } });
      }

      /**
       * 新增条目备注（可选携带多图）
       * @param {string} content
       * @param {string[]} [images] 已上传到服务端的图片文件名数组（无图时 null）
       * @param {string} [noteId] 预先指定的备注 id（有图时必须与上传时 X-Bug-Note-Id 一致）
       */
      function addBugNote(content, images, noteId) {
        const bug = bugNotesTargetBug.value;
        if (!bug || !content.trim()) return;
        if (!bug.notes) bug.notes = [];
        const taskId = bugNotesTaskId.value;
        const note = {
          id: noteId || randomUUID(),
          clientId: clientId,
          content: content.trim(),
          createdAt: Date.now(), // 创建时间锚点（判断"已修改"）
          updatedAt: Date.now(),
          authorName: displayName.value.trim() || null,
          ...(images && images.length ? { images } : {}),
        };
        bug.notes.push(note);
        newBugNoteContent.value = '';
        sendMessage({ type: 'addBugNote', clientId, data: { taskId, bugId: bug.id, note } });
      }

      /**
       * 添加条目备注（可选携带多图）：一次点击内完成"逐张传图 → 建备注"
       * 两步式：先逐张上传图片（同一 noteId，服务端暂存文件）→ 随即 addBugNote 携带 filenames 数组关联
       */
      async function addBugNoteWithImage(content) {
        const bug = bugNotesTargetBug.value;
        if (!bug || !content.trim()) return;
        let images = null;
        let noteId = null;
        const files = pendingBugNoteFiles.value;
        if (files && files.length) {
          // 上限防御：单条备注最多 6 张图片（新备注 note.images 尚为空，按待传数量判定；>6 仅拦截超限，恰好 6 张放行）
          if (files.length > 6) {
            ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
            return;
          }
          noteId = randomUUID();
          const filenames = [];
          const uploadedFiles = [];   // 已成功上传的文件名：失败时逐张补偿删除，避免孤儿文件
          for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            try {
              const resp = await fetch(apiUrl('/api/upload'), {
                method: 'POST',
                headers: { 'X-Bug-Note-Id': noteId, 'X-Bug-Id': bug.id, 'X-Task-Id': bugNotesTaskId.value, 'X-Client-Id': clientId },
                body: formData,
              });
              const r = await resp.json();
              if (!r.success) {
                ElementPlus.ElMessage.error('备注图片上传失败: ' + (r.error || '未知错误'));
                // 两步式补偿：已传文件不会再关联备注，fire-and-forget 删除避免孤儿文件
                uploadedFiles.forEach(f => { fetch(apiUrl('/api/upload/' + encodeURIComponent(f)), { method: 'DELETE' }).catch(() => {}); });
                return;
              }
              filenames.push(r.filename);
              uploadedFiles.push(r.filename);
              // 孤儿风险说明：上传成功后若 addNote 失败（断线），服务端会暂存一个孤儿文件。
              // 局域网场景概率极低，此处仅做连接就绪检查并在断开时明确提示用户，不做重发队列。
              if (!ws || ws.readyState !== WebSocket.OPEN) {
                ElementPlus.ElMessage.warning('图片已上传，但连接已断开，备注未保存，请重连后重试');
                // 两步式补偿：连接已断，已传文件不会关联备注，补偿删除避免孤儿文件
                uploadedFiles.forEach(f => { fetch(apiUrl('/api/upload/' + encodeURIComponent(f)), { method: 'DELETE' }).catch(() => {}); });
                return;
              }
            } catch (err) {
              ElementPlus.ElMessage.error('备注图片上传失败');
              // 两步式补偿：本次中断，已传文件不会关联备注，补偿删除避免孤儿文件
              uploadedFiles.forEach(f => { fetch(apiUrl('/api/upload/' + encodeURIComponent(f)), { method: 'DELETE' }).catch(() => {}); });
              return;
            }
          }
          images = filenames;
        }
        addBugNote(content, images, noteId);
        clearPendingBugNoteImage();
        newBugNoteContent.value = '';
      }

      /**
       * 选择条目备注图片：有 attachTargetBugNote 时为已有备注附加图片（支持多选逐张附加），否则作为待提交图片暂存
       */
      function onChooseBugNoteImage(event) {
        const files = Array.from(event.target.files || []);
        if (!files.length) {
          // 取消选择：复位附加目标，避免下次误附加到旧备注
          attachTargetBugNote.value = null;
          return;
        }
        if (attachTargetBugNote.value) {
          // 已有备注：批量预判"已有数 + 本次选择数 > 6"整批拦截（attachBugNoteImage 内单张守卫保留作纵深）
          const note = attachTargetBugNote.value;
          if ((note.images || []).length + files.length > 6) {
            ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
            event.target.value = '';
            attachTargetBugNote.value = null;   // 与成功路径对称复位，避免拦截后误附加到旧备注
            return;
          }
          // 逐张附加（服务端追加并广播；本地因自身广播被过滤需手动 push）
          files.forEach(f => attachBugNoteImage(note, f));
          attachTargetBugNote.value = null;
        } else {
          // 新备注待提交模式：批量预判"待传数 + 本次选择数 > 6"拦截（未超限才 push）
          if (pendingBugNoteFiles.value.length + files.length > 6) {
            ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
            event.target.value = '';
            return;
          }
          // 多图逐张暂存（objectURL 与文件一一对应，避免泄漏）
          files.forEach(f => {
            pendingBugNoteFiles.value.push(f);
            pendingBugNoteFileUrls.value.push(URL.createObjectURL(f));
          });
        }
        event.target.value = '';
      }

      /** 移除一张待提交的条目备注图片（含释放对应 objectURL） */
      function removePendingBugNoteFile(index) {
        const urls = pendingBugNoteFileUrls.value;
        if (urls[index]) URL.revokeObjectURL(urls[index]);
        pendingBugNoteFiles.value.splice(index, 1);
        pendingBugNoteFileUrls.value.splice(index, 1);
      }

      /** 清除待提交的条目备注图片（含释放所有 objectURL） */
      function clearPendingBugNoteImage() {
        pendingBugNoteFileUrls.value.forEach(u => { if (u) URL.revokeObjectURL(u); });
        pendingBugNoteFiles.value = [];
        pendingBugNoteFileUrls.value = [];
      }

      /** 点击"＋图"：记录目标条目备注并触发文件选择 */
      function pickAttachBugImage(note) {
        attachTargetBugNote.value = note;
        bugNoteFileInput.value.click();
      }

      /**
       * 为已有条目备注附加图片：上传 → 服务端追加关联并广播 → 本地手动追加
       * （自己的广播被 originClientId 过滤，需本地直接更新）
       */
      async function attachBugNoteImage(note, file) {
        if (!note || note.clientId !== clientId || !file) return;
        const bug = bugNotesTargetBug.value;
        if (!bug) return;
        // 上限防御：单条备注最多 6 张图片
        if ((note.images || []).length >= 6) {
          ElementPlus.ElMessage.warning('单条备注最多 6 张图片');
          return;
        }
        const taskId = bugNotesTaskId.value;
        const formData = new FormData();
        formData.append('file', file);
        try {
          const resp = await fetch(apiUrl('/api/upload'), {
            method: 'POST',
            headers: { 'X-Bug-Note-Id': note.id, 'X-Bug-Id': bug.id, 'X-Task-Id': taskId, 'X-Client-Id': clientId },
            body: formData,
          });
          const r = await resp.json();
          if (!r.success) { ElementPlus.ElMessage.error('图片上传失败: ' + (r.error || '未知错误')); return; }
          // 自己的广播被 originClientId 过滤，需本地手动 push（多图追加，不替换）
          if (!Array.isArray(note.images)) note.images = [];
          note.images.push(r.filename);
          ElementPlus.ElMessage.success('图片已添加');
        } catch (err) {
          ElementPlus.ElMessage.error('图片上传失败');
        }
      }

      /** 作者移除条目备注图片：本地先移除该文件名（自己的广播被 originClientId 过滤，需本地立即更新），再发 removeImage 让服务端校验归属并清理文件 */
      function updateBugNoteImage(noteId, filename) {
        const bug = bugNotesTargetBug.value;
        if (!bug) return;
        const note = (bug.notes || []).find(n => n.id === noteId);
        if (note && Array.isArray(note.images)) {
          const i = note.images.indexOf(filename);
          if (i !== -1) note.images.splice(i, 1);
        }
        sendMessage({ type: 'updateBugNote', clientId, data: { taskId: bugNotesTaskId.value, bugId: bug.id, noteId, removeImage: filename } });
      }

      function updateBugNote(noteId, content) {
        const bug = bugNotesTargetBug.value;
        if (!bug || !bug.notes) return;
        const note = bug.notes.find(n => n.id === noteId);
        if (!note || note.clientId !== clientId) return;
        note.content = content;
        note.updatedAt = Date.now();
        sendMessage({ type: 'updateBugNote', clientId, data: { taskId: bugNotesTaskId.value, bugId: bug.id, noteId, content, updatedAt: note.updatedAt } });
      }

      function deleteBugNote(noteId) {
        const bug = bugNotesTargetBug.value;
        if (!bug || !bug.notes) return;
        const note = bug.notes.find(n => n.id === noteId);
        // 归属防御：仅作者本人可删除（与服务端校验保持一致）
        if (!note || note.clientId !== clientId) return;
        ElementPlus.ElMessageBox.confirm('确定删除这条备注？删除后不可恢复。', '删除备注', {
          type: 'warning',
          confirmButtonText: '删除',
          cancelButtonText: '取消',
        }).then(() => {
          const idx = bug.notes.findIndex(n => n.id === noteId);
          if (idx === -1) return;
          bug.notes.splice(idx, 1);
          if (editingBugNoteId.value === noteId) editingBugNoteId.value = null;
          sendMessage({ type: 'deleteBugNote', clientId, data: { taskId: bugNotesTaskId.value, bugId: bug.id, noteId } });
        }).catch(() => { /* 用户取消 */ });
      }

      /** 条目备注 - 正在编辑的备注 id（null=查看模式） */
      const editingBugNoteId = ref(null);
      let editBugNoteBackup = '';

      /** 进入编辑：备份内容（取消可还原） */
      function startEditBugNote(note) {
        if (note.clientId !== clientId) return;
        editBugNoteBackup = note.content;
        editingBugNoteId.value = note.id;
      }
      /** 确认编辑：保存并退出编辑态 */
      function confirmEditBugNote(note) {
        editingBugNoteId.value = null;
        updateBugNote(note.id, note.content);
      }
      /** 取消编辑：还原内容并退出编辑态 */
      function cancelEditBugNote(note) {
        note.content = editBugNoteBackup;
        editingBugNoteId.value = null;
      }

      function onBugNoteEditKeydown(e, note) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          confirmEditBugNote(note);
        }
      }

      function onBugNoteNewKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          addBugNoteWithImage(newBugNoteContent.value);
        }
      }

      /** 统一时间格式化：'YYYY-MM-DD HH:mm'，sec=true 追加 ':ss' */
      function fmtStamp(d, sec) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` + (sec ? `:${p(d.getSeconds())}` : '');
      }

      /**
       * 格式化时间戳为可读时间
       */
      function formatTime(ts) {
        return ts ? fmtStamp(new Date(ts)) : '';
      }

      /**
       * 格式化时间戳，精确到秒（用于 completedAt 等时间锚点字段）
       */
      function formatTimestamp(date) {
        return fmtStamp(date, true);
      }

      // ==================== 本地备份 ====================

      let backupTimer = null;
      let backupCount = 0;
      const backupStatus = ref('等待中');
      const backupLabel = computed(() => {
        if (backupStatus.value === 'ok') return `已备份 ×${backupCount}`;
        if (backupStatus.value === 'no-api') return '不可用';
        if (backupStatus.value === 'waiting') return '等待中';
        return backupStatus.value;
      });

      /** 把 IP 里的非法目录名字符（: * ? 等）替换为 _ */
      function backupDirName(ip) {
        return ip.replace(/[:*?"<>|]/g, '_');
      }

      /** 写一次本地备份（30s 定时器与连接建立/断开等关键时刻共用）：深拷贝数据 → writeBackup → 更新计数/状态 */
      function writeBackupOnce() {
        const ip = serverHost.value;
        if (!ip || !tasks.value.length) return;
        const clean = structuredClone({ version: dataVersion.value, tasks: tasks.value });
        window.electronAPI.writeBackup(ip, clean).then((res) => {
          backupCount++;
          if (res && res.ok) {
            backupStatus.value = 'ok';
            console.log(`[Backup] #${backupCount} 备份成功 → D:\\Bug清单\\pc\\${backupDirName(ip)}\\data.json (tasks: ${clean.tasks.length})`);
          } else {
            backupStatus.value = 'fail';
            console.warn('[Backup] 写入失败:', res?.error || '未知错误');
          }
        }).catch((err) => {
          backupStatus.value = 'fail';
          console.error('[Backup] 异常:', err.message);
        });
      }

      /**
       * 启动 30s 间隔本地备份（仅 Electron 客户端生效）
       */
      function startBackupTimer() {
        if (backupTimer) return; // 已启动

        const hasAPI = !!(window.electronAPI?.writeBackup);
        console.log(`[Backup] 定时器启动, electronAPI 可用: ${hasAPI}, 目标IP: ${serverHost.value}, task数: ${tasks.value.length}`);

        if (!hasAPI) {
          backupStatus.value = 'no-api';
          console.warn('[Backup] electronAPI 不可用，备份功能无效。请确认在 Electron 环境下运行。');
          return;
        }

        backupStatus.value = 'waiting';
        backupTimer = setInterval(writeBackupOnce, 30000);
      }

      /**
       * 执行一次立即备份（连接成功后、断开连接等关键时刻调用）
       */
      function doBackupNow() {
        if (!window.electronAPI?.writeBackup) {
          console.warn('[Backup] 立即备份跳过: electronAPI 不可用');
          backupStatus.value = 'no-api';
          return;
        }
        writeBackupOnce();
      }

      // ==================== 工具函数 ====================

      /**
       * 构建指向目标服务器的绝对 URL（解决跨 Electron 实例上传问题）
       */
      function apiUrl(path) {
        return `${location.protocol}//${serverHost.value}${path}`;
      }

      // ==================== 图片上传 ====================

      /**
       * 核心函数：统一处理图片上传（三种方式共用入口）
       * @param {File|Blob} file
       * @param {string} bugId
       */
      async function handleImageUpload(file, bugId) {
        if (!file || !bugId) return;

        console.log(`[Image] 开始上传: bugId=${bugId}, taskId=${currentTaskId.value?.substring(0,8)}, clientId=${clientId.substring(0,8)}, fileSize=${file.size}, fileName=${file.name || '(blob)'}, target=${serverHost.value}`);

        // 查找对应任务（在当前任务中）
        const task = currentTask.value;
        const bug = task?.bugs?.find((b) => b.id === bugId);
        if (!bug) return;

        // 上限防御：单条任务（bug）最多 6 张截图，防止无上限堆积
        if ((bug.images || []).length >= 6) {
          ElementPlus.ElMessage.warning('单条任务最多 6 张截图');
          return;
        }

        try {
          const formData = new FormData();
          formData.append('file', file);

          const resp = await fetch(apiUrl('/api/upload'), {
            method: 'POST',
            headers: {
              'X-Bug-Id': bugId,
              'X-Client-Id': clientId,
              'X-Task-Id': currentTaskId.value,
            },
            body: formData,
          });

          const result = await resp.json();
          console.log(`[Image] 服务器响应: success=${result.success}, filename=${result.filename}, version=${result.version}`);
          if (!result.success) {
            ElementPlus.ElMessage.error('图片上传失败: ' + (result.error || '未知错误'));
            return;
          }

          // 更新本地数据（不通过 sendUpdate，服务端已广播；自己的广播被 originClientId 过滤，需本地直接追加）
          if (!Array.isArray(bug.images)) bug.images = [];
          bug.images.push(result.filename);

          // 落牌动画：新卡牌从上方落入牌堆（card-drop 由 Task 4 预留，450ms 后复位）
          newCardId.value = result.filename;
          setTimeout(() => { newCardId.value = null; }, 450);

          // 发射动画：仅目标行的上传按钮播放"托举发射"（launch 仅由 JS 控制，360ms 后移除）
          // 先等 v-if/v-else 重渲染（首次上传时 shot-add 会替换为 shot-add-more），再锁定重渲染后的元素
          await nextTick();
          const rowEl = rowElementOf(bugId);
          if (rowEl) {
            rowEl.querySelectorAll('.btn-upload').forEach(b => pulse(b, 'launch', 360));
          }

          // 服务端已直接更新 data.json 并广播，客户端不需要再 sendUpdate
          // 多图语义：不再覆盖旧图，所有图片由服务端统一管理生命周期

          ElementPlus.ElMessage.success('图片上传成功');
        } catch (err) {
          console.error('[Image] 上传失败:', err);
          ElementPlus.ElMessage.error('图片上传失败，请检查网络连接');
        }
      }

      /**
       * 点击截图 + 号：弹出选择气泡
       */
      function triggerImageMenu(event, bugId) {
        currentImageBugId.value = bugId;
        // 定位气泡在点击位置
        imageMenuX.value = event.clientX + 4;
        imageMenuY.value = event.clientY + 4;
        imageMenuVisible.value = true;
      }

      /**
       * 选择「上传文件」
       */
      function onChooseUpload() {
        imageMenuVisible.value = false;
        const bugId = currentImageBugId.value;
        if (!bugId) return;
        nextTick(() => {
          const input = fileInputRef.value;
          if (input) {
            input.value = '';
            input.click();
          }
        });
      }

      /**
       * 选择「粘贴截图」
       */
      function onChoosePaste() {
        imageMenuVisible.value = false;
        pasteTargetBugId.value = currentImageBugId.value;
        pasteBlob.value = null;
        pastePreviewUrl.value = '';
        pasteDialogVisible.value = true;
      }

      /**
       * 粘贴对话框打开后聚焦粘贴区域
       */
      function focusPasteArea() {
        nextTick(() => {
          if (pasteAreaRef.value) {
            pasteAreaRef.value.focus();
          }
        });
      }

      /**
       * 确认粘贴上传
       */
      function confirmPaste() {
        if (!pasteBlob.value || !pasteTargetBugId.value) return;
        handleImageUpload(pasteBlob.value, pasteTargetBugId.value);
        closePasteDialog();
      }

      /**
       * 关闭粘贴对话框
       */
      function closePasteDialog() {
        pasteDialogVisible.value = false;
        if (pastePreviewUrl.value) {
          URL.revokeObjectURL(pastePreviewUrl.value);
        }
        pasteBlob.value = null;
        pastePreviewUrl.value = '';
        pasteTargetBugId.value = null;
      }

      /**
       * 文件选择回调（支持多选：逐个上传追加）
       */
      function onFileSelect(event) {
        const files = event.target.files;
        if (!files || !files.length) return;
        const bugId = currentImageBugId.value;
        if (bugId) {
          // 批量预判："已有数 + 本次选择数 > 6" 整批拦截（handleImageUpload 内单张守卫保留作纵深）
          const bug = currentTask.value?.bugs?.find((b) => b.id === bugId);
          if (bug && (bug.images || []).length + files.length > 6) {
            ElementPlus.ElMessage.warning('单条任务最多 6 张截图');
            event.target.value = '';
            return;
          }
          for (let i = 0; i < files.length; i++) {
            handleImageUpload(files[i], bugId);
          }
        }
        event.target.value = '';
      }

      /**
       * 拖拽进入缩略图区域
       */
      function onDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget) {
          e.currentTarget.classList.add('drag-over');
        }
      }

      /**
       * 拖拽离开缩略图区域
       */
      function onDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget) {
          e.currentTarget.classList.remove('drag-over');
        }
      }

      /**
       * 拖拽放下
       */
      function onDrop(e, bugId) {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget) {
          e.currentTarget.classList.remove('drag-over');
        }
        const file = e.dataTransfer.files[0];
        if (file) {
          handleImageUpload(file, bugId);
        }
      }

      /**
       * 全局 Ctrl+V 粘贴：仅粘贴对话框打开时响应（对话框内焦点元素的 paste 冒泡到 document）
       */
      function onGlobalPaste(e) {
        if (!pasteDialogVisible.value) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type && item.type.startsWith('image/')) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (blob) {
              pasteBlob.value = blob;
              pastePreviewUrl.value = URL.createObjectURL(blob);
            }
            return;
          }
        }
      }

      /**
       * 删除单张图片
       * @param {object} bug
       * @param {string} filename
       */
      function deleteImage(bug, filename) {
        if (!bug || !filename) return;
        const i = (bug.images || []).indexOf(filename);
        if (i === -1) return; // 已不存在（如双击第二次）：不重复发送、不弹误导性提示
        bug.images.splice(i, 1);
        // 本地移除并通知服务端（服务端 handleRemoveImage 负责删除文件，保证先改数据、后删文件）
        sendMessage({ type: 'removeImage', clientId, data: { taskId: currentTaskId.value, bugId: bug.id, filename } });
        ElementPlus.ElMessage.success('图片已删除');
      }

      /** 查看器舞台就绪（展开动画完成后置 true，触发舞台淡入/复位） */
      const previewStageReady = ref(false);

      /** 查看器飞入/缩回元素（<div class="pv-zoom"> 的引用） */
      const pvZoom = ref(null);

      /** 触发展开的牌卡原始矩形（关闭时缩回原位）；pvTimer 为展开/缩回动画定时器 */
      let pvOriginRect = null, pvTimer = null;

      /**
       * 扑克牌堆卡片定位样式（第 1 张最上层，rotate/z 按序错落，最多 6 张全可见）
       * @param {number} i 卡片序号（0 起，取前 6 张）
       * @param {number[]} lefts 该堆的左偏移序列（主牌堆 52px 卡 / 备注 mini 堆 44px 卡）
       */
      function stackCardStyleAt(i, lefts) {
        const rot = [-5, -1, 3, 7, -2, 5][i] || 0;
        const z = [6, 5, 4, 3, 2, 1][i] || 1;
        return { left: (lefts[i] || 0) + 'px', transform: 'rotate(' + rot + 'deg)', zIndex: z };
      }
      function stackCardStyle(i) { return stackCardStyleAt(i, [2, 14, 26, 38, 50, 62]); }

      /**
       * 牌堆容器宽度自适应图片数量（= 最后一张卡片右缘）：图片少时紧凑、右侧无空隙；
       * 图片加多时容器自然变宽（卡片向左扩展）。卡片宽 52px、起始偏移 2px、步进 12px。
       * @param {number} n 图片总数（视觉最多叠 6 张）
       */
      function stackWrapStyle(n) {
        const count = Math.min(n || 0, 6);
        return { width: (52 + 2 + (count - 1) * 12) + 'px' };
      }

      /** 备注 mini 牌堆卡片定位（缩小版堆：偏移 [2,12,24,36,48,60]，点击整堆从第一张进查看器） */
      function noteStackCardStyle(i) { return stackCardStyleAt(i, [2, 12, 24, 36, 48, 60]); }

      /**
       * 打开大图预览（从点击的牌卡飞入展开；多图：从指定图片开始，支持前后翻页）
       * @param {object} bug
       * @param {string} [filename] 起始图片文件名（缺省时预览第一张）
       * @param {Event} [evt] 点击事件（取其 currentTarget 的矩形作为展开起点）
       */
      /** 当前预览图是否已完整下载（黑屏等待 → 下载完成一次性放出完整图，杜绝加载中间态闪烁） */
      const previewReady = ref(false);
      /** 当前预加载器（防快速翻页时旧回调误判） */
      let previewPreloader = null;

      /**
       * 预加载当前预览图：下载完成（含缓存命中）前保持黑屏，完成后放行显示
       */
      function preloadPreviewImage(url) {
        previewReady.value = false;
        if (previewPreloader) { previewPreloader.onload = null; previewPreloader.onerror = null; }
        const im = new Image();
        previewPreloader = im;
        im.onload = () => { if (previewPreloader === im) previewReady.value = true; };
        im.onerror = () => { if (previewPreloader === im) previewReady.value = true; }; // 失败也放行（避免黑屏卡死）
        im.src = url;
      }

      function openPreview(bug, filename, evt) {
        if (!bug || !Array.isArray(bug.images) || !bug.images.length) return;
        previewBug.value = bug;
        previewDeleteVisible.value = false;
        previewImages.value = [...bug.images];
        const idx = filename ? bug.images.indexOf(filename) : 0;
        previewIndex.value = idx === -1 ? 0 : idx;
        const cardEl = evt && evt.currentTarget;
        pvOriginRect = cardEl ? cardEl.getBoundingClientRect() : null;
        const zoom = pvZoom.value;
        clearTimeout(pvTimer);
        if (zoom && pvOriginRect) {
          const r = pvOriginRect;
          zoom.style.display = 'block';
          zoom.style.left = r.left + 'px'; zoom.style.top = r.top + 'px';
          zoom.style.width = r.width + 'px'; zoom.style.height = r.height + 'px';
          zoom.style.transform = 'none';
          // 缩放层纯黑放大过渡（不渲染图片，杜绝任何加载中间态）；图片由预加载完成后在舞台一次性放出
          imagePreviewVisible.value = true;   // 背景与放大同步开始变黑
          previewStageReady.value = false;
          preloadPreviewImage(previewImageUrl.value);
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
          preloadPreviewImage(previewImageUrl.value);
        }
      }

      /**
       * 关闭大图预览（缩回触发展开的牌卡原位；无起点时直接淡出）
       */
      function closePreview() {
        clearTimeout(pvTimer);
        previewBug.value = null;
        previewDeleteVisible.value = false;
        // 取出起点矩形后立即重置，避免备注图预览等无起点路径命中 stale 的缩回分支
        const r = pvOriginRect; pvOriginRect = null;
        const zoom = pvZoom.value;
        if (zoom && r) {
          previewStageReady.value = false;
          imagePreviewVisible.value = false;   // 背景同步淡出
          zoom.style.display = 'block';
          zoom.style.left = '50%'; zoom.style.top = '50%';
          zoom.style.transform = 'translate(-50%,-50%)';
          zoom.style.width = 'min(720px,86vw)'; zoom.style.height = 'min(520px,72vh)';
          requestAnimationFrame(() => requestAnimationFrame(() => {
            zoom.style.left = r.left + 'px'; zoom.style.top = r.top + 'px';
            zoom.style.transform = 'none';
            zoom.style.width = r.width + 'px'; zoom.style.height = r.height + 'px';
            // 隐藏定时器存入 pvTimer，快速重开时 openPreview 的 clearTimeout 可取消；回调内加双保险，避免误隐藏重开中的缩放层
            pvTimer = setTimeout(() => { if (!imagePreviewVisible.value) zoom.style.display = 'none'; }, 280);
          }));
        } else {
          imagePreviewVisible.value = false;
          previewStageReady.value = false;   // 与有起点分支对称，避免舞台状态残留
          // 无起点关闭：立即隐藏缩放层，防 bug 预览关闭后 280ms 内开 note 预览时缩放层残留可见
          if (zoom) zoom.style.display = 'none';
        }
      }

      /**
       * 备注图预览（任务级/条目级共用）：直接进查看器，不设置归属 bug（无删除钮）
       */
      function openNoteImagePreview(images) {
        previewBug.value = null;
        previewDeleteVisible.value = false;
        if (!Array.isArray(images) || !images.length) return;
        previewImages.value = [...images];
        previewIndex.value = 0;
        imagePreviewVisible.value = true;
        previewStageReady.value = true;
        preloadPreviewImage(previewImageUrl.value);
      }

      /**
       * 查看器内请求删除当前截图：弹居中确认框
       */
      function askPreviewDelete() { previewDeleteVisible.value = true; }

      /** 取消查看器内删除 */
      function cancelPreviewDelete() { previewDeleteVisible.value = false; }

      /**
       * 确认删除当前预览截图：
       * 本地移除 + 同步服务端（服务端删文件并广播）→ 预览切到下一张；尾张则回第一张；删空则关闭查看器
       */
      function confirmPreviewDelete() {
        const bug = previewBug.value;
        if (!bug) { previewDeleteVisible.value = false; return; }
        const filename = previewImages.value[previewIndex.value];
        if (!filename) { previewDeleteVisible.value = false; return; }

        deleteImage(bug, filename); // 从 bug.images 移除 + sendRemoveImage（服务端删文件 + 广播）

        const idx = previewImages.value.indexOf(filename);
        if (idx !== -1) previewImages.value.splice(idx, 1);
        if (!previewImages.value.length) {
          previewDeleteVisible.value = false;
          closePreview(); // 删空：关闭查看器
          return;
        }
        // 尾张 → 第一张；否则 splice 后当前索引即"下一张"
        const newIdx = previewIndex.value >= previewImages.value.length ? 0 : previewIndex.value;
        previewIndex.value = newIdx;
        previewDeleteVisible.value = false;
      }

      /**
       * 全局 Esc 关闭查看器：仅查看器可见且无 Element Plus 弹窗时消费 Esc
       * （有 .el-overlay 时让弹窗优先消费 Esc，避免误关查看器；删除确认框打开时先取消确认）
       */
      function onGlobalKeydown(e) {
        if (e.key !== 'Escape') return;
        if (previewDeleteVisible.value) { previewDeleteVisible.value = false; return; }
        if (!imagePreviewVisible.value) return;
        if (document.querySelector('.el-overlay')) return; // 有 Element Plus 弹窗时让弹窗优先消费 Esc
        closePreview();
      }

      /**
       * 预览上一张
       */
      function previewPrev() { if (previewIndex.value > 0) { previewIndex.value--; preloadPreviewImage(previewImageUrl.value); } }

      /**
       * 预览下一张
       */
      function previewNext() { if (previewIndex.value < previewImages.value.length - 1) { previewIndex.value++; preloadPreviewImage(previewImageUrl.value); } }

      // ==================== 启动模式选择 ====================

      /**
       * 用户选择模式（服务器 / 客户端）
       */
      async function selectMode(mode) {
        startupMode.value = mode;
        if (mode === 'server') {
          // 服务器模式：获取本机局域网 IP 显示给用户
          if (window.electronAPI?.getLocalIp) {
            try {
              const ip = await window.electronAPI.getLocalIp();
              if (ip) locationHost.value = ip;
            } catch (e) { /* 保持默认 hostname */ }
          }
        } else if (mode === 'client') {
          // 客户端模式：预填上次保存的地址
          const saved = localStorage.getItem('buglist_server_host');
          if (saved) {
            startupAddressInput.value = saved;
          }
        }
      }

      /**
       * 确认客户端模式：设置远程地址并连接
       */
      async function confirmClientMode() {
        await ensureClientId();
        displayName.value = displayName.value.trim();
        if (!displayName.value) { ElementPlus.ElMessage.warning('请先填写你的名字'); return; }
        identity = { clientId: clientId, displayName: displayName.value };
        try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch (e) { /* 忽略 */ }

        const addr = startupAddressInput.value.trim();
        if (!addr) { ElementPlus.ElMessage.warning('请输入服务器地址'); return; }
        // 保存地址
        localStorage.setItem('buglist_server_host', addr);
        // 保存模式偏好（下次跳过对话框）
        localStorage.setItem('buglist_mode', 'client');
        // 更新 serverHost
        serverHost.value = addr;
        // 关闭对话框并连接
        showStartupDialog.value = false;
        connectWebSocket();
      }

      /**
       * 确认服务器模式：连接本地
       */
      async function confirmServerMode() {
        await ensureClientId();
        displayName.value = displayName.value.trim();
        if (!displayName.value) { ElementPlus.ElMessage.warning('请先填写你的名字'); return; }
        identity = { clientId: clientId, displayName: displayName.value };
        try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch (e) { /* 忽略 */ }

        // 保存模式偏好
        localStorage.setItem('buglist_mode', 'server');
        // 连接 localhost
        serverHost.value = location.host;
        showStartupDialog.value = false;
        connectWebSocket();
      }

      /**
       * 初始化启动流程：检查是否有已保存的偏好
       */
      async function initStartup() {
        await ensureClientId();
        if (!identity || !identity.displayName) {
          // 存量用户已有模式偏好但从未填过名字：弹对话框补填（可点右上角关闭跳过）
          showStartupDialog.value = true;
          return;
        }
        const savedMode = localStorage.getItem('buglist_mode');
        if (savedMode === 'server') {
          // 已选过服务器模式，直接连接本地
          serverHost.value = location.host;
          connectWebSocket();
        } else if (savedMode === 'client') {
          // 已选过客户端模式，用保存的地址连接
          const savedHost = localStorage.getItem('buglist_server_host');
          if (savedHost) {
            serverHost.value = savedHost;
          }
          connectWebSocket();
        } else {
          // 首次启动，显示对话框
          showStartupDialog.value = true;
        }
      }

      /**
       * 重新选择启动模式：仅显示对话框，不删除已保存的偏好
       */
      function resetStartupMode() {
        // 不再删除 localStorage 中的模式/地址：误点"重新选择启动模式"不应丢配置。
        // 仅在用户确认新模式/新地址时（confirmClientMode / confirmServerMode）才覆盖。
        disconnectReason.value = null; // 重置模式后清掉旧的断线原因文案
        disconnect(); // 断连复用 disconnect：清重连定时器 + 待发队列，onclose 已摘除不自动重连
        showStartupDialog.value = true;
        startupMode.value = null;
        startupAddressInput.value = (function () {
          try { return localStorage.getItem('buglist_server_host') || ''; } catch (e) { return ''; }
        })();
        connectionStatus.value = 'disconnected';
      }

      /** 是否已有保存的模式偏好（首次启动无偏好时不允许关闭对话框，否则无法进入应用） */
      const hasSavedPrefs = computed(() => {
        try { return !!(localStorage.getItem('buglist_mode') || localStorage.getItem('buglist_server_host')); } catch (e) { return false; }
      });

      /** 关闭启动对话框，回到清单页并恢复原有连接 */
      async function cancelStartup() {
        await ensureClientId();
        showStartupDialog.value = false;
        startupMode.value = null;
        startupAddressInput.value = '';
        connectWebSocket(); // serverHost.value 未被改动，自动连回原服务器
      }

      // ==================== 生命周期 ====================

      /** 宽窗口判定（≥1200px 启用 .bug-list-wide 加宽列） */
      const updW = () => {
        isWideWindow.value = window.innerWidth >= 1200;
      };

      onMounted(() => {
        // 恢复上次使用的任务
        try {
          const saved = localStorage.getItem('buglist_current_task');
          if (saved) currentTaskId.value = saved;
        } catch (e) { /* 静默忽略 */ }
        initStartup();
        // 注册全局粘贴事件监听（仅粘贴对话框打开时生效）
        document.addEventListener('paste', onGlobalPaste);
        // 注册全局 Esc 监听（仅查看器打开时生效，用于关闭大图预览；onGlobalKeydown 即查看器 Esc 处理器）
        document.addEventListener('keydown', onGlobalKeydown);
        // 桌面版：把本机保存的快捷键同步给主进程（globalShortcut 注册窗口切换热键）
        syncShortcutToMain();
        // 宽窗口标记
        updW();
        window.addEventListener('resize', updW);
        // 滚动反馈：吸顶投影 + 小火箭（passive，rAF 节流见 onWinScroll）
        panelStickyEl = document.querySelector('.panel-sticky');
        titlebarH = document.querySelector('.win-titlebar')?.offsetHeight || 0; // 量 DOM 真实高度（裁决③：DOM 成唯一事实源，浏览器无此元素→0）
        window.addEventListener('scroll', onWinScroll, { passive: true });
        onWinScroll(); // 首屏主动校准一次，消除无 scroll 事件时（如会话恢复滚动位置）投影/火箭的一帧滞后（审查#3）
      });

      onUnmounted(() => {
        document.removeEventListener('paste', onGlobalPaste);
        document.removeEventListener('keydown', onGlobalKeydown);
        window.removeEventListener('resize', updW);
        window.removeEventListener('scroll', onWinScroll);
        if (scrollRafId) { cancelAnimationFrame(scrollRafId); scrollRafId = 0; }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws) {
          ws.onclose = null; // 避免触发重连
          ws.close();
          ws = null;
        }
      });

      // ==================== 导出 ====================

      return {
        // 启动模式对话框
        // 启动模式选择
        showStartupDialog,
        // Electron 自绘标题栏（窗口控制）
        isElectron,
        stickyStuck,
        rocketVisible,
        archivedBugs,
        archiveExpanded,
        archiveFlash,
        toggleArchive,
        archiveBug,
        restoreBug,
        winAlwaysOnTop,
        winMaximized,
        winMinimize,
        winMaximizeToggle,
        winClose,
        toggleAlwaysOnTop,
        startupMode,
        startupAddressInput,
        displayName,
        locationHost,
        locationPort,
        selectMode,
        confirmClientMode,
        confirmServerMode,
        resetStartupMode,
        hasSavedPrefs,
        cancelStartup,

        // 备份状态
        backupStatus,
        backupLabel,

        // 主题（仅本机生效）
        themes,
        themeId,
        themeMenuVisible,
        themeMenuLeaving,
        themeMenuX,
        themeMenuY,
        toggleThemeMenu,
        closeThemeMenu,
        applyThemeRebuild,

        // 更多菜单（导出 / 导入）
        moreMenuVisible,
        moreMenuX,
        moreMenuY,
        importFileInput,
        toggleMoreMenu,
        closeMoreMenu,
        exportData,
        onImportFileSelect,
        launchRocket,

        // 设置面板 + 快捷键
        settingsVisible,
        settingsClosing,
        shortcutRecording,
        shortcutDraft,
        shortcut,
        openSettings,
        closeSettings,
        onSettingsAnimEnd,
        startRecordShortcut,
        confirmSettings,
        shortcutLabel,

        // 搜索
        searchText,

        // 组内排序（正序/倒序）
        sortDesc,
        toggleSort,

        // 状态变更动画（手动 FLIP / 飞向 tag + 计数闪烁）
        flashStatus,

        // 数据
        tasks,
        currentTaskId,
        clientId,
        connectionStatus,
        disconnectReason,
        dataVersion,
        onlineCount,
        statusOptions,
        isWideWindow,
        confirmBugId,
        dyingBugId,
        fadingBugId,
        enteringBugId,
        newCardId,
        editingBugId,
        editingTaskId,
        editingTaskName,
        statusFilter,
        imagePreviewVisible,
        previewImages,
        previewReady,
        previewIndex,
        previewStageReady,
        previewBug,
        previewDeleteVisible,
        pvZoom,
        fileInputRef,

        // 截图选择气泡
        imageMenuVisible,
        imageMenuX,
        imageMenuY,

        // 粘贴对话框
        pasteDialogVisible,
        pasteBlob,
        pastePreviewUrl,
        pasteAreaRef,

        // 任务备注弹窗
        notesDialogVisible,
        notesDialogTask,
        newNoteContent,
        pendingNoteFiles,
        pendingNoteFileUrls,
        attachTargetNote,
        noteFileInput,

        // 任务备注弹窗
        bugNotesVisible,
        bugNotesTargetBug,
        newBugNoteContent,
        pendingBugNoteFiles,
        pendingBugNoteFileUrls,
        attachTargetBugNote,
        bugNoteFileInput,

        // 计算属性
        shortClientId,
        statusText,
        filteredAndSortedBugs,
        statusCounts,

        // 服务器地址
        serverHost,
        onServerChange,

        // 方法
        getStatusClass,
        setStatusFilter,
        filterStatusClass,
        onStatusChange,
        startEditName,
        finishEditName,
        cancelEditName,

        // 新增任务"下一步"面板（deadline / 备注询问）
        nextStepBugId,
        nsDeadlineOn,
        nsDeadline,
        nsNoteOn,
        nsNoteText,
        nsClosing,
        nsHoursVisible,
        nsHoursClosing,
        closeNextStep,
        confirmNextStep,
        onNextStepAnimEnd,
        openHoursPicker,
        applyHoursDays,
        closeHoursPicker,
        onHoursAnimEnd,
        addBug,
        onDelDown,
        onDelUp,
        cancelDeleteConfirm,
        confirmDeleteBug,

        // 任务方法
        createTask,
        switchTask,
        startRenameTask,
        finishRenameTask,
        cancelRenameTask,
        deleteTask,

        // 任务排序（本地拖拽，仅本机生效）
        orderedTasks,
        dragTaskId,
        dragOverTaskId,
        onTaskDragStart,
        onTaskDragEnd,
        onTaskDragOver,
        onTaskDragLeave,
        onTaskDropAt,
        onTaskDropToEnd,

        // 任务备注方法
        getNoteWriters: noteWriters,
        getNoteColor,
        assigneeLabel,
        openNotesDialog,
        editingTaskNoteId,
        startEditTaskNote,
        confirmEditTaskNote,
        cancelEditTaskNote,
        isNoteModified,
        onTaskNoteEditKeydown,
        onTaskNoteNewKeydown,
        addNoteWithImage,
        onChooseNoteImage,
        removePendingNoteFile,
        clearPendingNoteImage,
        pickAttachImage,
        updateNoteImage,
        deleteNote,

        // 任务备注方法
        getBugNoteWriters: noteWriters,
        openBugNotesDialog,
        editingBugNoteId,
        startEditBugNote,
        confirmEditBugNote,
        cancelEditBugNote,
        addBugNoteWithImage,
        onChooseBugNoteImage,
        removePendingBugNoteFile,
        clearPendingBugNoteImage,
        pickAttachBugImage,
        updateBugNoteImage,
        deleteBugNote,
        onBugNoteEditKeydown,
        onBugNoteNewKeydown,
        formatTime,

        // 图片方法
        triggerImageMenu,
        onChooseUpload,
        onChoosePaste,
        focusPasteArea,
        confirmPaste,
        closePasteDialog,
        onFileSelect,
        onDragOver,
        onDragLeave,
        onDrop,
        openPreview,
        openNoteImagePreview,
        askPreviewDelete,
        cancelPreviewDelete,
        confirmPreviewDelete,
        previewPrev,
        previewNext,
        closePreview,
        stackCardStyle,
        stackWrapStyle,
        noteStackCardStyle,
      };
    },
  });

  // 安装 Element Plus（中文语言包）
  app.use(ElementPlus, {
    locale: ElementPlusLocaleZhCn,
  });

  // 挂载应用
  app.mount('#app');
})();
