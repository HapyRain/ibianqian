/**
 * Electron 主进程
 * - 内嵌 WebSocket 服务器
 * - 系统托盘（关闭隐藏、双击显示、置顶开关、退出）
 * - BrowserWindow 加载本地服务
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { startServer } = require('../server');

// 去掉默认英文菜单栏
Menu.setApplicationMenu(null);

// ================================================================
// 全局引用（防止 GC 回收）
// ================================================================
let mainWindow = null;
let tray = null;

// ================================================================
// 退出标志
// ================================================================
app.isQuitting = false;

// ================================================================
// 应用图标（开发与打包路径一致：asar 内 public/favicon.ico）
// ================================================================
const APP_ICON_PATH = path.join(__dirname, '..', 'public', 'favicon.ico');

// ================================================================
// 创建托盘图标（加载应用图标；加载失败回退纯色块）
// ================================================================
function createTrayIcon() {
  try {
    const img = nativeImage.createFromPath(APP_ICON_PATH);
    if (!img.isEmpty()) return img;
  } catch (e) { /* 忽略，走回退 */ }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;     // B
    buf[i + 1] = 158; // G
    buf[i + 2] = 64;  // R
    buf[i + 3] = 255; // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 1.0 });
}

// ================================================================
// 创建系统托盘
// ================================================================
function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('任务清单 - 多人协同');

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 右键菜单
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
      click: (item) => {
        if (mainWindow) {
          mainWindow.setAlwaysOnTop(item.checked);
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ================================================================
// IPC：获取本机局域网 IP
// ================================================================
ipcMain.handle('get-local-ip', () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过内部回环地址和 IPv6
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
});

// ================================================================
// IPC：客户端备份数据到本地磁盘
// ================================================================
ipcMain.handle('write-backup', async (_event, { serverIp, data }) => {
  try {
    // 清洗目录名：Windows 非法字符（含冒号）替换为 _，再拒绝路径分隔符与 ..
    // serverIp 来自渲染进程不可信任：只清洗不过校验会被 ..\ 等输入带出备份根目录（路径穿越）
    let safeName = String(serverIp || '').replace(/[:*?"<>|]/g, '_').trim();
    if (!safeName || /[\\/]/.test(safeName) || safeName.includes('..')) {
      return { ok: false, error: '非法的服务器地址：' + serverIp };
    }
    // 备份根目录：userData/backups/pc（旧版硬编码 D:\Bug清单\pc 已废弃，历史备份请手动搬移）
    const backupDir = path.join(app.getPath('userData'), 'backups', 'pc', safeName);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupPath = path.join(backupDir, 'data.json');
    const tmpPath = backupPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, backupPath);
    // 回传真实落盘路径：渲染端日志直接用，避免在渲染侧臆测路径（旧版曾硬编码 D:\Bug清单\pc 打日志，与实际位置不符）
    return { ok: true, path: backupPath };
  } catch (err) {
    console.error('[Backup] 写入失败:', err.message);
    return { ok: false, error: err.message };
  }
});

// ================================================================
// IPC：获取稳定的设备 id（多网卡排序后取首个，sha256 哈希取前 16 位，不泄露原始 MAC）
// ================================================================
ipcMain.handle('get-mac-id', () => {
  try {
    const ifs = os.networkInterfaces();
    const macs = [];
    // 过滤虚拟网卡：按接口名排除常见虚拟/隧道/代理网卡，并要求该接口存在非内网 IPv4
    const VIRTUAL_RE = /virtual|vethernet|tap|tun|wsl|isatap|loopback|vpn|tailscale|wireguard|hamachi|zerotier|docker/i;
    for (const name of Object.keys(ifs)) {
      if (VIRTUAL_RE.test(name)) continue;
      const hasRealIpv4 = (ifs[name] || []).some(x => x.family === 'IPv4' && !x.internal);
      if (!hasRealIpv4) continue;
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

// ================================================================
// IPC：窗口控制（自绘标题栏：置顶 / 最小化 / 最大化还原 / 关闭）
// ================================================================
ipcMain.handle('win-minimize', () => { if (mainWindow) mainWindow.minimize(); });

ipcMain.handle('win-maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.handle('win-close', () => { if (mainWindow) mainWindow.close(); }); // close 事件 → 隐藏到托盘

ipcMain.handle('win-always-on-top', (_e, v) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!v);
  return mainWindow ? mainWindow.isAlwaysOnTop() : false;
});

ipcMain.handle('win-always-on-top-get', () => (mainWindow ? mainWindow.isAlwaysOnTop() : false));

// ================================================================
// 全局快捷键：窗口 最小化 ↔ 还原（窗口化）切换
// - 快捷键在渲染进程设置面板里配置（存本机 localStorage），启动/确认时经 IPC 同步到主进程
// - 用 Electron globalShortcut 注册为系统级热键：窗口最小化/隐藏时按键仍能触发还原
// ================================================================
let windowShortcut = null;

/** 窗口 最小化 ↔ 还原 切换（隐藏(托盘)→显示；最小化→还原；正常→最小化） */
function toggleWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
    mainWindow.focus();
    return;
  }
  mainWindow.minimize();
}

/**
 * 注册/更新全局快捷键（accel 形如 'Alt+3' / 'Control+Alt+3'）
 * @param {string|null} accel - null 表示注销当前快捷键（录制新键期间调用）
 * @returns {boolean} 注册是否成功（false = 组合键被其他程序占用等）
 */
function registerWindowShortcut(accel) {
  if (windowShortcut === accel && accel && globalShortcut.isRegistered(accel)) return true;
  if (windowShortcut) {
    globalShortcut.unregister(windowShortcut);
    windowShortcut = null;
  }
  if (!accel) return true;
  const ok = globalShortcut.register(accel, toggleWindowState);
  if (ok) windowShortcut = accel;
  return ok;
}

// 渲染进程同步快捷键（启动时 / 设置面板确认后 / 录制期间注销）
ipcMain.handle('shortcut-set', (_e, accel) => registerWindowShortcut(accel));

// ================================================================
// 窗口状态持久化（userData/window-state.json：位置/大小/最大化/置顶）
// ================================================================
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_WIN_STATE = { bounds: { width: 900, height: 600 }, isMaximized: false, alwaysOnTop: false };
let winStateTimer = null;

/** 防抖保存窗口状态（resize/move 高频触发，500ms 合并一次写盘） */
function scheduleSaveWindowState() {
  if (winStateTimer) clearTimeout(winStateTimer);
  winStateTimer = setTimeout(saveWindowState, 500);
}

/** 同步保存当前窗口状态（写盘失败静默，不影响运行） */
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const state = {
      // getNormalBounds：最大化时仍记录"还原后"的正常尺寸，避免把最大化尺寸当成默认尺寸存下来
      bounds: mainWindow.getNormalBounds(),
      isMaximized: mainWindow.isMaximized(),
      alwaysOnTop: mainWindow.isAlwaysOnTop(),
    };
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) { /* 忽略写盘失败 */ }
}

/** 校验窗口矩形是否至少有 100×100 落在某块显示屏的可视区域内（防显示器拔掉后窗口漂出屏幕） */
function boundsInDisplay(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= 100 && h >= 100;
  });
}

