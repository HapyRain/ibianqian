/**
 * Electron preload 脚本（最小化）
 * 通过 contextBridge 暴露 electronAPI 给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

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
});
