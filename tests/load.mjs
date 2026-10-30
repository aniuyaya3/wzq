// 多房间对战压测：N 个房间机器人互打 M 分钟，采集手数/局数/错误，
// 用于按比例推演生产环境的请求量与存储写入量。
// 用法：node tests/load.mjs --rooms 10 --minutes 10 --base ws://127.0.0.1:8787
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ROOMS = parseInt(args.rooms || '10');
const MINUTES = parseFloat(args.minutes || '10');
const BASE = args.base || 'ws://127.0.0.1:8787';
const DELAY_MIN = parseInt(args.dmin || '250'), DELAY_MAX = parseInt(args.dmax || '600');
const deadline = Date.now() + MINUTES * 60 * 1000;

const stats = { moves: 0, games: 0, errors: 0, disconnects: 0, reconnects: 0, sent: 0, received: 0, draws: 0 };
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickMove(board, n) {
  const cand = new Set();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (board[y][x]) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && !board[ny][nx]) cand.add(ny * n + nx);
    }
  }
  if (!cand.size) return { x: 7, y: 7 };
  const arr = [...cand];
  const c = arr[Math.floor(Math.random() * arr.length)];
  return { x: c % n, y: Math.floor(c / n) };
}

class Bot {
  constructor(room, wantColor) {
    this.room = room; this.wantColor = wantColor; this.my = 0; this.over = false;
    this.board = []; this.moves = 0; this.thinking = false; this.dead = false;
  }
  connect() {
    const url = `${BASE}/room/${this.room}/ws`;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => { stats.received++; this.onMsg(JSON.parse(ev.data)); };
    this.ws.onclose = () => {
      if (Date.now() > deadline || this.dead) return;
      stats.disconnects++;
      setTimeout(() => { if (Date.now() < deadline) { stats.reconnects++; this.connect(); } }, 1000);
    };
    this.ws.onerror = () => { stats.errors++; };
  }
  send(o) { try { this.ws.send(JSON.stringify(o)); stats.sent++; } catch { stats.errors++; } }
  rebuild(mvs) {
    this.board = Array.from({ length: 15 }, () => Array(15).fill(0));
    this.moves = 0;
    for (const m of mvs || []) { this.board[m.y][m.x] = m.player; this.moves++; }
  }
  turnNow() { return this.moves % 2 === 0 ? 1 : 2; }
  act() {
    if (this.over || this.thinking || !this.my || this.turnNow() !== this.my || Date.now() > deadline) return;
    this.thinking = true;
    const wait = Math.max(rand(DELAY_MIN, DELAY_MAX), (this.startAt || 0) - Date.now() + 30);
    setTimeout(() => {
      this.thinking = false;
      if (this.over || !this.my || this.turnNow() !== this.my || Date.now() > deadline) return;
      const mv = pickMove(this.board, 15);
      if (this.board[mv.y][mv.x]) return;
      this.send({ type: 'move', x: mv.x, y: mv.y });
    }, wait);
  }
  onMsg(m) {
    switch (m.type) {
      case 'welcome': this.my = m.color || 0; this.rebuild(m.moves); this.over = false; break;
      case 'start':
        this.my = m.color; this.startAt = m.startAt || 0;
        if (!m.resume) this.rebuild([]);
        this.over = false; this.act();
        break;
      case 'move':
        this.board[m.y][m.x] = m.player; this.moves++; stats.moves++;
        if (m.winner || m.draw) { this.over = true; stats.games++; if (m.draw) stats.draws++; this.afterGame(); }
        else this.act();
        break;
      case 'sync': this.rebuild(m.moves); this.over = false; this.act(); break;
      case 'gameover': this.over = true; this.afterGame(); break;
      case 'undo_req': this.send({ type: 'undo_ack' }); break;
      case 'draw_req': this.send({ type: 'draw_ack' }); break;
      case 'restart_req': this.send({ type: 'restart_ack' }); break;
      case 'leave': stats.errors++; break;
    }
  }
  afterGame() {
    if (this.my !== 1) return; // 由黑方发起重开
    setTimeout(() => { if (Date.now() < deadline && !this.dead) this.send({ type: 'restart_req' }); }, 800);
  }
}

const bots = [];
const tag = 'ld' + Math.random().toString(36).slice(2, 6);
for (let i = 0; i < ROOMS; i++) {
  const room = `${tag}${i}`;
  const a = new Bot(room, 1), b = new Bot(room, 0);
  a.connect();
  setTimeout(() => b.connect(), 150);
  bots.push(a, b);
}
const t0 = Date.now();
const timer = setInterval(() => {
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[${el}s] 手数 ${stats.moves} · 局数 ${stats.games} · 错误 ${stats.errors} · 断线 ${stats.disconnects} · 重连 ${stats.reconnects}`);
}, 30000);
await sleep(MINUTES * 60 * 1000 + 500);
clearInterval(timer);
for (const b of bots) { b.dead = true; try { b.ws.close(); } catch {} }
const seconds = (Date.now() - t0) / 1000;
const out = {
  rooms: ROOMS, seconds: Math.round(seconds),
  moves: stats.moves, games: stats.games, draws: stats.draws,
  avgMovesPerGame: stats.games ? +(stats.moves / stats.games).toFixed(1) : 0,
  movesPerRoomPerMin: +(stats.moves / ROOMS / (seconds / 60)).toFixed(2),
  sent: stats.sent, received: stats.received,
  errors: stats.errors, disconnects: stats.disconnects, reconnects: stats.reconnects,
};
console.log('LOAD_RESULT ' + JSON.stringify(out));
process.exit(0);
