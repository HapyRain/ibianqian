/**
 * Electron 主进程
 * - 内嵌 WebSocket 服务器
 * - 系统托盘（关闭隐藏、双击显示、置顶开关、退出）
 * - BrowserWindow 加载本地服务
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut } = require('electron');
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
    // Windows 目录不允许冒号，将 IP:port 中的 : 替换为 _
    const safeName = serverIp.replace(/[:*?"<>|]/g, '_');
    const backupDir = path.join('D:\\Bug清单\\pc', safeName);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupPath = path.join(backupDir, 'data.json');
    const tmpPath = backupPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, backupPath);
    return { ok: true };
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
// 创建主窗口
// ================================================================
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
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
  });

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

  mainWindow.loadURL(`http://localhost:${port}`);

  // 关闭窗口 → 隐藏到托盘（不退出）
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

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

    // 启动内嵌 WebSocket 服务器（端口自适应）
    const { port } = await startServer(3050);
    console.log(`[Electron] 内嵌服务器已启动，端口: ${port}`);

    // 创建主窗口
    createWindow(port);

    // 创建系统托盘
    createTray();
  } catch (err) {
    console.error('[Electron] 启动失败:', err.message);
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

app.on('activate', () => {
  // macOS: 点击 Dock 图标时显示窗口
  if (mainWindow) {
    mainWindow.show();
  }
});
