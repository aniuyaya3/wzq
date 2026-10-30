// ============ Durable Object：房间状态同步（支持悔棋/重开协商、选边） ============
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = []; // {socket, player}
    this.moves = [];    // [{x,y,player}]
    this.turn = 1;
    this.winner = 0;
    this.creatorColor = 1; // 房主选择的颜色
  }

  board() {
    const b = Array.from({ length: 15 }, () => Array(15).fill(0));
    for (const m of this.moves) b[m.y][m.x] = m.player;
    return b;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      if (this.sessions.length >= 2) return new Response("Room is full", { status: 403 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);

      // 房主（第一个连入）可指定颜色，加入者拿剩余颜色
      let player;
      if (this.sessions.length === 0) {
        this.creatorColor = parseInt(url.searchParams.get("color")) === 2 ? 2 : 1;
        player = this.creatorColor;
      } else {
        player = this.creatorColor === 1 ? 2 : 1;
      }
      this.sessions.push({ socket: pair[1], player });
      pair[1].serializeAttachment({ player });
      this.sendTo(pair[1], { type: "welcome", player });

      if (this.sessions.length === 2) {
        this.broadcast({ type: "start", turn: this.turn });
      } else {
        this.sendTo(pair[1], { type: "waiting" });
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const { player } = ws.serializeAttachment();

    switch (data.type) {
      case "move": {
        if (this.winner !== 0 || player !== this.turn) return;
        const { x, y } = data;
        const b = this.board();
        if (x < 0 || x > 14 || y < 0 || y > 14 || b[y][x] !== 0) return;
        this.moves.push({ x, y, player });
        this.turn = player === 1 ? 2 : 1;
        const winner = this.checkWin(x, y, player);
        if (winner) this.winner = winner;
        this.broadcast({ type: "move", x, y, player, turn: this.turn, winner: this.winner });
        break;
      }
      case "undo_req": {
        // 请求悔棋：转发给对方，等对方同意
        const opponent = this.sessions.find(s => s.player !== player);
        if (opponent) this.sendTo(opponent.socket, { type: "undo_req" });
        break;
      }
      case "undo_ack": {
        // 对方同意：回退到「请求者上一次落子之前」
        const requester = this.sessions.find(s => s.socket !== ws);
        if (!requester || this.moves.length === 0) return;
        while (this.moves.length > 0) {
          const last = this.moves.pop();
          this.turn = last.player;
          if (last.player === requester.player) break; // 弹到请求者那步为止
        }
        this.winner = 0;
        this.broadcast({ type: "sync", moves: this.moves, turn: this.turn, winner: 0, note: "undo" });
        break;
      }
      case "undo_deny": {
        const requester = this.sessions.find(s => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "undo_deny" });
        break;
      }
      case "restart_req": {
        const opponent = this.sessions.find(s => s.player !== player);
        if (opponent) this.sendTo(opponent.socket, { type: "restart_req" });
        break;
      }
      case "restart_ack": {
        this.moves = [];
        this.turn = 1;
        this.winner = 0;
        this.broadcast({ type: "sync", moves: [], turn: 1, winner: 0, note: "restart" });
        break;
      }
    }
  }

  webSocketClose(ws) {
    this.sessions = this.sessions.filter(s => s.socket !== ws);
    this.broadcast({ type: "leave" });
  }

  checkWin(x, y, p) {
    const b = this.board();
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let c = 1;
      for (const s of [1, -1]) {
        let nx = x + dx * s, ny = y + dy * s;
        while (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && b[ny][nx] === p) { c++; nx += dx * s; ny += dy * s; }
      }
      if (c >= 5) return p;
    }
    return 0;
  }

  sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) { for (const s of this.sessions) this.sendTo(s.socket, obj); }
}

