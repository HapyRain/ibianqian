const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');

// ================================================================
// 1. 配置常量
// ================================================================
// 起始端口（环境变量 BUGLIST_PORT 可覆盖：自动化验证用独立端口，避免与运行中服务冲突；3050 被占时自动 +1 探测到 3070）
const INITIAL_PORT = Number(process.env.BUGLIST_PORT) || 3050;
const MAX_PORT = 3070;
const BIND_ADDR = '0.0.0.0';

// 程序版本号（唯一来源：package.json；前端底部栏经 __APP_VERSION__ 占位符注入显示）
const { version: APP_VERSION } = require('./package.json');

// 状态枚举（与前端 statusOptions 保持一致，服务端仅接受这三个值）
const ALLOWED_STATUSES = ['待修复', '修复中', '已完成'];

// 打包后 (asar) __dirname 指向只读归档，数据文件放到 exe 旁边
// 便携版通过 PORTABLE_EXECUTABLE_FILE 获取原始 exe 路径
const isPackaged = __dirname.endsWith('.asar');

// 数据目录：优先环境变量，否则 D:\Bug清单\[用户名]\
const username = (() => {
  try { return os.userInfo().username; } catch (_) { return 'default'; }
})();
const DATA_ROOT = process.env.BUGLIST_DATA_ROOT || path.join('D:\\Bug清单', username);
const DATA_FILE = path.join(DATA_ROOT, 'data.json');
const TMP_FILE = path.join(DATA_ROOT, '.data.tmp');
const PUBLIC_DIR = isPackaged ? path.join(__dirname, 'public') : path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');

// 启动时自动创建 data 及 uploads 目录
if (!fs.existsSync(DATA_ROOT)) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  console.log('已创建数据目录:', DATA_ROOT);
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log('已创建 uploads 目录:', UPLOADS_DIR);
}

// ================================================================
// MIME 类型映射
// ================================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ================================================================
// 2. Promise 队列文件锁
// ================================================================
let queue = Promise.resolve();

function acquireLock() {
  return new Promise((resolve) => {
    queue = queue.then(() => {
      return new Promise((innerResolve) => {
        resolve(innerResolve);
      });
    });
  });
}

// ================================================================
// 3. 数据持久化
// ================================================================
// 一次性迁移备份标志：仅当真正遇到旧格式 bug.image 字符串时才备份一次
let imageMigrationBackedUp = false;
// 一次性备注图迁移备份标志：仅当真正遇到旧格式 note.image 字符串时才备份一次
let noteImagesMigrated = false;

/**
 * 备注图迁移前的一次性备份（best-effort：成功后才置位，失败可重试，与 bug 图迁移一致）
 * 任务级与条目级备注迁移分支发现旧格式 note.image 字符串时都会调用；
 * noteImagesMigrated 保证全程只备份一次。
 */
function backupForNoteMigration() {
  if (noteImagesMigrated) return;
  try {
    fs.copyFileSync(DATA_FILE, `${DATA_FILE}.backup-note-${Date.now()}`);
    noteImagesMigrated = true;
    console.log('[Data] 已备份备注图迁移前数据');
  } catch (e) {
    console.error('[Data] 备注图迁移备份失败:', e.message);
  }
}

/**
 * 迁移旧数据格式 → 新格式（纯函数：只改内存对象并 return，不写盘）
 * 旧: { bugs: [...], version: N }
 * 新: { tasks: [{ id, name, bugs: [...] }], version: N }
 *
 * 写盘统一由 updateData 负责，下次任何更新时自然持久化迁移后的格式；
 * 无更新期间每次 readData 重复迁移是幂等的，可接受。
 */
function migrateData(data) {
  if (data.bugs && !data.tasks) {
    console.log('[Data] 检测到旧格式数据，自动迁移...');
    const defaultTask = {
      id: crypto.randomUUID(),
      name: '默认任务',
      bugs: data.bugs,
      notes: [],
    };
    delete data.bugs;
    data.tasks = [defaultTask];
    console.log(`[Data] 迁移完成：${defaultTask.bugs.length} 条 任务已归入「${defaultTask.name}」`);
  }
  // 兼容：旧 task 没有 notes 字段
  if (data.tasks) {
    let patched = false;
    data.tasks.forEach(t => {
      if (!Array.isArray(t.notes)) {
        t.notes = [];
        patched = true;
      }
    });
    // 补全 bug 的 notes 字段
    let bugPatched = false;
    data.tasks.forEach(t => {
      (t.bugs || []).forEach(b => {
        if (!Array.isArray(b.notes)) {
          b.notes = [];
          bugPatched = true;
        }
      });
    });
    if (patched || bugPatched) {
      console.log('[Data] 已补全 notes 字段' + (bugPatched ? '（含 bug 级）' : ''));
    }
    // 旧格式：bug.image 字符串 → images 数组（迁移前留一次性备份）
    data.tasks.forEach(t => (t.bugs || []).forEach(b => {
      if (typeof b.image === 'string') {
        if (!imageMigrationBackedUp) {
          // 首次迁移前留一份保险备份（仅一次，best-effort；失败不置位，后续读可重试）
          try {
            fs.copyFileSync(DATA_FILE, `${DATA_FILE}.backup-${Date.now()}`);
            imageMigrationBackedUp = true;
            console.log('[Data] 已备份迁移前数据: data.json.backup-*');
          } catch (e) {
            console.error('[Data] 迁移备份失败:', e.message);
          }
        }
        b.images = [b.image]; delete b.image;
      }
      if (!Array.isArray(b.images)) b.images = [];
      // 组内排序依据（新来的往组末尾）：旧数据无时间戳 → 0（保持数组原序）
      if (typeof b.statusChangedAt !== 'number') b.statusChangedAt = 0;
    }));
    // 旧格式：note.image 字符串 → images 数组（一次性备份，任务级与条目级分支共用 backupForNoteMigration）
    data.tasks.forEach(t => {
      ((t.notes) || []).forEach(n => {
        if (typeof n.image === 'string') {
          backupForNoteMigration();
          n.images = [n.image]; delete n.image;
        }
        if (!Array.isArray(n.images)) n.images = [];
        // 创建时间锚点（"已修改"判断）：旧数据缺省取 updatedAt（视为未修改过）
        if (typeof n.createdAt !== 'number') n.createdAt = n.updatedAt || Date.now();
      });
      (t.bugs || []).forEach(b => ((b.notes) || []).forEach(n => {
        if (typeof n.image === 'string') {
          backupForNoteMigration();
          n.images = [n.image]; delete n.image;
        }
        if (!Array.isArray(n.images)) n.images = [];
        if (typeof n.createdAt !== 'number') n.createdAt = n.updatedAt || Date.now();
      }));
    });
  }
  return data;
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return migrateData(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 文件不存在：首次启动，正常
      return { tasks: [], version: 0 };
    }

    // JSON 解析失败或磁盘错误：备份损坏文件
    console.error('[Data] 读取 data.json 失败:', err.message);
    try {
      const timestamp = Date.now();
      const backupPath = DATA_FILE + '.corrupted.' + timestamp;
      fs.copyFileSync(DATA_FILE, backupPath);
      console.error(`[Data] 已备份损坏文件到: ${backupPath}`);
    } catch (backupErr) {
      console.error('[Data] 备份损坏文件失败:', backupErr.message);
    }

    return { tasks: [], version: 0 };
  }
}

/**
 * 原子写入：获取锁 → 执行 transform → 写 .tmp → fs.renameSync → 释放锁
 * @param {Function} transformFn 接收 data，原地修改后返回 change 描述对象
 * @returns {Promise<{ data: object, change: object, version: number }>}
 */
