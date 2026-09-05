/**
 * Electron preload 脚本（最小化）
 * 通过 contextBridge 暴露 electronAPI 给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 获取本机局域网 IP 地址
   */
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),

  /**
   * 将当前数据备份到本地磁盘
   * @param {string} serverIp - 服务端 IP，用于目录名
   * @param {object} data - 要备份的数据 { version, tasks }
   */
  writeBackup: (serverIp, data) => ipcRenderer.invoke('write-backup', { serverIp, data }),

  /**
   * 获取稳定的设备 id（MAC 哈希，前 16 位）
   */
  getMacId: () => ipcRenderer.invoke('get-mac-id'),

  /**
   * 窗口控制（自绘标题栏：置顶 / 最小化 / 最大化还原 / 关闭）
   */
  windowControls: {
    minimize: () => ipcRenderer.invoke('win-minimize'),
    maximizeToggle: () => ipcRenderer.invoke('win-maximize-toggle'),
    close: () => ipcRenderer.invoke('win-close'),
    setAlwaysOnTop: (v) => ipcRenderer.invoke('win-always-on-top', !!v),
    getAlwaysOnTop: () => ipcRenderer.invoke('win-always-on-top-get'),
    /** 置顶状态变化（托盘菜单 / 标题栏按钮双向同步） */
    onAlwaysOnTopChange: (cb) => ipcRenderer.on('win-always-on-top-changed', (_e, v) => cb(v)),
    /** 最大化/还原状态变化（标题栏图标切换） */
    onMaximizedChange: (cb) => ipcRenderer.on('win-maximized-changed', (_e, v) => cb(v)),
    /** 同步全局快捷键（窗口 最小化↔还原 切换；accel 形如 'Alt+3'；null 表示注销） */
    setShortcut: (accel) => ipcRenderer.invoke('shortcut-set', accel),
  },
});
