// Postinstall: 编译并安装 7za 代理（symlink 容错包装），替换 node_modules/7zip-bin 里的 7za.exe
// 背景：electron-builder 解压 winCodeSign 时软链接在 Windows 上报错，用代理包装吞掉该错误（详见 build/7za-wrapper.cs）
// - 7za-proxy.exe 不入库（.gitignore），全新 clone 上必须由本脚本现场编译：
//   用 Windows 自带的 .NET Framework csc 编译 build/7za-wrapper.cs
// - csc 不可用或编译失败：把备份的原版 7za_real.exe 还原回 7za.exe，跳过代理安装
//   （未打补丁状态下 electron-builder 用原版 7za 仍可正常打包）
// - 幂等：重复运行不重复改名，也不会出现 7za_real_real.exe 嵌套
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const targetDir = path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64');
const realPath = path.join(targetDir, '7za_real.exe');
const exePath = path.join(targetDir, '7za.exe');
const proxyPath = path.join(__dirname, '7za-proxy.exe');
const csPath = path.join(__dirname, '7za-wrapper.cs');

// csc 编译的代理仅几 KB，原版 7za.exe 约 1.2MB——按大小区分"7za.exe 现在是原版还是代理"
const PROXY_MAX_BYTES = 100 * 1024;

function looksLikeProxy(p) {
  try {
    return fs.statSync(p).size < PROXY_MAX_BYTES;
  } catch (e) {
    return false;
  }
}

/** 找 csc.exe：优先 64 位 .NET Framework 4，其次 32 位，最后指望 PATH 里有 csc */
function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'csc.exe';
}

/** 编译代理到 build/7za-proxy.exe；成功返回 true */
function compileProxy() {
  if (!fs.existsSync(csPath)) {
    console.log('[postinstall] 未找到 build/7za-wrapper.cs，无法编译 7za 代理');
    return false;
  }
  const csc = findCsc();
  try {
    const res = spawnSync(csc, ['/nologo', '/target:exe', '/out:' + proxyPath, csPath], { encoding: 'utf8' });
    if (res.status === 0 && fs.existsSync(proxyPath)) {
      console.log('[postinstall] 已用 csc 编译 7za 代理:', proxyPath);
      return true;
    }
    const detail = ((res.stderr || '') + (res.stdout || '')).trim() || ('csc 退出码 ' + res.status);
    console.log('[postinstall] csc 编译失败:', detail);
  } catch (e) {
    console.log('[postinstall] csc 调用失败:', e.message);
  }
  return false;
}

if (!fs.existsSync(targetDir)) {
  // 非 Windows 或 7zip-bin 未安装
  process.exit(0);
}

if (!compileProxy()) {
  // 编译失败：还原原版 7za.exe（此前可能被改名成 7za_real.exe 备份过）
  if (fs.existsSync(realPath)) {
    try {
      if (fs.existsSync(exePath)) fs.unlinkSync(exePath); // 先移除可能已装的旧代理
      fs.renameSync(realPath, exePath);
      console.log('[postinstall] 已还原原版 7za.exe，跳过代理安装（electron-builder 用原版 7za 照常工作）');
    } catch (e) {
      console.log('[postinstall] 原版 7za.exe 还原失败:', e.message);
    }
  } else if (!fs.existsSync(exePath)) {
    console.log('[postinstall] 无原版 7za 可还原，跳过代理安装');
  } else {
    console.log('[postinstall] 跳过代理安装（保留现有 7za.exe）');
  }
  process.exit(0);
}

try {
  // 备份原版：仅当 7za.exe 是原版时改名一次（幂等关键——已是代理则绝不再改名，防嵌套 7za_real_real）
  if (fs.existsSync(exePath) && !looksLikeProxy(exePath)) {
    if (fs.existsSync(realPath)) fs.rmSync(realPath); // 旧备份（可能来自旧版 7zip-bin）以当前原版为准
    fs.renameSync(exePath, realPath);
    console.log('[postinstall] 已备份原版 7za.exe -> 7za_real.exe');
  } else if (!fs.existsSync(realPath)) {
    console.log('[postinstall] 警告：找不到原版 7za.exe 可备份（7za_real.exe 也不存在）');
  }
  fs.copyFileSync(proxyPath, exePath);
  console.log('[postinstall] 7za 代理已安装（symlink 容错包装）');
} catch (e) {
  console.log('[postinstall] 代理安装失败:', e.message);
  // 兜底还原：若改名备份后拷贝失败导致 7za.exe 缺失，把原版恢复回去
  try {
    if (!fs.existsSync(exePath) && fs.existsSync(realPath)) {
      fs.renameSync(realPath, exePath);
      console.log('[postinstall] 已还原原版 7za.exe');
    }
  } catch (e2) {
    console.log('[postinstall] 原版 7za.exe 还原失败:', e2.message);
  }
}