async function updateData(transformFn) {
  const release = await acquireLock();
  try {
    const data = readData();
    const change = transformFn(data);

    // 无变化时不递增版本、不写盘
    if (!change) {
      return { data, change: null, version: data.version };
    }

    data.version = (data.version || 0) + 1;

    // 原子写入：先写临时文件，再重命名
    // 写临时文件前清理旧 tmp
    try { fs.unlinkSync(TMP_FILE); } catch (e) { /* 不存在则忽略 */ }
    fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2), 'utf-8');
    try {
      fs.renameSync(TMP_FILE, DATA_FILE);
    } catch (renameErr) {
      // rename 失败时清理临时文件
      try { fs.unlinkSync(TMP_FILE); } catch (e) { /* 忽略 */ }
      throw renameErr; // 向上抛出，让调用方知道写入失败
    }

    backupDataFile(); // 写盘成功后节流轮转备份（至少间隔 1 分钟）

    return { data, change, version: data.version };
  } finally {
    release();
  }
}

// ================================================================
// 辅助工具
// ================================================================
// 数据备份：每次写盘后节流轮转备份（保留最近 20 份）+ 删除前快照（保留最近 5 份）
const BACKUP_DIR = path.join(DATA_ROOT, 'backups');
const BACKUP_KEEP = 20;
const PRE_DELETE_KEEP = 5;
let lastDataBackup = 0;

/** 轮转备份 data.json → backups/data-<时间戳>.json（1 分钟节流，保留最近 BACKUP_KEEP 份） */
function backupDataFile() {
  const now = Date.now();
  if (now - lastDataBackup < 60000) return; // 节流：频繁写盘（如连续传图）不重复备份
  lastDataBackup = now;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = formatTimestamp(new Date()).replace(/[: ]/g, '-');
    const dest = path.join(BACKUP_DIR, 'data-' + stamp + '.json');
    fs.copyFileSync(DATA_FILE, dest);
    // 轮转：只保留最近 BACKUP_KEEP 份
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('data-')).sort();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    console.log(`[Backup] data.json 已备份（${BACKUP_DIR} 保留 ${BACKUP_KEEP} 份）`);
  } catch (e) {
    console.error('[Backup] 轮转备份失败:', e.message);
  }
}

/** 删除类操作前的即时快照（不节流，保证删除前一刻的数据可回滚，保留最近 PRE_DELETE_KEEP 份） */
function snapshotBeforeDelete() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, 'pre-delete-' + Date.now() + '.json');
    fs.copyFileSync(DATA_FILE, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('pre-delete-')).sort();
    while (files.length > PRE_DELETE_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    console.log(`[Backup] 删除前快照: ${path.basename(dest)}`);
  } catch (e) {
    console.error('[Backup] 删除前快照失败:', e.message);
  }
}
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

function broadcast(_wss, message) {
  const payload = JSON.stringify(message);
  _wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastClientCount(_wss) {
  let count = 0;
  _wss.clients.forEach((client) => {
    if (client.readyState === 1) count++;
  });
  broadcast(_wss, { type: 'clientCount', count });
}

// ================================================================
// 5. WebSocket 消息处理
// ================================================================

/** 辅助：根据 taskId 查找 task 和 bug */
function findBugInTasks(tasks, taskId, bugId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { task: null, bug: null };
  const bug = task.bugs.find(b => b.id === bugId);
  return { task, bug };
}

// 格式化时间戳 YYYY-MM-DD HH:mm:ss
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function handleUpdate(ws, msg, _wss) {
  const { taskId, bugId, field, value } = msg.data || {};
  console.log(`[WS] handleUpdate: clientId=${(ws.clientId || '?').substring(0,8)}, taskId=${taskId?.substring(0,8)}, bugId=${bugId}, field=${field}, value=${value}`);
  if (!taskId || !bugId || !field || value === undefined) return;

  // 字段白名单 + 值校验（放在 updateData 之前，尽早 return，避免无谓进锁）
  // 'name' 允许空字符串（清空名称）；图片生命周期改由 upload/removeImage/DELETE 端点管理，'image' 不再走 update
  if (!['name', 'status', 'deadline', 'archived'].includes(field)) return;
  if (field === 'name' && typeof value !== 'string') return;
  if (field === 'status' && !ALLOWED_STATUSES.includes(value)) return;
  // deadline（0.3 体验小点）：仅接受时间戳 number（毫秒）或 null（清除）；非法值一律拒绝
  if (field === 'deadline' && !(typeof value === 'number' && Number.isFinite(value)) && value !== null) return;
  // archived（归档体系）：仅接受布尔；状态机细则在锁内校验（依赖 bug 当前状态）
  if (field === 'archived' && typeof value !== 'boolean') return;

  const result = await updateData((data) => {
    const { bug } = findBugInTasks(data.tasks, taskId, bugId);
    if (!bug) return null;
    // 归档行锁死：archived 行拒绝一切其它字段修改（spec 第 7 节防线）
    if (bug.archived === true && field !== 'archived') return null;
    // 归档状态机：true 仅当已完成且未归档；false 仅当已归档（spec 第 10 节矩阵）
    if (field === 'archived') {
      if (value === true && (bug.status !== '已完成' || bug.archived === true)) return null;
      if (value === false && bug.archived !== true) return null;
    }
    bug[field] = value;

    // 状态变更时自动管理 completedAt 时间锚点 + statusChangedAt（组内排序依据：新来的往组末尾）
    let completedAt = undefined;
    if (field === 'status') {
      bug.statusChangedAt = Date.now();
      if (value === '已完成') {
        completedAt = formatTimestamp(new Date());
        bug.completedAt = completedAt;
      } else if (bug.completedAt !== undefined) {
        delete bug.completedAt;
        completedAt = null; // 通知客户端删除
      }
    }

    // archivedAt 伴生字段（同 completedAt 范式）：归档写入 / 恢复删除
    let archivedAt = undefined;
    if (field === 'archived') {
      if (value === true) {
        bug.archivedAt = Date.now();
        archivedAt = bug.archivedAt;
      } else {
        // 恢复归档：彻底清除标记（不留 archived:false，保持与导入归一化一致的干净形态）
        delete bug.archived;
        delete bug.archivedAt;
        archivedAt = null; // 通知客户端删除
      }
    }

    return { type: 'update', taskId, bugId, field, value, completedAt, archivedAt, statusChangedAt: bug.statusChangedAt };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });
  }
}

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

async function handleAdd(ws, msg, _wss) {
  const { taskId, bug } = msg.data || {};
  if (!taskId || !bug || !bug.id) return;

  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    // 检查是否已存在（防重复）
    if (task.bugs.some(b => b.id === bug.id)) return null;
    // 归一化：确保 images 字段为数组（旧客户端 add 不带 images）；statusChangedAt 缺省为当前时间
    const normalizedBug = { ...bug, images: Array.isArray(bug.images) ? bug.images : [] };
    if (typeof normalizedBug.statusChangedAt !== 'number') normalizedBug.statusChangedAt = Date.now();
    // assignee 归一化（0.3 负责人）：只接受 { clientId: string, name: string|null }，非法值（含非对象）显式删除，杜绝脏数据入库
    if (bug.assignee && typeof bug.assignee === 'object' && typeof bug.assignee.clientId === 'string' && bug.assignee.clientId) {
      normalizedBug.assignee = { clientId: bug.assignee.clientId, name: typeof bug.assignee.name === 'string' ? bug.assignee.name : null };
    } else {
      delete normalizedBug.assignee;
    }
    // deadline 归一化（0.3 体验小点）：仅保留合法时间戳 number（毫秒），其余（含 null/字符串）显式删除
    if (!(typeof bug.deadline === 'number' && Number.isFinite(bug.deadline))) {
      delete normalizedBug.deadline;
    }
    // archived（归档体系，0903）：仅当 status 已完成时保留布尔标记与数字时间，非法一律 delete（与 normalizeBugForImport 同规则）
    // 注：{ ...bug } 展开会原样带进 archived:1 / 待修复却 archived:true 等脏值，必须在此显式覆盖或删除
    if (bug.archived === true && bug.status === '已完成') {
      normalizedBug.archived = true;
      if (typeof bug.archivedAt === 'number' && Number.isFinite(bug.archivedAt)) {
        normalizedBug.archivedAt = bug.archivedAt;
      } else {
        delete normalizedBug.archivedAt;
      }
    } else {
      delete normalizedBug.archived;
      delete normalizedBug.archivedAt;
    }
    task.bugs.push(normalizedBug);
    return { type: 'add', taskId, bug: { ...normalizedBug } };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });
  }
}

