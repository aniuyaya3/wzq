import { ENGINE_JS } from './engine.js';

// 前端页面（内嵌 AI 引擎）。同样不要从 Worker 入口顶层导出本常量，见 engine.js 的说明。
export const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#14100d">
<title>五子棋 · Gomoku</title>
<style>
  :root{
    --bg:#14100d; --panel:#211a14; --panel2:#2b2118; --line:#3d2f21;
    --text:#f3e9dc; --muted:#b8a88f; --accent:#e8a33d; --accent2:#c97b2d;
    --danger:#e4572e; --ok:#7bc47f; --radius:16px;
  }
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  html,body{background:var(--bg)}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--text);
       min-height:100dvh;display:flex;justify-content:center;padding:14px 12px calc(18px + env(safe-area-inset-bottom))}
  .app{width:100%;max-width:560px;display:flex;flex-direction:column;gap:14px}
  header{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 0}
  .logo{font-size:26px;font-weight:800;letter-spacing:2px}
  .logo small{display:block;font-size:11px;font-weight:500;color:var(--muted);letter-spacing:4px;margin-top:1px}
  .icon-btn{width:42px;height:42px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:19px;cursor:pointer}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px}
  .hero{text-align:center;padding:22px 16px 18px;background:linear-gradient(160deg,#2b2118,#1c150f);border:1px solid var(--line);border-radius:var(--radius)}
  .hero .stones{font-size:34px;letter-spacing:6px}
  .hero p{color:var(--muted);font-size:13.5px;margin-top:8px;line-height:1.6}
  .modes{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
  .mode-btn{padding:15px 6px;border-radius:var(--radius);border:1.5px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;text-align:center;transition:.15s}
  .mode-btn .ic{font-size:24px;display:block;margin-bottom:6px}
  .mode-btn .nm{font-size:15.5px;font-weight:700}
  .mode-btn .ds{font-size:11px;color:var(--muted);display:block;margin-top:3px}
  .mode-btn.active{border-color:var(--accent);background:var(--panel2);box-shadow:0 0 0 1px var(--accent) inset}
  .setup{display:none;flex-direction:column;gap:14px}
  .setup.show{display:flex}
  .lbl{font-size:13px;color:var(--muted);margin-bottom:8px;font-weight:600;letter-spacing:1px}
  .seg{display:flex;background:#171208;border:1px solid var(--line);border-radius:12px;padding:4px;gap:4px}
  .seg button{flex:1;padding:10px 2px;border:none;border-radius:9px;background:transparent;color:var(--muted);font-size:14.5px;font-weight:600;cursor:pointer;min-height:44px}
  .seg button.active{background:var(--accent);color:#221503}
  .seg button small{display:block;font-size:10px;font-weight:500;opacity:.75;margin-top:1px}
  .primary{width:100%;padding:15px;border:none;border-radius:13px;background:linear-gradient(180deg,var(--accent),var(--accent2));color:#221503;font-size:17px;font-weight:800;cursor:pointer;min-height:52px}
  .primary:active{transform:scale(.985)}
  .row{display:flex;gap:10px}
  .row>*{flex:1}
  .ghost-btn{padding:13px;border-radius:12px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:15px;font-weight:600;cursor:pointer;min-height:48px}
  input.code{width:100%;padding:13px;border-radius:12px;border:1px solid var(--line);background:#171208;color:var(--text);font-size:17px;text-align:center;letter-spacing:4px;text-transform:lowercase;outline:none}
  input.code:focus{border-color:var(--accent)}
  .stats{display:flex;justify-content:space-around;text-align:center}
  .stats b{font-size:21px;display:block}
  .stats span{font-size:11.5px;color:var(--muted)}
  .tip{font-size:12.5px;color:var(--muted);line-height:1.7}
  /* ---- 对局界面 ---- */
  #gameView{display:none;flex-direction:column;gap:12px}
  #gameView.show{display:flex}
  .players{display:flex;align-items:center;gap:10px}
  .p-chip{flex:1;display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:13px;border:1.5px solid var(--line);background:var(--panel);transition:.15s;min-width:0}
  .p-chip.turn{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
  .stone-ic{width:26px;height:26px;border-radius:50%;flex:none;box-shadow:0 2px 5px rgba(0,0,0,.5), inset -2px -3px 5px rgba(0,0,0,.35)}
  .stone-ic.b{background:radial-gradient(circle at 35% 30%,#777,#0a0a0a 70%)}
  .stone-ic.w{background:radial-gradient(circle at 35% 30%,#fff,#c9c9c9 75%)}
  .p-chip .who{font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .p-chip .sub{font-size:11px;color:var(--muted)}
  .vs{font-size:12px;color:var(--muted);font-weight:700}
  #statusBar{text-align:center;font-size:15.5px;font-weight:600;min-height:24px;color:var(--accent)}
  #statusBar .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--muted);border-top-color:var(--accent);border-radius:50%;vertical-align:-2px;margin-right:7px;animation:sp 0.7s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .board-wrap{position:relative;width:100%;aspect-ratio:1/1;border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.55)}
  canvas#board{width:100%;height:100%;display:block;border-radius:14px;touch-action:none;cursor:pointer}
  .meta-row{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--muted);padding:0 2px}
  .meta-row select{background:#171208;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:13px}
  .toolbar{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}
  .toolbar button{padding:12px 2px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:14px;font-weight:600;cursor:pointer;min-height:48px}
  .toolbar button:active{background:var(--panel2)}
  .toolbar button:disabled{opacity:.38}
  .toolbar button.danger{color:#ff9a7a}
  .history{display:flex;gap:6px;overflow-x:auto;padding:4px 2px 8px;scrollbar-width:none;min-height:34px}
  .history::-webkit-scrollbar{display:none}
  .history .mv{flex:none;font-size:12px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px 10px;color:var(--muted)}
  .history .mv b{color:var(--text)}
  .room-bar{display:none;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:9px 12px;font-size:14px}
  .room-bar.show{display:flex}
  .room-bar code{font-size:17px;font-weight:800;letter-spacing:3px;color:var(--accent)}
  .room-bar button{margin-left:auto;padding:8px 13px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;cursor:pointer}
  /* ---- 弹层 / 提示 ---- */
  #modalWrap{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;align-items:flex-end;justify-content:center;z-index:50}
  #modalWrap.show{display:flex}
  #modal{width:100%;max-width:560px;background:var(--panel);border-radius:20px 20px 0 0;padding:22px 18px calc(18px + env(safe-area-inset-bottom));animation:up .22s ease}
  @keyframes up{from{transform:translateY(26px);opacity:.4}to{transform:none;opacity:1}}
  #modal h3{font-size:19px;text-align:center;margin-bottom:8px}
  #modal p{text-align:center;color:var(--muted);font-size:14.5px;line-height:1.65;margin-bottom:18px;white-space:pre-line}
  #modal .btns{display:flex;flex-direction:column;gap:9px}
  #toast{position:fixed;left:50%;bottom:calc(26px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(20px);background:#000;color:#fff;padding:11px 20px;border-radius:999px;font-size:14px;opacity:0;pointer-events:none;transition:.25s;z-index:60;max-width:88vw;text-align:center}
  #toast.show{opacity:.94;transform:translateX(-50%)}
  @media (min-width:520px){ #modalWrap{align-items:center} #modal{border-radius:20px;margin:0 14px} }
  @media (max-width:380px){ .modes{grid-template-columns:1fr 1fr 1fr} .mode-btn .ds{display:none} .logo{font-size:23px} }
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="logo">五子棋<small>GOMOKU · 五子连珠</small></div>
    <button class="icon-btn" id="soundBtn" title="声音开关">🔊</button>
  </header>

  <!-- ===== 主页 ===== -->
  <section id="homeView">
    <div class="hero">
      <div class="stones">⚫⚪</div>
      <p>强 AI 对手 · 攻防兼备<br>支持人机 / 双人 / 在线联机对战</p>
    </div>
    <div style="height:14px"></div>
    <div class="modes">
      <button class="mode-btn active" data-mode="ai"><span class="ic">🤖</span><span class="nm">人机对战</span><span class="ds">挑战强 AI</span></button>
      <button class="mode-btn" data-mode="local"><span class="ic">👥</span><span class="nm">双人对战</span><span class="ds">同屏轮流</span></button>
      <button class="mode-btn" data-mode="online"><span class="ic">🌐</span><span class="nm">在线对战</span><span class="ds">房间联机</span></button>
    </div>
    <div style="height:14px"></div>

    <div class="card setup show" id="setup-ai">
      <div>
        <div class="lbl">AI 难度</div>
        <div class="seg" id="diffSeg">
          <button data-diff="easy">简单<small>新手热身</small></button>
          <button data-diff="normal" class="active">普通<small>小有挑战</small></button>
          <button data-diff="hard">困难<small>攻防兼备</small></button>
          <button data-diff="master">大师<small>深谋远虑</small></button>
        </div>
      </div>
      <div>
        <div class="lbl">你的棋子</div>
        <div class="seg" id="colorSeg">
          <button data-color="1" class="active">⚫ 执黑 · 先行</button>
          <button data-color="2">⚪ 执白 · 后行</button>
        </div>
      </div>
      <button class="primary" id="startAiBtn">开始对局</button>
      <p class="tip">大师难度会进行多层搜索：识别活四、冲四、活三及双三 / 四三等组合杀招，并优先封堵你的威胁。想赢，得下出双头棋。</p>
    </div>

    <div class="card setup" id="setup-local">
      <p class="tip">两名玩家在同一台设备上轮流落子，黑棋先行。支持悔棋、提示与认输。</p>
      <button class="primary" id="startLocalBtn">开始双人对局</button>
    </div>

    <div class="card setup" id="setup-online">
      <div>
        <div class="lbl">创建房间时你的棋子</div>
        <div class="seg" id="olColorSeg">
          <button data-color="1" class="active">⚫ 执黑</button>
          <button data-color="2">⚪ 执白</button>
        </div>
      </div>
      <button class="primary" id="createRoomBtn">创建房间</button>
      <div>
        <div class="lbl">或输入房间号加入</div>
        <div class="row">
          <input class="code" id="roomInput" placeholder="房间号" maxlength="12" autocomplete="off">
          <button class="ghost-btn" id="joinRoomBtn" style="flex:0 0 108px">加入</button>
        </div>
      </div>
      <p class="tip">把房间号发给朋友，对方打开本页面输入即可对战。联机支持悔棋 / 重开 / 和棋协商与认输。</p>
    </div>

    <div style="height:14px"></div>
    <div class="card">
      <div class="lbl">人机战绩（本机保存）</div>
      <div class="stats">
        <div><b id="statW" style="color:var(--ok)">0</b><span>胜</span></div>
        <div><b id="statD">0</b><span>平</span></div>
        <div><b id="statL" style="color:var(--danger)">0</b><span>负</span></div>
        <div><b id="statRate">—</b><span>胜率</span></div>
      </div>
    </div>
    <div style="height:14px"></div>
    <p class="tip" style="text-align:center">规则：15×15 棋盘，黑棋先行，任意一方横 / 竖 / 斜连成五子获胜（无禁手）。</p>
  </section>

  <!-- ===== 对局 ===== -->
  <section id="gameView">
    <div class="players">
      <div class="p-chip" id="chip1"><div class="stone-ic b"></div><div><div class="who" id="who1">黑棋</div><div class="sub" id="sub1"></div></div></div>
      <div class="vs">VS</div>
      <div class="p-chip" id="chip2"><div class="stone-ic w"></div><div><div class="who" id="who2">白棋</div><div class="sub" id="sub2"></div></div></div>
    </div>
    <div id="statusBar">准备中…</div>
    <div class="board-wrap"><canvas id="board"></canvas></div>
    <div class="meta-row">
      <span id="moveInfo">第 0 手 · 00:00</span>
      <label id="diffWrap" style="display:none">难度
        <select id="diffSelect">
          <option value="easy">简单</option>
          <option value="normal">普通</option>
          <option value="hard">困难</option>
          <option value="master">大师</option>
        </select>
      </label>
    </div>
    <div class="room-bar" id="roomBar"><span>房间号</span><code id="roomCode"></code><button id="copyRoomBtn">复制</button></div>
    <div class="toolbar">
      <button id="undoBtn">↩ 悔棋</button>
      <button id="hintBtn">💡 提示</button>
      <button id="restartBtn">🔄 重开</button>
      <button id="moreBtn">⋯ 更多</button>
    </div>
    <div class="history" id="history"></div>
  </section>
</div>

<div id="modalWrap"><div id="modal"><h3 id="modalTitle"></h3><p id="modalBody"></p><div class="btns" id="modalBtns"></div></div></div>
<div id="toast"></div>

<script>
${ENGINE_JS}
</script>
<script>
'use strict';
var N = 15;
var $ = function (id) { return document.getElementById(id); };
var canvas = $('board'), ctx = canvas.getContext('2d');

// ---------- 持久化 ----------
function loadJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
var stats = loadJSON('gomoku-stats-v2', { w: 0, l: 0, d: 0 });
var soundOn = loadJSON('gomoku-sound', true);

// ---------- 状态 ----------
var mode = null;               // 'ai' | 'local' | 'online'
var board = null, moves = [], turn = 1, gameOver = false, resultCounted = false;
var myColor = 1, aiColor = 2, difficulty = 'normal', pickColorVal = 1, olColorVal = 1;
var ws = null, roomId = null, thinking = false, startTime = 0, timerId = null;
var hoverCell = null, previewCell = null, hintCell = null, hintTimer = null;
var winCells = [];
var selectedMode = 'ai';

function emptyBoard() { var b = []; for (var y = 0; y < N; y++) { var r = []; for (var x = 0; x < N; x++) r.push(0); b.push(r); } return b; }
function notation(x, y) { return 'ABCDEFGHIJKLMNO'.charAt(x) + (15 - y); }
function stoneName(p) { return p === 1 ? '黑棋' : '白棋'; }

// ---------- 声音 ----------
// 落子声不用蜂鸣音，改为合成「棋子扣木盘」的敲击声：短促噪声咔哒 + 低频木质共鸣
var audioCtx = null;
function ensureAudio() {
  if (!soundOn) return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}
// 首次手势时解锁音频（移动端自动播放策略要求）
document.addEventListener('pointerdown', function () { ensureAudio(); }, { passive: true });
function beep(freq, dur, type, vol, when) {
  if (!soundOn) return;
  var ac = ensureAudio(); if (!ac) return;
  try {
    var t = ac.currentTime + (when || 0);
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + dur);
  } catch (e) {}
}
function sndPlace() {
  if (!soundOn) return;
  var ac = ensureAudio(); if (!ac) return;
  try {
    var t = ac.currentTime;
    // 咔哒：白噪声短脉冲过带通（石质脆响）
    var len = Math.max(1, Math.floor(ac.sampleRate * 0.055));
    var buf = ac.createBuffer(1, len, ac.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ac.createBufferSource(); src.buffer = buf;
    var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1750; bp.Q.value = 0.9;
    var ng = ac.createGain();
    ng.gain.setValueAtTime(0.85, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(bp); bp.connect(ng); ng.connect(ac.destination);
    src.start(t);
    // 木盘共鸣：低频正弦快速滑落 + 衰减
    var o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(235, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.09);
    og.gain.setValueAtTime(0.4, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    o.connect(og); og.connect(ac.destination);
    o.start(t); o.stop(t + 0.12);
  } catch (e) {}
}
function sndWin() { [523, 659, 784, 1047].forEach(function (f, i) { beep(f, 0.22, 'sine', 0.12, i * 0.11); }); }
function sndLose() { [392, 330, 262].forEach(function (f, i) { beep(f, 0.22, 'sine', 0.1, i * 0.12); }); }
function vibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) {} } }

// ---------- 弹层 / Toast ----------
function showModal(title, body, btns) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body || '';
  var box = $('modalBtns'); box.innerHTML = '';
  (btns || [{ label: '知道了' }]).forEach(function (b) {
    var btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = b.ghost ? 'ghost-btn' : 'primary';
    btn.onclick = function () { closeModal(); if (b.cb) b.cb(); };
    box.appendChild(btn);
  });
  $('modalWrap').classList.add('show');
}
function closeModal() { $('modalWrap').classList.remove('show'); }
$('modalWrap').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
var toastTimer = null;
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
}

// ---------- 状态栏 / 信息 ----------
function setStatus(html) { $('statusBar').innerHTML = html; }
function thinkingStatus() { setStatus('<span class="spin"></span>AI 思考中…'); }
function turnStatus() {
  if (gameOver) return;
  if (mode === 'ai') setStatus(turn === myColor ? '轮到你落子' : 'AI 思考中…');
  else if (mode === 'local') setStatus('轮到' + stoneName(turn) + '落子');
  else setStatus(turn === myColor ? '轮到你落子' : '等待对方落子…');
}
function refreshChips() {
  $('chip1').classList.toggle('turn', !gameOver && turn === 1);
  $('chip2').classList.toggle('turn', !gameOver && turn === 2);
  var names;
  if (mode === 'ai') names = myColor === 1 ? ['你', 'AI'] : ['AI', '你'];
  else if (mode === 'local') names = ['玩家一', '玩家二'];
  else names = myColor === 1 ? ['你', '对手'] : ['对手', '你'];
  $('who1').textContent = names[0] + ' · 黑'; $('who2').textContent = names[1] + ' · 白';
  $('sub1').textContent = mode === 'ai' && myColor !== 1 ? diffName() : (mode === 'online' && myColor !== 1 ? '房主/对手' : '');
  $('sub2').textContent = mode === 'ai' && myColor === 1 ? diffName() : '';
  $('diffWrap').style.display = mode === 'ai' ? '' : 'none';
}
function diffName() { return { easy: '简单 AI', normal: '普通 AI', hard: '困难 AI', master: '大师 AI' }[difficulty]; }
function refreshMeta() {
  var sec = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  var mm = ('0' + Math.floor(sec / 60)).slice(-2), ss = ('0' + (sec % 60)).slice(-2);
  $('moveInfo').textContent = '第 ' + moves.length + ' 手 · ' + mm + ':' + ss;
}
function renderHistory() {
  var h = $('history'); h.innerHTML = '';
  moves.forEach(function (m, i) {
    var el = document.createElement('span'); el.className = 'mv';
    el.innerHTML = (i + 1) + '. <b>' + (m.player === 1 ? '⚫' : '⚪') + notation(m.x, m.y) + '</b>';
    h.appendChild(el);
  });
  h.scrollLeft = h.scrollWidth;
}
function renderStats() {
  $('statW').textContent = stats.w; $('statL').textContent = stats.l; $('statD').textContent = stats.d;
  var tot = stats.w + stats.l + stats.d;
  $('statRate').textContent = tot ? Math.round(stats.w / tot * 100) + '%' : '—';
}

// ---------- 棋盘绘制 ----------
var view = { size: 0, dpr: 1, pad: 0, cell: 0 };
function fitCanvas() {
  var wrap = canvas.parentElement;
  var w = wrap.clientWidth; if (!w) return;
  view.dpr = Math.min(window.devicePixelRatio || 1, 3);
  view.size = w;
  canvas.width = Math.round(w * view.dpr);
  canvas.height = Math.round(w * view.dpr);
  view.pad = w / (N + 1);
  view.cell = (w - 2 * view.pad) / (N - 1);
  draw();
}
function px(x) { return view.pad + x * view.cell; }
function draw() {
  if (!view.size) return;
  var S = view.size, dpr = view.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 盘面
  var g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#e3b26a'); g.addColorStop(0.5, '#d9a558'); g.addColorStop(1, '#c98f3f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(122,78,32,.16)'; ctx.lineWidth = 1;
  for (var t = 0; t < S; t += 7) { ctx.beginPath(); ctx.moveTo(0, t + 0.5); ctx.lineTo(S, t + 2.5); ctx.stroke(); }
  // 坐标
  ctx.fillStyle = 'rgba(90,55,18,.85)';
  ctx.font = '600 ' + Math.max(9, view.cell * 0.34) + 'px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (var i = 0; i < N; i++) {
    ctx.fillText('ABCDEFGHIJKLMNO'.charAt(i), px(i), view.pad * 0.42);
    ctx.fillText('ABCDEFGHIJKLMNO'.charAt(i), px(i), S - view.pad * 0.42);
    ctx.fillText(String(15 - i), view.pad * 0.42, px(i));
    ctx.fillText(String(15 - i), S - view.pad * 0.42, px(i));
  }
  // 网格
  ctx.strokeStyle = 'rgba(74,46,16,.92)'; ctx.lineWidth = 1;
  for (i = 0; i < N; i++) {
    ctx.beginPath(); ctx.moveTo(px(0), px(i)); ctx.lineTo(px(N - 1), px(i)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px(i), px(0)); ctx.lineTo(px(i), px(N - 1)); ctx.stroke();
  }
  ctx.lineWidth = 2; ctx.strokeRect(px(0), px(0), view.cell * (N - 1), view.cell * (N - 1));
  // 星位
  ctx.fillStyle = 'rgba(74,46,16,.95)';
  [3, 7, 11].forEach(function (sx) { [3, 7, 11].forEach(function (sy) {
    ctx.beginPath(); ctx.arc(px(sx), px(sy), Math.max(2.4, view.cell * 0.1), 0, Math.PI * 2); ctx.fill();
  }); });
  if (!board) return;
  // 提示落点
  if (hintCell && !gameOver) {
    ctx.strokeStyle = '#2f9e44'; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.arc(px(hintCell.x), px(hintCell.y), view.cell * 0.52, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(47,158,68,.25)';
    ctx.beginPath(); ctx.arc(px(hintCell.x), px(hintCell.y), view.cell * 0.52, 0, Math.PI * 2); ctx.fill();
  }
  // 预览（触摸/悬停）
  var pv = previewCell || hoverCell;
  if (pv && !gameOver && board[pv.y][pv.x] === 0 && canHumanPlay()) drawStone(pv.x, pv.y, turn, 0.5, true);
  // 棋子
  for (i = 0; i < moves.length; i++) drawStone(moves[i].x, moves[i].y, moves[i].player, 1, false);
  // 最后一手标记
  if (moves.length) {
    var last = moves[moves.length - 1];
    ctx.fillStyle = '#e03131';
    ctx.beginPath(); ctx.arc(px(last.x), px(last.y), Math.max(2.6, view.cell * 0.11), 0, Math.PI * 2); ctx.fill();
  }
  // 获胜连线
  if (winCells.length >= 2) {
    var a = winCells[0], b2 = winCells[winCells.length - 1];
    ctx.strokeStyle = 'rgba(224,49,49,.88)'; ctx.lineWidth = Math.max(3, view.cell * 0.14); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(px(a.x), px(a.y)); ctx.lineTo(px(b2.x), px(b2.y)); ctx.stroke();
    winCells.forEach(function (c) {
      ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(px(c.x), px(c.y), view.cell * 0.5, 0, Math.PI * 2); ctx.stroke();
    });
  }
}
function drawStone(x, y, p, alpha, ghost) {
  var cx = px(x), cy = px(y), r = view.cell * 0.46;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (!ghost) { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2; }
  var g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r);
  if (p === 1) { g.addColorStop(0, '#6b6b6b'); g.addColorStop(0.55, '#232323'); g.addColorStop(1, '#000'); }
  else { g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#f1f1f1'); g.addColorStop(1, '#c4c4c4'); }
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}
window.addEventListener('resize', fitCanvas);

// ---------- 胜负 ----------
function findWinLine(x, y, p) {
  var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var d = 0; d < 4; d++) {
    var dx = dirs[d][0], dy = dirs[d][1], cells = [{ x: x, y: y }], s, nx, ny;
    for (s = 1; s >= -1; s -= 2) {
      nx = x + dx * s; ny = y + dy * s;
      while (nx >= 0 && nx < N && ny >= 0 && ny < N && board[ny][nx] === p) { cells.push({ x: nx, y: ny }); nx += dx * s; ny += dy * s; }
    }
    if (cells.length >= 5) {
      cells.sort(function (a, b) { return (a.x - b.x) || (a.y - b.y); });
      return cells;
    }
  }
  return null;
}

// ---------- 对局流程 ----------
function showGame() {
  $('homeView').style.display = 'none';
  $('gameView').classList.add('show');
  requestAnimationFrame(fitCanvas);
}
function showHome() {
  $('gameView').classList.remove('show');
  $('homeView').style.display = '';
  if (ws) {
    // 先发 bye 让对方立即看到离开通知，不等 TCP 关闭握手（移动端切后台时握手可能延迟很久）
    try { if (mode === 'online' && ws.readyState === 1) ws.send(JSON.stringify({ type: 'bye' })); } catch (e) {}
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  stopTimer(); renderStats();
}
function resetGame() {
  board = emptyBoard(); moves = []; turn = 1; gameOver = false; resultCounted = false;
  winCells = []; hoverCell = null; previewCell = null; hintCell = null; thinking = false;
  startTime = Date.now();
  stopTimer(); timerId = setInterval(refreshMeta, 1000);
  refreshChips(); renderHistory(); refreshMeta(); draw();
}
function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

function startAI() {
  mode = 'ai'; myColor = pickColorVal; aiColor = myColor === 1 ? 2 : 1;
  difficulty = currentDiff();
  $('diffSelect').value = difficulty;
  $('roomBar').classList.remove('show');
  showGame(); resetGame();
  if (myColor === 1) setStatus('你执黑先行，请落子');
  else { setStatus('AI 执黑先行'); setTimeout(aiTurn, 450); }
}
function startLocal() {
  mode = 'local'; myColor = 1;
  $('roomBar').classList.remove('show');
  showGame(); resetGame();
  setStatus('双人对战 · 黑棋先行');
}
function currentDiff() {
  var b = document.querySelector('#diffSeg button.active');
  return b ? b.getAttribute('data-diff') : 'normal';
}

function canHumanPlay() {
  if (gameOver || thinking || !board) return false;
  if (mode === 'local') return true;
  return turn === myColor;
}

function humanPlace(x, y) {
  if (!canHumanPlay() || board[y][x] !== 0) return;
  if (mode === 'online') {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'move', x: x, y: y }));
    return;
  }
  applyMove(x, y, turn);
  if (!gameOver && mode === 'ai') setTimeout(aiTurn, 120);
}

function applyMove(x, y, p) {
  board[y][x] = p;
  moves.push({ x: x, y: y, player: p });
  turn = p === 1 ? 2 : 1;
  sndPlace(); vibrate(8);
  var line = findWinLine(x, y, p);
  if (line) { winCells = line; gameOver = true; onGameEnd(p, 'five'); }
  else if (moves.length === N * N) { gameOver = true; onGameEnd(0, 'draw-full'); }
  refreshChips(); renderHistory(); refreshMeta(); draw();
  if (!gameOver) turnStatus();
}

function aiTurn() {
  if (gameOver || mode !== 'ai' || turn !== aiColor) return;
  thinking = true; thinkingStatus(); draw();
  setTimeout(function () {
    var res;
    try { res = GomokuAI.findBestMove(board, aiColor, difficulty); }
    catch (e) { res = GomokuAI.greedyMove(board, aiColor); }
    thinking = false;
    if (gameOver) return;
    applyMove(res.x, res.y, aiColor);
  }, 70);
}

function onGameEnd(winner, reason) {
  stopTimer(); refreshChips();
  var title, body, mine = false;
  if (winner === 0) { title = '🤝 平局'; body = reason === 'draw' ? '双方同意和棋。' : '棋盘已满，平局。'; }
  else if (mode === 'ai') {
    mine = winner === myColor;
    title = mine ? '🎉 你赢了！' : '🤖 AI 获胜';
    body = mine ? '漂亮！你战胜了' + diffName() + '。' : diffName() + '技高一筹，再接再厉。';
  } else if (mode === 'local') { title = '🎉 ' + stoneName(winner) + '获胜'; body = '本局共 ' + moves.length + ' 手。'; mine = true; }
  else {
    mine = winner === myColor;
    title = mine ? '🎉 你赢了！' : '对方获胜';
    body = reason === 'resign' ? (mine ? '对方已认输。' : '你已认输。') : '本局共 ' + moves.length + ' 手。';
  }
  if (winner !== 0) { if (mode !== 'ai' || mine) sndWin(); else sndLose(); vibrate([60, 40, 60]); }
  setStatus(title.replace(/🎉|🤖|🤝/g, '').trim());
  if (mode === 'ai' && !resultCounted) {
    resultCounted = true;
    if (winner === 0) stats.d++; else if (winner === myColor) stats.w++; else stats.l++;
    saveJSON('gomoku-stats-v2', stats); renderStats();
  }
  setTimeout(function () {
    showModal(title, body, [
      { label: '再来一局', cb: function () { restartGame(); } },
      { label: '返回主页', ghost: true, cb: function () { showHome(); } }
    ]);
  }, 650);
}

// ---------- 悔棋 / 重开 / 认输 / 和棋 / 提示 ----------
function popMove() {
  var m = moves.pop();
  if (m) board[m.y][m.x] = 0;
  return m;
}
function afterUndoCleanup() {
  gameOver = false; winCells = []; resultCounted = resultCounted && false;
  refreshChips(); renderHistory(); refreshMeta(); draw();
}
function doUndo() {
  if (thinking) return toast('AI 思考中，稍等一下');
  if (mode === 'ai') {
    if (!moves.length) return toast('还没有落子');
    // 撤掉 AI 的应招 + 自己上一手（若最后一手是自己的则只撤一手），回到自己落子前
    var last = moves[moves.length - 1];
    if (last.player === aiColor) popMove();
    if (moves.length && moves[moves.length - 1].player === myColor) popMove();
    else if (last.player === myColor) { /* 已在上一行撤掉 */ }
    if (!moves.length && myColor === 2) { /* 白棋开局前无棋可悔 */ }
    turn = myColor;
    afterUndoCleanup();
    setStatus('已悔棋，轮到你落子');
    if (myColor === 2 && moves.length === 0) { setStatus('已悔棋，AI 重新先行'); setTimeout(aiTurn, 350); }
  } else if (mode === 'local') {
    if (!moves.length) return toast('还没有落子');
    var m = popMove(); turn = m.player;
    afterUndoCleanup(); turnStatus();
  } else if (mode === 'online') {
    if (!moves.length) return toast('还没有落子');
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'undo_req' })); toast('已发送悔棋请求'); }
  }
}
function restartGame() {
  if (mode === 'online') {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'restart_req' })); toast('已发送重开请求，等待对方同意'); }
    return;
  }
  resetGame();
  if (mode === 'ai') {
    if (myColor === 1) setStatus('新对局 · 你执黑先行');
    else { setStatus('新对局 · AI 先行'); setTimeout(aiTurn, 400); }
  } else setStatus('新对局 · 黑棋先行');
}
function doResign() {
  if (gameOver) return;
  showModal('确认认输？', '认输后本局将判负。', [
    { label: '确认认输', cb: function () {
        if (mode === 'online') { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resign' })); }
        else { gameOver = true; onGameEnd(turn === 1 ? 2 : 1, 'resign'); draw(); }
      } },
    { label: '继续对局', ghost: true }
  ]);
}
function doDrawOffer() {
  if (gameOver) return;
  if (mode === 'online') {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'draw_req' })); toast('已发送和棋请求'); }
  } else {
    showModal('同意和棋？', mode === 'ai' ? 'AI 表示：可以，本局和棋。' : '双方同意后本局和棋。', [
      { label: '和棋', cb: function () { gameOver = true; onGameEnd(0, 'draw'); draw(); } },
      { label: '继续对局', ghost: true }
    ]);
  }
}
function doHint() {
  if (!canHumanPlay()) return toast('现在不能提示');
  thinking = true; setStatus('正在计算提示…');
  var forColor = turn;
  setTimeout(function () {
    var res;
    try { res = GomokuAI.hintMove(board, forColor); } catch (e) { res = GomokuAI.greedyMove(board, forColor); }
    thinking = false;
    hintCell = { x: res.x, y: res.y };
    setStatus('提示：' + notation(res.x, res.y));
    draw();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hintCell = null; draw(); turnStatus(); }, 2600);
  }, 60);
}

