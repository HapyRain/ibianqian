/**
 * 任务清单 - 主题定义（10 套成品主题 + CSS 生成器）
 * 应用（index.html/app.js）与调色台（tuner.html）共用。
 *
 * 配色依据（行业护眼规范）：
 * - 浅色系：暖灰/米白纸面，绝不用纯白 #FFF 铺底，文字绝不用纯黑（参考 Solarized #fdf6e3 系）
 * - 深色系：绝不纯黑底，采用程序员暗色标配 One Dark（#282c34）与 GitHub Dark（#0d1117）色板
 * - 模块层次：行/面板带分层阴影 + 可见分隔线；按钮统一为「底色 + 边框 + 投影」明确可辨
 *
 * 每套主题：vars（CSS 变量）+ shadow（阴影强度 %）+ radius（行圆角）+ headerBg（头栏材质）+ dark（深色增强）
 * 选择结果存 localStorage('buglist_theme')，仅本机生效，不参与服务器同步。
 */
(function () {
  'use strict';

  // ⚠️ 主题方案待定：配色讨论后实装（功能保留，菜单暂不提供选择）。
  // 结构改进（行阴影/总分卡片/按钮可辨）已烙进 style.css 基础样式，不依赖主题。
  window.BUGLIST_THEMES = [];

  /**
   * 由主题对象生成完整 CSS（变量 + 结构性覆盖 + 深色增强）
   * @param {object} t BUGLIST_THEMES 中的一项
   * @returns {string}
   */
  window.buildThemeCss = function (t) {
    if (!t || !t.vars) return '';
    var s = (t.shadow || 100) / 100;
    var a = function (base) { return Math.min(1, +(base * s).toFixed(3)); };
    var v = t.vars;
    var headerBg = t.headerBg === 'mica' ? 'rgba(255,255,255,0.72)'
      : t.headerBg === 'surface' ? 'var(--surface)' : 'var(--surface-hi)';

    var css = ':root{';
    css += '--bg:' + v.bg + ';--surface:' + v.surface + ';--surface-hi:' + v['surface-hi'] + ';';
    css += '--line:' + v.line + ';--line-soft:' + v['line-soft'] + ';';
    css += '--text:' + v.text + ';--text-2:' + v['text-2'] + ';';
    css += '--primary:' + v.primary + ';--danger:' + v.danger + ';--ok:' + v.ok + ';--warn:' + v.warn + ';';
    css += '--shadow-card:0 1px 2px rgba(0,0,0,' + a(0.05) + '),0 2px 8px rgba(0,0,0,' + a(0.07) + '),0 0 0 1px rgba(0,0,0,' + a(0.03) + ');';
    css += '--shadow-hover:0 2px 5px rgba(0,0,0,' + a(0.06) + '),0 8px 22px rgba(0,0,0,' + a(0.12) + ');';
    css += '--shadow-dialog:0 0 0 1px rgba(0,0,0,' + a(0.05) + '),0 10px 30px rgba(0,0,0,' + a(0.15) + '),0 30px 70px rgba(0,0,0,' + a(0.11) + ');';
    css += '--radius:' + (t.radius || 11) + 'px;}';

    // 结构性覆盖 1：头栏材质 + 列表卡片（总分一体）+ 行阴影（模块层次关键）
    css += '.app-header,.task-tabs-bar{background:' + headerBg + ';border-color:var(--line)}';
    css += '.bug-panel{background:var(--surface);border-color:var(--line-soft);box-shadow:var(--shadow-card)}';
    css += '.search-bar{background:var(--surface-hi);border-color:var(--line-soft)}';
    css += '.bug-row{box-shadow:var(--shadow-card)}.bug-row:hover{box-shadow:var(--shadow-hover)}';
    css += '.bug-row-spotlight{box-shadow:0 0 0 4px rgba(255,255,255,.7),0 6px 22px rgba(0,0,0,.22) !important}';

    // 结构性覆盖 2：按钮可辨（底色 + 边框 + 投影，与纯文本拉开层次）
    css += '.btn-upload,.btn-note,.theme-btn,.shot-add{background:var(--surface-hi);border-color:var(--line);box-shadow:0 1px 2px rgba(0,0,0,' + a(0.05) + '),0 1px 3px rgba(0,0,0,' + a(0.06) + ')}';
    css += '.btn-upload:hover,.btn-note:hover,.theme-btn:hover{box-shadow:var(--shadow-hover)}';
    css += '.btn-add{box-shadow:0 2px 6px rgba(0,0,0,' + a(0.18) + ')}';
    css += '.status-select .el-select__wrapper{border:1px solid var(--line)}';

    // 深色主题：Element Plus 变量 + 硬编码浅色点位兜底
    if (t.dark) {
      css += ':root{';
      css += '--el-bg-color:' + v['surface-hi'] + ';--el-bg-color-overlay:' + v['surface-hi'] + ';';
      css += '--el-text-color-primary:' + v.text + ';--el-text-color-regular:' + v.text + ';--el-text-color-secondary:' + v['text-2'] + ';--el-text-color-placeholder:' + v['text-2'] + ';';
      css += '--el-border-color:rgba(255,255,255,.16);--el-border-color-light:rgba(255,255,255,.11);--el-border-color-lighter:rgba(255,255,255,.07);--el-border-color-extra-light:rgba(255,255,255,.05);';
      css += '--el-fill-color:rgba(255,255,255,.07);--el-fill-color-light:rgba(255,255,255,.1);--el-fill-color-lighter:rgba(255,255,255,.05);--el-fill-color-blank:' + v['surface-hi'] + ';';
      css += '--el-color-white:' + v.text + ';}';
      css += '.el-message{background:' + v['surface-hi'] + ' !important;border-color:' + v.line + ' !important;color:' + v.text + ' !important}';
      css += '.el-dialog{background:' + v['surface-hi'] + ' !important}.el-dialog__title{color:' + v.text + ' !important}';
      css += '.el-message-box{background:' + v['surface-hi'] + ' !important;color:' + v.text + ' !important}';
      css += '.pv-confirm-box{background:' + v['surface-hi'] + ';color:' + v.text + '}.pv-confirm-title{color:' + v.text + '}';
      css += '.img-stack-card,.note-stack-card{border-color:rgba(255,255,255,.22)}';
      css += '.pv-zoom{background:#191816}';
      css += '.btn-del{border-color:rgba(239,106,110,.55);background:rgba(239,106,110,.1)}';
      css += '.btn-del:hover{background:rgba(239,106,110,.18);box-shadow:0 3px 10px rgba(0,0,0,.4)}';
      css += '.theme-item:hover{background:rgba(255,255,255,.09)}.theme-item.active{background:rgba(97,175,239,.22)}';
      css += '.theme-popover{border-color:' + v.line + '}';
    }
    if (t.extra) css += t.extra;
    return css;
  };
})();
