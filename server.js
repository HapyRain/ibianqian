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

// 数据目录：优先环境变量，否则 D:\Bug清单\[用户名]\
const username = (() => {
  try { return os.userInfo().username; } catch (_) { return 'default'; }
})();
const DATA_ROOT = process.env.BUGLIST_DATA_ROOT || path.join('D:\\Bug清单', username);
// AI 网关（M1+M4）：配置与连通探测。key 只进 ai.config.json，不进 data.json / WS。
const { createAiGateway } = require('./ai-gateway');
const aiGateway = createAiGateway({ dataRoot: DATA_ROOT });
const DATA_FILE = path.join(DATA_ROOT, 'data.json');
const TMP_FILE = path.join(DATA_ROOT, '.data.tmp');
const PUBLIC_DIR = path.join(__dirname, 'public');
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
// 只读保护模式：data.json 损坏（解析失败/结构非法）后置位。
// 置位后所有写操作直接抛错拒绝（绝不以空数据覆盖真实数据），需人工恢复数据文件后重启。
let readOnlyMode = false;

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

/**
 * data.json 损坏处理：备份 .corrupted 后进入只读保护模式（仅一次），返回空数据。
 * 读取路径（fullSync/导出等）仍可用空数据兜底不崩溃；写入路径由 updateData 的 readOnlyMode
 * 检查统一拒绝——旧实现"损坏后拿空数据继续跑"会导致下一次编辑用空数据永久覆盖真实数据。
 */
function enterReadOnlyMode(cause) {
  if (!readOnlyMode) {
    readOnlyMode = true;
    console.error('============================================================');
    console.error('[Data] ⚠️ data.json 损坏（JSON 解析失败或结构非法），已进入只读保护模式！');
    console.error('[Data] ⚠️ 原因:', cause.message);
    console.error('[Data] ⚠️ 所有写入/删除操作将被拒绝，请人工恢复 data.json（或从 backups/ 恢复）后重启服务。');
    console.error('============================================================');
    try {
      const backupPath = DATA_FILE + '.corrupted.' + Date.now();
      fs.copyFileSync(DATA_FILE, backupPath);
      console.error(`[Data] 已备份损坏文件到: ${backupPath}`);
    } catch (backupErr) {
      console.error('[Data] 备份损坏文件失败:', backupErr.message);
    }
  }
  return { tasks: [], version: 0 };
}

function readData() {
  let data;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    data = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 文件不存在：首次启动，正常
      return { tasks: [], version: 0 };
    }
    // 区分两类失败：
    // - 读取 IO 错误（EACCES/EBUSY 等权限/占用）：直接向上抛，中止本次操作——绝不能当作"损坏"而写空数据；
    // - 仅"文件存在但 JSON 解析失败"才走损坏保护路径（JSON.parse 抛 SyntaxError）
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    return enterReadOnlyMode(err);
  }

  // 结构校验：顶层必须是含 tasks 数组的对象（也是 migrateData 的前置假设），否则视为损坏
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.tasks)) {
    return enterReadOnlyMode(new Error('data.json 结构非法（缺少 tasks 数组）'));
  }
  return migrateData(data);
}

/**
 * rename 重试：Windows 下杀毒/索引服务可能短暂占用目标文件导致 EPERM/EACCES，
 * 50ms 后重试一次，仍失败才抛错（避免单次偶发占用导致整次更新静默丢失）
 */
async function renameWithRetry(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    console.error('[Data] rename 失败（可能被杀毒/索引服务占用），50ms 后重试:', err.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.renameSync(from, to); // 重试仍失败则向上抛
  }
}

/**
 * 原子写入：获取锁 → 执行 transform → 写 .tmp（fsync 落盘）→ fs.renameSync → 释放锁
 * @param {Function} transformFn 接收 data，原地修改后返回 change 描述对象
 * @returns {Promise<{ data: object, change: object, version: number }>}
 */