async function handleDelete(ws, msg, _wss) {
  const { taskId, bugId } = msg.data || {};
  if (!taskId || !bugId) return;

  // 防线预检（spec 第 7 节）：已完成/已归档任务不可删除——仅避免无谓快照；
  // 权威防线在下方锁内 transform（返回 null 即拒绝），此处提前 return 同样不写盘不广播
  const pre = readData();
  const preTask = pre.tasks.find(t => t.id === taskId);
  const preBug = preTask && preTask.bugs.find(b => b.id === bugId);
  if (preBug && (preBug.status === '已完成' || preBug.archived === true)) return;

  snapshotBeforeDelete(); // 删除前快照：可回滚
  // 闭包收集被删 bug 的全部图片文件名（不放进 change，避免污染广播协议）
  const deletedImages = [];
  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    const index = task.bugs.findIndex(b => b.id === bugId);
    if (index === -1) return null;
    // 权威防线：已完成/已归档任务不可删除（竞态兜底，与预检同规则）
    if (task.bugs[index].status === '已完成' || task.bugs[index].archived === true) return null;
    if (Array.isArray(task.bugs[index].images)) {
      deletedImages.push(...task.bugs[index].images);
    }
    task.bugs.splice(index, 1);
    return { type: 'delete', taskId, bugId };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });

    // 数据写盘成功后再清理图片文件（best-effort，ENOENT 容忍）
    deletedImages.forEach(filename => {
      const imgPath = path.join(UPLOADS_DIR, filename);
      try {
        fs.unlinkSync(imgPath);
        console.log(`[Delete] 已清理图片: ${filename}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Delete] 清理图片失败: ${filename}`, e.message);
      }
    });
  }
}

// ================================================================
// 5.1 任务级别操作
// ================================================================

async function handleCreateTask(ws, msg, _wss) {
  const { task } = msg.data || {};
  if (!task || !task.id) return;

  const result = await updateData((data) => {
    if (data.tasks.some(t => t.id === task.id)) return null;
    data.tasks.push({ id: task.id, name: task.name || '新项目', bugs: [] });
    return { type: 'createTask', task: { id: task.id, name: task.name || '新项目' } };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });
  }
}

async function handleUpdateTask(ws, msg, _wss) {
  const { taskId, field, value } = msg.data || {};
  if (!taskId || !field || value === undefined) return;

  // 字段白名单 + 值校验：只允许 'name'，且 trim() 后非空（修复"空任务名可绕过"问题）
  // 放在 updateData 之前，尽早 return，避免无谓进锁
  if (field !== 'name' || typeof value !== 'string' || value.trim() === '') return;

  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    task[field] = value;
    return { type: 'updateTask', taskId, field, value };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });
  }
}

async function handleDeleteTask(ws, msg, _wss) {
  const { taskId } = msg.data || {};
  if (!taskId) return;

  snapshotBeforeDelete(); // 删除前快照：可回滚
  // 闭包收集该任务下所有图片文件名（不放进 change，避免污染广播协议）
  const deletedImages = [];
  const result = await updateData((data) => {
    if (data.tasks.length <= 1) return null; // 至少保留一个任务
    const index = data.tasks.findIndex(t => t.id === taskId);
    if (index === -1) return null;

    const deletedTask = data.tasks[index];

    // 只收集文件名，不在此处删文件（必须先改数据、后删文件）
    deletedTask.bugs.forEach(bug => {
      if (Array.isArray(bug.images)) {
        bug.images.forEach(img => deletedImages.push(img));
      }
    });

    data.tasks.splice(index, 1);
    return { type: 'deleteTask', taskId };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });

    // 数据写盘成功后再逐个清理图片文件（best-effort，ENOENT 容忍）
    deletedImages.forEach(filename => {
      const imgPath = path.join(UPLOADS_DIR, filename);
      try {
        fs.unlinkSync(imgPath);
        console.log(`[Task] 已清理图片: ${filename}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Task] 清理图片失败: ${filename}`, e.message);
      }
    });
  }
}

// ================================================================
// 5.2 备注（note）操作 — 任务级
// ================================================================

async function handleAddNote(ws, msg, _wss) {
  const { taskId, note } = msg.data || {};
  if (!taskId || !note || !note.id) return;

  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    if (!task.notes) task.notes = [];
    if (task.notes.some(n => n.id === note.id)) return null;
    // 创建时间锚点（"已修改"判断）：旧客户端不带 createdAt 时补默认值
    const normalized = { ...note };
    if (typeof normalized.createdAt !== 'number') normalized.createdAt = normalized.updatedAt || Date.now();
    task.notes.push(normalized);
    return { type: 'addNote', taskId, note: { ...normalized } };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });
  }
}

async function handleUpdateNote(ws, msg, _wss) {
  const { taskId, noteId, content, updatedAt } = msg.data || {};
  const imageValue = msg.data && msg.data.image;
  const removeImage = msg.data && msg.data.removeImage;
  if (!taskId || !noteId) return;
  // 纯图片移除（removeImage 按文件名，或旧语义 image:null）也合法；content 与移除参数均缺省时拒绝
  if (content === undefined && removeImage === undefined && imageValue !== null) return;

  let removedNoteImage = null;
  const removedNoteImages = []; // 闭包（函数顶部 let 声明）：广播后统一清理被移除的图片文件
  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task || !task.notes) return null;
    const note = task.notes.find(n => n.id === noteId);
    if (!note) return null;
    // 更新权限：仅作者本人可修改（含移除图片）
    if (note.clientId !== msg.clientId) return null;
    // 变更判定：content 更新 / removeImage 命中 / 旧语义 image:null 命中，任一才算有变更；
    // 全部未命中（如 removeImage 不在 images 中）→ return null，避免无效广播与版本递增
    let changed = false;
    if (content !== undefined) {
      note.content = content;
      note.updatedAt = updatedAt || Date.now();
      changed = true;
    }
    // 旧语义：image:null 移除单图（兼容旧客户端）
    if (imageValue === null && typeof note.image === 'string') {
      removedNoteImage = note.image;
      note.image = null;
      changed = true;
    }
    // 新语义：removeImage 按文件名从多图数组中移除
    if (typeof removeImage === 'string' && Array.isArray(note.images)) {
      const ri = note.images.indexOf(removeImage);
      if (ri !== -1) { note.images.splice(ri, 1); removedNoteImages.push(removeImage); changed = true; }
    }
    if (!changed) return null;
    return { type: 'updateNote', taskId, noteId, content: note.content, updatedAt: note.updatedAt, images: [...(note.images || [])] };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });

    // 数据写盘成功并广播后，再清理被移除的图片文件（best-effort，ENOENT 容忍）
    if (removedNoteImage) {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, removedNoteImage));
        console.log(`[Note] 已清理备注图片: ${removedNoteImage}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Note] 清理备注图片失败: ${removedNoteImage}`, e.message);
      }
    }
    removedNoteImages.forEach(f => {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, f));
        console.log('[Note] 已清理备注图片: ' + f);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error('[Note] 清理备注图片失败:', f, e.message);
      }
    });
  }
}

