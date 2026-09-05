/**
 * 任务清单 - 主题定义（10 套成品主题 + CSS 生成器）
 * 应用（index.html/app.js）与调色台（tuner.html）共用。
 *
 * 配色依据（行业护眼规范）：
 * - 浅色系：暖灰/米白纸面，绝不用纯白 #FFF 铺底，文字绝不用纯黑（参考 Solarized #fdf6e3 系）
 * - 深色系：绝不纯黑底，采用程序员暗色标配 One Dark（#282c34）与 GitHub Dark（#0d1117）色板
 * - 模块层次：行/面板带分层阴影 + 可见分隔线；按钮统一为「底色 + 边框 + 投影」明确可辨
 *
 * 主题=完整皮肤，拒绝割裂：
 * - vars 提供全部基础色（含状态三色 / 连接色 / 反白字），buildThemeCss 自动派生
 *   -rgb 三元组（rgba(var(--primary-rgb), .3)）与 color-mix 软色（--primary-soft 等），
 *   因此按钮、焦点环、删除蓄怒动画、状态胶囊、Element Plus 组件随主题整体联动；
 * - extra 提供主题专属元素（星空主题的星云与闪烁星星、羊皮纸噪点等），即"新玩法"；
 * - 功能与动效（FLIP 滑位 / 飞行 / 呼吸 / 扳手 / 充电）不依赖配色，全部常驻。
 *
 * 每套主题：id + name + desc + vars + shadow（阴影强度 %）+ radius（行圆角）
 *           + headerBg（头栏材质：mica 毛玻璃 / surface 面板色 / surface-hi 弹窗色）+ dark（深色增强）
 * 选择结果存 localStorage('buglist_theme')，仅本机生效，不参与服务器同步。
 *
 * 10 套设计稿由 10 位子 Agent 并行产出、程序化验收（对比度/纯白纯黑/字段合法性）后合入。
 */