// ============ Worker 入口 ============
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([a-z0-9]{4,8})\/ws$/);
    if (match) {
      const stub = env.ROOM.get(env.ROOM.idFromName(match[1]));
      return stub.fetch(url.toString(), request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_PAGE, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};

// ============ 前端页面 ============
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>五子棋</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee;
         min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 16px; }
  h1 { margin: 8px 0 12px; }
  #status { margin-bottom: 12px; font-size: 17px; min-height: 26px; color: #ffd369; text-align: center; }
  #menu { display: flex; flex-direction: column; gap: 10px; margin-top: 40px; width: 260px; }
  .btn { padding: 12px 24px; font-size: 17px; border: 1px solid #0f3460; border-radius: 8px;
         background: #16213e; color: #eee; cursor: pointer; }
  .btn:hover { background: #0f3460; }
  .btn.small { padding: 8px 14px; font-size: 14px; }
  #colorPick { display: none; flex-direction: column; gap: 10px; margin-top: 40px; width: 260px; }
  #roomBar { display: none; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; justify-content: center; }
  #roomBar input, #roomBar select { padding: 8px; border-radius: 6px; border: none; font-size: 15px; }
  #roomBar input { width: 100px; }
  #toolbar { display: none; gap: 8px; margin-bottom: 10px; }
  #board { background: #d4a055; border-radius: 6px; box-shadow: 0 4px 20px rgba(0,0,0,.5);
           touch-action: manipulation; max-width: 95vw; cursor: pointer; }
  #backBtn { position: fixed; top: 12px; left: 12px; }
</style>
</head>
<body>
<h1>♞ 五子棋</h1>
<div id="status"></div>

<div id="roomBar">
  <select id="myColor">
    <option value="1">我执黑</option>
    <option value="2">我执白</option>
  </select>
  <input id="roomInput" placeholder="房间号" maxlength="8">
  <button class="btn small" onclick="createRoom()">创建房间</button>
  <button class="btn small" onclick="joinRoom()">加入房间</button>
</div>

<div id="toolbar">
  <button class="btn small" onclick="undo()">↩ 悔棋</button>
  <button class="btn small" onclick="restart()">🔄 重新开始</button>
</div>

<canvas id="board" width="450" height="450"></canvas>

<div id="menu">
  <button class="btn" onclick="pickColor('ai')">👤 人机对战</button>
  <button class="btn" onclick="pickColor('online')">🌐 真人对战</button>
</div>

<div id="colorPick">
  <button class="btn" onclick="chosenColor(1)">⚫ 我执黑（先手）</button>
  <button class="btn" onclick="chosenColor(2)">⚪ 我执白（后手）</button>
</div>

<button id="backBtn" class="btn small" style="display:none" onclick="location.reload()">← 返回</button>

<script>
const N = 15, CELL = 30, PAD = 15;
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');

let mode = null, board, turn, myColor, aiColor, gameOver, ws = null;
let moves = []; // [{x,y,player}]

canvas.style.display = 'none';

// ---------- 界面流转 ----------
function pickColor(m) {
  mode = m;
  document.getElementById('menu').style.display = 'none';
  document.getElementById('backBtn').style.display = 'block';
  if (m === 'ai') {
    document.getElementById('colorPick').style.display = 'flex';
    setStatus('请选择你的棋子颜色');
  } else {
    document.getElementById('roomBar').style.display = 'flex';
    setStatus('选择颜色后创建房间，或输入房间号加入');
  }
}

function chosenColor(c) {
  document.getElementById('colorPick').style.display = 'none';
  myColor = c;
  aiColor = c === 1 ? 2 : 1;
  resetGame();
  setStatus(c === 1 ? '你执黑先行' : '你执白，AI 先行');
  if (c === 2) setTimeout(aiMove, 300);
}

// ---------- 游戏状态 ----------
function resetGame() {
  board = Array.from({length: N}, () => Array(N).fill(0));
  moves = [];
  turn = 1;
  gameOver = false;
  canvas.style.display = 'block';
  document.getElementById('toolbar').style.display = 'flex';
  document.getElementById('backBtn').style.display = 'block';
  drawBoard();
}

function rebuild(mvs) {
  board = Array.from({length: N}, () => Array(N).fill(0));
  moves = mvs;
  for (const m of mvs) board[m.y][m.x] = m.player;
  turn = mvs.length ? (mvs[mvs.length-1].player === 1 ? 2 : 1) : 1;
  gameOver = false;
  drawBoard();
  setStatus(mode === 'online'
    ? (turn === myColor ? '轮到你了' : '等待对方落子...')
    : (turn === myColor ? '轮到你落子' : 'AI 思考中...'));
}

// ---------- 绘制 ----------
function drawBoard() {
  ctx.fillStyle = '#d4a055';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#7a5230'; ctx.lineWidth = 1;
  for (let i = 0; i < N; i++) {
    ctx.beginPath(); ctx.moveTo(PAD + i*CELL, PAD); ctx.lineTo(PAD + i*CELL, PAD + (N-1)*CELL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD, PAD + i*CELL); ctx.lineTo(PAD + (N-1)*CELL, PAD + i*CELL); ctx.stroke();
  }
  for (const [sx, sy] of [[3,3],[11,3],[3,11],[11,11],[7,7]]) {
    ctx.beginPath(); ctx.arc(PAD + sx*CELL, PAD + sy*CELL, 3, 0, Math.PI*2);
    ctx.fillStyle = '#7a5230'; ctx.fill();
  }
  for (const m of moves) drawStone(m.x, m.y, m.player);
  // 最后一手标记
  if (moves.length) {
    const last = moves[moves.length - 1];
    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 2;
    ctx.strokeRect(PAD + last.x*CELL - 4, PAD + last.y*CELL - 4, 8, 8);
  }
}
function drawStone(x, y, p) {
  const cx = PAD + x*CELL, cy = PAD + y*CELL;
  const g = ctx.createRadialGradient(cx-3, cy-3, 2, cx, cy, 13);
  if (p === 1) { g.addColorStop(0, '#666'); g.addColorStop(1, '#000'); }
  else { g.addColorStop(0, '#fff'); g.addColorStop(1, '#ccc'); }
  ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI*2);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.stroke();
}

