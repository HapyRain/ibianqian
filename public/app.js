/**
 * 任务清单 - 多人协同
 * Vue 3 应用核心逻辑
 * 包含：数据绑定、表格编辑、WebSocket 客户端、断线重连
 */
(function () {
  const { createApp, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick, toRaw } = Vue;

  // ==================== UUID 兼容 ====================
  function uuid() {
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
  const randomUUID = uuid;

  const app = createApp({
    setup() {
      // ==================== 诊断 ====================
      console.log('[Init] electronAPI 可用:', !!(window.electronAPI));
      console.log('[Init] writeBackup 可用:', typeof window.electronAPI?.writeBackup);
      console.log('[Init] getLocalIp 可用:', typeof window.electronAPI?.getLocalIp);

      // ==================== 响应式数据 ====================

      /** 所有任务列表 */
      const tasks = ref([]);

      /** 宽窗口标记（≥1200px 时行内列加宽，见 .bug-list-wide） */
      const isWideWindow = ref(false);

      /** 删除/落位确认高亮行 id（spotlight） */
      const confirmBugId = ref(null);

      /** 正在"消亡"（删除过渡）的行 id */
      const dyingBugId = ref(null);

      /** 覆盖在下方的行 id（spotlight 浮层阴影） */
      const coveringBugId = ref(null);

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
      function onTaskDrop(targetId) {
        const from = dragTaskId.value;
        dragTaskId.value = null;
        if (!from || from === targetId) return;
        const order = orderedTasks.value.map(t => t.id);
        const fromIdx = order.indexOf(from);
        if (fromIdx === -1) return;
        order.splice(fromIdx, 1);
        const toIdx = order.indexOf(targetId); // 移除后重算
        order.splice(toIdx, 0, from);
        taskOrder.value = order;
        persistTaskOrder();
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

      /** 状态排序映射：修复中(0) → 待修复(1) → 已完成(2) */
      const STATUS_ORDER = { '修复中': 0, '待修复': 1, '已完成': 2 };

      /** 正在编辑名称的任务 ID */
      const editingBugId = ref(null);

      /** 状态筛选条件（默认"全部"即不筛选） */
      const statusFilter = ref('全部');

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

      /** 名称输入框引用 */
      const nameInputRef = ref(null);

      /** 图片上传：当前正在操作的任务 ID（用于文件选择器关联） */
      const currentImageBugId = ref(null);

      /** 大图预览对话框可见性 */
      const imagePreviewVisible = ref(false);

      /** 当前预览的图片 URL */
      const previewImageUrl = ref('');

      /** 当前预览的图片集合（多图） */
      const previewImages = ref([]);

      /** 当前预览的图片索引 */
      const previewIndex = ref(0);

      /** 正在上传中的任务 ID（用于 loading 遮罩） */
      const uploadingBugId = ref(null);

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
        let list = bugs;
        // 筛选
        if (statusFilter.value !== '全部') {
          list = list.filter(b => b.status === statusFilter.value);
        }
        // 排序：修复中(0) → 待修复(1) → 已完成(2)，同状态保持原序（稳定排序）
        return [...list].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
      });

      /** 备注弹窗对应的任务 */
      const notesDialogTask = computed(() => {
        return tasks.value.find(t => t.id === notesDialogTaskId.value) || null;
      });

      /** 各状态任务数量（用于筛选按钮显示） */
      const statusCounts = computed(() => {
        const bugs = currentTask.value?.bugs || [];
        const counts = { '全部': bugs.length };
        statusOptions.forEach(opt => {
          counts[opt] = bugs.filter(b => b.status === opt).length;
        });
        return counts;
      });

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
          // 服务端会自动发送 fullSync，但也可以主动请求
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
       */
      function sendMessage(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        } else {
          console.warn('[WS] 无法发送消息，连接未就绪');
        }
      }

      /**
       * 发送更新消息
       */
      function sendUpdate(bugId, field, value) {
        sendMessage({
          type: 'update',
          clientId,
          data: { taskId: currentTaskId.value, bugId, field, value },
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

        const { type, taskId, bugId, field, value, completedAt } = msg.change;
        console.log(`[WS] 收到广播: type=${type}, taskId=${taskId?.substring(0,8)}, bugId=${bugId}, field=${field}, value=${value}, completedAt=${completedAt}, 来源=${(msg.originClientId || '?').substring(0,8)}`);

        switch (type) {
          case 'add':
            handleRemoteAdd(msg);
            break;
          case 'update':
            handleRemoteUpdate(taskId, bugId, field, value, completedAt);
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
       * 处理远程新增
       */
      function handleRemoteAdd(msg) {
        const change = msg.change;
        if (!change || !change.bug || !change.taskId) return;
        const task = tasks.value.find(t => t.id === change.taskId);
        if (!task) {
          console.log(`[WS] handleRemoteAdd: taskId=${change.taskId?.substring(0,8)} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
        const newBug = { ...change.bug };
        // 检查是否已存在（防重复）
        if (!task.bugs.some(b => b.id === newBug.id)) {
          task.bugs.push(newBug);
        }
      }

      /**
       * 处理远程更新
       */
      function handleRemoteUpdate(taskId, bugId, field, value, completedAt) {
        const task = tasks.value.find(t => t.id === taskId);
        if (!task) {
          console.log(`[WS] handleRemoteUpdate: taskId=${taskId?.substring(0,8)} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
        const bug = task.bugs.find(b => b.id === bugId);
        if (!bug) {
          console.log(`[WS] handleRemoteUpdate: bugId=${bugId} 在 taskId=${taskId?.substring(0,8)} 中未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }

        // 第三层防护：新旧值相同时跳过
        if (bug[field] === value && completedAt === undefined) {
          console.log(`[WS] handleRemoteUpdate: bugId=${bugId} ${field} 值相同，跳过 (${value})`);
          return;
        }

        console.log(`[WS] handleRemoteUpdate: taskId=${taskId?.substring(0,8)}, bugId=${bugId}, ${field}=${value} (旧值=${bug[field]})`);
        bug[field] = value;

        // 同步 completedAt 时间锚点
        if (completedAt !== undefined) {
          if (completedAt === null) {
            delete bug.completedAt;
          } else {
            bug.completedAt = completedAt;
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
        const task = tasks.value.find(t => t.id === taskId);
        if (!task) {
          console.log(`[WS] handleRemoteAddImage: taskId=${taskId?.substring(0,8)} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
        const bug = task.bugs.find(b => b.id === bugId);
        if (!bug) {
          console.log(`[WS] handleRemoteAddImage: bugId=${bugId} 在 taskId=${taskId?.substring(0,8)} 中未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
        if (!Array.isArray(bug.images)) bug.images = [];
        if (!bug.images.includes(filename)) bug.images.push(filename);
      }

      /**
       * 处理远程移除单张图片
       */
      function handleRemoteRemoveImage(taskId, bugId, filename) {
        const task = tasks.value.find(t => t.id === taskId);
        if (!task) {
          console.log(`[WS] handleRemoteRemoveImage: taskId=${taskId?.substring(0,8)} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
        const bug = task.bugs.find(b => b.id === bugId);
        if (!bug) {
          console.log(`[WS] handleRemoteRemoveImage: bugId=${bugId} 在 taskId=${taskId?.substring(0,8)} 中未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
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
        const task = tasks.value.find(t => t.id === change.taskId);
        if (!task) {
          console.log(`[WS] handleRemoteAddNote: taskId=${change.taskId?.substring(0, 8)} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
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
        const task = tasks.value.find(t => t.id === change.taskId);
        if (!task) {
          console.log(`[WS] handleRemoteAddBugNote: taskId=${change.taskId?.substring(0, 8)} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
        const bug = task.bugs.find(b => b.id === change.bugId);
        if (!bug) {
          console.log(`[WS] handleRemoteAddBugNote: bugId=${change.bugId} 未找到，请求全量同步`);
          sendMessage({ type: 'requestSync', clientId });
          return;
        }
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

      /**
       * 状态变更
       */
      function onStatusChange(bug, newStatus) {
        bug.status = newStatus;
        // 自动管理完成时间锚点
        if (newStatus === '已完成') {
          bug.completedAt = formatTimestamp(new Date());
        } else if (bug.completedAt !== undefined) {
          delete bug.completedAt;
        }
        sendUpdate(bug.id, 'status', newStatus);
      }

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
       */
      function finishEditName(bug) {
        editingBugId.value = null;
        // 值无变化则跳过
        if (bug.name === editNameBackup) return;
        sendUpdate(bug.id, 'name', bug.name);
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
          ElementPlus.ElMessage.warning('请先创建任务');
          return;
        }

        const newBug = {
          id: randomUUID(),
          name: '',
          status: '待修复',
          images: [],
        };

        task.bugs.push(newBug);

        // 发送新增消息
        sendAdd(newBug.id);

        // 行生长动画：标记新行播放 row-enter（Task 3 预留接线，320ms 后复位）
        enteringBugId.value = newBug.id;
        setTimeout(() => { enteringBugId.value = null; }, 320);

        // 新增按钮"垒上"动画（land 仅由 JS 控制；限定工具栏按钮，避免误中标签栏"＋"）
        const addBtn = document.querySelector('.toolbar-actions .btn-add');
        if (addBtn) {
          addBtn.classList.add('land');
          setTimeout(() => addBtn.classList.remove('land'), 360);
        }

        // 自动进入编辑模式
        nextTick(() => {
          startEditName(newBug);
        });
      }

      /**
       * 删除任务
       */
      function deleteBug(bug) {
        const task = currentTask.value;
        if (!task) return;

        const index = task.bugs.findIndex((b) => b.id === bug.id);
        if (index !== -1) {
          task.bugs.splice(index, 1);
        }

        // 图片文件由服务端 handleDelete 在数据写盘成功后统一清理
        sendDelete(bug.id);
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
        const btn = e.currentTarget;
        btn.classList.add('burst');
        setTimeout(() => btn.classList.remove('burst'), 440);
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

      /**
       * 被删行的下一行 id（该行获得"盖子投影"）
       */
      function nextBugIdOf(bug) {
        const list = filteredAndSortedBugs.value;
        const i = list.findIndex(b => b.id === bug.id);
        return i !== -1 && list[i + 1] ? list[i + 1].id : null;
      }

      /** 按 data-bug-id 找到对应行元素 */
      function rowElementOf(id) { return document.querySelector('.bug-row[data-bug-id="' + id + '"]'); }

      /**
       * 确认删除：幕布渐亮 → 红光一闪 + 高度坍塌 → 340ms 后真正移除并同步
       */
      function confirmDeleteBug(bug) {
        if (dyingBugId.value) return; // 重入守卫：已有删除动画进行中
        const task = currentTask.value;
        if (!task) return;
        confirmBugId.value = null;        // 幕布渐亮
        dyingBugId.value = bug.id;        // 红光一闪 + 高度坍塌
        coveringBugId.value = nextBugIdOf(bug); // 下面一行获得盖子投影
        const rowEl = rowElementOf(bug.id);
        const h = rowEl ? rowEl.offsetHeight : 44;
        if (rowEl) {
          rowEl.style.minHeight = '0px';  // 红线①：min-height:44px 会顶住坍塌，先归零
          rowEl.style.height = h + 'px';  // 红线①：必须先钉死像素（auto→0 无法过渡）
          rowEl.getBoundingClientRect();
          rowEl.style.height = '0px';
        }
        setTimeout(() => {
          if (dyingBugId.value === bug.id) { // 身份守卫：仍在本行的消亡中才真正删除
            const task2 = currentTask.value;
            const idx = (task2 && task2.bugs) ? task2.bugs.findIndex(b => b.id === bug.id) : -1;
            if (idx !== -1) task2.bugs.splice(idx, 1);
            sendDelete(bug.id);
            dyingBugId.value = null;
            coveringBugId.value = null;
          }
        }, 340); // 文字被完全压住后才真正删除
      }

      // ==================== 任务操作 ====================

      /** 正在编辑名称的任务 ID */
      const editingTaskId = ref(null);
      const editingTaskName = ref('');

      /**
       * 新建任务
       */
      function createTask() {
        const task = {
          id: randomUUID(),
          name: '新任务',
          bugs: [],
        };
        tasks.value.push(task);
        currentTaskId.value = task.id;
        persistCurrentTask();
        sendMessage({ type: 'createTask', clientId, data: { task: { id: task.id, name: task.name } } });
        // 自动进入编辑模式
        nextTick(() => {
          startRenameTask(task);
        });
      }

      /**
       * 切换任务
       */
      function switchTask(taskId) {
        currentTaskId.value = taskId;
        persistCurrentTask();
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
       * 开始重命名任务
       */
      function startRenameTask(task) {
        editingTaskName.value = task.name;
        editingTaskId.value = task.id;
        nextTick(() => {
          const input = document.querySelector('.task-name-edit input');
          if (input) {
            input.focus();
            input.select();
          }
        });
      }

      /**
       * 完成重命名任务
       */
      function finishRenameTask(task) {
        if (!task) return;
        const newName = editingTaskName.value.trim();
        editingTaskId.value = null;
        if (!newName || newName === task.name) return;
        task.name = newName;
        sendMessage({ type: 'updateTask', clientId, data: { taskId: task.id, field: 'name', value: newName } });
      }

      /**
       * 取消重命名任务
       */
      function cancelRenameTask() {
        editingTaskId.value = null;
        editingTaskName.value = '';
      }

      /**
       * 删除任务
       */
      function deleteTask(taskId) {
        if (tasks.value.length <= 1) {
          ElementPlus.ElMessage.warning('至少保留一个任务');
          return;
        }
        const task = tasks.value.find(t => t.id === taskId);
        if (!task) return;
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
       * 计算某任务有多少个不同的人写过备注
       */
      function getNoteWriters(task) {
        if (!task || !task.notes || task.notes.length === 0) return 0;
        return new Set(task.notes.map(n => n.clientId)).size;
      }

      /**
       * 打开备注弹窗
       */
      function openNotesDialog(task, evt) {
        // 任务标签栏备注按钮"便签翘角"动画：用事件源精确定位被点击标签的按钮（peel 仅由 JS 控制，300ms 后移除）
        const el = evt && evt.currentTarget;
        if (el) {
          el.classList.add('peel');
          setTimeout(() => el.classList.remove('peel'), 300);
        }
        notesDialogTaskId.value = task.id;
        notesDialogVisible.value = true;
      }

      /**
       * 任务备注 - 编辑键盘事件（Enter 确认，Shift+Enter 换行）
       */
      function onTaskNoteEditKeydown(e, note) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          updateNote(note.id, note.content);
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
          // 上限防御：单条备注最多 20 张图片（新备注 note.images 尚为空，按待传数量判定；>20 仅拦截超限，恰好 20 张放行）
          if (files.length > 20) {
            ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
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
          // 已有备注：批量预判"已有数 + 本次选择数 > 20"整批拦截（attachNoteImage 内单张守卫保留作纵深）
          const note = attachTargetNote.value;
          if ((note.images || []).length + files.length > 20) {
            ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
            event.target.value = '';
            attachTargetNote.value = null;   // 与成功路径对称复位，避免拦截后误附加到旧备注
            return;
          }
          // 逐张附加（服务端追加并广播；本地因自身广播被过滤需手动 push）
          files.forEach(f => attachNoteImage(note, f));
          attachTargetNote.value = null;
        } else {
          // 新备注待提交模式：批量预判"待传数 + 本次选择数 > 20"拦截（未超限才 push）
          if (pendingNoteFiles.value.length + files.length > 20) {
            ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
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
        // 上限防御：单条备注最多 20 张图片
        if ((note.images || []).length >= 20) {
          ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
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
       * 删除备注
       */
      function deleteNote(noteId) {
        const task = notesDialogTask.value;
        if (!task || !task.notes) return;
        const note = task.notes.find(n => n.id === noteId);
        // 归属防御：仅作者本人可删除（与服务端校验保持一致）
        if (!note || note.clientId !== clientId) return;
        const index = task.notes.findIndex(n => n.id === noteId);
        if (index === -1) return;
        task.notes.splice(index, 1);
        sendMessage({ type: 'deleteNote', clientId, data: { taskId: task.id, noteId } });
      }

      /** 备注作者颜色调色板 */
      const NOTE_COLORS = ['#e6a23c', '#409eff', '#67c23a', '#f56c6c', '#9b59b6', '#1abc9c'];

      /**
       * 根据 clientId 返回一个稳定的颜色
       */
      function getNoteColor(clientId) {
        if (!clientId) return NOTE_COLORS[0];
        let hash = 0;
        for (let i = 0; i < clientId.length; i++) {
          hash = ((hash << 5) - hash) + clientId.charCodeAt(i);
          hash |= 0;
        }
        return NOTE_COLORS[Math.abs(hash) % NOTE_COLORS.length];
      }

      // ==================== 任务备注操作 ====================

      /** 任务备注弹窗对应的任务 */
      const bugNotesTargetBug = computed(() => {
        const task = tasks.value.find(t => t.id === bugNotesTaskId.value);
        return task?.bugs?.find(b => b.id === bugNotesBugId.value) || null;
      });

      function getBugNoteWriters(bug) {
        if (!bug || !bug.notes || bug.notes.length === 0) return 0;
        return new Set(bug.notes.map(n => n.clientId)).size;
      }

      function openBugNotesDialog(taskId, bugId) {
        // 行内备注按钮"便签翘角"动画：按 data-bug-id 精确锁定被点击行的按钮（peel 仅由 JS 控制，300ms 后移除）
        const noteBtn = document.querySelector('.bug-row[data-bug-id="' + bugId + '"] .btn-note');
        if (noteBtn) {
          noteBtn.classList.add('peel');
          setTimeout(() => noteBtn.classList.remove('peel'), 300);
        }
        bugNotesTaskId.value = taskId;
        bugNotesBugId.value = bugId;
        bugNotesVisible.value = true;
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
          // 上限防御：单条备注最多 20 张图片（新备注 note.images 尚为空，按待传数量判定；>20 仅拦截超限，恰好 20 张放行）
          if (files.length > 20) {
            ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
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
          // 已有备注：批量预判"已有数 + 本次选择数 > 20"整批拦截（attachBugNoteImage 内单张守卫保留作纵深）
          const note = attachTargetBugNote.value;
          if ((note.images || []).length + files.length > 20) {
            ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
            event.target.value = '';
            attachTargetBugNote.value = null;   // 与成功路径对称复位，避免拦截后误附加到旧备注
            return;
          }
          // 逐张附加（服务端追加并广播；本地因自身广播被过滤需手动 push）
          files.forEach(f => attachBugNoteImage(note, f));
          attachTargetBugNote.value = null;
        } else {
          // 新备注待提交模式：批量预判"待传数 + 本次选择数 > 20"拦截（未超限才 push）
          if (pendingBugNoteFiles.value.length + files.length > 20) {
            ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
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
        // 上限防御：单条备注最多 20 张图片
        if ((note.images || []).length >= 20) {
          ElementPlus.ElMessage.warning('单条备注最多 20 张图片');
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
        const index = bug.notes.findIndex(n => n.id === noteId);
        if (index === -1) return;
        bug.notes.splice(index, 1);
        sendMessage({ type: 'deleteBugNote', clientId, data: { taskId: bugNotesTaskId.value, bugId: bug.id, noteId } });
      }

      function onBugNoteEditKeydown(e, note) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          updateBugNote(note.id, note.content);
        }
      }

      function onBugNoteNewKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          addBugNoteWithImage(newBugNoteContent.value);
        }
      }

      /**
       * 格式化时间戳为可读时间
       */
      function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }

      /**
       * 格式化时间戳，精确到秒（用于 completedAt 等时间锚点字段）
       */
      function formatTimestamp(date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

      /**
       * 启动 30s 间隔本地备份（仅 Electron 客户端生效）
       */
      function backupDirName(ip) {
        return ip.replace(/[:*?"<>|]/g, '_');
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
        backupTimer = setInterval(() => {
          const ip = serverHost.value;
          if (!ip || !tasks.value.length) return;
          const clean = JSON.parse(JSON.stringify({ version: dataVersion.value, tasks: tasks.value }));
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
        }, 30000);
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
        const ip = serverHost.value;
        if (!ip || !tasks.value.length) {
          console.log(`[Backup] 立即备份跳过: ip=${ip}, tasks=${tasks.value.length}`);
          return;
        }
        const clean = JSON.parse(JSON.stringify({ version: dataVersion.value, tasks: tasks.value }));
        window.electronAPI.writeBackup(ip, clean).then((res) => {
          if (res && res.ok) {
            backupCount = 1;
            backupStatus.value = 'ok';
            console.log(`[Backup] 首次备份成功 → D:\\Bug清单\\pc\\${backupDirName(ip)}\\data.json (tasks: ${clean.tasks.length})`);
          } else {
            backupStatus.value = 'fail';
            console.warn('[Backup] 首次备份失败:', res?.error || '未知错误');
          }
        }).catch((err) => {
          backupStatus.value = 'fail';
          console.error('[Backup] 异常:', err.message);
        });
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

        // 上限防御：单条任务（bug）最多 20 张截图，防止无上限堆积
        if ((bug.images || []).length >= 20) {
          ElementPlus.ElMessage.warning('单条任务最多 20 张截图');
          return;
        }

        uploadingBugId.value = bugId;

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
          const rowEl = document.querySelector('.bug-row[data-bug-id="' + bugId + '"]');
          if (rowEl) {
            const btns = rowEl.querySelectorAll('.btn-upload');
            btns.forEach(b => b.classList.add('launch'));
            setTimeout(() => btns.forEach(b => b.classList.remove('launch')), 360);
          }

          // 服务端已直接更新 data.json 并广播，客户端不需要再 sendUpdate
          // 多图语义：不再覆盖旧图，所有图片由服务端统一管理生命周期

          ElementPlus.ElMessage.success('图片上传成功');
        } catch (err) {
          console.error('[Image] 上传失败:', err);
          ElementPlus.ElMessage.error('图片上传失败，请检查网络连接');
        } finally {
          uploadingBugId.value = null;
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
       * 粘贴对话框内捕获 Ctrl+V
       */
      function onPasteInDialog(e) {
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
          // 批量预判："已有数 + 本次选择数 > 20" 整批拦截（handleImageUpload 内单张守卫保留作纵深）
          const bug = currentTask.value?.bugs?.find((b) => b.id === bugId);
          if (bug && (bug.images || []).length + files.length > 20) {
            ElementPlus.ElMessage.warning('单条任务最多 20 张截图');
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
       * 全局 Ctrl+V 粘贴：仅粘贴对话框打开时响应
       */
      function onGlobalPaste(e) {
        if (pasteDialogVisible.value) {
          onPasteInDialog(e);
        }
      }

      /**
       * 发送 removeImage 消息（删除单张图片）
       */
      function sendRemoveImage(bugId, filename) {
        sendMessage({ type: 'removeImage', clientId, data: { taskId: currentTaskId.value, bugId, filename } });
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
        sendRemoveImage(bug.id, filename);
        ElementPlus.ElMessage.success('图片已删除');
      }

      /** 查看器舞台就绪（展开动画完成后置 true，触发舞台淡入/复位） */
      const previewStageReady = ref(false);

      /** 查看器飞入/缩回元素（<div class="pv-zoom"> 的引用） */
      const pvZoom = ref(null);

      /** 触发展开的牌卡原始矩形（关闭时缩回原位）；pvTimer 为展开/缩回动画定时器 */
      let pvOriginRect = null, pvTimer = null;

      /**
       * 扑克牌堆卡片定位样式（第 1 张最上层，rotate/left/z 按序错落）
       * @param {number} i 卡片序号（0 起，取前 4 张）
       */
      function stackCardStyle(i) {
        // 窄窗（!isWideWindow）牌堆缩至 3 张，偏移收紧避免溢出（30+52=82px < 96px）
        const narrow = !isWideWindow.value;
        const rot = [-5, -1, 3, 7][i] || 0;
        const left = (narrow ? [2, 16, 30] : [2, 18, 34, 50])[i] || 0;
        const z = [4, 3, 2, 1][i] || 1;
        return { left: left + 'px', transform: 'rotate(' + rot + 'deg)', zIndex: z };
      }

      /**
       * 备注 mini 牌堆卡片定位样式（缩小版：卡片 44×60、偏移 [2,16,30]、rot 同款）
       * 最多展示 3 张，第 1 张最上层，点击整堆从第一张进查看器
       */
      function noteStackCardStyle(i) {
        const rot = [-5, -1, 3][i] || 0;
        const left = [2, 16, 30][i] || 0;
        const z = [3, 2, 1][i] || 1;
        return { left: left + 'px', transform: 'rotate(' + rot + 'deg)', zIndex: z };
      }

      /**
       * 打开大图预览（从点击的牌卡飞入展开；多图：从指定图片开始，支持前后翻页）
       * @param {object} bug
       * @param {string} [filename] 起始图片文件名（缺省时预览第一张）
       * @param {Event} [evt] 点击事件（取其 currentTarget 的矩形作为展开起点）
       */
      function openPreview(bug, filename, evt) {
        if (!bug || !Array.isArray(bug.images) || !bug.images.length) return;
        previewImages.value = [...bug.images];
        const idx = filename ? bug.images.indexOf(filename) : 0;
        previewIndex.value = idx === -1 ? 0 : idx;
        previewImageUrl.value = '//' + serverHost.value + '/uploads/' + encodeURIComponent(previewImages.value[previewIndex.value]);
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
          zoom.querySelector('img').src = previewImageUrl.value;
          imagePreviewVisible.value = true;   // 背景与放大同步开始变黑
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

      /**
       * 关闭大图预览（缩回触发展开的牌卡原位；无起点时直接淡出）
       */
      function closePreview() {
        clearTimeout(pvTimer);
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
          zoom.querySelector('img').src = '//' + serverHost.value + '/uploads/' + encodeURIComponent(previewImages.value[previewIndex.value] || '');
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
       * 全局 Esc 关闭查看器：仅查看器可见且无 Element Plus 弹窗时消费 Esc
       * （有 .el-overlay 时让弹窗优先消费 Esc，避免误关查看器）
       */
      function onGlobalKeydown(e) {
        if (e.key !== 'Escape') return;
        if (!imagePreviewVisible.value) return;
        if (document.querySelector('.el-overlay')) return; // 有 Element Plus 弹窗时让弹窗优先消费 Esc
        closePreview();
      }

      /**
       * 预览上一张
       */
      function previewPrev() { if (previewIndex.value > 0) { previewIndex.value--; previewImageUrl.value = '//' + serverHost.value + '/uploads/' + encodeURIComponent(previewImages.value[previewIndex.value]); } }

      /**
       * 预览下一张
       */
      function previewNext() { if (previewIndex.value < previewImages.value.length - 1) { previewIndex.value++; previewImageUrl.value = '//' + serverHost.value + '/uploads/' + encodeURIComponent(previewImages.value[previewIndex.value]); } }

      /**
       * 整行拖拽（表格级别事件代理）
       */
      let tableDragRow = null;
      function onTableDragOver(e) {
        e.preventDefault();
        const row = e.target.closest('tr.el-table__row');
        if (row) {
          if (tableDragRow && tableDragRow !== row) {
            tableDragRow.classList.remove('drag-over-row');
          }
          row.classList.add('drag-over-row');
          tableDragRow = row;
        }
      }
      function onTableDragLeave(e) {
        const row = e.target.closest('tr.el-table__row');
        if (row === tableDragRow || !e.relatedTarget || !e.relatedTarget.closest('tr.el-table__row')) {
          if (tableDragRow) {
            tableDragRow.classList.remove('drag-over-row');
          }
          tableDragRow = null;
        }
      }
      function onTableDrop(e) {
        e.preventDefault();
        if (tableDragRow) {
          tableDragRow.classList.remove('drag-over-row');
          tableDragRow = null;
        }
        const file = e.dataTransfer.files[0];
        if (!file) return;
        // 找到目标行对应的 bug ID
        const row = e.target.closest('tr.el-table__row');
        if (!row) return;
        const bugId = row.getAttribute('data-row-key') || row.getAttribute('data-key');
        if (bugId) {
          handleImageUpload(file, bugId);
        }
      }

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
        if (ws) {
          ws.onclose = null; // 避免触发自动重连逻辑
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
        // 注册全局 Esc 监听（仅查看器打开时生效，用于关闭大图预览）
        document.addEventListener('keydown', onGlobalKeydown);
        // 宽窗口标记
        updW();
        window.addEventListener('resize', updW);
      });

      onUnmounted(() => {
        document.removeEventListener('paste', onGlobalPaste);
        document.removeEventListener('keydown', onGlobalKeydown);
        window.removeEventListener('resize', updW);
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
        showStartupDialog,
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
        coveringBugId,
        enteringBugId,
        newCardId,
        editingBugId,
        editingTaskId,
        editingTaskName,
        nameInputRef,
        statusFilter,
        currentImageBugId,
        imagePreviewVisible,
        previewImageUrl,
        previewImages,
        previewIndex,
        previewStageReady,
        pvZoom,
        uploadingBugId,
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
        pasteTargetBugId,

        // 任务备注弹窗
        notesDialogVisible,
        notesDialogTaskId,
        notesDialogTask,
        newNoteContent,
        pendingNoteFiles,
        pendingNoteFileUrls,
        attachTargetNote,
        noteFileInput,

        // 任务备注弹窗
        bugNotesVisible,
        bugNotesTaskId,
        bugNotesBugId,
        bugNotesTargetBug,
        newBugNoteContent,
        pendingBugNoteFiles,
        pendingBugNoteFileUrls,
        attachTargetBugNote,
        bugNoteFileInput,

        // 计算属性
        shortClientId,
        statusText,
        currentTask,
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
        addBug,
        deleteBug,
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
        onTaskDrop,
        onTaskDropAt,
        onTaskDropToEnd,

        // 任务备注方法
        getNoteWriters,
        getNoteColor,
        openNotesDialog,
        onTaskNoteEditKeydown,
        onTaskNoteNewKeydown,
        addNote,
        addNoteWithImage,
        onChooseNoteImage,
        removePendingNoteFile,
        clearPendingNoteImage,
        pickAttachImage,
        attachNoteImage,
        updateNoteImage,
        updateNote,
        deleteNote,

        // 任务备注方法
        getBugNoteWriters,
        openBugNotesDialog,
        addBugNote,
        addBugNoteWithImage,
        onChooseBugNoteImage,
        removePendingBugNoteFile,
        clearPendingBugNoteImage,
        pickAttachBugImage,
        attachBugNoteImage,
        updateBugNoteImage,
        updateBugNote,
        deleteBugNote,
        onBugNoteEditKeydown,
        onBugNoteNewKeydown,
        formatTime,

        // 图片方法
        handleImageUpload,
        triggerImageMenu,
        onChooseUpload,
        onChoosePaste,
        focusPasteArea,
        onPasteInDialog,
        confirmPaste,
        closePasteDialog,
        onFileSelect,
        onDragOver,
        onDragLeave,
        onDrop,
        onGlobalPaste,
        onGlobalKeydown,
        onTableDragOver,
        onTableDragLeave,
        onTableDrop,
        deleteImage,
        sendRemoveImage,
        openPreview,
        previewPrev,
        previewNext,
        closePreview,
        stackCardStyle,
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