// ---------- 棋盘指针交互（鼠标悬停 + 触摸预览后松手落子） ----------
function eventCell(e) {
  var rect = canvas.getBoundingClientRect();
  var cx = (e.clientX - rect.left) * (view.size / rect.width);
  var cy = (e.clientY - rect.top) * (view.size / rect.height);
  var gx = Math.round((cx - view.pad) / view.cell);
  var gy = Math.round((cy - view.pad) / view.cell);
  if (gx < 0 || gx >= N || gy < 0 || gy >= N) return null;
  if (Math.abs(cx - px(gx)) > view.cell * 0.52 || Math.abs(cy - px(gy)) > view.cell * 0.52) return null;
  return { x: gx, y: gy };
}
canvas.addEventListener('pointermove', function (e) {
  var c = eventCell(e);
  if (e.pointerType === 'mouse') {
    if (!hoverCell || !c || hoverCell.x !== c.x || hoverCell.y !== c.y) { hoverCell = c; draw(); }
  } else if (previewCell) {
    previewCell = c; draw();
  }
});
canvas.addEventListener('pointerdown', function (e) {
  if (!canHumanPlay()) return;
  var c = eventCell(e);
  if (c && board[c.y][c.x] === 0) { previewCell = c; try { canvas.setPointerCapture(e.pointerId); } catch (err) {} draw(); }
});
canvas.addEventListener('pointerup', function (e) {
  var c = eventCell(e) || previewCell;
  var pv = previewCell;
  previewCell = null;
  if (!canHumanPlay()) { draw(); return; }
  var target = (c && pv && c.x === pv.x && c.y === pv.y) ? c : (e.pointerType === 'mouse' ? c : pv);
  if (target && board[target.y][target.x] === 0) humanPlace(target.x, target.y);
  draw();
});
canvas.addEventListener('pointercancel', function () { previewCell = null; draw(); });
canvas.addEventListener('pointerleave', function () { hoverCell = null; if (!previewCell) draw(); });