async function handleDeleteNote(ws, msg, _wss) {
  const { taskId, noteId } = msg.data || {};
  if (!taskId || !noteId) return;

  snapshotBeforeDelete(); // 删除前快照：可回滚
  let deletedNoteImages = [];
  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task || !task.notes) return null;
    const note = task.notes.find(n => n.id === noteId);
    if (!note) return null;
    // 删除权限与更新一致：仅作者本人可删除
    if (note.clientId !== msg.clientId) return null;
    const index = task.notes.findIndex(n => n.id === noteId);
    if (index === -1) return null;
    // splice 前记录备注图片（多图），供删除后清理文件
    deletedNoteImages = [...(note.images || [])];
    task.notes.splice(index, 1);
    return { type: 'deleteNote', taskId, noteId };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });

    // 数据写盘成功并广播后，再清理备注图片文件（best-effort，ENOENT 容忍）
    deletedNoteImages.forEach(filename => {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, filename));
        console.log(`[Note] 已清理备注图片: ${filename}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Note] 清理备注图片失败: ${filename}`, e.message);
      }
    });
  }
}

// ================================================================
// 5.3 备注（note）操作 — Bug 级
// ================================================================

function findBugAndNote(tasks, taskId, bugId, noteId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { task: null, bug: null, note: null };
  const bug = task.bugs.find(b => b.id === bugId);
  if (!bug) return { task, bug: null, note: null };
  if (!bug.notes) bug.notes = [];
  const note = noteId ? bug.notes.find(n => n.id === noteId) : null;
  return { task, bug, note };
}

async function handleAddBugNote(ws, msg, _wss) {
  const { taskId, bugId, note } = msg.data || {};
  if (!taskId || !bugId || !note || !note.id) return;

  const result = await updateData((data) => {
    const { bug } = findBugAndNote(data.tasks, taskId, bugId);
    if (!bug) return null;
    if (bug.notes.some(n => n.id === note.id)) return null;
    // 创建时间锚点（"已修改"判断）：旧客户端不带 createdAt 时补默认值
    const normalized = { ...note };
    if (typeof normalized.createdAt !== 'number') normalized.createdAt = normalized.updatedAt || Date.now();
    bug.notes.push(normalized);
    return { type: 'addBugNote', taskId, bugId, note: { ...normalized } };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });
  }
}

async function handleUpdateBugNote(ws, msg, _wss) {
  const { taskId, bugId, noteId, content, updatedAt } = msg.data || {};
  const imageValue = msg.data && msg.data.image;
  const removeImage = msg.data && msg.data.removeImage;
  if (!taskId || !bugId || !noteId) return;
  // 纯图片移除（removeImage 按文件名，或旧语义 image:null）也合法；content 与移除参数均缺省时拒绝
  if (content === undefined && removeImage === undefined && imageValue !== null) return;

  let removedNoteImage = null;
  const removedNoteImages = []; // 闭包（函数顶部 let 声明）：广播后统一清理被移除的图片文件
  const result = await updateData((data) => {
    const { note } = findBugAndNote(data.tasks, taskId, bugId, noteId);
    if (!note) return null;
    // 更新权限：仅作者本人可修改（含移除图片）
    if (note.clientId !== msg.clientId) return null;
    // 变更判定：content 更新 / removeImage 命中 / 旧语义 image:null 命中，任一才算有变更；
    // 全部未命中（如 removeImage 不在 images 中）→ return null，避免无效广播与版本递增
    let changed = false;
    if (content !== undefined) {
      note.content = content;
      note.updatedAt = updatedAt || Date.now();
      changed = true;
    }
    // 旧语义：image:null 移除单图（兼容旧客户端）
    if (imageValue === null && typeof note.image === 'string') {
      removedNoteImage = note.image;
      note.image = null;
      changed = true;
    }
    // 新语义：removeImage 按文件名从多图数组中移除
    if (typeof removeImage === 'string' && Array.isArray(note.images)) {
      const ri = note.images.indexOf(removeImage);
      if (ri !== -1) { note.images.splice(ri, 1); removedNoteImages.push(removeImage); changed = true; }
    }
    if (!changed) return null;
    return { type: 'updateBugNote', taskId, bugId, noteId, content: note.content, updatedAt: note.updatedAt, images: [...(note.images || [])] };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });

    // 数据写盘成功并广播后，再清理被移除的图片文件（best-effort，ENOENT 容忍）
    if (removedNoteImage) {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, removedNoteImage));
        console.log(`[Note] 已清理备注图片: ${removedNoteImage}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Note] 清理备注图片失败: ${removedNoteImage}`, e.message);
      }
    }
    removedNoteImages.forEach(f => {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, f));
        console.log('[Note] 已清理备注图片: ' + f);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error('[Note] 清理备注图片失败:', f, e.message);
      }
    });
  }
}

async function handleDeleteBugNote(ws, msg, _wss) {
  const { taskId, bugId, noteId } = msg.data || {};
  if (!taskId || !bugId || !noteId) return;

  snapshotBeforeDelete(); // 删除前快照：可回滚
  let deletedNoteImages = [];
  const result = await updateData((data) => {
    const { bug, note } = findBugAndNote(data.tasks, taskId, bugId, noteId);
    if (!bug || !note) return null;
    // 删除权限与更新一致：仅作者本人可删除
    if (note.clientId !== msg.clientId) return null;
    const index = bug.notes.findIndex(n => n.id === noteId);
    if (index === -1) return null;
    // splice 前记录备注图片（多图），供删除后清理文件
    deletedNoteImages = [...(note.images || [])];
    bug.notes.splice(index, 1);
    return { type: 'deleteBugNote', taskId, bugId, noteId };
  });

  if (result.change) {
    broadcast(_wss, {
      type: 'broadcast',
      originClientId: msg.clientId,
      change: result.change,
      version: result.version,
    });

    // 数据写盘成功并广播后，再清理备注图片文件（best-effort，ENOENT 容忍）
    deletedNoteImages.forEach(filename => {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, filename));
        console.log(`[Note] 已清理备注图片: ${filename}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Note] 清理备注图片失败: ${filename}`, e.message);
      }
    });
  }
}

function handleRequestSync(ws, _wss) {
  const data = readData();
  sendTo(ws, {
    type: 'fullSync',
    data,
    version: data.version,
  });
  // 同时发送当前在线人数
  let count = 0;
  _wss.clients.forEach((client) => {
    if (client.readyState === 1) count++;
  });
  sendTo(ws, { type: 'clientCount', count });
}

