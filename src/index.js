import { HTML_PAGE } from './page.js';
// ============================================================
// 五子棋 · Gomoku — Cloudflare Worker + Durable Object 联机房间
// 入口模块只导出 GameRoom 与 default handler（workerd 对入口命名导出有类型限制）；
// AI 引擎在 src/engine.js，前端页面在 src/page.js，由本文件 import 后使用。
// ============================================================

// ================= AI 引擎（纯逻辑，无 DOM 依赖） =================
// 设计要点：
//  1. 棋型评估：连子+开放端 + 断点（跳吃）识别，识别活四/冲四/活三等
//  2. 组合威胁：双四、四三、双三在单点评分阶段直接给必杀级加分
//  3. 全盘评估：5 格窗口势能 + 连子段扫描，双视角差值（防守加权）
//  4. 搜索：Negamax + Alpha-Beta 剪枝 + 置换表(Zobrist) + 迭代加深(大师)
//  5. 强制着法裁剪：对方有成五点时，非赢即堵，别无选择


// 棋谱紧凑编码：每手 1 个字符（code = y*15+x，0–224）；执子由手数奇偶决定
// （黑棋必为第 1、3、5… 手，与服务端回合校验一致），全盘 225 手仅 225 字节。
function encodeMoves(moves) {
  let s = '';
  for (const m of moves) s += String.fromCharCode(m.y * 15 + m.x);
  return s;
}
function decodeMoves(s) {
  const out = [];
  if (typeof s !== 'string') return out;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push({ x: c % 15, y: Math.floor(c / 15), player: i % 2 === 0 ? 1 : 2 });
  }
  return out;
}