// ---------- 工具栏 ----------
$('undoBtn').onclick = doUndo;
$('hintBtn').onclick = doHint;
$('restartBtn').onclick = function () {
  if (mode === 'online') restartGame();
  else showModal('重新开始？', '当前对局将被清空。', [
    { label: '重新开始', cb: restartGame },
    { label: '取消', ghost: true }
  ]);
};
$('moreBtn').onclick = function () {
  showModal('更多操作', '', [
    { label: '🏳 认输', cb: doResign },
    { label: '🤝 提议和棋', cb: doDrawOffer },
    { label: '🏠 返回主页', ghost: true, cb: showHome },
    { label: '关闭', ghost: true }
  ]);
};
$('diffSelect').addEventListener('change', function () {
  difficulty = this.value;
  document.querySelectorAll('#diffSeg button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-diff') === difficulty);
  });
  refreshChips(); toast('难度已切换为' + diffName());
});

// ---------- 主页交互 ----------
document.querySelectorAll('.mode-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    selectedMode = btn.getAttribute('data-mode');
    document.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
    ['ai', 'local', 'online'].forEach(function (m) { $('setup-' + m).classList.toggle('show', m === selectedMode); });
  });
});
function segWire(id, attr, cb) {
  document.querySelectorAll('#' + id + ' button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#' + id + ' button').forEach(function (o) { o.classList.toggle('active', o === b); });
      cb(b.getAttribute(attr));
    });
  });
}
segWire('diffSeg', 'data-diff', function (v) { difficulty = v; });
segWire('colorSeg', 'data-color', function (v) { pickColorVal = parseInt(v, 10); });
segWire('olColorSeg', 'data-color', function (v) { olColorVal = parseInt(v, 10); });
$('startAiBtn').onclick = startAI;
$('startLocalBtn').onclick = startLocal;
$('soundBtn').onclick = function () {
  soundOn = !soundOn; saveJSON('gomoku-sound', soundOn);
  this.textContent = soundOn ? '🔊' : '🔇';
  if (soundOn) sndPlace();
};
$('soundBtn').textContent = soundOn ? '🔊' : '🔇';