async function handleMessage(ws, rawMessage, _wss) {
  let msg;
  try {
    msg = JSON.parse(rawMessage);
  } catch (e) {
    return;
  }

  switch (msg.type) {
    case 'update':
      try { await handleUpdate(ws, msg, _wss); } catch (e) { console.error('[WS] handleUpdate 错误:', e.message); }
      break;
    case 'add':
      try { await handleAdd(ws, msg, _wss); } catch (e) { console.error('[WS] handleAdd 错误:', e.message); }
      break;
    case 'delete':
      try { await handleDelete(ws, msg, _wss); } catch (e) { console.error('[WS] handleDelete 错误:', e.message); }
      break;
    case 'removeImage':
      try { await handleRemoveImage(ws, msg, _wss); } catch (e) { console.error('[WS] handleRemoveImage 错误:', e.message); }
      break;
    case 'createTask':
      try { await handleCreateTask(ws, msg, _wss); } catch (e) { console.error('[WS] handleCreateTask 错误:', e.message); }
      break;
    case 'updateTask':
      try { await handleUpdateTask(ws, msg, _wss); } catch (e) { console.error('[WS] handleUpdateTask 错误:', e.message); }
      break;
    case 'deleteTask':
      try { await handleDeleteTask(ws, msg, _wss); } catch (e) { console.error('[WS] handleDeleteTask 错误:', e.message); }
      break;
    case 'addNote':
      try { await handleAddNote(ws, msg, _wss); } catch (e) { console.error('[WS] handleAddNote 错误:', e.message); }
      break;
    case 'updateNote':
      try { await handleUpdateNote(ws, msg, _wss); } catch (e) { console.error('[WS] handleUpdateNote 错误:', e.message); }
      break;
    case 'deleteNote':
      try { await handleDeleteNote(ws, msg, _wss); } catch (e) { console.error('[WS] handleDeleteNote 错误:', e.message); }
      break;
    case 'addBugNote':
      try { await handleAddBugNote(ws, msg, _wss); } catch (e) { console.error('[WS] handleAddBugNote 错误:', e.message); }
      break;
    case 'updateBugNote':
      try { await handleUpdateBugNote(ws, msg, _wss); } catch (e) { console.error('[WS] handleUpdateBugNote 错误:', e.message); }
      break;
    case 'deleteBugNote':
      try { await handleDeleteBugNote(ws, msg, _wss); } catch (e) { console.error('[WS] handleDeleteBugNote 错误:', e.message); }
      break;
    case 'requestSync':
      handleRequestSync(ws, _wss);
      break;
  }
}

// ================================================================
// 4. HTTP 静态文件服务
// ================================================================
function serveStaticFile(res, filePath, cacheImmutable) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
      }
    } else {
      // HTML 注入：__APP_VERSION__ 占位符 ← package.json 的 version（唯一版本来源，改一处即可）
      let body = content;
      if (ext === '.html') {
        body = Buffer.from(content.toString('utf-8').replace(/__APP_VERSION__/g, APP_VERSION), 'utf-8');
      }
      // uploads 图片文件名唯一且内容不可变 → 长缓存（浏览器缓存命中，二次查看/翻页秒开，消除"先模糊后清晰"的闪现）
      // 其他静态文件（html/js/css）保持 no-cache 便于开发即时更新
      const cacheControl = cacheImmutable ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
      res.end(body);
    }
  });
}

// ================================================================
// 图片上传：MIME 白名单 + 魔数校验
// ================================================================
const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
];

/** 魔数映射：文件头字节 → 真实 MIME */
function detectMagicMime(buffer) {
  if (buffer.length < 4) return null;
  const head4 = buffer.toString('hex', 0, 4).toUpperCase();

  // PNG：完整 8 字节签名 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 && head4 === '89504E47' &&
      buffer.toString('hex', 0, 8).toUpperCase() === '89504E470D0A1A0A') return 'image/png';
  if (head4.startsWith('FFD8FF')) return 'image/jpeg';
  // GIF：GIF87a (474946383761) 或 GIF89a (474946383961)，即前 6 字节
  if (buffer.length >= 6) {
    const head6 = buffer.toString('hex', 0, 6).toUpperCase();
    if (head6 === '474946383761' || head6 === '474946383961') return 'image/gif';
  }
  // WEBP：RIFF (52494646) 容器 + 偏移 8 字节处为 'WEBP' (57454250)
  if (buffer.length >= 12 && head4 === '52494646' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (head4.startsWith('424D')) return 'image/bmp';
  // SVG 是文本格式，没有固定魔数，跳过二进制校验
  return null;
}

/** 检查文件名是否合法（防止路径穿越） */
function isSafeFilename(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (name.length === 0 || name.length > 255) return false;
  return true;
}

/**
 * 手动解析 multipart/form-data（不引入第三方库）
 * 格式：
 *   --boundary\r\n
 *   Content-Disposition: form-data; name="file"; filename="xxx.png"\r\n
 *   Content-Type: image/png\r\n
 *   \r\n
 *   <binary data>\r\n
 *   --boundary--\r\n
 */
function parseMultipart(buffer, boundary) {
  const boundaryStr = '--' + boundary;
  const boundaryBuf = Buffer.from(boundaryStr);
  const crlfcrlf = Buffer.from('\r\n\r\n');

  // 查找第一个 boundary 位置
  const boundaryStart = buffer.indexOf(boundaryBuf);
  if (boundaryStart === -1) return null;

  // 跳过 boundary + \r\n
  const headerStart = boundaryStart + boundaryBuf.length + 2;

  // 查找头部结束位置 (\r\n\r\n)
  const headerEnd = buffer.indexOf(crlfcrlf, headerStart);
  if (headerEnd === -1) return null;

  // 提取头部字符串（使用 utf-8，文本头部不会有二进制问题）
  const headerStr = buffer.slice(headerStart, headerEnd).toString('utf-8');

  // 提取 filename
  const filenameMatch = headerStr.match(/filename="([^"]*)"/);
  if (!filenameMatch) return null;
  const filename = filenameMatch[1];

  // 提取 Content-Type
  const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
  const declaredMime = ctMatch ? ctMatch[1].trim() : null;

  // 文件数据起始位置（头部结束 + 4）
  const dataStart = headerEnd + 4;

  // 文件数据结束位置（下一个 boundary 之前）
  const endBoundary = buffer.indexOf(boundaryBuf, dataStart);
  let dataEnd;
  if (endBoundary !== -1) {
    // 去掉尾部 \r\n
    dataEnd = endBoundary - 2;
  } else {
    dataEnd = buffer.length;
  }

  const fileBuffer = buffer.slice(dataStart, dataEnd);

  return { filename, declaredMime, fileBuffer };
}

/**
 * 处理 POST /api/upload
 */