/** 读取上次的窗口状态；无文件/损坏/位置漂出屏幕/尺寸低于最小窗时回退默认 900×600（居中） */
function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf-8'));
    const b = raw.bounds;
    if (b && b.width >= 600 && b.height >= 530 && boundsInDisplay(b)) {
      return { bounds: b, isMaximized: !!raw.isMaximized, alwaysOnTop: !!raw.alwaysOnTop };
    }
  } catch (e) { /* 无文件或解析失败 → 默认；screen 未就绪时异常同样走这里 */ }
  return JSON.parse(JSON.stringify(DEFAULT_WIN_STATE));
}

// ================================================================
// 创建主窗口
// ================================================================
function createWindow(port) {
  // 恢复上次的窗口状态（位置/大小已在读取时校验；无效则回退默认 900×600 居中）
  const saved = loadWindowState();
  const winOptions = {
    width: saved.bounds.width,
    height: saved.bounds.height,
    minWidth: 600,
    minHeight: 530, /* 最小窗 600×530（spec 第 9 节）：保证启动弹窗与贴底面板在极限小窗下仍完整可用 */
    title: '任务清单 - 多人协同',
    icon: APP_ICON_PATH, // 窗口/任务栏图标（Windows 上显式指定，避免默认 Electron 图标）
    frame: false, // 自绘标题栏（HTML 承载拖拽与窗口控制按钮，含"置顶"）
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  // x/y 不写进默认配置：首次运行（无状态文件）交给系统居中
  if (Number.isFinite(saved.bounds.x)) winOptions.x = saved.bounds.x;
  if (Number.isFinite(saved.bounds.y)) winOptions.y = saved.bounds.y;
  mainWindow = new BrowserWindow(winOptions);

  // 恢复上次的置顶与最大化
  if (saved.alwaysOnTop) mainWindow.setAlwaysOnTop(true);
  if (saved.isMaximized) mainWindow.maximize();

  // 加载失败时显示具体错误页面
  mainWindow.webContents.on('did-fail-load', (event, code, desc, url) => {
    console.error('[Electron] 页面加载失败:', code, desc, url);
    mainWindow.loadURL(`data:text/html,
      <h1 style="color:red;font-family:sans-serif;padding:40px">
        连接失败 (${code})<br>
        <small>端口: ${port} | ${desc}</small><br>
        <small>请确认服务器已正常启动</small>
      </h1>`);
  });

  // 监听控制台消息，转发到主进程日志
  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log('[Renderer]', message);
  });

  // 渲染进程崩溃（内存/GPU 等原因）→ 记日志并重载，避免打包 exe 无控制台时白屏挂着
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Electron] 渲染进程崩溃:', details.reason, 'exitCode:', details.exitCode);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  // 关闭窗口 → 隐藏到托盘（不退出）
  mainWindow.on('close', (event) => {
    saveWindowState(); // 关闭/隐藏前同步保存一份窗口状态（比防抖更可靠）
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 窗口状态持久化：移动/调整大小防抖保存（close 里另有一份同步保存兜底）
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);

  // 窗口置顶状态变化时更新托盘菜单 + 推送渲染进程（标题栏置顶按钮激活态同步）
  mainWindow.on('always-on-top-changed', () => {
    updateTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win-always-on-top-changed', mainWindow.isAlwaysOnTop());
    }
  });

  // 最大化/还原状态变化 → 推送渲染进程（标题栏图标切换）
  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('win-maximized-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('win-maximized-changed', false);
  });
}