// ---------- 落子 ----------
canvas.addEventListener('click', (e) => {
  if (gameOver || turn !== myColor) return;
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  const gx = Math.round(((e.clientX - rect.left) * scale - PAD) / CELL);
  const gy = Math.round(((e.clientY - rect.top) * scale - PAD) / CELL);
  if (gx < 0 || gx >= N || gy < 0 || gy >= N || board[gy][gx] !== 0) return;

  if (mode === 'ai') {
    place(gx, gy, myColor);
    if (!gameOver) { setStatus('AI 思考中...'); setTimeout(aiMove, 80); }
  } else if (mode === 'online') {
    ws.send(JSON.stringify({ type: 'move', x: gx, y: gy }));
  }
});

function place(x, y, p) {
  board[y][x] = p;
  moves.push({x, y, player: p});
  turn = p === 1 ? 2 : 1;
  drawBoard();
  if (checkWin(x, y, p)) {
    gameOver = true;
    const name = p === 1 ? '黑棋' : '白棋';
    if (mode === 'ai') setStatus(p === aiColor ? 'AI 获胜！再接再厉' : '你赢了！🎉');
    else setStatus(p === myColor ? '你赢了！🎉' : '对方获胜');
  } else if (moves.length === N*N) {
    gameOver = true; setStatus('平局！');
  } else {
    setStatus(mode === 'online'
      ? (turn === myColor ? '轮到你了' : '等待对方落子...')
      : (turn === myColor ? '轮到你落子' : ''));
  }
}

function checkWin(x, y, p) {
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let c = 1;
    for (const s of [1, -1]) {
      let nx = x + dx*s, ny = y + dy*s;
      while (nx >= 0 && nx < N && ny >= 0 && ny < N && board[ny][nx] === p) { c++; nx += dx*s; ny += dy*s; }
    }
    if (c >= 5) return true;
  }
  return false;
}

function setStatus(s) { statusEl.textContent = s; }

// ---------- 悔棋 / 重新开始 ----------
function undo() {
  if (mode === 'ai') {
    // 撤销自己 + AI 各一步（如果都存在），回到自己落子前
    let n = 0;
    while (moves.length > 0 && n < 2) {
      const last = moves[moves.length - 1];
      if (n === 0 && last.player !== myColor) break; // 最后一步不是自己的（AI 未落），只撤自己
      board[last.y][last.x] = 0;
      moves.pop();
      turn = last.player;
      n++;
      if (last.player === myColor && n >= 1 && (moves.length === 0 || moves[moves.length-1].player === aiColor)) {
        // 再撤掉 AI 那一步
      }
    }
    // 简化处理：保证撤完后轮到自己
    if (moves.length && moves[moves.length-1].player === aiColor) {
      const last = moves.pop();
      board[last.y][last.x] = 0;
      turn = last.player;
    }
    gameOver = false;
    turn = myColor;
    drawBoard();
    setStatus('已悔棋，轮到你落子');
  } else if (mode === 'online' && ws && ws.readyState === 1) {
    if (moves.length === 0) return setStatus('还没有落子');
    ws.send(JSON.stringify({ type: 'undo_req' }));
    setStatus('已发送悔棋请求，等待对方同意...');
  }
}