async function handleUpload(req, res) {
  // 文件大小限制（局域网场景设为 100MB）
  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

  const chunks = [];
  let totalSize = 0;
  let sizeExceeded = false;
  req.on('data', (chunk) => {
    if (sizeExceeded) return; // 已超限：丢弃后续数据，不再入内存
    totalSize += chunk.length;
    if (totalSize > MAX_FILE_SIZE) {
      sizeExceeded = true;
      chunks.length = 0; // 释放已收集内存
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    try {
      // 大小限制检查（已在 data 收集阶段提前触发并丢弃数据；此处直接响应 413）
      if (sizeExceeded) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: `文件大小超过限制（最大 ${MAX_FILE_SIZE / 1024 / 1024}MB）` }));
        return;
      }

      const body = Buffer.concat(chunks);

      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '缺少 boundary 参数' }));
        return;
      }

      const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
      const parsed = parseMultipart(body, boundary);
      if (!parsed || !parsed.fileBuffer || parsed.fileBuffer.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '未找到上传文件' }));
        return;
      }

      const { filename, declaredMime, fileBuffer } = parsed;

      // MIME 白名单校验
      if (declaredMime && !ALLOWED_MIME_TYPES.includes(declaredMime)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: `不支持的文件类型: ${declaredMime}` }));
        return;
      }

      // 魔数校验（SVG 跳过，因为是文本格式）
      const magicMime = detectMagicMime(fileBuffer);
      if (magicMime && !ALLOWED_MIME_TYPES.includes(magicMime)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: `文件内容与声明类型不符，真实类型: ${magicMime}` }));
        return;
      }

      // 二进制图片类型必须能检测到合法魔数（SVG 是文本格式，跳过）
      // 防止"RIFF + 垃圾"等伪文件声明成 image/webp 后绕过校验；
      // 若内容实为另一种白名单图片类型（如 .webp 后缀的 PNG），放行——浏览器可正常渲染，避免误伤
      if (declaredMime && declaredMime !== 'image/svg+xml' && !magicMime) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '文件内容无法识别为声明的图片类型' }));
        return;
      }

      // 兜底：declaredMime 和 magicMime 至少有一个在白名单中
      // 防止 declaredMime 为 null 且 magicMime 也为 null 时绕过所有校验
      const effectiveMime = declaredMime || magicMime;
      if (!effectiveMime || !ALLOWED_MIME_TYPES.includes(effectiveMime)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '无法识别的文件类型' }));
        return;
      }

      // 生成唯一文件名
      const uuid = crypto.randomUUID();
      const safeFilename = `${uuid}_${filename}`;
      const filePath = path.join(UPLOADS_DIR, safeFilename);

      fs.writeFileSync(filePath, fileBuffer);
      console.log(`[Upload] 图片已保存: ${safeFilename} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);

      // 从请求头获取 bugId 和 taskId，由服务端直接更新 data.json 并广播
      const bugId = req.headers['x-bug-id'];
      const taskId = req.headers['x-task-id'];
      const noteId = req.headers['x-note-id'];
      const bugNoteId = req.headers['x-bug-note-id'];
      const uploaderClientId = req.headers['x-client-id'] || '__server__';
      console.log(`[Upload] bugId=${bugId}, taskId=${taskId?.substring(0,8)}, noteId=${noteId}, bugNoteId=${bugNoteId}, clientId=${uploaderClientId?.substring(0,8)}, file=${safeFilename}`);
      // note 路径下"无任何可关联任务"标志：此时文件必然孤儿，需清理 + 400（与 bug 路径语义对称）
      let notePathNoTask = false;
      let broadcastResult = null;
      // 备注图片关联分支（与 bug 图片路径互斥）：X-Note-Id → 任务级备注，X-Bug-Note-Id → 条目级备注
      if (noteId || bugNoteId) {
        try {
          broadcastResult = await updateData((data) => {
            // 确保 taskId 存在，否则用第一个 task（兼容旧客户端）
            const resolvedTaskId = taskId || data.tasks[0]?.id;
            if (!resolvedTaskId) {
              notePathNoTask = true;
              return null;
            }

            let task = data.tasks.find(t => t.id === resolvedTaskId);
            if (!task) {
              // taskId 指定的任务不存在，回退到第一个
              task = data.tasks[0];
            }
            if (!task) {
              // 数据为空（无任何任务），无法关联 → 标记孤儿，由外层清理文件
              notePathNoTask = true;
              return null;
            }

            let note = null;
            let changeType = 'updateNote';
            if (noteId) {
              note = (task.notes || []).find(n => n.id === noteId);
            } else {
              changeType = 'updateBugNote';
              let bug = task.bugs.find(b => b.id === bugId);
              let autoCreatedBugForNote = false;
              if (!bug && bugId) {
                // 与 bug 图片路径对称的容错：bug 不存在时自动创建，避免"暂存文件→addBugNote 被拒→永久孤儿"
                bug = { id: bugId, name: '', status: '待修复', images: [] };
                task.bugs.push(bug);
                autoCreatedBugForNote = true;
                console.log(`[Upload] ⚠️ bugId=${bugId} 不存在，已自动创建（备注图片关联）`);
              }
              note = bug && (bug.notes || []).find(n => n.id === bugNoteId);
              if (!note) {
                if (autoCreatedBugForNote) {
                  // 广播 bug 创建（含空 images），随后 addBugNote 的广播会携带图片备注，
                  // 其他客户端先有 bug 才能应用该备注
                  return { type: 'add', taskId: resolvedTaskId, bug: { id: bug.id, name: bug.name, status: bug.status, images: [] } };
                }
                return null; // note 尚未创建：只存文件，由随后 addBugNote 关联
              }
            }

            if (!note) {
              // note 尚未创建：只存文件，由随后 addNote/addBugNote 携带 filename 关联
              console.log(`[Upload] ⏳ note(${noteId || bugNoteId}) 尚未创建，暂存文件待 addNote 关联: ${safeFilename}`);
              return null;
            }

            // 多图追加：不再替换单图，旧图不清理（图片生命周期由 removeImage/删除备注/DELETE 端点管理）
            if (!Array.isArray(note.images)) note.images = [];
            note.images.push(safeFilename);
            console.log(`[Upload] ✅ data.json 已更新: taskId=${resolvedTaskId?.substring(0,8)}, changeType=${changeType}, noteId=${noteId || bugNoteId}, image=${safeFilename}`);
            if (changeType === 'updateNote') {
              return { type: 'updateNote', taskId: resolvedTaskId, noteId, images: [...note.images] };
            }
            return { type: 'updateBugNote', taskId: resolvedTaskId, bugId, noteId: bugNoteId, images: [...note.images] };
          });
        } catch (assocErr) {
          // 数据关联失败：文件已落盘但无引用，先清理孤儿文件再向上抛
          console.error('[Upload] 关联备注数据失败:', assocErr.message);
          try {
            fs.unlinkSync(filePath);
            console.log(`[Upload] 已清理孤儿文件: ${safeFilename}`);
          } catch (e2) {
            if (e2.code !== 'ENOENT') console.error(`[Upload] 清理孤儿文件失败: ${safeFilename}`, e2.message);
          }
          throw assocErr;
        }
      } else if (bugId) {
        try {
          broadcastResult = await updateData((data) => {
            // 确保 taskId 存在，否则用第一个 task（兼容旧客户端）
            const resolvedTaskId = taskId || data.tasks[0]?.id;
            if (!resolvedTaskId) return null;

            let task = data.tasks.find(t => t.id === resolvedTaskId);
            if (!task) {
              // taskId 指定的任务不存在，回退到第一个
              task = data.tasks[0];
            }
            if (!task) {
              // 数据为空（无任何任务），无法关联 → 返回 null，由外层清理孤儿文件
              return null;
            }

            const bug = task.bugs.find(b => b.id === bugId);
            if (!bug) {
              // bug 不在 data.json 中（可能客户端新增后未同步），自动创建并广播完整 add：
              // 其他客户端从未收到过该 bug 的创建广播，必须发 add 让它们建行并携带图片（handleRemoteAdd 有去重，安全）
              const newBug = { id: bugId, name: '', status: '待修复', images: [safeFilename] };
              task.bugs.push(newBug);
              console.log(`[Upload] ⚠️ bugId=${bugId} 不存在于 task=${resolvedTaskId?.substring(0,8)}，已自动创建并关联图片`);
              return { type: 'add', taskId: resolvedTaskId, bug: { ...newBug } };
            }
            // 追加图片到 bug.images（多图语义：不再覆盖；旧图不在此处清理）
            if (!Array.isArray(bug.images)) bug.images = [];
            bug.images.push(safeFilename);
            console.log(`[Upload] ✅ data.json 已更新: taskId=${resolvedTaskId?.substring(0,8)}, bugId=${bugId}, image=${safeFilename}`);
            return { type: 'addImage', taskId: resolvedTaskId, bugId, filename: safeFilename };
          });
        } catch (assocErr) {
          // 数据关联失败（如空 tasks 下解析 task 抛错）：文件已落盘但无引用，先清理孤儿文件再向上抛
          console.error('[Upload] 关联数据失败:', assocErr.message);
          try {
            fs.unlinkSync(filePath);
            console.log(`[Upload] 已清理孤儿文件: ${safeFilename}`);
          } catch (e2) {
            if (e2.code !== 'ENOENT') console.error(`[Upload] 清理孤儿文件失败: ${safeFilename}`, e2.message);
          }
          throw assocErr;
        }
      } else {
        console.log('[Upload] ⚠️ 缺少关联请求头（X-Bug-Id / X-Note-Id / X-Bug-Note-Id）！');
      }

      // 文件已落盘但数据未关联成功 → 按关联类型分流处理
      // 注意：bug 不存在时自动创建 bug 的路径（change 非 null）不删
      const hasAnyAssocHeader = !!(bugId || noteId || bugNoteId);
      // 分支 1：无任何关联请求头 → 纯孤儿，清理文件 + 400
      if (!hasAnyAssocHeader) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[Upload] 已清理孤儿文件: ${safeFilename}`);
        } catch (e) {
          if (e.code !== 'ENOENT') console.error(`[Upload] 清理孤儿文件失败: ${safeFilename}`, e.message);
        }
        // 文件已被清理，明确告知失败，避免客户端把不存在的文件写入数据
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '缺少 X-Bug-Id / X-Note-Id / X-Bug-Note-Id 请求头', filename: safeFilename }));
        return;
      }
      // 分支 2：bug 图片路径（仅 X-Bug-Id）且数据未关联成功（如 tasks 为空）→ 孤儿，清理 + 400
      if (bugId && !noteId && !bugNoteId && (!broadcastResult || !broadcastResult.change)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[Upload] 已清理孤儿文件: ${safeFilename}`);
        } catch (e) {
          if (e.code !== 'ENOENT') console.error(`[Upload] 清理孤儿文件失败: ${safeFilename}`, e.message);
        }
        // 文件已被清理，明确告知失败，避免客户端把不存在的文件写入 bug.images
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '上传未关联到任何任务条目（服务器数据为空）', filename: safeFilename }));
        return;
      }
      // 分支 3：note 路径（X-Note-Id / X-Bug-Note-Id）但无任何可关联任务 → 文件必然孤儿，清理 + 400
      // （与 bug 路径语义对称：空数据下上传不会产生无法关联的孤儿文件）
      if ((noteId || bugNoteId) && notePathNoTask) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[Upload] 已清理孤儿文件: ${safeFilename}`);
        } catch (e) {
          if (e.code !== 'ENOENT') console.error(`[Upload] 清理孤儿文件失败: ${safeFilename}`, e.message);
        }
        // 文件已被清理，明确告知失败，避免客户端把不存在的文件写入 note
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '没有可关联的任务（服务器数据为空）', filename: safeFilename }));
        return;
      }
      // 分支 4：note 路径（X-Note-Id / X-Bug-Note-Id）且 change 为 null（note 尚未创建）
      // → 保留文件，200 成功（由随后 addNote/addBugNote 携带 filename 关联），绝不清理文件

      // 响应客户端
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        filename: safeFilename,
        version: broadcastResult ? broadcastResult.version : undefined,
      }));

      // 广播给所有客户端（服务端直接更新，不依赖客户端 WebSocket）
      if (broadcastResult && broadcastResult.change) {
        const clientCount = _wss ? _wss.clients.size : 0;
        console.log(`[Upload] 📡 广播中: type=${broadcastResult.change.type}, originClientId=${uploaderClientId}, 目标客户端数=${clientCount}`);
        broadcast(_wss, {
          type: 'broadcast',
          originClientId: uploaderClientId,
          change: broadcastResult.change,
          version: broadcastResult.version,
        });
        console.log(`[Upload] 📡 广播完成`);
      } else {
        console.log(`[Upload] ⚠️ 跳过广播: broadcastResult=${JSON.stringify(broadcastResult)}`);
      }
    } catch (err) {
      console.error('[Upload] 处理失败:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '服务器内部错误' }));
    }
  });
}