async function updateData(transformFn) {
  // 只读保护模式：data.json 损坏后拒绝一切写盘（含导入/上传关联/删除反查），防止空数据覆盖真实数据
  if (readOnlyMode) {
    throw new Error('data.json 已损坏，服务器处于只读保护模式，写入被拒绝');
  }
  const release = await acquireLock();
  try {
    const data = readData();
    // 双保险：若本次 readData 期间刚发现损坏（首个请求即写入的场景），同样拒绝，绝不以空数据落盘
    if (readOnlyMode) {
      throw new Error('data.json 已损坏，服务器处于只读保护模式，写入被拒绝');
    }
    const change = transformFn(data);

    // 无变化时不递增版本、不写盘
    if (!change) {
      return { data, change: null, version: data.version };
    }

    // version 类型守卫：历史数据可能存成字符串，直接 || 会拼接而非递增
    data.version = (Number(data.version) || 0) + 1;

    // 原子写入：先写临时文件（fsync 确保数据落盘后再改名，防掉电丢数据），再重命名
    // 写临时文件前清理旧 tmp
    try { fs.unlinkSync(TMP_FILE); } catch (e) { /* 不存在则忽略 */ }
    const fd = fs.openSync(TMP_FILE, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      await renameWithRetry(TMP_FILE, DATA_FILE);
    } catch (renameErr) {
      // rename 最终失败时清理临时文件
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

/** 轮转备份 data.json → backups/<prefix>-<stamp>.json，保留同前缀最近 keep 份（按文件名排序）；返回备份路径，失败/无数据文件返回 null */
function rotateBackup(prefix, stamp, keep) {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `${prefix}-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(prefix + '-')).sort();
    while (files.length > keep) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    return dest;
  } catch (e) {
    return { error: e };
  }
}

/** 轮转备份 data.json → backups/data-<时间戳>.json（1 分钟节流，保留最近 BACKUP_KEEP 份） */
function backupDataFile() {
  const now = Date.now();
  if (now - lastDataBackup < 60000) return; // 节流：频繁写盘（如连续传图）不重复备份
  lastDataBackup = now;
  const result = rotateBackup('data', formatTimestamp(new Date()).replace(/[: ]/g, '-'), BACKUP_KEEP);
  if (result && result.error) console.error('[Backup] 轮转备份失败:', result.error.message);
  else if (result) console.log(`[Backup] data.json 已备份（${BACKUP_DIR} 保留 ${BACKUP_KEEP} 份）`);
}

/** 删除类操作前的即时快照（不节流，保证删除前一刻的数据可回滚，保留最近 PRE_DELETE_KEEP 份） */
function snapshotBeforeDelete() {
  if (readOnlyMode) return; // 只读保护模式：删除必然被拒绝，不打无谓快照
  const result = rotateBackup('pre-delete', String(Date.now()), PRE_DELETE_KEEP);
  if (result && result.error) console.error('[Backup] 删除前快照失败:', result.error.message);
  else if (result) console.log(`[Backup] 删除前快照: ${path.basename(result)}`);
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

function countOpenClients(_wss) {
  let count = 0;
  _wss.clients.forEach((client) => {
    if (client.readyState === 1) count++;
  });
  return count;
}

function broadcastClientCount(_wss) {
  broadcast(_wss, { type: 'clientCount', count: countOpenClients(_wss) });
}

/** 向单个客户端发送全量同步（新连接 / requestSync 共用） */
function sendFullSync(ws) {
  const data = readData();
  sendTo(ws, { type: 'fullSync', data, version: data.version });
}

/** 写盘成功后广播变更（change 为 null 则不广播）——所有 handle* 与上传/删除端点共用 */
function broadcastChange(_wss, originClientId, result) {
  if (!result || !result.change) return;
  broadcast(_wss, {
    type: 'broadcast',
    originClientId,
    change: result.change,
    version: result.version,
  });
}

/**
 * 清理 uploads 图片文件（best-effort，ENOENT 容忍——文件可能已被删）。
 * 文件名先过 resolveUploadPath 校验（isSafeFilename + resolve 前缀双保险）：
 * 历史数据可能混入穿越名，此处拒绝删除 uploads/ 之外的任意文件
 */
function deleteImageFile(f) {
  const filePath = resolveUploadPath(f);
  if (!filePath) {
    console.error(`[Image] 拒绝删除非法/不安全文件名: ${f}`);
    return;
  }
  try {
    fs.unlinkSync(filePath);
    console.log(`[Image] 已清理图片: ${f}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[Image] 清理图片失败: ${f}`, e.message);
  }
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
  // 日志截断（超 200 字符）：防超长 value（如粘贴大文本）刷屏
  const valuePreview = String(value);
  const valueLog = valuePreview.length > 200
    ? `${valuePreview.slice(0, 200)}…(已截断,共${valuePreview.length}字符)`
    : valuePreview;
  console.log(`[WS] handleUpdate: clientId=${(ws.clientId || '?').substring(0,8)}, taskId=${taskId?.substring(0,8)}, bugId=${bugId}, field=${field}, value=${valueLog}`);
  if (!taskId || !bugId || !field || value === undefined) return;

  // 字段白名单 + 值校验（放在 updateData 之前，尽早 return，避免无谓进锁）
  // 'name' 允许空字符串（清空名称）；图片生命周期改由 upload/removeImage/DELETE 端点管理，'image' 不再走 update
  if (!['name', 'status', 'deadline', 'archived'].includes(field)) return;
  // name 长度上限 120：超长拒绝
  if (field === 'name' && (typeof value !== 'string' || value.length > 120)) return;
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

  broadcastChange(_wss, msg.clientId, result);
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
  broadcastChange(_wss, msg.clientId, result);
  if (result.change) deleteImageFile(removed);
}

/**
 * assignee / deadline / archived 显式归一化（handleAdd 与导入共用，同一规则）：
 * 合法值写入规范形态，非法值显式 delete——`{ ...bug }` 展开会原样带进脏值，杜绝其入库。
 * 注：deadline（0.3 体验小点）仅保留合法时间戳 number，null/字符串一律删除；
 * archived（归档体系）仅当 status 已完成时保留布尔标记与数字时间（spec 第 7 节）。
 */
function normalizeBugTrustFields(target, src) {
  if (src.assignee && typeof src.assignee === 'object' && typeof src.assignee.clientId === 'string' && src.assignee.clientId) {
    target.assignee = { clientId: src.assignee.clientId, name: typeof src.assignee.name === 'string' ? src.assignee.name : null };
  } else {
    delete target.assignee;
  }
  if (typeof src.deadline === 'number' && Number.isFinite(src.deadline)) {
    target.deadline = src.deadline;
  } else {
    delete target.deadline;
  }
  if (src.archived === true && src.status === '已完成') {
    target.archived = true;
    if (typeof src.archivedAt === 'number' && Number.isFinite(src.archivedAt)) {
      target.archivedAt = src.archivedAt;
    } else {
      delete target.archivedAt;
    }
  } else {
    delete target.archived;
    delete target.archivedAt;
  }
  return target;
}

async function handleAdd(ws, msg, _wss) {
  const { taskId, bug } = msg.data || {};
  // taskId / bug.id 必须为非空字符串（防数字 id / 空串污染数据，后续所有查找都按 id 匹配）
  if (!taskId || typeof taskId !== 'string' || !bug || typeof bug.id !== 'string' || !bug.id) return;

  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    // 检查是否已存在（防重复）
    if (task.bugs.some(b => b.id === bug.id)) return null;
    // 归一化：确保 images 字段为字符串数组（旧客户端 add 不带 images）；statusChangedAt 缺省为当前时间
    const normalizedBug = { ...bug, images: Array.isArray(bug.images) ? bug.images.filter(x => typeof x === 'string') : [] };
    // status 必须在白名单内，否则归一化为默认值「待修复」
    if (!ALLOWED_STATUSES.includes(normalizedBug.status)) normalizedBug.status = '待修复';
    // name 长度上限 120：非字符串或超长拒绝（transform 返回 null → 不写盘不广播）
    if (typeof normalizedBug.name !== 'string' || normalizedBug.name.length > 120) return null;
    if (typeof normalizedBug.statusChangedAt !== 'number') normalizedBug.statusChangedAt = Date.now();
    // assignee（0.3 负责人）/ deadline / archived：与 normalizeBugForImport 共用同一归一化（非法值显式删除）
    normalizeBugTrustFields(normalizedBug, bug);
    task.bugs.push(normalizedBug);
    return { type: 'add', taskId, bug: { ...normalizedBug } };
  });

  broadcastChange(_wss, msg.clientId, result);
}

async function handleDelete(ws, msg, _wss) {
  const { taskId, bugId } = msg.data || {};
  if (!taskId || !bugId) return;

  // 防线预检（spec 第 7 节）：目标不存在或已完成/已归档任务不可删除——均不快照直接返回（防垃圾快照挤占轮转）；
  // 权威防线在下方锁内 transform（返回 null 即拒绝），此处提前 return 同样不写盘不广播
  let pre = null;
  try {
    pre = readData();
  } catch (e) {
    // 读取 IO 错误（权限/占用等）：放弃本次删除，绝不能基于错误状态继续
    console.error('[WS] delete 预读数据失败，放弃本次删除:', e.message);
    return;
  }
  const preTask = pre.tasks.find(t => t.id === taskId);
  const preBug = preTask && preTask.bugs.find(b => b.id === bugId);
  if (!preBug || preBug.status === '已完成' || preBug.archived === true) return;

  snapshotBeforeDelete(); // 删除前快照：可回滚（仅确认目标存在后才执行）
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
    // 条目级备注引用的图片随条目一起清理（防孤儿文件）
    collectNoteImages(task.bugs[index].notes, deletedImages);
    task.bugs.splice(index, 1);
    return { type: 'delete', taskId, bugId };
  });

  broadcastChange(_wss, msg.clientId, result);
  // 数据写盘成功后再清理图片文件（best-effort，ENOENT 容忍）
  if (result.change) deletedImages.forEach(deleteImageFile);
}

// ================================================================
// 5.1 任务级别操作
// ================================================================

async function handleCreateTask(ws, msg, _wss) {
  const { task } = msg.data || {};
  // task.id 必须为非空字符串
  if (!task || typeof task.id !== 'string' || !task.id) return;
  // name 非 string 时走「新项目」默认（与客户端占位统一）；超长（>120）截断
  const taskName = (typeof task.name === 'string' && task.name)
    ? (task.name.length > 120 ? task.name.slice(0, 120) : task.name)
    : '新项目';

  const result = await updateData((data) => {
    if (data.tasks.some(t => t.id === task.id)) return null;
    data.tasks.push({ id: task.id, name: taskName, bugs: [] });
    return { type: 'createTask', task: { id: task.id, name: taskName } };
  });

  broadcastChange(_wss, msg.clientId, result);
}

async function handleUpdateTask(ws, msg, _wss) {
  const { taskId, field, value } = msg.data || {};
  if (!taskId || !field || value === undefined) return;

  // 字段白名单 + 值校验：只允许 'name'，且 trim() 后非空（修复"空任务名可绕过"问题）、长度 ≤ 120
  // 放在 updateData 之前，尽早 return，避免无谓进锁
  if (field !== 'name' || typeof value !== 'string' || value.trim() === '' || value.length > 120) return;

  const result = await updateData((data) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    task[field] = value;
    return { type: 'updateTask', taskId, field, value };
  });

  broadcastChange(_wss, msg.clientId, result);
}

async function handleDeleteTask(ws, msg, _wss) {
  const { taskId } = msg.data || {};
  if (!taskId) return;

  // 防线预检：目标不存在或只剩最后一个任务时直接返回，不打快照（防垃圾快照挤占轮转）；
  // 权威防线仍在锁内 transform（返回 null 即拒绝）
  let pre = null;
  try {
    pre = readData();
  } catch (e) {
    // 读取 IO 错误（权限/占用等）：放弃本次删除，绝不能基于错误状态继续
    console.error('[WS] deleteTask 预读数据失败，放弃本次删除:', e.message);
    return;
  }
  if (pre.tasks.length <= 1 || !pre.tasks.some(t => t.id === taskId)) return;

  snapshotBeforeDelete(); // 删除前快照：可回滚（仅确认目标存在后才执行）
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
      collectNoteImages(bug.notes, deletedImages);
    });
    // 任务级备注的图片也随任务一起清理
    collectNoteImages(deletedTask.notes, deletedImages);

    data.tasks.splice(index, 1);
    return { type: 'deleteTask', taskId };
  });

  broadcastChange(_wss, msg.clientId, result);
  // 数据写盘成功后再逐个清理图片文件（best-effort，ENOENT 容忍）
  if (result.change) deletedImages.forEach(deleteImageFile);
}

// ================================================================
// 5.2 备注（note）操作 — 任务级与条目级合并（按 data.bugId 有无区分层级；
//     change.type 仍分别为 addNote/addBugNote 等，WS 协议形态不变）
// ================================================================

/** 收集一个 notes 数组里引用的全部图片文件名（删除任务/条目时随宿主一起清理，防孤儿文件） */
function collectNoteImages(notes, bucket) {
  if (!Array.isArray(notes)) return;
  notes.forEach(n => {
    if (n && Array.isArray(n.images)) bucket.push(...n.images.filter(f => typeof f === 'string'));
  });
}

/** 辅助：根据 taskId/bugId/noteId 逐级查找 task → bug → note */
function findBugAndNote(tasks, taskId, bugId, noteId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { task: null, bug: null, note: null };
  const bug = task.bugs.find(b => b.id === bugId);
  if (!bug) return { task, bug: null, note: null };
  if (!bug.notes) bug.notes = [];
  const note = noteId ? bug.notes.find(n => n.id === noteId) : null;
  return { task, bug, note };
}

/** 找到备注所在数组：有 bugId → 条目级 bug.notes；无 → 任务级 task.notes；宿主不存在返回 null */
function findNoteList(tasks, taskId, bugId) {
  if (bugId) {
    const { bug } = findBugAndNote(tasks, taskId, bugId);
    return bug ? bug.notes : null;
  }
  const task = tasks.find(t => t.id === taskId);
  if (!task) return null;
  if (!Array.isArray(task.notes)) task.notes = [];
  return task.notes;
}

async function handleAddNote(ws, msg, _wss) {
  const { taskId, bugId, note } = msg.data || {};
  // note.id 必须为非空字符串
  if (!taskId || !note || typeof note.id !== 'string' || !note.id) return;

  const result = await updateData((data) => {
    const notes = findNoteList(data.tasks, taskId, bugId);
    if (!notes || notes.some(n => n.id === note.id)) return null;
    // 不再 spread 信任整包：按备注 schema 白名单逐字段归一化（防脏字段入库）。
    // - content 必须为字符串并截断（上限 4000，防超大备注）；
    // - clientId 缺失时用 msg.clientId 兜底：updateNote/deleteNote 均校验
    //   note.clientId === msg.clientId，缺失会导致该备注永远无人能改/删
    const normalized = {
      id: note.id,
      clientId: (typeof note.clientId === 'string' && note.clientId)
        ? note.clientId
        : ((typeof msg.clientId === 'string' && msg.clientId) ? msg.clientId : '__unknown__'),
      content: typeof note.content === 'string' ? note.content.slice(0, 4000) : '',
      createdAt: typeof note.createdAt === 'number' ? note.createdAt : (typeof note.updatedAt === 'number' ? note.updatedAt : Date.now()),
      updatedAt: typeof note.updatedAt === 'number' ? note.updatedAt : Date.now(),
      ...(typeof note.authorName === 'string' && note.authorName ? { authorName: note.authorName } : {}),
      images: Array.isArray(note.images) ? note.images.filter(x => typeof x === 'string') : [],
    };
    notes.push(normalized);
    return bugId
      ? { type: 'addBugNote', taskId, bugId, note: { ...normalized } }
      : { type: 'addNote', taskId, note: { ...normalized } };
  });

  broadcastChange(_wss, msg.clientId, result);
}

async function handleUpdateNote(ws, msg, _wss) {
  const { taskId, bugId, noteId, content, updatedAt, removeImage } = msg.data || {};
  if (!taskId || !noteId) return;
  // 纯图片移除（removeImage 按文件名）也合法；content 与移除参数均缺省时拒绝；
  // content 必须为字符串（防任意类型入库），截断上限 4000 与 addNote 一致
  if (content === undefined && removeImage === undefined) return;
  if (content !== undefined && typeof content !== 'string') return;

  const removedNoteImages = []; // 闭包：广播后统一清理被移除的图片文件
  const result = await updateData((data) => {
    const notes = findNoteList(data.tasks, taskId, bugId);
    const note = notes && notes.find(n => n.id === noteId);
    if (!note) return null;
    // 更新权限：仅作者本人可修改（含移除图片）
    if (note.clientId !== msg.clientId) return null;
    // 变更判定：content 更新 / removeImage 命中，任一才算有变更；
    // 全部未命中（如 removeImage 不在 images 中）→ return null，避免无效广播与版本递增
    let changed = false;
    if (content !== undefined) {
      note.content = content.slice(0, 4000);
      note.updatedAt = updatedAt || Date.now();
      changed = true;
    }
    // removeImage 按文件名从多图数组中移除
    if (typeof removeImage === 'string' && Array.isArray(note.images)) {
      const ri = note.images.indexOf(removeImage);
      if (ri !== -1) { note.images.splice(ri, 1); removedNoteImages.push(removeImage); changed = true; }
    }
    if (!changed) return null;
    const images = [...(note.images || [])];
    return bugId
      ? { type: 'updateBugNote', taskId, bugId, noteId, content: note.content, updatedAt: note.updatedAt, images }
      : { type: 'updateNote', taskId, noteId, content: note.content, updatedAt: note.updatedAt, images };
  });

  broadcastChange(_wss, msg.clientId, result);
  // 数据写盘成功并广播后，再清理被移除的图片文件（best-effort，ENOENT 容忍）
  if (result.change) removedNoteImages.forEach(deleteImageFile);
}

async function handleDeleteNote(ws, msg, _wss) {
  const { taskId, bugId, noteId } = msg.data || {};
  if (!taskId || !noteId) return;

  // 防线预检：目标不存在或非作者本人时直接返回，不打快照（防垃圾快照挤占轮转）；
  // 权威防线仍在锁内 transform（返回 null 即拒绝），此处提前 return 同样不写盘不广播
  let pre = null;
  try {
    pre = readData();
  } catch (e) {
    // 读取 IO 错误（权限/占用等）：放弃本次删除，绝不能基于错误状态继续
    console.error('[WS] deleteNote 预读数据失败，放弃本次删除:', e.message);
    return;
  }
  {
    const preNotes = findNoteList(pre.tasks, taskId, bugId);
    const preNote = preNotes && preNotes.find(n => n.id === noteId);
    if (!preNote || preNote.clientId !== msg.clientId) return;
  }

  snapshotBeforeDelete(); // 删除前快照：可回滚（仅确认目标存在且校验通过后执行）
  let deletedNoteImages = [];
  const result = await updateData((data) => {
    const notes = findNoteList(data.tasks, taskId, bugId);
    const note = notes && notes.find(n => n.id === noteId);
    if (!note) return null;
    // 删除权限与更新一致：仅作者本人可删除
    if (note.clientId !== msg.clientId) return null;
    const index = notes.findIndex(n => n.id === noteId);
    if (index === -1) return null;
    // splice 前记录备注图片（多图），供删除后清理文件
    deletedNoteImages = [...(note.images || [])];
    notes.splice(index, 1);
    return bugId
      ? { type: 'deleteBugNote', taskId, bugId, noteId }
      : { type: 'deleteNote', taskId, noteId };
  });

  broadcastChange(_wss, msg.clientId, result);
  // 数据写盘成功并广播后，再清理备注图片文件（best-effort，ENOENT 容忍）
  if (result.change) deletedNoteImages.forEach(deleteImageFile);
}

/** requestSync 最小间隔（毫秒）：防客户端高频刷全量同步（大数据下每次都要读盘+序列化） */
const REQUEST_SYNC_MIN_INTERVAL = 500;

function handleRequestSync(ws, _msg, _wss) {
  // 形参对齐统一调用约定 handler(ws, msg, _wss)：中参是 msg、末参才是 _wss
  // （此前误声明为 (ws, _wss)，_wss 实绑到 msg，clientCount 从未随 requestSync 发出）
  // 速率限制：同一连接 500ms 内的重复 requestSync 直接忽略
  const now = Date.now();
  if (typeof ws._lastSyncAt === 'number' && now - ws._lastSyncAt < REQUEST_SYNC_MIN_INTERVAL) return;
  ws._lastSyncAt = now;

  sendFullSync(ws);
  // 同时发送当前在线人数
  sendTo(ws, { type: 'clientCount', count: countOpenClients(_wss) });
}

/** 消息类型 → 处理函数（备注六个类型两两复用同一函数，内部按 bugId 有无分流） */
const WS_HANDLERS = {
  update: handleUpdate,
  add: handleAdd,
  delete: handleDelete,
  removeImage: handleRemoveImage,
  createTask: handleCreateTask,
  updateTask: handleUpdateTask,
  deleteTask: handleDeleteTask,
  addNote: handleAddNote,
  updateNote: handleUpdateNote,
  deleteNote: handleDeleteNote,
  addBugNote: handleAddNote,
  updateBugNote: handleUpdateNote,
  deleteBugNote: handleDeleteNote,
  requestSync: handleRequestSync,
};

async function handleMessage(ws, rawMessage, _wss) {
  let msg;
  try {
    msg = JSON.parse(rawMessage);
  } catch (e) {
    return;
  }
  // 类型守卫：JSON.parse('null') 得 null，数组/字符串等原始值也没有 .type——
  // 直接忽略，否则 WS_HANDLERS[msg.type] 处 TypeError 会崩掉进程
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

  const handler = WS_HANDLERS[msg.type];
  if (!handler) return;
  try {
    await handler(ws, msg, _wss);
  } catch (e) {
    console.error(`[WS] handle_${msg.type} 错误:`, e.message);
  }
}

// ================================================================
// 4. HTTP 静态文件服务
// ================================================================
function serveStaticFile(res, filePath, cacheImmutable, isUpload) {
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
      const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControl };
      if (isUpload) {
        // uploads 内容（如 SVG）可含脚本：加 CSP sandbox + nosniff 防存储型 XSS（脚本被隔离无法执行），
        // 不加 attachment（保留 <img> 内联展示）；仅对 /uploads/ 生效，public/ 自有资源不加避免影响页面
        headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
        headers['X-Content-Type-Options'] = 'nosniff';
      }
      res.writeHead(200, headers);
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
 * 校验文件名并解析为 uploads 目录内的绝对路径（上传落盘 / 删除 / 静态服务共用）：
 * isSafeFilename 拒绝穿越与分隔符 + path.resolve 后带 path.sep 前缀比较的双保险；
 * 非法返回 null（调用方一律拒绝，不做清洗），杜绝 ..\..\ 逃出 uploads/ 读写删任意文件
 */
function resolveUploadPath(name) {
  if (!isSafeFilename(name)) return null;
  const base = path.resolve(UPLOADS_DIR);
  const full = path.resolve(base, name);
  if (!full.startsWith(base + path.sep)) return null; // 必须严格位于 uploads/ 目录内
  return full;
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

      // 文件名校验（防路径穿越任意写）：拒绝而非清洗；超长文件名（>150 字符）一并拒绝
      // （穿越名一旦入库，后续 deleteImageFile 会按名删除 → 升级为任意文件删除）
      if (!isSafeFilename(filename) || filename.length > 150) {
        console.log(`[Upload] ⚠️ 非法/超长文件名被拒绝: "${String(filename).substring(0, 60)}"`);
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '非法的文件名' }));
        return;
      }

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

      // 生成唯一文件名（uuid 前缀 + 已过 isSafeFilename 的原始名；resolve 双保险确认落在 uploads/ 内）
      const uuid = crypto.randomUUID();
      const safeFilename = `${uuid}_${filename}`;
      const filePath = resolveUploadPath(safeFilename);
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '非法的文件名' }));
        return;
      }

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
    // 路径穿越防护（isSafeFilename + resolve 前缀双保险）
    const filePath = resolveUploadPath(filename);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '非法的文件名' }));
      return;
    }

    // 文件不存在直接 404：不打快照（防垃圾快照挤占轮转）、不动数据
    if (!fs.existsSync(filePath)) {
      console.log(`[Upload] 删除目标不存在: ${filename}`);
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '文件不存在' }));
      return;
    }

    snapshotBeforeDelete(); // 删除前快照：可回滚（确认文件存在后才执行）

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
        // 反查备注图片（混版本窗口兜底：旧客户端可能直接 DELETE 文件，其 data.json 中仍有引用）。
        // 遍历清理【所有】任务级/条目级备注中的引用（旧实现 .find 只清第一条命中），首个命中作为广播 change
        // （单条 change 为协议上限，其余引用的服务端清理经下次 fullSync 对齐，不新增消息类型）
        const cleanNoteRef = (t, b, n) => {
          let touched = false;
          if (Array.isArray(n.images)) {
            const ni = n.images.indexOf(filename);
            if (ni !== -1) { n.images.splice(ni, 1); touched = true; }
          }
          if (n.image === filename) { n.image = null; touched = true; } // 旧单图字段兜底
          if (touched && !change) {
            change = b
              ? { type: 'updateBugNote', taskId: t.id, bugId: b.id, noteId: n.id, images: [...(n.images || [])] }
              : { type: 'updateNote', taskId: t.id, noteId: n.id, images: [...(n.images || [])] };
          }
        };
        for (const t of data.tasks) {
          (t.notes || []).forEach(n => cleanNoteRef(t, null, n));
          for (const b of (t.bugs || [])) {
            (b.notes || []).forEach(n => cleanNoteRef(t, b, n));
          }
        }
        return change;
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
    // 文件名经 resolveUploadPath 校验：穿越名一律计缺失，也绝不拿它去 uploads/ 之外探测文件存在性
    const referenced = new Set();
    tasks.forEach(t => (t.bugs || []).forEach(b => (b.images || []).forEach(f => referenced.add(f))));
    let missing = 0;
    referenced.forEach(f => {
      const p = resolveUploadPath(f);
      if (!p || !fs.existsSync(p)) missing++;
    });

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
    // 路由统一取去查询串后的路径，并去尾斜杠做精确匹配（防 /api/exportxxx 之类前缀误命中）
    const routePath = req.url.split('?')[0].replace(/\/+$/, '') || '/';

    // ---- AI 网关路由（M1+M4）----
    // ⚠️ 所在 handler 是**同步** function（createHttpHandler 返回的 handler），块内禁用 await——
    //    异步一律 .then()，绝不能把外层 handler 改成 async。
    if (req.method === 'GET' && routePath === '/api/ai/config') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ config: aiGateway.maskConfig(aiGateway.loadConfig()) }));
      return;
    }
    if (req.method === 'PUT' && routePath === '/api/ai/config') {
      let body = '';
      let oversized = false;
      req.on('data', (c) => {
        if (oversized) return;
        body += c;
        if (body.length > 65536) {
          oversized = true;
          res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Payload Too Large');
          req.destroy();
        }
      });
      req.on('end', () => {
        if (oversized) return; // destroy 后部分 Node 版本仍会派发 end——标志位防重复响应
        let incoming;
        try { incoming = JSON.parse(body || '{}'); }
        catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
          return;
        }
        // 修正点G：parse 结果必须先验 plain object——body 为 'null' 时 JSON.parse 返回 null，
        // 下方 hasOwnProperty.call(null, 'key') 抛 TypeError 且无人捕获 → req 'end' 监听器内崩进程
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '请求体必须是 JSON 对象' }));
          return;
        }
        // 修正点⑤：key 字段级语义——缺省 key 字段 = 保留已存 key；显式 key:'' = 清空（key:null 归一为 ''）
        if (!Object.prototype.hasOwnProperty.call(incoming, 'key')) {
          incoming.key = aiGateway.loadConfig().key;
        }
        // 修正点C（触发侧）：先取旧配置，供下方摘要触发比较——保存后 loadConfig 返回的已是新值，比较恒假
        const oldCfg = aiGateway.loadConfig();
        let out;
        try { out = aiGateway.saveConfig(incoming); }
        catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }
        // 修正点C：context 变更（含清空）→ 异步预压缩摘要（fire-and-forget，失败静默保留旧摘要）
        if (oldCfg.context !== out.context && typeof aiGateway.refreshContextSummary === 'function') {
          aiGateway.refreshContextSummary().catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ config: aiGateway.maskConfig(out) }));
      });
      return;
    }
    if (req.method === 'POST' && routePath === '/api/ai/test') {
      aiGateway.testConnection().then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      }).catch((e) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, latencyMs: 0, error: e.message }));
      });
      return;
    }

    // API 路由：数据导出 / 导入
    // 注：前端/Electron 均同源访问（loadURL http://localhost:port），不再返回 CORS 通配头——
    // 收紧跨站读取面：其他站点的 drive-by 页面无法跨域读取 /api/export 或 POST /api/import
    if (req.method === 'GET' && routePath === '/api/export') {
      handleExportData(res);
      return;
    }
    if (req.method === 'POST' && routePath === '/api/import') {
      handleImportData(req, res);
      return;
    }

    // API 路由：图片上传
    if (req.method === 'POST' && routePath === '/api/upload') {
      handleUpload(req, res);
      return;
    }

    // API 路由：图片删除
    if (req.method === 'DELETE' && routePath.startsWith('/api/upload/')) {
      let filename = null;
      try {
        // 畸形百分号编码（如 DELETE /api/upload/%）会让 decodeURIComponent 抛 URIError：
        // 捕获后按 400 拒绝，绝不能让异常冒泡崩掉进程
        filename = decodeURIComponent(req.url.split('?')[0].slice('/api/upload/'.length));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '非法的文件名编码' }));
        return;
      }
      handleDeleteUpload(req, res, filename);
      return;
    }

    // CORS 预检：同源部署无需跨域，仅回 204、不返回任何 CORS 头
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 上传文件路由：/uploads/ -> 数据目录（asar 外，可读写）
    if (req.url.startsWith('/uploads/')) {
      let uploadFilename = null;
      try {
        // 畸形百分号编码（如 GET /uploads/%）：按 400 拒绝，不崩进程
        uploadFilename = decodeURIComponent(req.url.split('?')[0].slice('/uploads/'.length));
      } catch (e) {
        console.log('[Static] ⚠️ 非法百分号编码的上传文件名请求被拒绝（400）');
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request');
        return;
      }
      const fullPath = resolveUploadPath(uploadFilename);
      if (!fullPath) {
        console.log(`[Static] ⚠️ 文件名不安全: "${uploadFilename}"`);
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('400 Bad Request');
        return;
      }
      const fileExists = fs.existsSync(fullPath);
      if (!fileExists) console.log(`[Static] 图片不存在: ${uploadFilename}`);
      serveStaticFile(res, fullPath, true, true); // uploads 图片：长缓存（不可变）+ CSP sandbox 加固
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
      // 前缀比较带 path.sep：防未来出现 node_modules2/ 类同级目录被误放行
      if (!safeVendorPath.startsWith(NODE_MODULES_DIR + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }
      serveStaticFile(res, safeVendorPath);
      return;
    }

    // 安全检查：防止目录遍历
    const safePath = path.resolve(PUBLIC_DIR, '.' + path.normalize(urlPath));
    // 前缀比较带 path.sep：防未来出现 public2/ 类同级目录被误放行
    if (!safePath.startsWith(PUBLIC_DIR + path.sep)) {
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
let heartbeatTimer = null;

function _createServer(port) {
  const httpServer = http.createServer(createHttpHandler());
  // maxPayload：单条 WS 消息上限 10MB（防超大帧耗尽内存）
  _wss = new WebSocketServer({ server: httpServer, maxPayload: 10 * 1024 * 1024 });

  // WebSocket 服务器级错误：记日志即可（端口占用等监听期错误由 httpServer 的 error 事件统一处理）
  _wss.on('error', (err) => {
    console.error('[WS] 服务器错误:', err.message);
  });

  // WS 心跳：每 30s ping 一次（pong 自动回应）；连续 2 次未回应判定半开连接，terminate 清理
  const HEARTBEAT_INTERVAL_MS = 30000;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!_wss) return;
    _wss.clients.forEach((client) => {
      if (client.isAlive === false) {
        client._missedPongs = (client._missedPongs || 0) + 1;
        if (client._missedPongs >= 2) {
          client.terminate(); // 连续 2 次未回应 pong：判定为死连接
          return;
        }
      } else {
        client._missedPongs = 0;
      }
      client.isAlive = false;
      try { client.ping(); } catch (e) { /* 忽略 */ }
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref(); // 不阻止进程自然退出
  // HTTP 服务器关闭时同步清掉心跳（定时器生命周期与服务器绑定；否则 close 后残留的
  // unref 定时器在 Windows/Node 24 下与某些嵌入方的退出路径组合会触发 libuv 退出断言）
  httpServer.on('close', () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  });

  // WebSocket 连接处理
  _wss.on('connection', (ws) => {
    const clientId = crypto.randomUUID();
    ws.clientId = clientId;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // 新连接发送全量同步（读取 IO 失败只记日志，不影响连接建立）
    try {
      const data = readData();
      sendTo(ws, {
        type: 'fullSync',
        data,
        version: data.version,
      });
    } catch (e) {
      console.error('[WS] 新连接全量同步失败:', e.message);
    }

    // 广播在线人数
    broadcastClientCount(_wss);

    ws.on('message', (raw) => {
      // 兜底 catch：任何消息处理异常只记日志，绝不因未捕获 rejection 崩溃进程
      handleMessage(ws, raw.toString(), _wss).catch((err) => {
        console.error('[WS] 消息处理未捕获错误:', err && err.stack ? err.stack : err);
      });
    });

    ws.on('close', () => {
      broadcastClientCount(_wss);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket 客户端 ${clientId} 错误:`, err.message);
    });
  });

  return new Promise((resolve, reject) => {
    // 探测失败轮次（如 EADDRINUSE）：关闭本轮创建的 httpServer/WSS，避免句柄泄漏后再试下一端口
    const onListenError = (err) => {
      try { _wss.close(); } catch (e) { /* 忽略 */ }
      try { httpServer.close(() => {}); } catch (e) { /* 忽略 */ }
      reject(err);
    };
    httpServer.once('error', onListenError);

    httpServer.listen(port, BIND_ADDR, () => {
      // 监听成功：移除探测期 once 监听，换成长期 error 日志监听
      // （旧实现 resolve 后 error 事件无监听，进程会因未捕获 'error' 直接退出）
      httpServer.removeListener('error', onListenError);
      httpServer.on('error', (err) => {
        console.error(`[Server] HTTP 服务器错误 (port=${port}):`, err.message);
      });
      resolve({ httpServer, _wss, port });
    });
  });
}