// ================================================================
// 单实例检测（必须在 whenReady 之前调用）
// ================================================================
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return; // 停止执行，不继续 app.whenReady()
}

// 第二个实例启动时，恢复已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ================================================================
// 应用启动
// ================================================================
app.whenReady().then(async () => {
  try {
    console.log('[Electron] 数据目录:', process.env.BUGLIST_DATA_ROOT || '(默认)');

    // 启动内嵌 WebSocket 服务器（端口自适应；BUGLIST_PORT 可覆盖起始端口）
    const { port } = await startServer(parseInt(process.env.BUGLIST_PORT, 10) || 3050);
    console.log(`[Electron] 内嵌服务器已启动，端口: ${port}`);

    // 创建主窗口
    createWindow(port);

    // 创建系统托盘
    createTray();
  } catch (err) {
    console.error('[Electron] 启动失败:', err.message);
    // 打包 exe 无控制台，静默退出用户只看到闪退——用系统对话框给出原因（端口 3050–3070 全忙等）
    dialog.showMessageBoxSync({
      type: 'error',
      title: '任务清单',
      message: '启动失败',
      detail: `${err.message}\n\n若为端口占用：默认端口 3050–3070 被其他程序占满时无法启动，请释放端口后重试（可用环境变量 BUGLIST_PORT 指定起始端口）。`,
    });
    app.quit();
  }
});

// ================================================================
// 应用退出
// ================================================================
app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // 不自动退出，由托盘控制
});
