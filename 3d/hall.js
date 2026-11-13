/* 东坡 · 苏轼诗词展 · 3D 展厅
   轻量实现：低面数几何 + Canvas 程序化纹理 + 假光照，无实时阴影 / 无后处理。 */
(function () {
  'use strict';

  var DATA = window.HALL_DATA;
  if (!DATA) return;

  var CH = {};
  DATA.chapters.forEach(function (c) { CH[c.id] = c; });
  var EX = {};
  DATA.exhibits.forEach(function (e) { EX[e.id] = e; });

  var SERIF = '"Songti SC","STSong","Noto Serif CJK SC","Source Han Serif SC","Source Han Serif CN","SimSun",serif';
  var SANS = '"PingFang SC","Hiragino Sans GB","Helvetica Neue",sans-serif';
  var PUNCT = '，。？！；、：';

  /* ---------- 空间参数 ---------- */
  var R = 13;                                  // 外接圆半径
  var APOTHEM = R * Math.cos(Math.PI / 8);     // 墙面到中心的距离
  var SIDE = 2 * R * Math.sin(Math.PI / 8);    // 单面墙宽
  var WALL_H = 7;
  var EYE = 1.66;
  var PLAYER_R = 0.42;
  var KEEP_OUT = 3.15;

  var BAYS = [
    { chapter: 'prologue', exhibits: ['e01'], intro: true },
    { chapter: 'ch1', exhibits: ['e02', 'e03'] },
    { chapter: 'ch1', exhibits: ['e04', 'e05'] },
    { chapter: 'ch2', exhibits: ['e06', 'e07', 'e08'] },
    { chapter: 'ch2', exhibits: ['e09', 'e10'] },
    { chapter: 'ch2', exhibits: ['e11', 'e12'] },
    { chapter: 'ch3', exhibits: ['e13', 'e14'] },
    { chapter: 'ch4', exhibits: ['e15', 'e16'] }
  ];

  /* ---------- DOM ---------- */
  var canvas = document.getElementById('hall');
  var $id = function (id) { return document.getElementById(id); };
  var startEl = $id('start');
  var readerEl = $id('reader');
  var drawerEl = $id('drawer');
  var helpEl = $id('help');
  var promptEl = $id('prompt');
  var promptTitle = $id('promptTitle');
  var promptMeta = $id('promptMeta');
  var reticleEl = $id('reticle');
  var hintEl = $id('hint');
  var fallbackTip = $id('fallbackTip');
  var flatEl = $id('flat');
  var flatNav = $id('flatNav');
  var flatArticle = $id('flatArticle');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (isTouch) document.body.classList.add('touch');

  /* ---------- WebGL ---------- */
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    renderer = null;
  }
  if (!renderer) {
    fallbackTip.hidden = false;
    buildFlat();
    enterFlat();
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = false;

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1215);
  scene.fog = new THREE.Fog(0x11171a, 22, 56);

  var camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 80);
  camera.rotation.order = 'YXZ';

  /* ---------- 纹理工具 ---------- */
  var maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
  }
  function tex(c) {
    var t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = maxAniso;
    return t;
  }
  function speckle(ctx, w, h, n, rgb, aMax) {
    for (var i = 0; i < n; i++) {
      ctx.fillStyle = 'rgba(' + rgb + ',' + (Math.random() * aMax).toFixed(3) + ')';
      var s = 0.4 + Math.random() * 1.5;
      ctx.fillRect(Math.random() * w, Math.random() * h, s, s);
    }
  }
  function hex2rgb(hex) {
    var n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function chapterGlow(id, alpha) {
    var rgb = hex2rgb(CH[id].ambient);
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
  }
  function drawSpaced(ctx, text, cx, y, size, spacing, color, font) {
    ctx.save();
    ctx.font = size + 'px ' + (font || SERIF);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var chars = Array.from(text);
    var total = 0, i, w;
    for (i = 0; i < chars.length; i++) total += ctx.measureText(chars[i]).width + spacing;
    total -= spacing;
    var x = cx - total / 2;
    for (i = 0; i < chars.length; i++) {
      w = ctx.measureText(chars[i]).width;
      ctx.fillText(chars[i], x, y);
      x += w + spacing;
    }
    ctx.restore();
  }
  function drawVert(ctx, text, x, top, size, color, gap) {
    ctx.save();
    ctx.font = size + 'px ' + SERIF;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var y = top;
    var chars = Array.from(text);
    for (var i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], x, y);
      y += size * (gap || 1.05);
    }
    ctx.restore();
    return y;
  }
  function clauses(line) {
    var out = [], buf = '';
    Array.from(line).forEach(function (ch) {
      if (PUNCT.indexOf(ch) >= 0) { buf += ch; out.push(buf); buf = ''; }
      else buf += ch;
    });
    if (buf) out.push(buf);
    return out;
  }
  function wrapCJK(ctx, text, maxW) {
    var lines = [], cur = '';
    Array.from(text).forEach(function (ch) {
      if (ch === '\n') { lines.push(cur); cur = ''; return; }
      if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; }
      else cur += ch;
    });
    if (cur) lines.push(cur);
    return lines;
  }

  /* ---------- 展品挂轴 ---------- */
  function panelTexture(item) {
    var W = 512, H = 896;
    var nc = newCanvas(W, H), c = nc[0], ctx = nc[1];

    var bg = ctx.createLinearGradient(0, 0, W * 0.35, H);
    bg.addColorStop(0, '#f2ebdc');
    bg.addColorStop(0.5, '#e9e1cf');
    bg.addColorStop(1, '#dbd1bc');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    var stain = ctx.createRadialGradient(W * 0.32, H * 0.18, 10, W * 0.32, H * 0.18, W * 0.8);
    stain.addColorStop(0, 'rgba(168,148,108,.10)');
    stain.addColorStop(1, 'rgba(168,148,108,0)');
    ctx.fillStyle = stain;
    ctx.fillRect(0, 0, W, H);

    var wash = ctx.createRadialGradient(W * 0.56, H * 0.42, 20, W * 0.56, H * 0.42, W * 0.62);
    wash.addColorStop(0, 'rgba(92,96,94,.075)');
    wash.addColorStop(1, 'rgba(92,96,94,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);

    speckle(ctx, W, H, 900, '90,84,68', 0.05);

    ctx.strokeStyle = 'rgba(210,174,110,.85)';
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, W - 36, H - 36);
    ctx.strokeStyle = 'rgba(255,235,192,.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(24, 24, W - 48, H - 48);
    ctx.strokeStyle = 'rgba(146,118,76,.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(31, 31, W - 62, H - 62);

    var title = item.title + (item.subtitle ? '·' + item.subtitle : '');
    var tChars = Array.from(title);
    var tSize = tChars.length > 13 ? 32 : (tChars.length > 9 ? 38 : 46);
    var tTop = 126;
    var tX = W - 78;
    ctx.fillStyle = 'rgba(146,118,76,.28)';
    ctx.fillRect(W - 114, tTop - 30, 1, tChars.length * tSize * 1.06 + 40);
    drawVert(ctx, title, tX, tTop, tSize, '#23262a');

    var cols = [];
    item.snippet.forEach(function (ln) {
      clauses(ln).forEach(function (cl) { cols.push(cl); });
    });
    if (cols.length > 6) cols = cols.slice(0, 6);
    var colSize = cols.length >= 6 ? 30 : 34;
    var step = cols.length >= 6 ? 48 : 52;
    var startX = W - 154;
    for (var i = 0; i < cols.length; i++) {
      drawVert(ctx, cols[i], startX - i * step, 138, colSize, '#2c2e31');
    }

    ctx.fillStyle = 'rgba(168,58,44,.88)';
    ctx.fillRect(52, H - 132, 46, 46);
    ctx.fillStyle = '#f3e7d3';
    ctx.font = '19px ' + SERIF;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('東', 75, H - 108);
    ctx.fillText('坡', 75, H - 86);

    ctx.fillStyle = 'rgba(122,102,72,.32)';
    ctx.font = '18px ' + SANS;
    ctx.textAlign = 'right';
    ctx.fillText('No. ' + item.no, W - 44, H - 46);

    return tex(c);
  }

  function plaqueTexture(item, chapter) {
    var W = 512, H = 144;
    var nc = newCanvas(W, H), c = nc[0], ctx = nc[1];
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#111417');
    bg.addColorStop(1, '#090b0c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(199,172,124,.26)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    var title = item.title + (item.subtitle ? ' · ' + item.subtitle : '');
    if (title.length > 15) title = item.title;
    drawSpaced(ctx, title, W / 2, 52, 27, 1, '#d8c59c');
    drawSpaced(ctx, item.kind + ' · ' + item.year + ' · ' + item.place, W / 2, 101, 15, 1.5, 'rgba(199,172,124,.52)', SANS);
    return tex(c);
  }

  function chapterPlaqueTexture(chapter, part) {
    var W = 1024, H = 256;
    var nc = newCanvas(W, H), c = nc[0], ctx = nc[1];
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(18,21,23,.92)');
    bg.addColorStop(1, 'rgba(8,10,11,.92)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(199,172,124,.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, W - 12, H - 12);
    ctx.strokeStyle = 'rgba(199,172,124,.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(16, 16, W - 32, H - 32);

    drawSpaced(ctx, chapter.years, W / 2, 58, 19, 3.2, 'rgba(199,172,124,.58)', SANS);
    drawSpaced(ctx, chapter.name, W / 2, 140, 82, 14, '#d6bb8a');
    drawSpaced(ctx, chapter.quote, W / 2, 216, 22, 1, 'rgba(234,228,215,.4)');

    if (part) {
      ctx.fillStyle = 'rgba(199,172,124,.4)';
      ctx.font = '22px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(part, 56, 58);
    }
    return tex(c);
  }

  function introTexture(chapter) {
    var W = 1024, H = 640;
    var nc = newCanvas(W, H), c = nc[0], ctx = nc[1];
    var bg = ctx.createLinearGradient(0, 0, W * 0.4, H);
    bg.addColorStop(0, '#f1eada');
    bg.addColorStop(0.6, '#e8e0ce');
    bg.addColorStop(1, '#dcd2bd');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    speckle(ctx, W, H, 1400, '90,84,68', 0.05);
    ctx.strokeStyle = 'rgba(146,118,76,.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(24, 24, W - 48, H - 48);
    ctx.strokeStyle = 'rgba(146,118,76,.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(34, 34, W - 68, H - 68);

    drawSpaced(ctx, '序 · ' + chapter.name, 260, 100, 22, 4, '#8a785a', SANS);
    ctx.fillStyle = 'rgba(146,118,76,.3)';
    ctx.fillRect(80, 128, 250, 1);

    ctx.fillStyle = '#25272a';
    ctx.font = '48px ' + SERIF;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('人生到处知何似，', 80, 196);
    ctx.fillText('应似飞鸿踏雪泥。', 80, 258);

    ctx.fillStyle = '#4c4840';
    ctx.font = '23px ' + SERIF;
    var lines = wrapCJK(ctx, chapter.desc, 820);
    lines.forEach(function (ln, i) {
      ctx.fillText(ln, 80, 344 + i * 42);
    });

    ctx.fillStyle = 'rgba(168,58,44,.85)';
    ctx.fillRect(W - 122, H - 132, 48, 48);
    ctx.fillStyle = '#f3e7d3';
    ctx.font = '20px ' + SERIF;
    ctx.textAlign = 'center';
    ctx.fillText('東', W - 98, H - 107);
    ctx.fillText('坡', W - 98, H - 85);

    drawSpaced(ctx, '东坡 · 苏轼诗词展 · 3D 展厅', 300, H - 72, 16, 2, 'rgba(90,80,60,.5)', SANS);
    return tex(c);
  }

  function wallTexture(chapter) {
    var W = 512, H = 512;
    var nc = newCanvas(W, H), c = nc[0], ctx = nc[1];
    ctx.fillStyle = '#363d47';
    ctx.fillRect(0, 0, W, H);

    var amb = ctx.createRadialGradient(W * 0.5, H * 0.34, 20, W * 0.5, H * 0.34, W * 0.85);
    amb.addColorStop(0, chapterGlow(chapter.id, 1));
    amb.addColorStop(1, chapterGlow(chapter.id, 0));
    ctx.fillStyle = amb;
    ctx.fillRect(0, 0, W, H);

    var warm = ctx.createRadialGradient(W * 0.5, H * 0.3, 10, W * 0.5, H * 0.3, W * 0.7);
    warm.addColorStop(0, 'rgba(255,226,180,.2)');
    warm.addColorStop(1, 'rgba(255,226,180,0)');
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, W, H);

    // 顶部灯槽：墙面自上而下的洗墙光
    var cove = ctx.createLinearGradient(0, 0, 0, H * 0.3);
    cove.addColorStop(0, 'rgba(255,214,160,.34)');
    cove.addColorStop(0.4, 'rgba(255,214,160,.12)');
    cove.addColorStop(1, 'rgba(255,214,160,0)');
    ctx.fillStyle = cove;
    ctx.fillRect(0, 0, W, H * 0.3);
    ctx.fillStyle = 'rgba(255,236,198,.5)';
    ctx.fillRect(0, 24, W, 2);

    // 底部灯槽：从地面向上溢出的暖光
    var foot = ctx.createLinearGradient(0, H, 0, H * 0.72);
    foot.addColorStop(0, 'rgba(255,206,150,.22)');
    foot.addColorStop(0.5, 'rgba(255,206,150,.06)');
    foot.addColorStop(1, 'rgba(255,206,150,0)');
    ctx.fillStyle = foot;
    ctx.fillRect(0, H * 0.72, W, H * 0.28);

    function ridge(baseY, amp, color, phase) {
      ctx.beginPath();
      ctx.moveTo(-10, H);
      ctx.lineTo(-10, baseY);
      for (var x = 0; x <= W + 20; x += 32) {
        var y = baseY - Math.sin(x * 0.012 + phase) * amp - Math.sin(x * 0.031 + phase * 2) * amp * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W + 10, H);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    ridge(H * 0.74, 34, 'rgba(0,0,0,.2)', 0.6);
    ridge(H * 0.8, 22, 'rgba(0,0,0,.26)', 2.1);

    for (var i = 0; i < 70; i++) {
      ctx.fillStyle = 'rgba(255,240,210,.012)';
      ctx.fillRect(Math.random() * W, 0, 0.6, H);
    }
    speckle(ctx, W, H, 700, '230,220,200', 0.035);

    ctx.fillStyle = 'rgba(199,172,124,.46)';
    ctx.fillRect(0, H - 60, W, 2);
    ctx.fillStyle = 'rgba(199,172,124,.16)';
    ctx.fillRect(0, H - 16, W, 1);
    ctx.fillStyle = 'rgba(199,172,124,.14)';
    ctx.fillRect(0, 34, W, 1);

    var edge = ctx.createLinearGradient(0, 0, W, 0);
    edge.addColorStop(0, 'rgba(0,0,0,.34)');
    edge.addColorStop(0.18, 'rgba(0,0,0,0)');
    edge.addColorStop(0.82, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,.34)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, W, H);

    var top = ctx.createLinearGradient(0, 0, 0, H);
    top.addColorStop(0, 'rgba(0,0,0,.26)');
    top.addColorStop(0.35, 'rgba(0,0,0,0)');
    top.addColorStop(0.8, 'rgba(0,0,0,.05)');
    top.addColorStop(1, 'rgba(0,0,0,.28)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, H);

    return tex(c);
  }

  function floorTexture() {
    var W = 1024;
    var nc = newCanvas(W, W), c = nc[0], ctx = nc[1];
    ctx.fillStyle = '#252b33';
    ctx.fillRect(0, 0, W, W);
    var g = ctx.createRadialGradient(W * 0.5, W * 0.5, 30, W * 0.5, W * 0.5, W * 0.55);
    g.addColorStop(0, 'rgba(112,90,58,.46)');
    g.addColorStop(0.3, 'rgba(58,49,38,.26)');
    g.addColorStop(0.55, 'rgba(30,30,32,.1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);

    for (var i = 0; i < 90; i++) {
      var x = Math.random() * W, y = Math.random() * W, r = 20 + Math.random() * 90;
      var rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      var light = Math.random() > 0.4;
      rg.addColorStop(0, light ? 'rgba(255,248,235,.05)' : 'rgba(0,0,0,.09)');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.strokeStyle = 'rgba(212,180,124,.32)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(W / 2, W / 2, W * 0.34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(224,196,142,.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(W / 2, W / 2, W * 0.17, 0, Math.PI * 2);
    ctx.stroke();
    speckle(ctx, W, W, 2600, '220,214,200', 0.03);
    return tex(c);
  }

  function ceilingTexture() {
    var W = 512;
    var nc = newCanvas(W, W), c = nc[0], ctx = nc[1];
    var g = ctx.createRadialGradient(W / 2, W / 2, 10, W / 2, W / 2, W * 0.58);
    g.addColorStop(0, '#5b4830');
    g.addColorStop(0.35, '#2b2419');
    g.addColorStop(1, '#0c0e10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);
    for (var i = 0; i < 40; i++) {
      ctx.strokeStyle = 'rgba(214,180,120,.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(W / 2, W / 2, 40 + i * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    return tex(c);
  }

  function waterTexture() {
    var W = 512;
    var nc = newCanvas(W, W), c = nc[0], ctx = nc[1];
    var g = ctx.createRadialGradient(W / 2, W * 0.42, 4, W / 2, W * 0.42, W * 0.52);
    g.addColorStop(0, '#55798a');
    g.addColorStop(0.4, '#254049');
    g.addColorStop(1, '#0d1a20');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);
    var streak = ctx.createLinearGradient(0, 0, 0, W);
    streak.addColorStop(0, 'rgba(255,236,200,0)');
    streak.addColorStop(0.3, 'rgba(255,238,205,.32)');
    streak.addColorStop(0.55, 'rgba(255,240,210,.42)');
    streak.addColorStop(0.72, 'rgba(255,236,200,.12)');
    streak.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = streak;
    ctx.fillRect(W * 0.38, 0, W * 0.24, W);
    // 涟漪
    for (var r = 1; r <= 5; r++) {
      ctx.strokeStyle = 'rgba(206,232,240,' + (0.12 - r * 0.016) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(W / 2, W * 0.42, 26 + r * 32, 0, Math.PI * 2);
      ctx.stroke();
    }
    speckle(ctx, W, W, 600, '210,230,230', 0.07);
    return tex(c);
  }

  function steleTexture(item) {
    var W = 512, H = 1024;
    var nc = newCanvas(W, H), c = nc[0], ctx = nc[1];
    var g = ctx.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, '#44423a');
    g.addColorStop(0.55, '#363530');
    g.addColorStop(1, '#2b2a26');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    speckle(ctx, W, H, 1900, '220,210,190', 0.05);
    for (var i = 0; i < 26; i++) {
      ctx.fillStyle = 'rgba(0,0,0,.05)';
      ctx.fillRect(0, Math.random() * H, W, 0.7 + Math.random() * 1.4);
    }
    ctx.strokeStyle = 'rgba(220,205,170,.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(26, 26, W - 52, H - 52);

    drawVert(ctx, '終', W / 2, 64, 20, 'rgba(199,172,124,.55)');
    ctx.fillStyle = 'rgba(199,172,124,.45)';
    ctx.font = '16px ' + SANS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('建 中 靖 国 元 年 · 1101', W / 2, 100);

    drawVert(ctx, item.title, W - 84, 150, 44, 'rgba(240,228,200,.98)');
    var cols = [];
    item.snippet.forEach(function (ln) { clauses(ln).forEach(function (cl) { cols.push(cl); }); });
    if (cols.length > 6) cols = cols.slice(0, 6);
    var colSize = cols.length >= 6 ? 30 : 34;
    var step = cols.length >= 6 ? 48 : 52;
    var startX = W - 164;
    for (var k = 0; k < cols.length; k++) {
      drawVert(ctx, cols[k], startX - k * step, 142, colSize, 'rgba(236,224,198,.88)');
    }
    ctx.fillStyle = 'rgba(150,60,45,.9)';
    ctx.fillRect(W - 128, H - 176, 46, 46);
    ctx.fillStyle = '#e9dcc6';
    ctx.font = '19px ' + SERIF;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('東', W - 105, H - 152);
    ctx.fillText('坡', W - 105, H - 130);
    return tex(c);
  }

  function glowTexture() {
    var W = 128;
    var nc = newCanvas(W, W), c = nc[0], ctx = nc[1];
    var g = ctx.createRadialGradient(W / 2, W / 2, 2, W / 2, W / 2, W / 2);
    g.addColorStop(0, 'rgba(255,228,180,.9)');
    g.addColorStop(0.42, 'rgba(255,214,150,.3)');
    g.addColorStop(0.72, 'rgba(255,210,146,.09)');
    g.addColorStop(1, 'rgba(255,210,146,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);
    return tex(c);
  }

  function dotTexture() {
    var W = 32;
    var nc = newCanvas(W, W), c = nc[0], ctx = nc[1];
    var g = ctx.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    g.addColorStop(0, 'rgba(255,246,226,1)');
    g.addColorStop(0.4, 'rgba(255,240,210,.5)');
    g.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);
    return tex(c);
  }

  /* ---------- 场景 ---------- */
  var glowTex = glowTexture();
  var panels = [];
  var navItems = [];   // 供目录跳转
  var proxies = [];    // 不可见拾取代理（整件展品的包围面）

  var woodMat = new THREE.MeshBasicMaterial({ color: 0x43362a });
  var postMat = new THREE.MeshBasicMaterial({ color: 0x3b3329 });
  var goldMat = new THREE.MeshBasicMaterial({ color: 0xc9a462 });
  var glowMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.78
  });

  // 地面
  var floor = new THREE.Mesh(
    new THREE.CircleGeometry(R, 8, Math.PI / 8),
    new THREE.MeshBasicMaterial({ map: floorTexture() })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // 顶
  var ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(R + 0.4, 8, Math.PI / 8),
    new THREE.MeshBasicMaterial({ map: ceilingTexture() })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_H;
  scene.add(ceiling);

  // 八面墙
  var wallMatCache = {};
  for (var b = 0; b < 8; b++) {
    var ang = b * Math.PI / 4;
    var nx = Math.cos(ang), nz = Math.sin(ang);
    var bay = BAYS[b];
    var chId = bay.chapter;
    if (!wallMatCache[chId]) wallMatCache[chId] = new THREE.MeshBasicMaterial({ map: wallTexture(CH[chId]) });
    var wall = new THREE.Mesh(new THREE.PlaneGeometry(SIDE, WALL_H), wallMatCache[chId]);
    wall.position.set(nx * APOTHEM, WALL_H / 2, nz * APOTHEM);
    wall.rotation.y = Math.atan2(-nx, -nz);
    scene.add(wall);
  }

  // 八角柱
  var postGeo = new THREE.BoxGeometry(0.34, WALL_H, 0.34);
  for (var v = 0; v < 8; v++) {
    var va = Math.PI / 8 + v * Math.PI / 4;
    var post = new THREE.Mesh(postGeo, postMat);
    post.position.set(Math.cos(va) * R, WALL_H / 2, Math.sin(va) * R);
    scene.add(post);
  }

  // 全场景采用烘焙式假光照（无实时灯光、无阴影），保证集显也稳定

  /* ---------- 展品布置 ---------- */
  function addExhibit(item, bayIndex, u) {
    var chapter = CH[item.chapter];
    var ang = bayIndex * Math.PI / 4;
    var n = { x: Math.cos(ang), z: Math.sin(ang) };
    var t = { x: -Math.sin(ang), z: Math.cos(ang) };
    var g = new THREE.Group();
    g.position.set(n.x * (APOTHEM - 0.12) + t.x * u, 0, n.z * (APOTHEM - 0.12) + t.z * u);
    g.rotation.y = Math.atan2(-n.x, -n.z);

    var paper = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 2.3),
      new THREE.MeshBasicMaterial({ map: panelTexture(item) })
    );
    paper.position.set(0, 2.8, 0.05);
    g.add(paper);

    var back = new THREE.Mesh(new THREE.BoxGeometry(1.44, 2.44, 0.06), woodMat);
    back.position.set(0, 2.8, 0);
    g.add(back);

    var glow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 3.4), glowMat);
    glow.position.set(0, 2.8, 0.032);
    g.add(glow);

    var plaque = new THREE.Mesh(
      new THREE.PlaneGeometry(1.12, 0.315),
      new THREE.MeshBasicMaterial({ map: plaqueTexture(item, chapter) })
    );
    plaque.position.set(0, 1.4, 0.06);
    g.add(plaque);

    var rod = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.045, 0.045), goldMat);
    rod.position.set(0, 3.99, 0.05);
    g.add(rod);

    scene.add(g);
    g.updateMatrixWorld(true);

    var wp = new THREE.Vector3();
    paper.getWorldPosition(wp);

    var rec = {
      item: item,
      chapter: chapter,
      center: wp,
      facing: new THREE.Vector3(-n.x, 0, -n.z),
      group: g
    };
    // 整件展品的拾取代理：比可见挂轴略大，完全覆盖纸面与木框
    var proxy = new THREE.Mesh(
      new THREE.PlaneGeometry(1.66, 2.78),
      new THREE.MeshBasicMaterial()
    );
    proxy.position.set(0, 2.78, 0.07);
    proxy.visible = false;
    proxy.userData.rec = rec;
    g.add(proxy);
    proxies.push(proxy);

    panels.push(rec);
    navItems.push(rec);
  }

  var partMarks = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ'];
  var baySeen = {};
  for (var bi = 0; bi < BAYS.length; bi++) {
    var bay = BAYS[bi];
    var chapter = CH[bay.chapter];
    baySeen[bay.chapter] = (baySeen[bay.chapter] || 0) + 1;
    var partCount = BAYS.filter(function (x) { return x.chapter === bay.chapter; }).length;
    var part = partCount > 1 ? partMarks[baySeen[bay.chapter]] : '';

    var bn = { x: Math.cos(bi * Math.PI / 4), z: Math.sin(bi * Math.PI / 4) };
    var bt = { x: -Math.sin(bi * Math.PI / 4), z: Math.cos(bi * Math.PI / 4) };
    var pgroup = new THREE.Group();
    pgroup.position.set(bn.x * (APOTHEM - 0.14), 0, bn.z * (APOTHEM - 0.14));
    pgroup.rotation.y = Math.atan2(-bn.x, -bn.z);

    var cplaque = new THREE.Mesh(
      new THREE.PlaneGeometry(3.0, 0.75),
      new THREE.MeshBasicMaterial({ map: chapterPlaqueTexture(chapter, part) })
    );
    cplaque.position.set(0, 5.35, 0.02);
    pgroup.add(cplaque);
    scene.add(pgroup);

    var items = bay.exhibits.map(function (id) { return EX[id]; });
    if (bay.intro) {
      var intro = new THREE.Mesh(
        new THREE.PlaneGeometry(3.2, 2.0),
        new THREE.MeshBasicMaterial({ map: introTexture(chapter) })
      );
      var ig = new THREE.Group();
      ig.position.set(bn.x * (APOTHEM - 0.12) + bt.x * -1.72, 0, bn.z * (APOTHEM - 0.12) + bt.z * -1.72);
      ig.rotation.y = Math.atan2(-bn.x, -bn.z);
      intro.position.set(0, 2.65, 0.04);
      ig.add(intro);
      var iback = new THREE.Mesh(new THREE.BoxGeometry(3.34, 2.14, 0.06), woodMat);
      iback.position.set(0, 2.65, 0);
      ig.add(iback);
      var iglow = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 3.0), glowMat);
      iglow.position.set(0, 2.65, 0.025);
      ig.add(iglow);
      scene.add(ig);
      addExhibit(items[0], bi, 2.05);
    } else {
      var n = items.length;
      var gap = n === 1 ? 0 : (n === 2 ? 2.5 : 1.92);
      var start = -(n - 1) * gap / 2;
      for (var k = 0; k < n; k++) {
        addExhibit(items[k], bi, start + k * gap);
      }
    }
  }

  /* ---------- 中央：终章碑 ---------- */
  var platform = new THREE.Mesh(
    new THREE.CylinderGeometry(2.95, 3.05, 0.16, 28),
    new THREE.MeshBasicMaterial({ color: 0x070809 })
  );
  platform.position.y = 0.08;
  scene.add(platform);

  // 池沿金色光环（加色叠加，制造科技感的轮廓光）
  var rimGlow = new THREE.Mesh(
    new THREE.RingGeometry(2.62, 3.02, 48),
    new THREE.MeshBasicMaterial({
      map: glowTex, color: 0xffd79a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55,
      side: THREE.DoubleSide
    })
  );
  rimGlow.rotation.x = -Math.PI / 2;
  rimGlow.position.y = 0.17;
  scene.add(rimGlow);

  var water = new THREE.Mesh(
    new THREE.CircleGeometry(2.72, 40),
    new THREE.MeshBasicMaterial({ map: waterTexture() })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.165;
  scene.add(water);
  var waterMap = water.material.map;
  waterMap.center.set(0.5, 0.42);

  var codaItem = EX['e17'];
  var steleStoneMat = new THREE.MeshBasicMaterial({ color: 0x32312c });
  var steleFaceMat = new THREE.MeshBasicMaterial({ map: steleTexture(codaItem) });
  var stele = new THREE.Mesh(
    new THREE.BoxGeometry(1.52, 3.0, 0.3),
    [steleStoneMat, steleStoneMat, steleStoneMat, steleStoneMat, steleFaceMat, steleStoneMat]
  );
  stele.position.y = 1.94;
  stele.rotation.y = Math.PI / 2;
  scene.add(stele);

  var steleBase = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.3, 0.62), new THREE.MeshBasicMaterial({ color: 0x292721 }));
  steleBase.position.y = 0.31;
  steleBase.rotation.y = Math.PI / 2;
  scene.add(steleBase);

  var halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffe0ad, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.38
  }));
  halo.position.set(0, 2.5, 0);
  halo.scale.set(8, 8, 1);
  scene.add(halo);

  // 碑顶光柱（假体积光，一次性烘焙成竖向渐变）
  function shaftTexture() {
    var W = 64, H = 256;
    var nc2 = newCanvas(W, H), c2 = nc2[0], ctx2 = nc2[1];
    var g2 = ctx2.createLinearGradient(0, 0, 0, H);
    g2.addColorStop(0, 'rgba(255,228,184,.55)');
    g2.addColorStop(0.5, 'rgba(255,222,175,.16)');
    g2.addColorStop(1, 'rgba(255,220,170,0)');
    ctx2.fillStyle = g2;
    ctx2.fillRect(0, 0, W, H);
    return tex(c2);
  }
  var shaft = new THREE.Mesh(
    new THREE.ConeGeometry(1.6, 6.3, 20, 1, true),
    new THREE.MeshBasicMaterial({
      map: shaftTexture(), color: 0xffe2b4, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, opacity: 0.22
    })
  );
  shaft.position.y = 3.85;
  scene.add(shaft);

  // 每面墙上方的射灯辉光（Sprite，几乎不增加填充压力）
  for (var li = 0; li < 8; li++) {
    var la = li * Math.PI / 4;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffe3b4, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.42
    }));
    sp.position.set(Math.cos(la) * (APOTHEM - 1.05), WALL_H - 0.4, Math.sin(la) * (APOTHEM - 1.05));
    sp.scale.set(1.6, 1.6, 1);
    scene.add(sp);
  }

  // 转角处的竖向灯带
  var stripMat = new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xffdca6, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5
  });
  var stripGeo = new THREE.PlaneGeometry(0.07, 6.1);
  for (var si = 0; si < 8; si++) {
    var sa = si * Math.PI / 4 + Math.PI / 8;
    var sn = { x: Math.cos(sa), z: Math.sin(sa) };
    var strip = new THREE.Mesh(stripGeo, stripMat);
    strip.position.set(sn.x * (APOTHEM - 0.02), 3.45, sn.z * (APOTHEM - 0.02));
    strip.rotation.y = Math.atan2(-sn.x, -sn.z);
    scene.add(strip);
  }

  var moon = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 36),
    new THREE.MeshBasicMaterial({
      map: glowTex, color: 0xfff0cd, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85
    })
  );
  moon.rotation.x = Math.PI / 2;
  moon.position.y = WALL_H - 0.12;
  scene.add(moon);

  var pool = new THREE.Mesh(
    new THREE.CircleGeometry(4.2, 40),
    new THREE.MeshBasicMaterial({
      map: glowTex, color: 0xc99a58, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.055
    })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.03;
  scene.add(pool);

  var codaRec = {
    item: codaItem,
    chapter: CH['coda'],
    center: new THREE.Vector3(0, 2.35, 0),
    facing: new THREE.Vector3(1, 0, 0),
    group: stele
  };
  var steleProxy = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 3.3, 1.1),
    new THREE.MeshBasicMaterial()
  );
  steleProxy.position.y = 1.9;
  steleProxy.visible = false;
  steleProxy.userData.rec = codaRec;
  scene.add(steleProxy);
  proxies.push(steleProxy);
  panels.push(codaRec);
  navItems.push(codaRec);

  /* ---------- 浮尘 ---------- */
  var dustCount = 380;
  var dustGeo = new THREE.BufferGeometry();
  var dustPos = new Float32Array(dustCount * 3);
  for (var d = 0; d < dustCount; d++) {
    var rr = Math.sqrt(Math.random()) * 11.4;
    var aa = Math.random() * Math.PI * 2;
    dustPos[d * 3] = Math.cos(aa) * rr;
    dustPos[d * 3 + 1] = 0.4 + Math.random() * 6.1;
    dustPos[d * 3 + 2] = Math.sin(aa) * rr;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  var dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 0.055, map: dotTexture(), color: 0xe8d9b8,
    transparent: true, opacity: 0.55, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true
  }));
  scene.add(dust);

  /* ---------- 漫游状态 ---------- */
  var pos = new THREE.Vector3(6.4, EYE, 0.1);
  var yaw = Math.PI / 2;
  var pitch = 0.02;
  var vel = new THREE.Vector3();
  var bob = 0, bobPhase = 0;
  var candidate = null;
  var readerOpen = false;
  var anim = null;
  var savedCam = null;
  var fovTarget = 60;
  var held = { forward: false, back: false, left: false, right: false };
  var keys = {};
  var focusTimer = 0;
  var hintFaded = false;

  var saved = null;

  function collide(p) {
    for (var k = 0; k < 8; k++) {
      var a = k * Math.PI / 4;
      var nx = Math.cos(a), nz = Math.sin(a);
      var d = p.x * nx + p.z * nz;
      var lim = APOTHEM - 0.62;
      if (d > lim) {
        p.x -= nx * (d - lim);
        p.z -= nz * (d - lim);
      }
    }
    var r = Math.hypot(p.x, p.z);
    if (r < KEEP_OUT && r > 0.0001) {
      p.x = p.x / r * KEEP_OUT;
      p.z = p.z / r * KEEP_OUT;
    }
  }
  collide(pos);

  function shortestAngle(from, to) {
    var d = (to - from + Math.PI) % (Math.PI * 2);
    if (d < 0) d += Math.PI * 2;
    return d - Math.PI;
  }

  function animateTo(target, dur, cb) {
    anim = {
      t: 0, dur: reduced ? 0.01 : dur,
      from: { x: pos.x, z: pos.z, yaw: yaw, pitch: pitch },
      to: { x: target.x, z: target.z, yaw: target.yaw, pitch: target.pitch },
      dy: shortestAngle(yaw, target.yaw),
      cb: cb || null
    };
  }

  function updateAnim(dt) {
    anim.t += dt;
    var k = Math.min(1, anim.t / anim.dur);
    var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    pos.x = anim.from.x + (anim.to.x - anim.from.x) * e;
    pos.z = anim.from.z + (anim.to.z - anim.from.z) * e;
    yaw = anim.from.yaw + anim.dy * e;
    pitch = anim.from.pitch + (anim.to.pitch - anim.from.pitch) * e;
    if (k >= 1) {
      var cb = anim.cb;
      anim = null;
      if (cb) cb();
    }
  }

  function frameTarget(rec) {
    var c = rec.center;
    var f = rec.facing;
    var dist = rec.item.id === 'e17' ? 4.3 : 3.25;
    var camX = c.x + f.x * dist;
    var camZ = c.z + f.z * dist;
    var dy = c.y - EYE;
    return {
      x: camX, z: camZ,
      yaw: Math.atan2(f.x, f.z),
      pitch: Math.atan2(dy, dist)
    };
  }

  /* ---------- 拾取（整件展品代理，非文字网格） ---------- */
  var raycaster = new THREE.Raycaster();
  var pickNdc = new THREE.Vector2();

  function pickExhibit(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    pickNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pickNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pickNdc, camera);
    var hits = raycaster.intersectObjects(proxies, false);
    return hits.length ? hits[0].object.userData.rec : null;
  }

  /* ---------- 近读 ---------- */
  function fillReader(rec) {
    var item = rec.item;
    var chapter = rec.chapter;
    $id('readerKicker').textContent = chapter.short + ' · ' + item.kind + ' · ' + item.era + ' ' + item.year + ' · ' + item.place;
    var titleEl = $id('readerTitle');
    titleEl.textContent = item.title;
    if (item.subtitle) {
      var small = document.createElement('small');
      small.textContent = /^词/.test(item.kind) ? '词牌 · ' + item.subtitle : item.subtitle;
      titleEl.appendChild(small);
    }
    var verse = $id('readerVerse');
    verse.innerHTML = '';
    verse.className = 'reader-verse' + (/^文/.test(item.kind) ? ' is-prose' : '');
    item.lines.forEach(function (ln) {
      var p = document.createElement('p');
      if (ln) p.textContent = ln;
      verse.appendChild(p);
    });
    $id('readerNote').textContent = item.note;
  }

  function openReader(rec) {
    if (readerOpen) return;
    readerOpen = true;
    document.body.classList.add('reading');
    hidePrompt();
    saved = { x: pos.x, z: pos.z, yaw: yaw, pitch: pitch };
    fillReader(rec);
    var target = frameTarget(rec);
    fovTarget = 55;                       // 轻微推镜
    animateTo(target, 0.8, function () {
      readerEl.classList.add('open');
      readerEl.setAttribute('aria-hidden', 'false');
    });
    if (!reduced) {
      window.setTimeout(function () {
        if (readerOpen && !readerEl.classList.contains('open')) {
          readerEl.classList.add('open');
          readerEl.setAttribute('aria-hidden', 'false');
        }
      }, 420);
    }
  }

  function closeReader() {
    if (!readerOpen) return;
    readerOpen = false;
    document.body.classList.remove('reading');
    readerEl.classList.remove('open');
    readerEl.setAttribute('aria-hidden', 'true');
    fovTarget = 60;
    if (saved) {
      animateTo({ x: saved.x, z: saved.z, yaw: saved.yaw, pitch: saved.pitch }, 0.65, function () {
        saved = null;
        updateCandidate(true);
      });
    }
  }

  function teleportTo(rec) {
    var target = frameTarget(rec);
    pos.x = target.x;
    pos.z = target.z;
    yaw = target.yaw;
    pitch = target.pitch;
    collide(pos);
    openReader(rec);
  }

  function updateCandidate(force) {
    if (readerOpen || anim) return;
    var fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
    var best = null, bestScore = 0;
    for (var i = 0; i < panels.length; i++) {
      var rec = panels[i];
      var dx = rec.center.x - pos.x;
      var dz = rec.center.z - pos.z;
      var dist = Math.hypot(dx, dz);
      if (dist > 6.2 || dist < 0.3) continue;
      var dot = (dx * fwdX + dz * fwdZ) / dist;
      if (dot < 0.5) continue;
      var score = dot * 2 - dist * 0.05;
      if (score > bestScore) { bestScore = score; best = rec; }
    }
    if (best !== candidate || force) {
      candidate = best;
      if (best) showPrompt(best); else hidePrompt();
    }
  }

  function showPrompt(rec) {
    var item = rec.item;
    promptTitle.textContent = '《' + item.title + (item.subtitle ? '·' + item.subtitle : '') + '》';
    promptMeta.textContent = item.kind + ' · ' + item.year + ' · ' + item.place;
    promptEl.hidden = false;
    requestAnimationFrame(function () { promptEl.classList.add('show'); });
    reticleEl.classList.add('active');
  }

  function hidePrompt() {
    promptEl.classList.remove('show');
    reticleEl.classList.remove('active');
    window.setTimeout(function () {
      if (!promptEl.classList.contains('show')) promptEl.hidden = true;
    }, 320);
  }

  /* ---------- 输入 ---------- */
  function isMoveKey(code) {
    return code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD' ||
      code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight';
  }

  window.addEventListener('keydown', function (e) {
    if (isMoveKey(e.code) || e.code === 'Space') e.preventDefault();
    if (e.code === 'Escape') {
      if (helpEl.classList.contains('open')) { closeHelp(); return; }
      if (drawerEl.classList.contains('open')) { closeDrawer(); return; }
      if (readerOpen) { closeReader(); return; }
      return;
    }
    if (readerOpen) return;
    if (flatMode) return;
    if (e.code === 'KeyE' || e.code === 'Enter') {
      if (candidate) openReader(candidate);
      return;
    }
    keys[e.code] = true;
  });

  window.addEventListener('keyup', function (e) {
    keys[e.code] = false;
  });
  window.addEventListener('blur', function () {
    keys = {};
    held.forward = held.back = held.left = held.right = false;
  });

  // 鼠标 / 触屏拖拽
  var drag = null;
  canvas.addEventListener('pointerdown', function (e) {
    if (readerOpen) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    canvas.classList.add('grabbing');
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag || drag.id !== e.pointerId || readerOpen) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    yaw -= dx * 0.0032;
    pitch -= dy * 0.0030;
    pitch = Math.max(-1.15, Math.min(1.15, pitch));
  });
  function endDrag(e) {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    canvas.classList.remove('grabbing');
    if (readerOpen || flatMode) return;
    if (e.type !== 'pointerup' || moved >= 7) return;
    // 点击命中整件展品的拾取代理，直接近读
    var hit = pickExhibit(e.clientX, e.clientY);
    if (!hit) return;
    var t = frameTarget(hit);
    // 远距离点击直接落位，避免镜头穿过中央碑体
    if (Math.hypot(t.x - pos.x, t.z - pos.z) > 6.5) teleportTo(hit);
    else openReader(hit);
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // 悬停时给出可点击的指针反馈
  var hoverAt = 0;
  canvas.addEventListener('pointermove', function (e) {
    if (drag || readerOpen || flatMode || e.pointerType === 'touch') {
      if (!drag) canvas.classList.remove('pickable');
      return;
    }
    var now = performance.now();
    if (now - hoverAt < 80) return;
    hoverAt = now;
    canvas.classList.toggle('pickable', !!pickExhibit(e.clientX, e.clientY));
  });

  // 触屏方向键
  Array.prototype.forEach.call(document.querySelectorAll('.dpad-btn'), function (btn) {
    var dir = btn.getAttribute('data-move');
    function press(e) {
      e.preventDefault();
      held[dir] = true;
      btn.classList.add('pressed');
    }
    function release(e) {
      if (e) e.preventDefault();
      held[dir] = false;
      btn.classList.remove('pressed');
    }
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  /* ---------- 面板 / 目录 ---------- */
  function openDrawer() {
    drawerEl.classList.add('open');
    drawerEl.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    drawerEl.classList.remove('open');
    drawerEl.setAttribute('aria-hidden', 'true');
  }
  function openHelp() {
    helpEl.classList.add('open');
    helpEl.setAttribute('aria-hidden', 'false');
  }
  function closeHelp() {
    helpEl.classList.remove('open');
    helpEl.setAttribute('aria-hidden', 'true');
  }

  function buildDrawer() {
    var body = $id('drawerBody');
    body.innerHTML = '';
    DATA.chapters.forEach(function (chapter) {
      var recs = navItems.filter(function (r) { return r.item.chapter === chapter.id; });
      if (!recs.length) return;
      var head = document.createElement('div');
      head.className = 'dir-chapter';
      head.innerHTML = '<b>' + chapter.name + '</b><em>' + chapter.years + '</em>';
      body.appendChild(head);
      recs.forEach(function (rec) {
        var btn = document.createElement('button');
        btn.className = 'dir-item';
        btn.type = 'button';
        btn.innerHTML = '<span class="no">' + rec.item.no + '</span>' +
          '<span class="t">' + rec.item.title + (rec.item.subtitle ? ' · ' + rec.item.subtitle : '') + '</span>' +
          '<span class="y">' + rec.item.year + '</span>';
        btn.addEventListener('click', function () {
          startEl.classList.add('gone');
          closeDrawer();
          window.setTimeout(function () { teleportTo(rec); }, 260);
        });
        body.appendChild(btn);
      });
    });
  }
  buildDrawer();

  /* ---------- 纯文字浏览 ---------- */
  var flatMode = false;

  function chapterLabel(ch) {
    return ch.short === ch.name ? ch.name : ch.short + ' · ' + ch.name;
  }

  function renderFlatArticle(item) {
    var ch = CH[item.chapter];
    var isProse = /^文/.test(item.kind);
    var html = '<p class="fa-kicker">' + chapterLabel(ch) + ' ／ ' + item.kind + '</p>' +
      '<h2 class="fa-title">' + item.title +
      (item.subtitle ? '<small>' + item.subtitle + '</small>' : '') + '</h2>' +
      '<p class="fa-meta">' + item.era + ' · ' + item.year + ' · ' + item.place + '</p>' +
      '<div class="fa-body' + (isProse ? ' is-prose' : '') + '">';
    item.lines.forEach(function (ln) { html += '<p>' + ln + '</p>'; });
    html += '</div><p class="fa-note">' + item.note + '</p>';
    flatArticle.innerHTML = html;
  }

  function selectFlat(item) {
    renderFlatArticle(item);
    var links = flatNav.querySelectorAll('.flat-link');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('active', links[i].getAttribute('data-id') === item.id);
    }
    if (flatMode) flatEl.scrollTop = 0;
  }

  function buildFlat() {
    DATA.chapters.forEach(function (ch) {
      var items = DATA.exhibits.filter(function (e) { return e.chapter === ch.id; });
      if (!items.length) return;
      var group = document.createElement('div');
      group.className = 'flat-chapter';
      group.innerHTML = '<b>' + chapterLabel(ch) + '</b><em>' + ch.years + '</em>';
      items.forEach(function (item) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'flat-link';
        btn.setAttribute('data-id', item.id);
        btn.innerHTML = '<span>' + item.title + (item.subtitle ? ' · ' + item.subtitle : '') + '</span>' +
          '<i>' + item.no + '</i>';
        btn.addEventListener('click', function () { selectFlat(item); });
        group.appendChild(btn);
      });
      flatNav.appendChild(group);
    });
    selectFlat(DATA.exhibits[0]);
  }
  buildFlat();

  function enterFlat() {
    flatMode = true;
    if (readerOpen) closeReader();
    anim = null;
    saved = null;
    stopLoop();
    document.body.classList.add('is-flat');
    startEl.classList.add('gone');
    flatEl.setAttribute('aria-hidden', 'false');
    closeDrawer();
    closeHelp();
    hidePrompt();
    flatEl.scrollTop = 0;
  }

  function enter3D() {
    flatMode = false;
    document.body.classList.remove('is-flat');
    flatEl.setAttribute('aria-hidden', 'true');
    startEl.classList.add('gone');
    startLoop();
    if (!hintFaded) {
      window.setTimeout(function () { hintEl.classList.add('fade'); hintFaded = true; }, 8000);
    }
  }

  $id('btnEnter').addEventListener('click', enter3D);
  $id('btnFlat').addEventListener('click', enterFlat);
  $id('btnEnter3D').addEventListener('click', enter3D);
  // 可直接分享纯文字版：3d/?view=text
  if (/(?:^|[?&])view=text(?:&|$)/.test(window.location.search)) enterFlat();
  $id('btnIndex').addEventListener('click', openDrawer);
  $id('btnHelp').addEventListener('click', openHelp);
  $id('btnCloseIndex').addEventListener('click', closeDrawer);
  $id('btnCloseHelp').addEventListener('click', closeHelp);
  drawerEl.addEventListener('click', function (e) { if (e.target === drawerEl) closeDrawer(); });
  helpEl.addEventListener('click', function (e) { if (e.target === helpEl) closeHelp(); });
  $id('btnCloseReader').addEventListener('click', closeReader);
  $id('btnBack').addEventListener('click', closeReader);
  readerEl.addEventListener('click', function (e) { if (e.target === readerEl) closeReader(); });
  promptEl.addEventListener('click', function () {
    if (candidate && !readerOpen) openReader(candidate);
  });

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  /* ---------- 主循环 ---------- */
  var last = 0;
  var clock = 0;
  var rafId = 0;
  var running = false;
  var perf = { n: 0, sum: 0, count: 0, done: false };

  function adaptResolution(dt) {
    if (perf.done) return;
    perf.n++;
    if (perf.n > 40 && perf.n <= 140) {
      perf.sum += dt;
      perf.count++;
    }
    if (perf.n === 140) {
      perf.done = true;
      var avg = perf.sum / perf.count;
      if (avg > 0.028 && renderer.getPixelRatio() > 1.01) {
        renderer.setPixelRatio(1);
        renderer.setSize(window.innerWidth, window.innerHeight, false);
      }
    }
  }

  function updateMovement(dt) {
    var f = 0, s = 0;
    if (keys.KeyW || keys.ArrowUp || held.forward) f += 1;
    if (keys.KeyS || keys.ArrowDown || held.back) f -= 1;
    if (keys.KeyD || keys.ArrowRight || held.right) s += 1;
    if (keys.KeyA || keys.ArrowLeft || held.left) s -= 1;

    var fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
    var rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
    var vx = fwdX * f + rightX * s;
    var vz = fwdZ * f + rightZ * s;
    var len = Math.hypot(vx, vz);
    if (len > 0.001) { vx /= len; vz /= len; }

    var speed = (keys.ShiftLeft || keys.ShiftRight) ? 5.0 : 3.0;
    var k = 1 - Math.exp(-dt * 11);
    vel.x += (vx * speed - vel.x) * k;
    vel.z += (vz * speed - vel.z) * k;

    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    collide(pos);

    var moving = Math.hypot(vel.x, vel.z) > 0.35;
    if (moving) {
      bobPhase += dt * 8.4;
      bob += (Math.sin(bobPhase) * 0.016 - bob) * 0.12;
      if (!hintFaded && clock > 1.2) {
        hintEl.classList.add('fade');
        hintFaded = true;
      }
    } else {
      bob += (0 - bob) * 0.1;
    }
  }

  function loop(now) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (!last) last = now;
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    adaptResolution(dt);

    if (anim) {
      updateAnim(dt);
    } else if (!readerOpen) {
      updateMovement(dt);
      focusTimer += dt;
      if (focusTimer > 0.12) {
        focusTimer = 0;
        updateCandidate(false);
      }
    }

    camera.position.set(pos.x, EYE + bob, pos.z);
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    // 轻微推镜：近读时收窄视场角
    if (camera.fov !== fovTarget) {
      camera.fov += (fovTarget - camera.fov) * Math.min(1, dt * 5);
      if (Math.abs(camera.fov - fovTarget) < 0.03) camera.fov = fovTarget;
      camera.updateProjectionMatrix();
    }

    dust.rotation.y += dt * 0.03;
    if (waterMap) waterMap.rotation += dt * 0.03;
    halo.material.opacity = 0.38 + Math.sin(clock * 0.7) * 0.06;

    renderer.render(scene, camera);
  }

  function startLoop() {
    if (running) return;
    running = true;
    last = 0;
    rafId = requestAnimationFrame(loop);
  }
  function stopLoop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (!flatMode) startLoop();

  // 首帧后自动淡出操作提示的兜底
  window.setTimeout(function () {
    if (!startEl.classList.contains('gone')) return;
    hintEl.classList.add('fade');
    hintFaded = true;
  }, 14000);

  // 便于调试 / 自动化验收
  window.HALL = {
    scene: scene,
    camera: camera,
    renderer: renderer,
    panels: panels,
    state: function () {
      return { x: pos.x, z: pos.z, yaw: yaw, pitch: pitch, candidate: candidate && candidate.item.id, readerOpen: readerOpen, flat: flatMode, fov: camera.fov };
    },
    // 数值验证：每件展品的停靠位是否正对展品中心
    aimAll: function () {
      return panels.map(function (rec) {
        var t = frameTarget(rec);
        var fx = -Math.sin(t.yaw) * Math.cos(t.pitch);
        var fy = Math.sin(t.pitch);
        var fz = -Math.cos(t.yaw) * Math.cos(t.pitch);
        var dx = rec.center.x - t.x, dy = rec.center.y - EYE, dz = rec.center.z - t.z;
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var dot = (fx * dx + fy * dy + fz * dz) / len;
        return {
          id: rec.item.id,
          dist: +len.toFixed(3),
          errDeg: +(Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI).toFixed(3)
        };
      });
    },
    // 数值验证：站到每件展品正前方，在代理面内取中心/四边/四角共 9 点，
    // 逐点做真实射线拾取，检查是否"点哪儿都命中自己、且只命中自己"
    testPick: function () {
      var rect = canvas.getBoundingClientRect();
      var out = [];
      panels.forEach(function (rec) {
        var proxy = null;
        for (var i = 0; i < proxies.length; i++) {
          if (proxies[i].userData.rec === rec) { proxy = proxies[i]; break; }
        }
        if (!proxy) return;
        var t = frameTarget(rec);
        var oldPos = camera.position.clone();
        var oldRot = camera.rotation.clone();
        camera.position.set(t.x, EYE, t.z);
        camera.rotation.set(t.pitch, t.yaw, 0);
        camera.updateMatrixWorld(true);
        scene.updateMatrixWorld(true);

        proxy.geometry.computeBoundingBox();
        var bb = proxy.geometry.boundingBox;
        var hw = (bb.max.x - bb.min.x) / 2;
        var hh = (bb.max.y - bb.min.y) / 2;
        var local = [
          [0, 0],
          [-hw * 0.9, 0], [hw * 0.9, 0],
          [0, -hh * 0.9], [0, hh * 0.9],
          [-hw * 0.8, hh * 0.8], [hw * 0.8, hh * 0.8],
          [-hw * 0.8, -hh * 0.8], [hw * 0.8, -hh * 0.8]
        ];
        var hits = local.map(function (lp) {
          var p = new THREE.Vector3(lp[0], lp[1], 0);
          proxy.localToWorld(p);
          p.project(camera);
          var sx = rect.left + (p.x * 0.5 + 0.5) * rect.width;
          var sy = rect.top + (-p.y * 0.5 + 0.5) * rect.height;
          var h = pickExhibit(sx, sy);
          return h ? h.item.id : null;
        });
        var v = rec.center.clone().project(camera);
        out.push({
          id: rec.item.id,
          centerNdc: [+v.x.toFixed(2), +v.y.toFixed(2)],
          hits: hits
        });
        camera.position.copy(oldPos);
        camera.rotation.copy(oldRot);
        camera.updateMatrixWorld(true);
      });
      return out;
    },
    // 数值验证：走真实 pointerdown/pointerup 事件链，逐件点击展品中心，
    // 检查近读浮层是否打开、标题是否为该件展品
    testClick: function () {
      var rect = canvas.getBoundingClientRect();
      var out = [];
      panels.forEach(function (rec) {
        var t = frameTarget(rec);
        var oldPos = camera.position.clone();
        var oldRot = camera.rotation.clone();
        camera.position.set(t.x, EYE, t.z);
        camera.rotation.set(t.pitch, t.yaw, 0);
        camera.updateMatrixWorld(true);
        var p = rec.center.clone().project(camera);
        var cx = rect.left + (p.x * 0.5 + 0.5) * rect.width;
        var cy = rect.top + (-p.y * 0.5 + 0.5) * rect.height;
        var opts = { pointerId: 1, pointerType: 'mouse', bubbles: true, clientX: cx, clientY: cy };
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', opts));
        var title = $id('readerTitle').textContent;
        out.push({
          id: rec.item.id,
          opened: readerOpen,
          title: title,
          match: title.indexOf(rec.item.title) === 0
        });
        if (readerOpen) {
          readerOpen = false;
          document.body.classList.remove('reading');
          readerEl.classList.remove('open');
          readerEl.setAttribute('aria-hidden', 'true');
        }
        saved = null;
        anim = null;
        fovTarget = 60;
        camera.fov = 60;
        camera.updateProjectionMatrix();
        camera.position.copy(oldPos);
        camera.rotation.copy(oldRot);
        camera.updateMatrixWorld(true);
        pos.x = oldPos.x;
        pos.z = oldPos.z;
        yaw = oldRot.y;
        pitch = oldRot.x;
      });
      return out;
    }
  };
})();