// ================================================================
// 7. 跨进程实例锁（防双实例互踩：端口自动 +1 会让第二个实例照常启动，整文件互相覆盖 data.json）
// ================================================================
const LOCK_FILE = path.join(DATA_ROOT, 'data.lock');
let instanceLockAcquired = false;

/** pid 对应进程是否存活（kill(pid,0) 探测；EPERM 表示进程存在但无权限，同样视为存活） */
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 获取跨进程实例锁（O_EXCL 独占创建 data.lock 并写入 pid）。
 * 已存在且持有者仍存活 → 明确报错退出；持有者已死（残留锁）→ 删除后继续。
 * 失败抛错，由调用方（startServer / main）中止启动。
 */
function acquireInstanceLock() {
  if (instanceLockAcquired) return;
  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // 锁文件已存在：读取 pid 判断持有者是否仍存活
    let holderPid = NaN;
    try { holderPid = Number(String(fs.readFileSync(LOCK_FILE, 'utf-8')).trim()); } catch (e) { /* 空/不可读按残留处理 */ }
    if (Number.isInteger(holderPid) && holderPid > 0 && isPidAlive(holderPid)) {
      throw new Error(`数据目录已被另一个实例锁定 (pid=${holderPid})：${LOCK_FILE}。请先关闭正在运行的实例——双开会互相覆盖 data.json。`);
    }
    // 残留锁（持有者已退出/崩溃未清理）：删除后重新获取
    console.warn(`[Lock] 发现残留实例锁（pid=${holderPid} 已不存活），自动清理: ${LOCK_FILE}`);
    try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 忽略 */ }
    fd = fs.openSync(LOCK_FILE, 'wx');
  }
  fs.writeFileSync(fd, String(process.pid), 'utf-8');
  fs.closeSync(fd);
  instanceLockAcquired = true;
  console.log(`[Lock] 实例锁已获取: ${LOCK_FILE} (pid=${process.pid})`);
}