/**
 * 处理 DELETE /api/upload/:filename
 * 混版本窗口兜底：旧客户端可能直接 DELETE 文件（其 data.json 中仍有引用），
 * 因此先反查所有 bug.images 引用并事务性移除，再删文件（先改数据、后删文件）。
 */
async function handleDeleteUpload(req, res, filename) {
  try {
    // 路径穿越防护
    if (!isSafeFilename(filename)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '非法的文件名' }));
      return;
    }

    snapshotBeforeDelete(); // 删除前快照：可回滚
    const filePath = path.join(UPLOADS_DIR, filename);

    // 确保文件在 uploads 目录内（二次防护）
    if (!filePath.startsWith(UPLOADS_DIR)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '禁止访问' }));
      return;
    }

    // 先改数据：反查所有任务中 images 包含该 filename 的 bug，全部移除引用（返回首个 change 供广播）
    let result = null;
    try {
      result = await updateData((data) => {
        let change = null;
        for (const task of data.tasks) {
          for (const bug of (task.bugs || [])) {
            if (Array.isArray(bug.images)) {
              const idx = bug.images.indexOf(filename);
              if (idx !== -1) {
                bug.images.splice(idx, 1);
                if (!change) {
                  change = { type: 'removeImage', taskId: task.id, bugId: bug.id, filename };
                }
              }
            }
          }
        }
        if (change) return change;
        // 反查备注图片（混版本窗口兜底：旧客户端可能直接 DELETE 文件，其 data.json 中仍有引用）
        // 先扫任务级备注的 images 多图数组，再扫条目级备注，命中即 splice 并返回快照 change 供广播
        for (const t of data.tasks) {
          const tn = (t.notes || []).find(n =>
            (Array.isArray(n.images) && n.images.includes(filename)) || n.image === filename);
          if (tn) {
            if (Array.isArray(tn.images)) {
              const ti = tn.images.indexOf(filename);
              if (ti !== -1) tn.images.splice(ti, 1);
            }
            if (tn.image === filename) tn.image = null;
            return { type: 'updateNote', taskId: t.id, noteId: tn.id, images: [...(tn.images || [])] };
          }
        }
        for (const t of data.tasks) {
          for (const b of t.bugs || []) {
            const bn = (b.notes || []).find(n =>
              (Array.isArray(n.images) && n.images.includes(filename)) || n.image === filename);
            if (bn) {
              if (Array.isArray(bn.images)) {
                const bi = bn.images.indexOf(filename);
                if (bi !== -1) bn.images.splice(bi, 1);
              }
              if (bn.image === filename) bn.image = null;
              return { type: 'updateBugNote', taskId: t.id, bugId: b.id, noteId: bn.id, images: [...(bn.images || [])] };
            }
          }
        }
        return null;
      });
    } catch (assocErr) {
      // 数据反查/写盘失败：不删文件，返回 500（保持"先改数据、后删文件"）
      console.error('[Upload] 删除前反查数据失败:', assocErr.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '删除失败' }));
      return;
    }

    // 后删文件（ENOENT 容忍：文件可能已被删）
    try {
      fs.unlinkSync(filePath);
      console.log(`[Upload] 图片已删除: ${filename}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    // 有引用被移除 → 广播 removeImage，让其他客户端同步移除（避免悬空引用破图）
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
}

// ================================================================
// 数据导出 / 导入（JSON，含 schema 归一化；图片需随 uploads/ 目录迁移）
// ================================================================
function handleExportData(res) {
  try {
    const data = readData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Export] 失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: '导出失败' }));
  }
}

function normalizeNoteForImport(n) {
  return {
    id: (typeof n.id === 'string' && n.id) ? n.id : crypto.randomUUID(),
    clientId: typeof n.clientId === 'string' ? n.clientId : '__import__',
    content: typeof n.content === 'string' ? n.content : '',
    createdAt: typeof n.createdAt === 'number' ? n.createdAt : (typeof n.updatedAt === 'number' ? n.updatedAt : Date.now()),
    updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.now(),
    ...(n.authorName ? { authorName: n.authorName } : {}),
    images: Array.isArray(n.images) ? n.images.filter(x => typeof x === 'string') : [],
  };
}

function normalizeBugForImport(b) {
  return {
    id: (typeof b.id === 'string' && b.id) ? b.id : crypto.randomUUID(),
    name: typeof b.name === 'string' ? b.name : '',
    status: ALLOWED_STATUSES.includes(b.status) ? b.status : '待修复',
    statusChangedAt: typeof b.statusChangedAt === 'number' ? b.statusChangedAt : 0,
    images: Array.isArray(b.images) ? b.images.filter(x => typeof x === 'string') : [],
    notes: Array.isArray(b.notes) ? b.notes.map(normalizeNoteForImport) : [],
    ...(b.completedAt ? { completedAt: b.completedAt } : {}),
    // assignee（0.3 负责人）：导入归一化保留 { clientId, name|null }，防止备份-恢复丢负责人
    ...(b.assignee && typeof b.assignee === 'object' && typeof b.assignee.clientId === 'string' && b.assignee.clientId
      ? { assignee: { clientId: b.assignee.clientId, name: typeof b.assignee.name === 'string' ? b.assignee.name : null } }
      : {}),
    // deadline（0.3 体验小点）：导入归一化保留合法时间戳 number，防止备份-恢复丢失
    ...(typeof b.deadline === 'number' && Number.isFinite(b.deadline) ? { deadline: b.deadline } : {}),
    // archived（归档体系）：仅当 status 为已完成时保留标记与时间（防脏数据，spec 第 7 节）
    ...(b.archived === true && b.status === '已完成'
      ? { archived: true, ...(typeof b.archivedAt === 'number' && Number.isFinite(b.archivedAt) ? { archivedAt: b.archivedAt } : {}) }
      : {}),
  };
}

function normalizeTaskForImport(t) {
  return {
    id: (typeof t.id === 'string' && t.id) ? t.id : crypto.randomUUID(),
    name: (typeof t.name === 'string' && t.name.trim()) ? t.name : '未命名项目',
    bugs: Array.isArray(t.bugs) ? t.bugs.map(normalizeBugForImport) : [],
    notes: Array.isArray(t.notes) ? t.notes.map(normalizeNoteForImport) : [],
  };
}

function handleImportData(req, res) {
  const MAX_IMPORT = 50 * 1024 * 1024; // 50MB
  const chunks = [];
  let total = 0;
  let over = false;
  req.on('data', (chunk) => {
    if (over) return;
    total += chunk.length;
    if (total > MAX_IMPORT) { over = true; chunks.length = 0; return; }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (over) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '导入文件过大（最大 50MB）' }));
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'JSON 解析失败' }));
      return;
    }
    if (!parsed || !Array.isArray(parsed.tasks)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '格式不正确（缺少 tasks 数组）' }));
      return;
    }
    const tasks = parsed.tasks.map(normalizeTaskForImport);

    // 统计引用但缺失的图片文件（提示用户需手动迁移 uploads/）
    const referenced = new Set();
    tasks.forEach(t => (t.bugs || []).forEach(b => (b.images || []).forEach(f => referenced.add(f))));
    let missing = 0;
    referenced.forEach(f => { if (!fs.existsSync(path.join(UPLOADS_DIR, f))) missing++; });

    try {
      const result = await updateData((data) => {
        data.tasks = tasks;
        return { type: '__import__' }; // 非 null → 写盘 + 版本递增
      });
      // 广播全量同步给所有客户端（含发起方）
      broadcast(_wss, { type: 'fullSync', data: result.data, version: result.version });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, version: result.version, missingImages: missing }));
    } catch (e) {
      console.error('[Import] 写盘失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '导入写盘失败' }));
    }
  });
}

function createHttpHandler() {
  const NODE_MODULES_DIR = path.join(__dirname, 'node_modules');

  return function handler(req, res) {
    // 通用 CORS 头（支持跨 Electron 实例/跨浏览器访问）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bug-Id, X-Client-Id, X-Task-Id, X-Note-Id, X-Bug-Note-Id');

    // API 路由：数据导出 / 导入
    if (req.method === 'GET' && req.url.startsWith('/api/export')) {
      handleExportData(res);
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/import')) {
      handleImportData(req, res);
      return;
    }

    // API 路由：图片上传
    if (req.method === 'POST' && req.url.startsWith('/api/upload')) {
      handleUpload(req, res);
      return;
    }

    // API 路由：图片删除
    if (req.method === 'DELETE' && req.url.startsWith('/api/upload/')) {
      const filename = decodeURIComponent(req.url.replace('/api/upload/', '').split('?')[0]);
      handleDeleteUpload(req, res, filename);
      return;
    }

    // CORS 预检：响应 OPTIONS 请求（跨 Electron 实例/跨浏览器需要）
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 上传文件路由：/uploads/ -> 数据目录（asar 外，可读写）
    if (req.url.startsWith('/uploads/')) {
      const rawName = req.url.split('?')[0].replace('/uploads/', '');
      const uploadFilename = decodeURIComponent(rawName);
      const fullPath = path.join(UPLOADS_DIR, uploadFilename);
      const fileExists = fs.existsSync(fullPath);
      if (!fileExists) console.log(`[Static] 图片不存在: ${uploadFilename}`);
      if (isSafeFilename(uploadFilename)) {
        serveStaticFile(res, fullPath, true); // uploads 图片：长缓存（不可变）
      } else {
        console.log(`[Static] ⚠️ 文件名不安全: "${uploadFilename}"`);
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request');
      }
      return;
    }

    // 根路径返回 index.html
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    // Vendor 路由：/vendor/ -> node_modules/
    if (urlPath.startsWith('/vendor/')) {
      const vendorRelPath = '/' + urlPath.replace('/vendor/', '');
      const safeVendorPath = path.resolve(NODE_MODULES_DIR, '.' + path.normalize(vendorRelPath));
      if (!safeVendorPath.startsWith(NODE_MODULES_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }
      serveStaticFile(res, safeVendorPath);
      return;
    }

    // 安全检查：防止目录遍历
    const safePath = path.resolve(PUBLIC_DIR, '.' + path.normalize(urlPath));
    if (!safePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    serveStaticFile(res, safePath);
  };
}

// ================================================================
// 6. 端口探测启动
// ================================================================
let _wss = null;
function _createServer(port) {
  const httpServer = http.createServer(createHttpHandler());
  _wss = new WebSocketServer({ server: httpServer });

  // 处理 WebSocket 服务器错误（避免未捕获异常）
  _wss.on('error', (err) => {
    // 错误由 httpServer 的 error 事件统一处理
  });

  // WebSocket 连接处理
  _wss.on('connection', (ws) => {
    const clientId = crypto.randomUUID();
    ws.clientId = clientId;

    // 新连接发送全量同步
    const data = readData();
    sendTo(ws, {
      type: 'fullSync',
      data,
      version: data.version,
    });

    // 广播在线人数
    broadcastClientCount(_wss);

    ws.on('message', (raw) => {
      handleMessage(ws, raw.toString(), _wss);
    });

    ws.on('close', () => {
      broadcastClientCount(_wss);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket 客户端 ${clientId} 错误:`, err.message);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, BIND_ADDR, () => {
      resolve({ httpServer, _wss, port });
    });

    httpServer.once('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 启动服务器（对外导出接口）
 * 在 initialPort 被占用时自动探测下一个可用端口（最大到 MAX_PORT）
 * @param {number} [initialPort=INITIAL_PORT]
 * @returns {Promise<{ httpServer, _wss, port }>}
 */
async function startServer(initialPort) {
  const startPort = initialPort || INITIAL_PORT;

  for (let port = startPort; port <= MAX_PORT; port++) {
    try {
      const result = await _createServer(port);
      console.log(`服务器已启动: http://${BIND_ADDR}:${result.port}`);

      const ips = getLocalIPs();
      if (ips.length > 0) {
        console.log('局域网访问地址:');
        ips.forEach((ip) => {
          console.log(`  http://${ip}:${result.port}`);
        });
      }
      return result;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.log(`端口 ${port} 被占用，尝试下一个...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`所有端口 (${startPort}-${MAX_PORT}) 均被占用，无法启动。`);
}

module.exports = { startServer };

// 直接运行 server.js 时自动启动
if (require.main === module) {
  startServer().catch((err) => {
    console.error('服务器启动失败:', err.message);
    process.exit(1);
  });
}
