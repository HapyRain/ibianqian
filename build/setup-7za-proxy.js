// Postinstall: replace 7za.exe with proxy that ignores symlink errors
const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64');
const realPath = path.join(targetDir, '7za_real.exe');
const exePath = path.join(targetDir, '7za.exe');
const proxyPath = path.join(__dirname, '7za-proxy.exe');

if (!fs.existsSync(targetDir)) {
  // Not on Windows or 7zip-bin not installed
  process.exit(0);
}

// Backup original if not already done
if (!fs.existsSync(realPath) && fs.existsSync(exePath)) {
  fs.renameSync(exePath, realPath);
  console.log('[postinstall] Backed up original 7za.exe -> 7za_real.exe');
}

// Copy proxy
if (fs.existsSync(proxyPath)) {
  fs.copyFileSync(proxyPath, exePath);
  console.log('[postinstall] 7za proxy installed (symlink-safe wrapper)');
} else {
  console.log('[postinstall] 7za proxy not found, skipping');
}