// ============ Durable Object：联机房间 ============
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // 房间 12 小时无人活动自动清理

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];        // [{ socket, seat }]：seat 是座位号（1=先入房者），与执子颜色无关
    this.moves = [];
    this.turn = 1;
    this.winner = 0;
    this.draw = false;
    this.creatorColor = 1;     // 仅用于兼容旧版记录与旧连接的颜色映射
    this.blackSeat = 0;        // 本局执黑的座位（0=尚未决定）
    this.gameSeq = 0;          // 已开局数：首局随机决定黑棋，之后每局轮换
    this.started = false;      // 当前局是否已经发过 start
    this.startAt = 0;          // 本局允许落子的时刻（抽签揭晓点，服务端拦截提前落子）
    this.drawMs = 1500;        // 开局决定先手的揭晓等待（毫秒）
    this.lastActive = 0;
    this.alarmAt = 0; // 当前已设置的清理闹钟时间（用于节流，避免每手都重设）
    // 关键：房间对象会被 Cloudflare 休眠/回收后重建（WebSocket 连接与附件仍保留），
    // 若只靠内存变量，先进房的玩家会从 sessions 中消失，后进者被误判为房主。
    // 因此构造时从持久化存储 + 仍存活的连接恢复房间状态。
    state.blockConcurrencyWhile(async () => { await this.restore(); });
  }

  colorOfSeat(seat) { return this.blackSeat ? (seat === this.blackSeat ? 1 : 2) : 0; }
  seatOfSocket(ws) { const s = this.sessions.find((s) => s.socket === ws); return s ? s.seat : 0; }

  async restore() {
    try {
      const saved = await this.state.storage.get("room");
      if (saved && saved.ts && Date.now() - saved.ts > ROOM_TTL_MS) {
        // 已过期（闹钟未触发的兜底）：直接丢弃旧房间
        try { await this.state.storage.delete("room"); } catch {}
      } else if (saved) {
        // v2：棋谱为紧凑编码字符串；旧版为 moves 数组，两者都兼容
        this.moves = saved.v === 2 ? decodeMoves(saved.m) : (Array.isArray(saved.moves) ? saved.moves : []);
        this.turn = saved.turn === 2 ? 2 : 1;
        this.winner = saved.winner || 0;
        this.draw = !!saved.draw;
        this.creatorColor = saved.creatorColor === 2 ? 2 : 1;
        this.lastActive = saved.ts || 0;
        // 先手状态：新版直接读；旧版按房主颜色推导（房主为座位 1）
        this.blackSeat = saved.blackSeat || (this.creatorColor === 2 ? 2 : 1);
        this.gameSeq = saved.gameSeq || 0;
        this.started = typeof saved.started === 'boolean' ? saved.started
          : (this.moves.length > 0 || this.winner !== 0 || this.draw);
        if (this.started && this.gameSeq === 0) this.gameSeq = 1;
        this.startAt = saved.startAt || 0;
      }
      this.alarmAt = (await this.state.storage.getAlarm()) || 0;
    } catch {}
    const seen = new Set();
    this.sessions = [];
    for (const ws of this.state.getWebSockets()) {
      let att = {};
      try { att = ws.deserializeAttachment() || {}; } catch {}
      // 旧版连接的附件存的是颜色（player），按房主颜色反推座位
      const seat = att.seat || (att.player ? (att.player === this.creatorColor ? 1 : 2) : 0);
      if ((seat === 1 || seat === 2) && !seen.has(seat) && this.sessions.length < 2) {
        seen.add(seat);
        this.sessions.push({ socket: ws, seat });
      }
    }
  }

  async persist() {
    this.lastActive = Date.now();
    try {
      await this.state.storage.put("room", {
        v: 2, m: encodeMoves(this.moves), turn: this.turn, winner: this.winner,
        draw: this.draw, creatorColor: this.creatorColor, ts: this.lastActive,
        blackSeat: this.blackSeat, gameSeq: this.gameSeq, started: this.started, startAt: this.startAt,
      });
      // 闹钟节流：目标时间比已设闹钟晚 10 分钟以上才重设，避免每手多写一行
      const target = this.lastActive + ROOM_TTL_MS;
      if (!this.alarmAt || target - this.alarmAt > 10 * 60 * 1000) {
        await this.state.storage.setAlarm(target);
        this.alarmAt = target;
      }
    } catch {}
  }

  async alarm() {
    // 12 小时无人活动触发：房内还有人（连接存活）则再顺延 12 小时，无人则清理房间
    if (this.state.getWebSockets().length > 0) {
      const next = Date.now() + ROOM_TTL_MS;
      try { await this.state.storage.setAlarm(next); this.alarmAt = next; } catch {}
      return;
    }
    this.moves = []; this.turn = 1; this.winner = 0; this.draw = false;
    this.creatorColor = 1; this.sessions = []; this.lastActive = 0; this.alarmAt = 0;
    this.blackSeat = 0; this.gameSeq = 0; this.started = false; this.startAt = 0;
    try { await this.state.storage.delete("room"); } catch {}
    try { await this.state.storage.deleteAlarm(); } catch {}
  }

  board() {
    const b = Array.from({ length: 15 }, () => Array(15).fill(0));
    for (const m of this.moves) b[m.y][m.x] = m.player;
    return b;
  }

  // 开一局：首局随机抽黑棋，之后每局与上一局轮换；drawMs 内落子会被 move 处理拦截
  startGame() {
    if (this.gameSeq === 0 || !this.blackSeat) this.blackSeat = Math.random() < 0.5 ? 1 : 2;
    else this.blackSeat = this.blackSeat === 1 ? 2 : 1;
    this.gameSeq++;
    this.moves = []; this.turn = 1; this.winner = 0; this.draw = false;
    this.started = true;
    this.startAt = Date.now() + this.drawMs;
  }

  sendStart(resume) {
    for (const s of this.sessions) {
      this.sendTo(s.socket, {
        type: "start", color: this.colorOfSeat(s.seat), turn: 1,
        startAt: resume ? 0 : this.startAt, game: this.gameSeq,
        first: this.gameSeq === 1, resume: !!resume,
      });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      if (this.sessions.length >= 2) return new Response("Room is full", { status: 403 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      const seat = this.sessions.some((s) => s.seat === 1) ? 2 : 1;
      this.sessions.push({ socket: pair[1], seat });
      pair[1].serializeAttachment({ seat });
      await this.persist();
      this.sendTo(pair[1], {
        type: "welcome", seat, color: this.colorOfSeat(seat),
        moves: this.moves, turn: this.turn, started: this.started,
      });
      if (this.sessions.length === 2) {
        if (!this.started) { this.startGame(); await this.persist(); this.sendStart(false); }
        else this.sendStart(true); // 断线重回：恢复对局，不重新抽签
      } else {
        this.sendTo(pair[1], { type: "waiting" });
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }

  opponentOf(seat) { return this.sessions.find((s) => s.seat !== seat); }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const seat = this.seatOfSocket(ws);
    if (!seat) return;
    const opponent = this.opponentOf(seat);

    switch (data.type) {
      case "move": {
        const color = this.colorOfSeat(seat);
        if (!this.started || this.winner !== 0 || this.draw || color !== this.turn) return;
        if (this.startAt && Date.now() < this.startAt) return; // 抽签揭晓前禁止落子
        const { x, y } = data;
        const b = this.board();
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 14 || y < 0 || y > 14 || b[y][x] !== 0) return;
        this.moves.push({ x, y, player: color });
        this.turn = color === 1 ? 2 : 1;
        const winner = this.checkWin(x, y, color);
        if (winner) this.winner = winner;
        else if (this.moves.length === 225) this.draw = true;
        await this.persist();
        this.broadcast({ type: "move", x, y, player: color, turn: this.turn, winner: this.winner, draw: this.draw });
        break;
      }
      case "undo_req": if (opponent) this.sendTo(opponent.socket, { type: "undo_req" }); break;
      case "undo_ack": {
        const requester = opponent;
        if (!requester || this.moves.length === 0) return;
        const reqColor = this.colorOfSeat(requester.seat);
        while (this.moves.length > 0) {
          const last = this.moves.pop();
          this.turn = last.player;
          if (last.player === reqColor) break;
        }
        this.winner = 0; this.draw = false;
        await this.persist();
        this.broadcast({ type: "sync", moves: this.moves, turn: this.turn, winner: 0, note: "undo" });
        break;
      }
      case "undo_deny": if (opponent) this.sendTo(opponent.socket, { type: "undo_deny" }); break;
      case "restart_req": if (opponent) this.sendTo(opponent.socket, { type: "restart_req" }); break;
      case "restart_ack": {
        this.startGame(); // 轮换先手并重新揭晓
        await this.persist();
        this.sendStart(false);
        break;
      }
      case "restart_deny": if (opponent) this.sendTo(opponent.socket, { type: "restart_deny" }); break;
      case "resign": {
        this.winner = this.colorOfSeat(seat) === 1 ? 2 : 1;
        await this.persist();
        this.broadcast({ type: "gameover", winner: this.winner, reason: "resign", loser: this.colorOfSeat(seat) });
        break;
      }
      case "draw_req": if (opponent) this.sendTo(opponent.socket, { type: "draw_req" }); break;
      case "draw_ack": {
        this.draw = true;
        await this.persist();
        this.broadcast({ type: "gameover", winner: 0, reason: "draw" });
        break;
      }
      case "draw_deny": if (opponent) this.sendTo(opponent.socket, { type: "draw_deny" }); break;
      case "bye": {
        // 客户端主动离开：立即摘除并通知对方，不等连接关闭事件
        const before = this.sessions.length;
        this.sessions = this.sessions.filter((s) => s.socket !== ws);
        if (this.sessions.length !== before) this.broadcast({ type: "leave" });
        try { ws.close(); } catch {}
        break;
      }
    }
  }

  webSocketClose(ws) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.socket !== ws);
    // 仅在确实摘除了一名玩家时通知，避免 bye + close 双重通知
    if (this.sessions.length !== before) this.broadcast({ type: "leave" });
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
    const match = url.pathname.match(/^\/room\/([a-z0-9]{4,12})\/ws$/i);
    if (match) {
      const stub = env.ROOM.get(env.ROOM.idFromName(match[1].toLowerCase()));
      return stub.fetch(url.toString(), request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_PAGE, {
        headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-cache" },
      });
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("Not found", { status: 404 });
  },
};


