/**
 * 模板回归防线：HTML 自定义元素（el-*）禁止自闭合 <el-input /> 写法。
 * 浏览器 HTML 解析器对未知元素忽略自闭合斜杠，会把后续兄弟节点吞为子节点，
 * 导致 v-else 失去相邻 v-if（Vue compiler-30）→ 应用白板无法挂载。
 * 历史事故：2026-08-15 白板 bug（HANDOFF 坑 6 的翻版）。
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const re = /<(el-[a-z-]+)\b[^>]*\/\s*>/g;
let m, failed = 0;
while ((m = re.exec(html)) !== null) {
  failed++;
  const line = html.slice(0, m.index).split('\n').length;
  console.log(`  [FAIL] 自闭合自定义元素 <${m[1]} /> 出现在第 ${line} 行，请改为 ></${m[1]}>`);
}
if (!failed) {
  console.log('  [PASS] 无自闭合自定义元素（el-* 均已显式闭合）');
} else {
  process.exit(1);
}