function restart() {
  if (mode === 'ai') {
    resetGame();
    setStatus(myColor === 1 ? '新对局，你执黑先行' : '新对局，AI 先行');
    if (myColor === 2) setTimeout(aiMove, 300);
  } else if (mode === 'online' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'restart_req' }));
    setStatus('已发送重新开始请求，等待对方同意...');
  }
}

// ---------- 联机 ----------
function createRoom() {
  const id = Math.random().toString(36).slice(2, 8);
  document.getElementById('roomInput').value = id;
  connect(id);
}
function joinRoom() {
  const id = document.getElementById('roomInput').value.trim();
  if (id.length < 4) return setStatus('请输入至少 4 位房间号');
  connect(id, true);
}
function connect(id, isJoin) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const color = isJoin ? '' : '?color=' + (document.getElementById('myColor').value === '2' ? 2 : 1);
  ws = new WebSocket(proto + '://' + location.host + '/room/' + id + '/ws' + color);
  ws.onopen = () => setStatus('已连接，房间号: ' + id);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') { mode = 'online'; myColor = msg.player; resetGame(); }
    if (msg.type === 'waiting') setStatus('等待对手加入... 房间号: ' + id);
    if (msg.type === 'start') {
      turn = msg.turn;
      setStatus(myColor === 1 ? '对局开始，你执黑先手' : '对局开始，你执白后手');
    }
    if (msg.type === 'move') {
      place(msg.x, msg.y, msg.player);
      if (msg.winner) gameOver = true;
    }
    if (msg.type === 'sync') {
      rebuild(msg.moves);
      if (msg.note === 'undo') setStatus('悔棋成功');
      if (msg.note === 'restart') setStatus('新对局开始，' + (myColor === 1 ? '你执黑先手' : '对方先行'));
    }
    if (msg.type === 'undo_req') {
      if (confirm('对方请求悔棋，是否同意？')) ws.send(JSON.stringify({type:'undo_ack'}));
      else ws.send(JSON.stringify({type:'undo_deny'}));
    }
    if (msg.type === 'undo_deny') setStatus('对方拒绝了你的悔棋请求');
    if (msg.type === 'restart_req') {
      if (confirm('对方请求重新开始，是否同意？')) ws.send(JSON.stringify({type:'restart_ack'}));
    }
    if (msg.type === 'leave') { gameOver = true; setStatus('对方已离开，刷新页面重新开始'); }
  };
  ws.onclose = () => { if (mode === 'online' && !gameOver) setStatus('连接已断开'); };
}

// ================= AI：Minimax + Alpha-Beta 剪枝 =================
// 棋型分值（连子数 x 开放端）
function shapeScore(count, open) {
  if (count >= 5) return 10000000;
  if (open === 0) return 0;
  const live = [0, 20, 200, 4000, 100000];   // 活一/活二/活三/活四
  const dead = [0, 5, 40, 500, 10000];       // 眠一/眠二/眠三/眠四
  return (open === 2 ? live : dead)[Math.min(count, 4)];
}

// 评估整盘：AI 视角（AI 分 - 玩家分）
function evaluateBoard() {
  let score = 0;
  const lines = [];
  // 横、竖
  for (let i = 0; i < N; i++) {
    lines.push([[i,0],[i,1],[i,2],[i,3],[i,4]].map(() => 0)); // placeholder, see below
  }
  // 逐方向扫描所有线（横、竖、两条对角）
  const scan = (getX, getY, len) => {
    for (let s = 0; s < len; s++) {
      let run = 0, runP = 0, openEnds = 0, prev = 0;
      const flush = () => {
        if (runP !== 0 && run > 0) {
          const v = shapeScore(run, openEnds);
          score += runP === aiColor ? v : -v * 1.05; // 玩家威胁略加权（偏防守）
        }
        run = 0; runP = 0;
      };
      for (let k = 0; k < N; k++) {
        const x = getX(s, k), y = getY(s, k);
        const v = (x < 0 || x >= N || y < 0 || y >= N) ? -1 : board[y][x];
        if (v === runP && v !== 0 && v !== -1) { run++; }
        else {
          flush();
          if (v === 0 || v === -1) { openEnds = (v === 0) ? 1 : 0; run = 0; runP = 0; }
          else { run = 1; runP = v; openEnds = 0; }
        }
        prev = v;
      }
      // 行尾开放性：最后一格若为空则 openEnds 有效
      flush();
    }
  };
  scan((s,k)=>k, (s,k)=>s, N);            // 横
  scan((s,k)=>s, (s,k)=>k, N);            // 竖
  scan((s,k)=>s+k-14, (s,k)=>s, 29);      // ↘ 对角
  scan((s,k)=>s+k, (s,k)=>14-s+k-14+14- (14-s) + (14-s) - (14-s) + s - s + (14 - s), 29); // 占位，实际用下面
  return score;
}