// ---------- 联机 ----------
function connectOnline(id, isCreator) {
  mode = 'online'; roomId = id;
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var q = isCreator ? ('?color=' + olColorVal) : '';
  ws = new WebSocket(proto + '://' + location.host + '/room/' + id + '/ws' + q);
  showGame(); resetGame();
  $('roomBar').classList.add('show');
  $('roomCode').textContent = id;
  setStatus('正在连接服务器…');
  ws.onopen = function () { setStatus('已连接，等待对手加入…'); };
  ws.onmessage = function (ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'welcome') {
      myColor = msg.player;
      if (msg.moves && msg.moves.length) rebuildFromMoves(msg.moves);
      refreshChips();
    }
    if (msg.type === 'waiting') setStatus('等待对手加入 · 房间号 ' + roomId);
    if (msg.type === 'start') { turn = msg.turn; refreshChips(); setStatus(myColor === 1 ? '对局开始 · 你执黑先行' : '对局开始 · 对方先行'); toast('对手已加入，对局开始'); }
    if (msg.type === 'move') {
      if (board[msg.y][msg.x] === 0) applyMove(msg.x, msg.y, msg.player);
      if (msg.winner) gameOver = true;
      if (msg.draw) { gameOver = true; onGameEnd(0, 'draw-full'); }
    }
    if (msg.type === 'sync') {
      rebuildFromMoves(msg.moves);
      gameOver = false; winCells = [];
      if (msg.note === 'undo') { setStatus('悔棋成功'); toast('悔棋成功'); }
      if (msg.note === 'restart') { startTime = Date.now(); setStatus('新对局开始'); turnStatus(); }
      draw();
    }
    if (msg.type === 'gameover') {
      gameOver = true;
      onGameEnd(msg.winner, msg.reason);
      draw();
    }
    if (msg.type === 'undo_req') {
      showModal('对方请求悔棋', '同意后将回退到对方上一次落子之前。', [
        { label: '同意悔棋', cb: function () { ws.send(JSON.stringify({ type: 'undo_ack' })); } },
        { label: '拒绝', ghost: true, cb: function () { ws.send(JSON.stringify({ type: 'undo_deny' })); } }
      ]);
    }
    if (msg.type === 'undo_deny') toast('对方拒绝了悔棋请求');
    if (msg.type === 'restart_req') {
      showModal('对方请求重新开始', '同意后将清空棋盘重新对局。', [
        { label: '同意重开', cb: function () { ws.send(JSON.stringify({ type: 'restart_ack' })); } },
        { label: '拒绝', ghost: true, cb: function () { ws.send(JSON.stringify({ type: 'restart_deny' })); } }
      ]);
    }
    if (msg.type === 'restart_deny') toast('对方拒绝了重新开始');
    if (msg.type === 'draw_req') {
      showModal('对方提议和棋', '同意后本局以平局结束。', [
        { label: '同意和棋', cb: function () { ws.send(JSON.stringify({ type: 'draw_ack' })); } },
        { label: '拒绝', ghost: true, cb: function () { ws.send(JSON.stringify({ type: 'draw_deny' })); } }
      ]);
    }
    if (msg.type === 'draw_deny') toast('对方拒绝了和棋提议');
    if (msg.type === 'leave') { gameOver = true; stopTimer(); setStatus('对方已离开房间'); toast('对方已离开房间'); draw(); }
  };
  ws.onclose = function () { if (mode === 'online' && !gameOver) setStatus('连接已断开，请返回主页重试'); };
  ws.onerror = function () { toast('连接失败，请稍后重试'); };
}
function rebuildFromMoves(mvs) {
  board = emptyBoard(); moves = [];
  mvs.forEach(function (m) { board[m.y][m.x] = m.player; moves.push({ x: m.x, y: m.y, player: m.player }); });
  turn = moves.length ? (moves[moves.length - 1].player === 1 ? 2 : 1) : 1;
  winCells = [];
  refreshChips(); renderHistory(); refreshMeta(); draw();
}
$('createRoomBtn').onclick = function () {
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789', id = '';
  for (var i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  connectOnline(id, true);
};
$('joinRoomBtn').onclick = function () {
  var id = $('roomInput').value.trim().toLowerCase();
  if (id.length < 4) return toast('请输入至少 4 位房间号');
  connectOnline(id, false);
};
$('copyRoomBtn').onclick = function () {
  var code = roomId || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(function () { toast('房间号已复制'); }, function () { toast('房间号：' + code); });
  } else toast('房间号：' + code);
};

// ---------- 初始化 ----------
board = emptyBoard();
renderStats();
fitCanvas();
</script>
</body>
</html>`;