/** 释放实例锁（进程退出时调用；先校验锁内容仍是本进程 pid，避免误删他人锁） */
function releaseInstanceLock() {
  if (!instanceLockAcquired) return;
  try {
    const holderPid = Number(String(fs.readFileSync(LOCK_FILE, 'utf-8')).trim());
    if (holderPid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* 忽略 */ }
  instanceLockAcquired = false;
}

/**
 * 启动服务器（对外导出接口）
 * 在 initialPort 被占用时自动探测下一个可用端口（最大到 MAX_PORT）
 * @param {number} [initialPort=INITIAL_PORT]
 * @returns {Promise<{ httpServer, _wss, port }>}
 */
async function startServer(initialPort) {
  const startPort = initialPort || INITIAL_PORT;

  // 起始端口超出探测范围时给出准确错误（旧实现循环一次不进，会报出 (4000-3070) 之类反向区间的误导文案）
  if (!Number.isInteger(startPort) || startPort < 0 || startPort > MAX_PORT) {
    throw new Error(`起始端口 ${startPort} 超出可用探测范围 (0-${MAX_PORT})，无法启动。`);
  }

  // 跨进程实例锁：双开时第二个实例明确报错退出（正常退出/信号终止时自动释放；强杀残留由下次启动按 pid 清理）
  acquireInstanceLock();
  process.once('exit', releaseInstanceLock);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { releaseInstanceLock(); process.exit(0); });
  }

  // 启动预读一次 data.json：损坏时立即进入只读保护模式并醒目告警（而非等到首个请求才暴露）；
  // IO 错误（权限/占用）仅记录——后续读写路径各自处理，绝不写空数据
  try { readData(); } catch (e) {
    console.error('[Data] ⚠️ 启动预读 data.json 失败（IO 错误）:', e.message);
  }

  try {
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
  } catch (err) {
    releaseInstanceLock(); // 启动失败：释放实例锁，不残留
    throw err;
  }

  releaseInstanceLock(); // 探测耗尽仍未成功：同样释放
  throw new Error(`端口 ${startPort}-${MAX_PORT} 范围内所有端口均被占用，无法启动。`);
}

module.exports = { startServer };

// 直接运行 server.js 时自动启动
if (require.main === module) {
  startServer().catch((err) => {
    console.error('服务器启动失败:', err.message);
    process.exit(1);
  });
}