(function () {
  'use strict';

  /* ---- 装饰皮肤生成器：多套主题的 extra 复用，产出的 CSS 与手写版逐字符一致 ---- */
  // 双层错位细点纸纹噪点（纯静态装饰）。rgb="r,g,b"，a1/a2=粗细两层点透明度，size=粗层间距 px（细层取其半），ox/oy=细层偏移 px，op=可选整体不透明度（字符串）
  function paperTexture(rgb, a1, a2, size, ox, oy, op) {
    return 'body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;' +
      'background-image:radial-gradient(rgba(' + rgb + ',' + a1 + ') 1px,transparent 1.1px),radial-gradient(rgba(' + rgb + ',' + a2 + ') 1px,transparent 1.15px);' +
      'background-size:' + size + 'px ' + size + 'px,' + size / 2 + 'px ' + size / 2 + 'px;background-position:0 0,' + ox + 'px ' + oy + 'px;background-attachment:fixed' +
      (op ? ';opacity:' + op : '') + '}' +
      '#app{position:relative;z-index:1}';
  }
  // 视口锚定霓虹网格背景
  function neonGrid(rgb, size) {
    return 'body{background-color:var(--bg);background-image:linear-gradient(' + rgb + ' 1px,transparent 1px),linear-gradient(90deg,' + rgb + ' 1px,transparent 1px);background-size:' + size + 'px ' + size + 'px;background-attachment:fixed}';
  }
  // 主按钮/火箭的霓虹主色 glow（纯装饰增强）。hoverA=主按钮 hover 光晕透明度，addBlur/addA/addB=次按钮光晕参数
  function neonGlow(hoverA, addBlur, addA, addB) {
    return '.btn-add-task{box-shadow:0 0 10px rgba(var(--primary-rgb),.35),0 2px 6px rgba(var(--primary-rgb),.25)}' +
      '.btn-add-task:hover{box-shadow:0 0 18px rgba(var(--primary-rgb),' + hoverA + '),0 4px 12px rgba(var(--primary-rgb),.3)}' +
      '.btn-add,.rocket-btn{box-shadow:0 0 ' + addBlur + 'px rgba(var(--primary-rgb),' + addA + '),0 6px 16px rgba(var(--primary-rgb),' + addB + ')}';
  }
  // 角落晨光/夜光（固定 900px 420px 椭圆、62% 处淡出）
  function cornerGlow(rgba, at) {
    return 'body{background-image:radial-gradient(900px 420px at ' + at + ',' + rgba + ',transparent 62%)}';
  }

  window.BUGLIST_THEMES = [
    /* ==================== 浅色 5 套 ==================== */
    {
      id: 'paper-warm',
      name: '暖纸面',
      desc: '默认主题：暖调米白纸面 + 靛蓝主色，与现网观感一致、老用户零感知',
      dark: false,
      headerBg: 'mica',
      shadow: 85,
      radius: 10,
      vars: {
        bg: '#EDEAE1', surface: '#F6F3EC', 'surface-hi': '#FFFDF6',
        line: '#DFDCCF', 'line-soft': '#E8E5DA',
        text: '#2A261E', 'text-2': '#8A8472', 'text-inverse': '#FFFDF6',
        primary: '#5E6AD2', danger: '#E5484D', ok: '#4CB782', warn: '#C9A227',
        'status-pending': '#8A8472', 'status-fixing': '#409EFF', 'status-done': '#2E9E6B',
        'ok-dot': '#34C77B', 'conn-ing': '#D9A23B'
      }
    },
    {
      id: 'paper-cool',
      name: '冷灰纸面',
      desc: 'GitHub Light 风格：三阶灰纸层次 + 细发丝线 + 清新蓝主色 · 轻微纸纹质感',
      dark: false,
      headerBg: 'mica',
      shadow: 98,
      radius: 10,
      extra:
        '/* 冷灰纸面：极淡纸纹噪点（两层错位细点，等效不透明度 <1%，纯静态装饰） */' + paperTexture('31,36,46', '.05', '.03', 26, 5, 8),
      vars: {
        bg: '#E8EBEF', surface: '#F4F6F9', 'surface-hi': '#FCFDFE',
        line: '#D8DDE3', 'line-soft': '#E7EBF0',
        text: '#1F242E', 'text-2': '#5B6472', 'text-inverse': '#F7F9FC',
        primary: '#0969DA', danger: '#D1242F', ok: '#1A7F37', warn: '#9A6700',
        'status-pending': '#B45309', 'status-fixing': '#0B72E6', 'status-done': '#1F883D',
        'ok-dot': '#1F9146', 'conn-ing': '#BF8700'
      }
    },
    {
      id: 'paper-green',
      name: '豆沙绿',
      desc: '低饱和护眼豆沙绿 · 轻微纸纹质感',
      dark: false,
      headerBg: 'surface-hi',
      shadow: 90,
      radius: 11,
      extra: paperTexture('46,74,51', '.05', '.035', 24, 6, 9, '.55'),
      vars: {
        bg: '#C7E8CB', surface: '#FCFCF7', 'surface-hi': '#EEF6F0',
        line: '#AFCEB6', 'line-soft': '#C5DDC9',
        text: '#2E4A33', 'text-2': '#5F7A64', 'text-inverse': '#F5F9F1',
        primary: '#569460', danger: '#C4554F', ok: '#4C9A5B', warn: '#A9711F',
        'status-pending': '#C07B2B', 'status-fixing': '#469494', 'status-done': '#478F52',
        'ok-dot': '#3F944B', 'conn-ing': '#D19A34'
      }
    },
    {
      id: 'paper-lilac',
      name: '晨雾淡紫',
      desc: '雾面低饱和淡紫灰底 · 紫罗兰主色 · 温柔克制',
      dark: false,
      headerBg: 'mica',
      shadow: 100,
      radius: 11,
      vars: {
        bg: '#E8E4F0', surface: '#F3F0F8', 'surface-hi': '#FAF8FD',
        line: '#D6CFE4', 'line-soft': '#E4DFEF',
        text: '#3F374E', 'text-2': '#6E6680', 'text-inverse': '#F8F5FD',
        primary: '#7C5CD6', danger: '#D1435F', ok: '#3E9C66', warn: '#D08A2F',
        'status-pending': '#CE4E68', 'status-fixing': '#C97F2D', 'status-done': '#468B5D',
        'ok-dot': '#3E9C66', 'conn-ing': '#D08A2F'
      }
    },
    {
      id: 'paper-parchment',
      name: '羊皮纸',
      desc: 'Solarized light 暖黄羊皮纸面 · 复古纸纹噪点背板',
      dark: false,
      headerBg: 'surface-hi',
      shadow: 92,
      radius: 12,
      extra:
        'body{background-color:#F8F1E3;background-image:linear-gradient(180deg,#F9F2E4 0%,#F4EBD9 55%,#EFE3CC 100%);background-attachment:fixed}' +
        'body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.06;' +
        'background-image:radial-gradient(rgba(101,123,131,.35) .55px,transparent .75px),radial-gradient(rgba(181,137,0,.20) .45px,transparent .65px);' +
        'background-size:6px 6px,9px 9px;background-position:0 0,3px 4px;background-repeat:repeat;background-attachment:fixed}' +
        'body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;' +
        'background-image:radial-gradient(ellipse at 50% 32%,transparent 58%,rgba(88,110,117,.05) 100%)}' +
        '#app{position:relative;z-index:1}',
      vars: {
        bg: '#F8F1E3', surface: '#FDF6E3', 'surface-hi': '#FFF9EA',
        line: '#E4DCC4', 'line-soft': '#EEE8D5',
        text: '#586E75', 'text-2': '#657B83', 'text-inverse': '#FDF6E3',
        primary: '#268BD2', danger: '#DC322F', ok: '#859900', warn: '#B58900',
        'status-pending': '#CB4B16', 'status-fixing': '#B58900', 'status-done': '#859900',
        'ok-dot': '#859900', 'conn-ing': '#B58900'
      }
    },
    {
      id: 'paper-sakura',
      name: '樱粉晨雾',
      desc: '樱花粉雾面 · 蔷薇粉主色 · 唯美温柔',
      dark: false,
      headerBg: 'mica',
      shadow: 95,
      radius: 12,
      extra:
        '/* 樱粉晨雾：右上角极淡粉色晨光 */' + cornerGlow('rgba(217,95,139,.07)', '82% -8%'),
      vars: {
        bg: '#F7E8EE', surface: '#FBF1F5', 'surface-hi': '#FEF8FA',
        line: '#F0DCE4', 'line-soft': '#F5E6EC',
        text: '#4A2E3A', 'text-2': '#8F6B7C', 'text-inverse': '#FEF6F9',
        primary: '#D95F8B', danger: '#C94F6D', ok: '#6FA887', warn: '#C08A4E',
        'status-pending': '#A98AA0', 'status-fixing': '#D95F8B', 'status-done': '#6FA887',
        'ok-dot': '#6FA887', 'conn-ing': '#C08A4E'
      }
    },
    /* ==================== 深色 5 套 ==================== */
    {
      id: 'dark-ondark',
      name: 'One Dark',
      desc: 'Atom One Dark 程序员暗色 · 经典 #282C34 系',
      dark: true,
      headerBg: 'surface-hi',
      shadow: 124,
      radius: 10,
      vars: {
        bg: '#282C34', surface: '#2F343D', 'surface-hi': '#3B4049',
        line: '#3E4451', 'line-soft': '#353B45',
        text: '#ABB2BF', 'text-2': '#828997', 'text-inverse': '#14283C',
        primary: '#61AFEF', danger: '#E06C75', ok: '#98C379', warn: '#E5C07B',
        'status-pending': '#D19A66', 'status-fixing': '#56B6C2', 'status-done': '#98C379',
        'ok-dot': '#98C379', 'conn-ing': '#E5C07B'
      }
    },
    {
      id: 'dark-github',
      name: 'GitHub Dark',
      desc: 'GitHub Dark 高对比暗色（经典 #0d1117 系）',
      dark: true,
      headerBg: 'surface-hi',
      shadow: 140,
      radius: 10,
      vars: {
        bg: '#0D1117', surface: '#161B22', 'surface-hi': '#21262D',
        line: '#30363D', 'line-soft': '#21262D',
        text: '#E6EDF3', 'text-2': '#8B949E', 'text-inverse': '#0D1117',
        primary: '#4493F8', danger: '#F85149', ok: '#3FB950', warn: '#D29922',
        'status-pending': '#F85149', 'status-fixing': '#D29922', 'status-done': '#3FB950',
        'ok-dot': '#3FB950', 'conn-ing': '#D29922'
      }
    },
    {
      id: 'dark-ember',
      name: '暖棕夜灯',
      desc: '深可可棕夜底 + 琥珀金主色 · 深夜台灯下的静谧氛围',
      dark: true,
      headerBg: 'surface-hi',
      shadow: 125,
      radius: 10,
      extra:
        'body::before{content:"";position:fixed;top:0;right:0;width:64vw;height:64vh;z-index:0;pointer-events:none;' +
        'background:radial-gradient(120% 100% at 100% 0%,rgba(232,162,60,.10) 0%,rgba(232,162,60,.04) 42%,rgba(232,162,60,0) 70%)}' +
        '#app{position:relative;z-index:1}',
      vars: {
        bg: '#282019', surface: '#33271C', 'surface-hi': '#3D2E21',
        line: '#4A3926', 'line-soft': '#3C2D1F',
        text: '#F3E9D7', 'text-2': '#C9B9A4', 'text-inverse': '#2A1C0F',
        primary: '#E8A23C', danger: '#E05C4A', ok: '#93BD66', warn: '#E9BD4B',
        'status-pending': '#C97F4A', 'status-fixing': '#EFAF4D', 'status-done': '#7FA954',
        'ok-dot': '#9BC469', 'conn-ing': '#F0B14E'
      }
    },
    {
      id: 'dark-star',
      name: '星空蓝',
      desc: '深空蓝紫星云底 + 双层闪烁星光 + 偶尔流星 · 毛玻璃卡片 · 沉浸式深色主题',
      dark: true,
      headerBg: 'surface-hi',
      shadow: 150,
      radius: 12,
      extra:
        '/* 深空星云背景（纯装饰，不遮内容） */' +
        'body{background-color:var(--bg);' +
        'background-image:' +
        'radial-gradient(ellipse 55% 42% at 16% 8%,rgba(96,124,255,.14) 0%,rgba(96,124,255,0) 62%),' +
        'radial-gradient(ellipse 58% 46% at 84% 92%,rgba(140,96,255,.12) 0%,rgba(140,96,255,0) 60%),' +
        'linear-gradient(180deg,rgba(255,255,255,0) 0%,rgba(36,50,132,.16) 42%,rgba(255,255,255,0) 100%)}' +
        '/* 双层星光：仅透明度闪烁（柔和小幅），禁止位移动画（防页面抖动）；显式 no-repeat 防平铺 */' +
        '@keyframes dstarTwinkleA{from{opacity:.6}to{opacity:.92}}' +
        '@keyframes dstarTwinkleB{from{opacity:.9}to{opacity:.5}}' +
        'body::before,body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background-repeat:no-repeat}' +
        'body::before{' +
        'background-image:' +
        'radial-gradient(circle at 6% 15%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 2px),' +
        'radial-gradient(circle at 15% 68%,rgba(255,255,255,.35) 0%,rgba(255,255,255,0) 1.5px),' +
        'radial-gradient(circle at 23% 34%,rgba(255,255,255,.45) 0%,rgba(255,255,255,0) 2.4px),' +
        'radial-gradient(circle at 38% 9%,rgba(255,255,255,.4) 0%,rgba(255,255,255,0) 1.8px),' +
        'radial-gradient(circle at 47% 55%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 2.2px),' +
        'radial-gradient(circle at 63% 78%,rgba(255,255,255,.4) 0%,rgba(255,255,255,0) 1.6px),' +
        'radial-gradient(circle at 71% 42%,rgba(255,255,255,.35) 0%,rgba(255,255,255,0) 1.5px),' +
        'radial-gradient(circle at 79% 12%,rgba(255,255,255,.55) 0%,rgba(255,255,255,0) 2px),' +
        'radial-gradient(circle at 87% 60%,rgba(255,255,255,.4) 0%,rgba(255,255,255,0) 1.7px),' +
        'radial-gradient(circle at 94% 30%,rgba(255,255,255,.45) 0%,rgba(255,255,255,0) 1.9px);' +
        'animation:dstarTwinkleA 5.2s ease-in-out infinite alternate}' +
        'body::after{' +
        'background-image:' +
        'radial-gradient(circle at 12% 40%,rgba(255,255,255,.45) 0%,rgba(255,255,255,0) 1.8px),' +
        'radial-gradient(circle at 28% 12%,rgba(255,255,255,.4) 0%,rgba(255,255,255,0) 1.6px),' +
        'radial-gradient(circle at 36% 62%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 2.2px),' +
        'radial-gradient(circle at 52% 80%,rgba(255,255,255,.4) 0%,rgba(255,255,255,0) 1.7px),' +
        'radial-gradient(circle at 60% 8%,rgba(255,255,255,.35) 0%,rgba(255,255,255,0) 1.5px),' +
        'radial-gradient(circle at 68% 48%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 2px),' +
        'radial-gradient(circle at 76% 88%,rgba(255,255,255,.4) 0%,rgba(255,255,255,0) 1.6px),' +
        'radial-gradient(circle at 92% 55%,rgba(255,255,255,.45) 0%,rgba(255,255,255,0) 1.8px);' +
        'animation:dstarTwinkleB 6s ease-in-out -3s infinite alternate}' +
        '#app{position:relative;z-index:1}' +
        '/* 流星：偶尔从右上划向左下（9s 周期，前 7.2s 隐藏，短暂划过、淡光不抢戏） */' +
        '#app::before{content:"";position:fixed;top:12%;left:105%;width:230px;height:1.5px;z-index:-1;pointer-events:none;opacity:0;' +
        'background:linear-gradient(90deg,transparent 0%,rgba(185,205,255,.75) 60%,rgba(255,255,255,.95) 100%);' +
        'border-radius:2px;filter:drop-shadow(0 0 5px rgba(150,185,255,.5));' +
        'animation:dstarMeteor 9s linear infinite}' +
        '@keyframes dstarMeteor{0%,80%{transform:translate3d(0,0,0) rotate(-30deg);opacity:0}' +
        '84%{transform:translate3d(0,0,0) rotate(-30deg);opacity:.8}' +
        '95%{transform:translate3d(-135vw,76vh,0) rotate(-30deg);opacity:.25}' +
        '100%{transform:translate3d(-135vw,76vh,0) rotate(-30deg);opacity:0}}' +
        '/* 卡片毛玻璃：星光透过隐约可见 */' +
        '.app-header,.task-tabs-bar,.bug-panel,.search-bar{background:color-mix(in srgb,var(--surface-hi) 85%,transparent);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5)}' +
        '.bug-row{background:color-mix(in srgb,var(--surface) 90%,transparent)}' +
        '.bug-row:hover{background:color-mix(in srgb,var(--surface-hi) 90%,transparent)}',
      vars: {
        bg: '#0B1026', surface: '#131B42', 'surface-hi': '#1D275C',
        line: '#2C3770', 'line-soft': '#232C5C',
        text: '#E9EDFF', 'text-2': '#A5B0E3', 'text-inverse': '#0A1030',
        primary: '#6FA8FF', danger: '#FF6B7A', ok: '#3ED598', warn: '#FFC24D',
        'status-pending': '#F0B54E', 'status-fixing': '#7FB8FF', 'status-done': '#3ED598',
        'ok-dot': '#45E2A4', 'conn-ing': '#FFB84D'
      }
    },
    {
      id: 'dark-rose',
      name: '蔷薇暮色',
      desc: '深蔷薇粉夜 · 玫瑰金主色 · 暮色温柔',
      dark: true,
      headerBg: 'surface-hi',
      shadow: 120,
      radius: 12,
      extra:
        '/* 蔷薇暮色：左上角极淡玫瑰金夜光 */' + cornerGlow('rgba(244,143,177,.08)', '18% -6%'),
      vars: {
        bg: '#2A1620', surface: '#33202C', 'surface-hi': '#3D2A37',
        line: '#4A3140', 'line-soft': '#382432',
        text: '#F0DDE6', 'text-2': '#B395A5', 'text-inverse': '#240E18',
        primary: '#F48FB1', danger: '#E57373', ok: '#81C784', warn: '#FFD54F',
        'status-pending': '#C9A0B8', 'status-fixing': '#F48FB1', 'status-done': '#81C784',
        'ok-dot': '#81C784', 'conn-ing': '#FFD54F'
      }
    },
    {
      id: 'dark-cyber',
      name: '赛博朋克',
      desc: '霓虹青品红 · 网格光晕 · 未来感',
      dark: true,
      headerBg: 'surface-hi',
      shadow: 160,
      radius: 10,
      extra:
        '/* 赛博朋克：淡青网格线（视口锚定）+ 霓虹 glow（纯装饰） */' +
        neonGrid('rgba(0,229,255,.045)', 44) + neonGlow('.55', 14, '.45', '.35') +
        '.task-tab-active{box-shadow:0 0 12px rgba(var(--primary-rgb),.45)}',
      vars: {
        bg: '#0A0A12', surface: '#131322', 'surface-hi': '#1D1D33',
        line: '#2C2C4E', 'line-soft': '#1A1A2E',
        text: '#E0E6FF', 'text-2': '#8B93C7', 'text-inverse': '#070714',
        primary: '#00E5FF', danger: '#FF2E63', ok: '#00FF9D', warn: '#FFD500',
        'status-pending': '#9D8CFF', 'status-fixing': '#00E5FF', 'status-done': '#00FF9D',
        'ok-dot': '#00FF9D', 'conn-ing': '#FFD500'
      }
    },
    {
      id: 'dark-matrix',
      name: '黑客帝国',
      desc: '矩阵代码雨 · 霓虹绿 · 深绿黑底',
      dark: true,
      headerBg: 'surface-hi',
      shadow: 150,
      radius: 10,
      extra:
        '/* 黑客帝国：淡网格 + 三列代码雨（不同速度/位置/透明度，纯装饰不挡操作） */' +
        neonGrid('rgba(0,230,118,.04)', 40) +
        '@keyframes dmatrixRain{0%{transform:translateY(-100%)}100%{transform:translateY(100vh)}}' +
        'body::before,body::after,#app::before{content:"01010\\a 11001\\a 00110\\a 10100\\a 01101\\a 10010\\a 01011\\a 00101\\a 11000\\a 10110\\a 01100\\a 10001";position:fixed;top:0;font:12px/1.5 monospace;white-space:pre;z-index:0;pointer-events:none;animation:dmatrixRain 12s linear infinite}' +
        'body::before{left:6%;color:rgba(0,255,65,.3)}' +
        'body::after{left:40%;color:rgba(0,255,65,.2);content:"10101\\a 01010\\a 11001\\a 00111\\a 10010\\a 01100\\a 10100\\a 01011\\a 11010\\a 00101\\a 11100\\a 01001";animation-duration:17s;animation-delay:-11s}' +
        '#app{position:relative;z-index:1}' +
        '#app::before{left:74%;color:rgba(0,255,65,.16);animation-duration:22s;animation-delay:-6s}' +
        '/* 霓虹绿 glow：主按钮/火箭 */' + neonGlow('.5', 12, '.4', '.3'),
      vars: {
        bg: '#0A120A', surface: '#0F1A0F', 'surface-hi': '#16261A',
        line: '#1F3A26', 'line-soft': '#14261A',
        text: '#C8F5D0', 'text-2': '#7FAE8A', 'text-inverse': '#06130A',
        primary: '#00E676', danger: '#FF6B5E', ok: '#00C853', warn: '#E6C44A',
        'status-pending': '#9BC49A', 'status-fixing': '#4DE38C', 'status-done': '#00C853',
        'ok-dot': '#00E676', 'conn-ing': '#E6C44A'
      }
    }
  ];

  /**
   * #RRGGBB → [h, s, l]（h∈[0,360), s/l∈[0,100]）
   */
  function hexToHsl(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }

  /**
   * [h, s, l] → #RRGGBB
   */
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    var to = function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, '0'); };
    return '#' + to(r) + to(g) + to(b);
  }

  /**
   * 由主题主色派生 6 个「主题和谐强调色」（负责人 hover 标签 / 备注作者色点共用色板）：
   * 保持主色的亮度、饱和度压到 ≤70%（避免高饱和主色旋转出荧光感），色相围绕主色旋转错开；
   * 保证同一主题内多人颜色可辨、整体柔和随主题联动（不再全局固定一套色）。
   */
  function deriveNotePalette(primaryHex) {
    var hsl = hexToHsl(primaryHex);
    var h = hsl[0], s = Math.min(hsl[1], 70), l = hsl[2];
    var offsets = [0, -48, 48, -100, 100, 165];
    return offsets.map(function (off) {
      return hslToHex(h + off, s, l);
    });
  }

  /**
   * #RRGGBB → "r,g,b" 逗号三元组（供 rgba(var(--xxx-rgb), a) 使用）
   */
  function rgbTriplet(hex) {
    var n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  /** 供 app.js 在主题切换时同步派生 JS 侧色板（负责人/备注强调色的唯一来源） */
  window.deriveNotePalette = deriveNotePalette;

  /**
   * 由主题对象生成完整 CSS（变量 + 派生色 + Element Plus 联动 + 结构性覆盖 + 深色增强 + extra）
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

    /* ---- 基础变量 ---- */
    var css = ':root{';
    css += '--bg:' + v.bg + ';--surface:' + v.surface + ';--surface-hi:' + v['surface-hi'] + ';';
    css += '--line:' + v.line + ';--line-soft:' + v['line-soft'] + ';';
    css += '--text:' + v.text + ';--text-2:' + v['text-2'] + ';--text-inverse:' + (v['text-inverse'] || '#FFFDF6') + ';';
    css += '--primary:' + v.primary + ';--danger:' + v.danger + ';--ok:' + v.ok + ';--warn:' + v.warn + ';';
    css += '--status-pending:' + v['status-pending'] + ';--status-fixing:' + v['status-fixing'] + ';--status-done:' + v['status-done'] + ';';
    css += '--ok-dot:' + (v['ok-dot'] || v.ok) + ';--conn-ing:' + (v['conn-ing'] || v.warn) + ';';

    /* ---- 自动派生的 rgb 三元组（rgba(var(--xxx-rgb), a) 用法） ---- */
    css += '--primary-rgb:' + rgbTriplet(v.primary) + ';--danger-rgb:' + rgbTriplet(v.danger) + ';';
    css += '--text-rgb:' + rgbTriplet(v.text) + ';';
    css += '--status-pending-rgb:' + rgbTriplet(v['status-pending']) + ';--status-fixing-rgb:' + rgbTriplet(v['status-fixing']) + ';--status-done-rgb:' + rgbTriplet(v['status-done']) + ';';
    css += '--ok-dot-rgb:' + rgbTriplet(v['ok-dot'] || v.ok) + ';--conn-ing-rgb:' + rgbTriplet(v['conn-ing'] || v.warn) + ';';

    /* ---- color-mix 软色（淡化底 / 描边 / 加深，主题联动） ---- */
    css += '--primary-soft:color-mix(in srgb,var(--primary) 13%,var(--surface));';
    css += '--primary-line:color-mix(in srgb,var(--primary) 22%,transparent);';
    css += '--primary-deep:color-mix(in srgb,var(--primary) 82%,#000);';
    css += '--danger-soft:color-mix(in srgb,var(--danger) 9%,var(--surface-hi));';
    css += '--danger-line:color-mix(in srgb,var(--danger) 30%,transparent);';
    css += '--warn-soft:color-mix(in srgb,var(--warn) 16%,var(--surface));';
    css += '--warn-line:color-mix(in srgb,var(--warn) 32%,transparent);';
    css += '--warn-deep:color-mix(in srgb,var(--warn) 45%,var(--text));';
    css += '--shadow-card:0 1px 2px rgba(0,0,0,' + a(0.05) + '),0 2px 8px rgba(0,0,0,' + a(0.07) + '),0 0 0 1px rgba(0,0,0,' + a(0.03) + ');';
    css += '--shadow-hover:0 2px 5px rgba(0,0,0,' + a(0.06) + '),0 8px 22px rgba(0,0,0,' + a(0.12) + ');';
    css += '--shadow-dialog:0 0 0 1px rgba(0,0,0,' + a(0.05) + '),0 10px 30px rgba(0,0,0,' + a(0.15) + '),0 30px 70px rgba(0,0,0,' + a(0.11) + ');';
    css += '--radius:' + (t.radius || 11) + 'px;}';

    /* ---- 强制页面背景（确定性优先）：直接写具体色值，不依赖 style.css 的 var(--bg) 链路 ---- */
    css += 'html,body{background-color:' + v.bg + '}';

    /* ---- Element Plus 变量联动（主色/底色/文字随主题，深浅差异在边框填充方向） ---- */
    css += ':root{';
    css += '--el-bg-color:' + v['surface-hi'] + ';--el-bg-color-overlay:' + v['surface-hi'] + ';';
    css += '--el-text-color-primary:' + v.text + ';--el-text-color-regular:' + v.text + ';--el-text-color-secondary:' + v['text-2'] + ';--el-text-color-placeholder:' + v['text-2'] + ';';
    css += (t.dark
      ? '--el-border-color:rgba(255,255,255,.16);--el-border-color-light:rgba(255,255,255,.11);--el-border-color-lighter:rgba(255,255,255,.07);--el-border-color-extra-light:rgba(255,255,255,.05);'
      : '--el-border-color:rgba(0,0,0,.10);--el-border-color-light:rgba(0,0,0,.07);--el-border-color-lighter:rgba(0,0,0,.05);--el-border-color-extra-light:rgba(0,0,0,.03);');
    css += (t.dark
      ? '--el-fill-color:rgba(255,255,255,.07);--el-fill-color-light:rgba(255,255,255,.10);--el-fill-color-lighter:rgba(255,255,255,.05);'
      : '--el-fill-color:rgba(0,0,0,.04);--el-fill-color-light:rgba(0,0,0,.05);--el-fill-color-lighter:rgba(0,0,0,.03);');
    css += '--el-fill-color-blank:' + v['surface-hi'] + ';';
    css += '--el-color-primary:' + v.primary + ';';
    css += '--el-color-primary-light-3:color-mix(in srgb,var(--primary) 30%,var(--surface-hi));';
    css += '--el-color-primary-light-5:color-mix(in srgb,var(--primary) 50%,var(--surface-hi));';
    css += '--el-color-primary-light-7:color-mix(in srgb,var(--primary) 70%,var(--surface-hi));';
    css += '--el-color-primary-light-8:color-mix(in srgb,var(--primary) 80%,var(--surface-hi));';
    css += '--el-color-primary-light-9:color-mix(in srgb,var(--primary) 90%,var(--surface-hi));';
    css += '--el-color-primary-dark-2:var(--primary-deep);';
    css += '--el-color-danger:' + v.danger + ';--el-color-success:' + v.ok + ';--el-color-warning:' + v.warn + ';--el-color-info:' + v['text-2'] + ';';
    css += (t.dark ? '--el-color-white:' + v.text + ';' : '--el-color-white:#fff;');
    css += '--el-color-black:' + (t.dark ? '#fff' : '#000') + ';}';

    /* ---- 结构性覆盖 1：头栏材质 + 列表卡片（总分一体）+ 行阴影（模块层次关键） ---- */
    css += '.app-header,.task-tabs-bar{background:' + headerBg + ';border-color:var(--line)}';
    css += '.bug-panel{background:var(--surface);border-color:var(--line-soft);box-shadow:var(--shadow-card)}';
    css += '.search-bar{background:var(--surface-hi);border-color:var(--line-soft)}';
    css += '.bug-row{box-shadow:var(--shadow-card)}.bug-row:hover{box-shadow:var(--shadow-hover)}';
    css += '.bug-row-spotlight{box-shadow:0 0 0 4px rgba(255,255,255,.7),0 6px 22px rgba(0,0,0,.22) !important}';

    /* ---- 结构性覆盖 2：按钮可辨（底色 + 边框 + 投影，与纯文本拉开层次） ---- */
    css += '.btn-upload,.btn-note,.theme-btn,.shot-add{background:var(--surface-hi);border-color:var(--line);box-shadow:0 1px 2px rgba(0,0,0,' + a(0.05) + '),0 1px 3px rgba(0,0,0,' + a(0.06) + ')}';
    css += '.btn-upload:hover,.btn-note:hover,.theme-btn:hover{box-shadow:var(--shadow-hover)}';
    css += '.btn-add,.btn-add-task{box-shadow:0 2px 6px rgba(var(--primary-rgb),' + a(0.22) + ')}';
    css += '.status-select .el-select__wrapper{border:1px solid var(--line)}';

    /* ---- 深色主题增强：Element Plus 深色点位 + 硬编码浅色点位兜底 ---- */
    if (t.dark) {
      css += '.el-message{background:' + v['surface-hi'] + ' !important;border-color:' + v.line + ' !important;color:' + v.text + ' !important}';
      css += '.el-dialog{background:' + v['surface-hi'] + ' !important}.el-dialog__title{color:' + v.text + ' !important}';
      css += '.el-message-box{background:' + v['surface-hi'] + ' !important;color:' + v.text + ' !important}';
      css += '.pv-confirm-box{background:' + v['surface-hi'] + ';color:' + v.text + '}.pv-confirm-title{color:' + v.text + '}';
      css += '.img-stack-card,.note-stack-card{border-color:rgba(255,255,255,.22)}';
      css += '.pv-zoom{background:#191816}';
      css += '.btn-del{border-color:var(--danger-line);background:var(--danger-soft)}';
      css += '.btn-del:hover{background:color-mix(in srgb,var(--danger) 16%,var(--surface-hi));box-shadow:0 3px 10px rgba(var(--danger-rgb),' + a(0.25) + '),0 0 0 3px rgba(var(--danger-rgb),' + a(0.08) + ')}';
      css += '.theme-item:hover{background:rgba(255,255,255,.09)}.theme-item.active{background:rgba(var(--primary-rgb),.22)}';
      css += '.theme-popover{border-color:' + v.line + '}';
      /* 中性黑硬编码点位 → 深色下转白 */
      css += '.filter-buttons .el-button:not(.el-button--primary){background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);color:var(--text-2)}';
      css += '.el-button--default{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16)}.el-button--default:hover{background:rgba(255,255,255,.1) !important;border-color:rgba(255,255,255,.22) !important}';
      css += '.name-text:hover{background:rgba(255,255,255,.07)}';
      css += '.status-select .el-select__wrapper{background:rgba(255,255,255,.05)}.status-select .el-select__wrapper:hover{background:rgba(255,255,255,.09)}';
      css += '.task-tab:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12)}';
      css += '::-webkit-scrollbar-thumb{background-color:rgba(255,255,255,.16)}::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.28)}';
      css += '*{scrollbar-color:rgba(255,255,255,.16) transparent}';
    }
    if (t.extra) css += t.extra;
    return css;
  };
})();