// 单点启发分：在该点落子后双方的棋型收益（用于候选点排序）
function evalPoint(x, y, p) {
  let total = 0;
  for (const [dx, dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let cnt = 1, openEnds = 0;
    for (const s of [1, -1]) {
      let nx = x + dx*s, ny = y + dy*s, run = 0;
      while (nx >= 0 && nx < N && ny >= 0 && ny < N && board[ny][nx] === p) { run++; nx += dx*s; ny += dy*s; }
      cnt += run;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N && board[ny][nx] === 0) openEnds++;
    }
    total += shapeScore(Math.min(cnt, 5), openEnds === 2 ? 2 : 1);
  }
  return total;
}

function candidates(limit) {
  const list = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (board[y][x] !== 0 || !hasNeighbor(x, y, 2)) continue;
    // 进攻 + 防守综合排序
    list.push({ x, y, score: evalPoint(x, y, aiColor) + evalPoint(x, y, myColor) * 1.05 });
  }
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, limit || 12);
}

function hasNeighbor(x, y, d) {
  for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
    const nx = x + dx, ny = y + dy;
    if ((dx || dy) && nx >= 0 && nx < N && ny >= 0 && ny < N && board[ny][nx] !== 0) return true;
  }
  return false;
}

const WIN = 1e9;
function minimax(depth, alpha, beta, player) {
  const cands = candidates(depth >= 3 ? 8 : 12);
  if (cands.length === 0) return { score: 0 };

  if (player === aiColor) { // MAX
    let best = { score: -Infinity };
    for (const c of cands) {
      board[c.y][c.x] = player;
      let sc;
      if (checkWin(c.x, c.y, player)) sc = WIN + depth; // 越早赢越好
      else if (depth <= 1) sc = evaluateBoardLite(c);
      else sc = minimax(depth - 1, alpha, beta, myColor).score;
      board[c.y][c.x] = 0;
      if (sc > best.score) best = { x: c.x, y: c.y, score: sc };
      alpha = Math.max(alpha, sc);
      if (beta <= alpha) break;
    }
    return best;
  } else { // MIN
    let best = { score: Infinity };
    for (const c of cands) {
      board[c.y][c.x] = player;
      let sc;
      if (checkWin(c.x, c.y, player)) sc = -WIN - depth;
      else if (depth <= 1) sc = evaluateBoardLite(c);
      else sc = minimax(depth - 1, alpha, beta, aiColor).score;
      board[c.y][c.x] = 0;
      if (sc < best.score) best = { x: c.x, y: c.y, score: sc };
      beta = Math.min(beta, sc);
      if (beta <= alpha) break;
    }
    return best;
  }
}

// 浅层评估：落子点的攻防净分（叶子节点用，比全盘扫描快）
function evaluateBoardLite(c) {
  return evalPoint(c.x, c.y, aiColor) - evalPoint(c.x, c.y, myColor) * 1.05;
}

function aiMove() {
  if (gameOver || turn !== aiColor) return;
  setStatus('AI 思考中...');
  setTimeout(() => {
    // 空盘直接天元
    if (moves.length === 0) { place(7, 7, aiColor); setStatus('轮到你落子'); return; }

    // 立即取胜检测
    for (const c of candidates(20)) {
      board[c.y][c.x] = aiColor;
      const win = checkWin(c.x, c.y, aiColor);
      board[c.y][c.x] = 0;
      if (win) { place(c.x, c.y, aiColor); setStatus('AI 获胜！再接再厉'); return; }
    }
    // 立即堵截检测（对方下一步成五）
    for (const c of candidates(20)) {
      board[c.y][c.x] = myColor;
      const win = checkWin(c.x, c.y, myColor);
      board[c.y][c.x] = 0;
      if (win) { place(c.x, c.y, aiColor); setStatus('轮到你落子'); return; }
    }

    const depth = moves.length < 4 ? 2 : 4; // 开局浅搜节省时间，中盘深搜
    const best = minimax(depth, -Infinity, Infinity, aiColor);
    if (best && best.x !== undefined) {
      place(best.x, best.y, aiColor);
      if (!gameOver) setStatus('轮到你落子');
    }
  }, 50);
}
</script>
</body>
</html>`;
