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


// ============ Durable Object：联机房间 ============
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // 房间 12 小时无人活动自动清理

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
    this.moves = [];
    this.turn = 1;
    this.winner = 0;
    this.draw = false;
    this.creatorColor = 1;
    this.lastActive = 0;
    // 关键：房间对象会被 Cloudflare 休眠/回收后重建（WebSocket 连接与附件仍保留），
    // 若只靠内存变量，先进房的玩家会从 sessions 中消失，后进者被误判为房主。
    // 因此构造时从持久化存储 + 仍存活的连接恢复房间状态。
    state.blockConcurrencyWhile(async () => { await this.restore(); });
  }

  async restore() {
    try {
      const saved = await this.state.storage.get("room");
      if (saved && saved.ts && Date.now() - saved.ts > ROOM_TTL_MS) {
        // 已过期（闹钟未触发的兜底）：直接丢弃旧房间
        try { await this.state.storage.delete("room"); } catch {}
      } else if (saved) {
        this.moves = Array.isArray(saved.moves) ? saved.moves : [];
        this.turn = saved.turn === 2 ? 2 : 1;
        this.winner = saved.winner || 0;
        this.draw = !!saved.draw;
        this.creatorColor = saved.creatorColor === 2 ? 2 : 1;
        this.lastActive = saved.ts || 0;
      }
    } catch {}
    const seen = new Set();
    this.sessions = [];
    for (const ws of this.state.getWebSockets()) {
      let p = 0;
      try { p = (ws.deserializeAttachment() || {}).player; } catch {}
      if ((p === 1 || p === 2) && !seen.has(p) && this.sessions.length < 2) {
        seen.add(p);
        this.sessions.push({ socket: ws, player: p });
      }
    }
  }

  async persist() {
    this.lastActive = Date.now();
    try {
      await this.state.storage.put("room", {
        moves: this.moves, turn: this.turn, winner: this.winner,
        draw: this.draw, creatorColor: this.creatorColor, ts: this.lastActive,
      });
      // 每次活动都把清理闹钟顺延到 12 小时后
      await this.state.storage.setAlarm(this.lastActive + ROOM_TTL_MS);
    } catch {}
  }

  async alarm() {
    // 12 小时无人活动触发：房内还有人（连接存活）则再顺延 12 小时，无人则清理房间
    if (this.state.getWebSockets().length > 0) {
      try { await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS); } catch {}
      return;
    }
    this.moves = []; this.turn = 1; this.winner = 0; this.draw = false;
    this.creatorColor = 1; this.sessions = []; this.lastActive = 0;
    try { await this.state.storage.delete("room"); } catch {}
    try { await this.state.storage.deleteAlarm(); } catch {}
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
      let player;
      if (this.sessions.length === 0) {
        this.creatorColor = parseInt(url.searchParams.get("color")) === 2 ? 2 : 1;
        player = this.creatorColor;
      } else {
        player = this.creatorColor === 1 ? 2 : 1;
      }
      this.sessions.push({ socket: pair[1], player });
      pair[1].serializeAttachment({ player });
      await this.persist();
      this.sendTo(pair[1], { type: "welcome", player, moves: this.moves, turn: this.turn });
      if (this.sessions.length === 2) this.broadcast({ type: "start", turn: this.turn });
      else this.sendTo(pair[1], { type: "waiting" });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }

  opponentOf(player) { return this.sessions.find(s => s.player !== player); }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment() || {};
    const player = att.player;
    const opponent = this.opponentOf(player);

    switch (data.type) {
      case "move": {
        if (this.winner !== 0 || this.draw || player !== this.turn) return;
        const { x, y } = data;
        const b = this.board();
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 14 || y < 0 || y > 14 || b[y][x] !== 0) return;
        this.moves.push({ x, y, player });
        this.turn = player === 1 ? 2 : 1;
        const winner = this.checkWin(x, y, player);
        if (winner) this.winner = winner;
        else if (this.moves.length === 225) this.draw = true;
        await this.persist();
        this.broadcast({ type: "move", x, y, player, turn: this.turn, winner: this.winner, draw: this.draw });
        break;
      }
      case "undo_req": if (opponent) this.sendTo(opponent.socket, { type: "undo_req" }); break;
      case "undo_ack": {
        const requester = this.sessions.find(s => s.socket !== ws);
        if (!requester || this.moves.length === 0) return;
        while (this.moves.length > 0) {
          const last = this.moves.pop();
          this.turn = last.player;
          if (last.player === requester.player) break;
        }
        this.winner = 0; this.draw = false;
        await this.persist();
        this.broadcast({ type: "sync", moves: this.moves, turn: this.turn, winner: 0, note: "undo" });
        break;
      }
      case "undo_deny": {
        const requester = this.sessions.find(s => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "undo_deny" });
        break;
      }
      case "restart_req": if (opponent) this.sendTo(opponent.socket, { type: "restart_req" }); break;
      case "restart_ack": {
        this.moves = []; this.turn = 1; this.winner = 0; this.draw = false;
        await this.persist();
        this.broadcast({ type: "sync", moves: [], turn: 1, winner: 0, note: "restart" });
        break;
      }
      case "restart_deny": {
        const requester = this.sessions.find(s => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "restart_deny" });
        break;
      }
      case "resign": {
        this.winner = player === 1 ? 2 : 1;
        await this.persist();
        this.broadcast({ type: "gameover", winner: this.winner, reason: "resign", loser: player });
        break;
      }
      case "draw_req": if (opponent) this.sendTo(opponent.socket, { type: "draw_req" }); break;
      case "draw_ack": {
        this.draw = true;
        await this.persist();
        this.broadcast({ type: "gameover", winner: 0, reason: "draw" });
        break;
      }
      case "draw_deny": {
        const requester = this.sessions.find(s => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "draw_deny" });
        break;
      }
      case "bye": {
        // 客户端主动离开：立即摘除并通知对方，不等连接关闭事件
        const before = this.sessions.length;
        this.sessions = this.sessions.filter(s => s.socket !== ws);
        if (this.sessions.length !== before) this.broadcast({ type: "leave" });
        try { ws.close(); } catch {}
        break;
      }
    }
  }

  webSocketClose(ws) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.socket !== ws);
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


