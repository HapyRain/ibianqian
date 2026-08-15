const { spawnSync } = require('child_process');
const path = require('path');

// Run the real 7za with all passed arguments
const realExe = path.join(__dirname, '7za_real.exe');
const args = process.argv.slice(2);

const result = spawnSync(realExe, args, { stdio: 'inherit' });

// Always exit 0 — symlink errors on .dylib files are harmless on Windows
process.exit(0);
