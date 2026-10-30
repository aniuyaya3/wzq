// ============================================================
// 五子棋 · Gomoku — Cloudflare Worker + Durable Object 联机房间
// 前端与 AI 引擎全部内嵌于本文件（ENGINE_JS 同时供 Node 测试导入）
// ============================================================

// ================= AI 引擎（纯逻辑，无 DOM 依赖） =================
// 设计要点：
//  1. 棋型评估：连子+开放端 + 断点（跳吃）识别，识别活四/冲四/活三等
//  2. 组合威胁：双四、四三、双三在单点评分阶段直接给必杀级加分
//  3. 全盘评估：5 格窗口势能 + 连子段扫描，双视角差值（防守加权）
//  4. 搜索：Negamax + Alpha-Beta 剪枝 + 置换表(Zobrist) + 迭代加深(大师)
//  5. 强制着法裁剪：对方有成五点时，非赢即堵，别无选择
export const ENGINE_JS = `
var GomokuAI = (function () {
  'use strict';
  var N = 15, CELLS = N * N;
  var WIN_SCORE = 100000000;
  // 5 格窗口势能表：窗口内只有一方棋子时，按子数计分
  var WINDOW_TABLE = [0, 12, 140, 1500, 22000, 12000000];
  // 连子段计分：[count][openEnds]
  var RUN_TABLE = {
    5: [WIN_SCORE, WIN_SCORE, WIN_SCORE],
    4: [0, 160000, 1600000],
    3: [0, 7000, 70000],
    2: [0, 350, 3600],
    1: [0, 25, 180]
  };
  // 单方向连子计分（单点评估用）
  function dirValue(count, open) {
    if (count >= 5) return 12000000;
    if (open === 0) return 0;
    if (count === 4) return open === 2 ? 1200000 : 110000;
    if (count === 3) return open === 2 ? 52000 : 5200;
    if (count === 2) return open === 2 ? 2600 : 260;
    return open === 2 ? 130 : 15;
  }
  var FOUR_LEVEL = 100000;   // >= 此值视为「四」级威胁（活四/冲四）
  var THREE_LEVEL = 40000;   // >= 此值视为「活三」级威胁

  // ---------- 预计算 5 格窗口 ----------
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  var WINDOWS = [];
  var CELL_WINDOWS = [];
  for (var ci = 0; ci < CELLS; ci++) CELL_WINDOWS.push([]);
  DIRS.forEach(function (d) {
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var ex = x + d[0] * 4, ey = y + d[1] * 4;
      if (ex < 0 || ex >= N || ey < 0 || ey >= N) continue;
      var cells = [];
      for (var k = 0; k < 5; k++) cells.push((y + d[1] * k) * N + (x + d[0] * k));
      var wi = WINDOWS.length;
      WINDOWS.push(cells);
      cells.forEach(function (c) { CELL_WINDOWS[c].push(wi); });
    }
  });

  // ---------- Zobrist 哈希 ----------
  var _seed = 987654321;
  function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed; }
  var ZOB = [];
  for (var zi = 0; zi < CELLS; zi++) ZOB.push([0, rnd() * 65536 + rnd(), rnd() * 65536 + rnd()]);
  var ZOB_TURN = rnd() * 65536 + rnd();

  function toFlat(board2d) {
    var b = new Int8Array(CELLS);
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) b[y * N + x] = board2d[y][x] | 0;
    return b;
  }
  function hashBoard(b) {
    var h = 0;
    for (var i = 0; i < CELLS; i++) if (b[i]) h ^= ZOB[i][b[i]];
    return h;
  }
  function checkWinFlat(b, idx, p) {
    var x = idx % N, y = (idx / N) | 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1], c = 1, s, nx, ny;
      for (s = 1; s >= -1; s -= 2) {
        nx = x + dx * s; ny = y + dy * s;
        while (nx >= 0 && nx < N && ny >= 0 && ny < N && b[ny * N + nx] === p) { c++; nx += dx * s; ny += dy * s; }
      }
      if (c >= 5) return true;
    }
    return false;
  }

  // ---------- 单方向分析：连子数、开放端、跳一格后的延伸子数 ----------
  function analyzeDir(b, x, y, dx, dy, p) {
    var cnt = 1, open = 0, gapCnt = 0, s, nx, ny, run;
    for (s = 1; s >= -1; s -= 2) {
      nx = x + dx * s; ny = y + dy * s; run = 0;
      while (nx >= 0 && nx < N && ny >= 0 && ny < N && b[ny * N + nx] === p) { run++; nx += dx * s; ny += dy * s; }
      cnt += run;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N && b[ny * N + nx] === 0) {
        open++;
        // 跳过这一个空位再看延伸（识别 XXX_X 型断点）
        var gx = nx + dx * s, gy = ny + dy * s, g = 0;
        while (gx >= 0 && gx < N && gy >= 0 && gy < N && b[gy * N + gx] === p) { g++; gx += dx * s; gy += dy * s; }
        if (g > gapCnt) gapCnt = g;
      }
    }
    return { count: cnt, open: open, gap: gapCnt };
  }

  // 单点价值的「方向部分」：连子棋型 + 断点 + 组合威胁（不含窗口势能）
  function dirOnlyScore(b, x, y, p) {
    var total = 0, fourCount = 0, threeCount = 0;
    for (var d = 0; d < 4; d++) {
      var info = analyzeDir(b, x, y, DIRS[d][0], DIRS[d][1], p);
      var v = dirValue(info.count, info.open);
      if (info.count + info.gap >= 5 && info.open > 0) v = Math.max(v, 900000);
      else if (info.count + info.gap === 4 && info.open > 0) v = Math.max(v, 42000);
      total += v;
      if (v >= FOUR_LEVEL) fourCount++;
      else if (v >= THREE_LEVEL) threeCount++;
    }
    if (fourCount >= 2) total += 9000000;
    else if (fourCount === 1 && threeCount >= 1) total += 1100000;
    else if (threeCount >= 2) total += 420000;
    return total;
  }

  // 在 (x,y) 为 p 落子后的单点价值（含组合威胁加成）
  function pointScore(b, x, y, p) {
    var idx = y * N + x, total = 0, i, k;
    // 窗口势能（含断点棋型）
    var ws = CELL_WINDOWS[idx];
    for (i = 0; i < ws.length; i++) {
      var cells = WINDOWS[ws[i]], own = 0, opp = 0;
      for (k = 0; k < 5; k++) { var cv = b[cells[k]]; if (cv === p) own++; else if (cv !== 0) opp++; }
      if (opp === 0) total += WINDOW_TABLE[Math.min(own + 1, 5)];
    }
    total += dirOnlyScore(b, x, y, p);
    // 中心位置微奖励（开局占位）
    var cd = Math.abs(x - 7) + Math.abs(y - 7);
    total += Math.max(0, 14 - cd);
    return total;
  }
  // 一方当前的最大单点威胁（下一步能造出的最强棋型）
  function bestThreat(b, p) {
    var best = 0;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      if (b[y * N + x] !== 0 || !hasNeighbor(b, x, y)) continue;
      var v = dirOnlyScore(b, x, y, p);
      if (v > best) best = v;
    }
    return best;
  }

  // ---------- 全盘评估：返回 player 相对 opponent 的分差 ----------
  function evaluate(b, player, opp) {
    var score = 0, i, k, cells, own, opv, cv;
    for (i = 0; i < WINDOWS.length; i++) {
      cells = WINDOWS[i]; own = 0; opv = 0;
      for (k = 0; k < 5; k++) { cv = b[cells[k]]; if (cv === player) own++; else if (cv === opp) opv++; }
      if (own && opv) continue;
      if (own) score += WINDOW_TABLE[own];
      else if (opv) score -= WINDOW_TABLE[opv] * 11 / 10;
    }
    // 连子段扫描（四个方向的每条线）
    var rp = runScan(b, player), ro = runScan(b, opp);
    score += rp.score - ro.score * 11 / 10;
    // 组合威胁加成：双四/四三/双三由不同线上的棋段组合而成，逐段计分会严重低估
    score += comboBonus(rp) - comboBonus(ro) * 11 / 10;
    // 下一步威胁：双方「再落一子能造出的最强棋型」之差（含断点棋型，逐段扫描看不到）
    score += (bestThreat(b, player) - bestThreat(b, opp) * 11 / 10) / 2;
    return score;
  }
  function comboBonus(r) {
    var v = 0;
    if (r.fours >= 2) v += 4000000;                    // 双四：无法双堵
    else if (r.fours >= 1 && r.threes >= 1) v += 600000; // 四三
    else if (r.threes >= 2) v += 380000;               // 双三
    return v;
  }
  function runScan(b, p) {
    var total = 0, fours = 0, threes = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        // 只从线的起点开始扫：前一格不在界内
        var px = x - dx, py = y - dy;
        if (px >= 0 && px < N && py >= 0 && py < N) continue;
        var run = 0, openStart = 0, cx = x, cy = y;
        var prevEmpty = false;
        while (cx >= 0 && cx < N && cy >= 0 && cy < N) {
          var v = b[cy * N + cx];
          if (v === p) { if (run === 0) openStart = prevEmpty ? 1 : 0; run++; }
          else {
            if (run > 0) {
              var open = openStart + (v === 0 ? 1 : 0);
              var row = RUN_TABLE[Math.min(run, 5)];
              total += row ? row[open] : 0;
              if (run === 4 && open >= 1) fours++;
              else if (run === 3 && open === 2) threes++;
              run = 0;
            }
            prevEmpty = (v === 0);
          }
          cx += dx; cy += dy;
        }
        if (run > 0) {
          var r2 = RUN_TABLE[Math.min(run, 5)];
          total += r2 ? r2[openStart] : 0;
          if (run === 4 && openStart >= 1) fours++;
          else if (run === 3 && openStart === 2) threes++;
        }
      }
    }
    return { score: total, fours: fours, threes: threes };
  }

  // ---------- 候选点生成 ----------
  function hasNeighbor(b, x, y) {
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      var nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N && b[ny * N + nx] !== 0) return true;
    }
    return false;
  }
  function genCandidates(b, player, opp, limit, defWeight) {
    var list = [];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var idx = y * N + x;
      if (b[idx] !== 0 || !hasNeighbor(b, x, y)) continue;
      var atk = pointScore(b, x, y, player);
      var def = pointScore(b, x, y, opp);
      list.push({ idx: idx, x: x, y: y, atk: atk, def: def, s: atk + def * defWeight });
    }
    list.sort(function (a, c) { return c.s - a.s; });
    if (list.length > limit) list.length = limit;
    return list;
  }

  // 精确成五点：落子后真成五的点（启发分会把双四等组合也叠到千万级，不能用于逻辑判定）
  function isWinAfter(b, idx, p) { b[idx] = p; var r = checkWinFlat(b, idx, p); b[idx] = 0; return r; }
  function exactWinPoints(b, p) {
    var res = [];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var idx = y * N + x;
      if (b[idx] === 0 && hasNeighbor(b, x, y) && isWinAfter(b, idx, p)) res.push(idx);
    }
    return res;
  }

  // ---------- Negamax + Alpha-Beta + 置换表 ----------
  var LEVELS = {
    easy:   { depth: 2, width: 8,  time: 350,  defWeight: 0.9,  blunder: 0.30 },
    normal: { depth: 4, width: 10, time: 1200, defWeight: 1.1,  blunder: 0 },
    hard:   { depth: 5, width: 11, time: 2000, defWeight: 1.22, blunder: 0 },
    master: { depth: 6, width: 12, time: 2800, defWeight: 1.28, blunder: 0 }
  };

  function searchRoot(board2d, aiColor, levelName) {
    var cfg = LEVELS[levelName] || LEVELS.normal;
    var opp = aiColor === 1 ? 2 : 1;
    var b = toFlat(board2d);
    var stones = 0, i;
    for (i = 0; i < CELLS; i++) if (b[i]) stones++;
    var t0 = Date.now();
    if (stones === 0) return { x: 7, y: 7, score: 0, depth: 0, nodes: 0, ms: 0 };
    if (stones === 1) {
      // 对方占天元则斜邻抢位，否则占天元
      if (b[7 * N + 7] === opp) return { x: 6, y: 6, score: 0, depth: 0, nodes: 0, ms: 0 };
      return { x: 7, y: 7, score: 0, depth: 0, nodes: 0, ms: 0 };
    }
    var st = { nodes: 0, deadline: t0 + cfg.time, aborted: false, tt: new Map(), hash: hashBoard(b), cfg: cfg, extLeft: 28 };
    var best = null, reachedDepth = 0;
    var maxDepth = cfg.depth;
    // 全部难度都迭代加深：超时就用上一层已完成的结果，绝不退化成贪心一手
    for (var depth = 2; depth <= maxDepth; depth++) {
      // 已用时间过半则不再开启新深度（大概率搜不完，不如保住已有结果）
      if (depth > 2 && Date.now() - t0 > cfg.time * 0.45) break;
      try {
        var r = negamaxRoot(b, aiColor, opp, depth, st);
        if (r && r.idx !== undefined) { best = r; reachedDepth = depth; }
      } catch (e) { st.aborted = true; }
      if (st.aborted || Date.now() > st.deadline) break;
      if (best && Math.abs(best.score) > WIN_SCORE / 2) break; // 已找到必胜/必败线
    }
    if (!best) { // 兜底：贪心一手
      var c = genCandidates(b, aiColor, opp, 1, cfg.defWeight)[0];
      best = { idx: c.idx, score: 0 };
    }
    var result = { x: best.idx % N, y: (best.idx / N) | 0, score: best.score, depth: reachedDepth, nodes: st.nodes, ms: Date.now() - t0 };
    // 简单难度：概率性次优着法（像真人失误，但不送成五的命）
    if (cfg.blunder > 0 && Math.random() < cfg.blunder && stones > 2 && exactWinPoints(b, opp).length === 0) {
      var top = genCandidates(b, aiColor, opp, 6, cfg.defWeight);
      if (top.length > 2) {
        var pick = top[1 + Math.floor(Math.random() * Math.min(3, top.length - 1))];
        if (pick && !isWinAfter(b, pick.idx, opp)) result = { x: pick.x, y: pick.y, score: 0, depth: reachedDepth, nodes: st.nodes, ms: Date.now() - t0 };
      }
    }
    return result;
  }

  function negamaxRoot(b, player, opp, depth, st) {
    var cands = genCandidates(b, player, opp, st.cfg.width + 4, st.cfg.defWeight);
    // 我方有精确成五点：直接赢
    for (var i = 0; i < cands.length; i++) if (isWinAfter(b, cands[i].idx, player)) return { idx: cands[i].idx, score: WIN_SCORE - 1 };
    // 对方有精确成五点且我方不能立即赢：必须堵，别无选择
    var oppWins = exactWinPoints(b, opp);
    if (oppWins.length) {
      var blocks = cands.filter(function (c) { return oppWins.indexOf(c.idx) >= 0; });
      if (blocks.length) cands = blocks;
      else cands = oppWins.map(function (idx) { return { idx: idx, x: idx % N, y: (idx / N) | 0, atk: 0, def: 0, s: 0 }; });
    }
    var alpha = -Infinity, best = null;
    for (i = 0; i < cands.length; i++) {
      var c = cands[i];
      b[c.idx] = player; st.hash ^= ZOB[c.idx][player];
      var sc;
      if (checkWinFlat(b, c.idx, player)) sc = WIN_SCORE - 1;
      else if (depth <= 1) sc = evaluate(b, player, opp);
      else sc = -negamax(b, depth - 1, -Infinity, -alpha, opp, player, 1, st);
      b[c.idx] = 0; st.hash ^= ZOB[c.idx][player];
      if (best === null || sc > best.score) best = { idx: c.idx, score: sc };
      if (sc > alpha) alpha = sc;
    }
    return best;
  }

  function negamax(b, depth, alpha, beta, player, opp, ply, st) {
    st.nodes++;
    if ((st.nodes & 1023) === 0 && Date.now() > st.deadline) throw new Error('timeout');
    // 置换表
    var key = st.hash ^ (player === 2 ? ZOB_TURN : 0);
    var hit = st.tt.get(key);
    if (hit && hit.depth >= depth) {
      if (hit.flag === 0) return hit.score;
      if (hit.flag === 1 && hit.score > alpha) alpha = hit.score;
      if (hit.flag === 2 && hit.score < beta) beta = hit.score;
      if (alpha >= beta) return hit.score;
    }
    var width = depth >= 3 ? st.cfg.width : Math.max(5, st.cfg.width - 5);
    var cands = genCandidates(b, player, opp, width, st.cfg.defWeight);
    if (!cands.length) return evaluate(b, player, opp);
    for (var i = 0; i < cands.length; i++) if (isWinAfter(b, cands[i].idx, player)) return WIN_SCORE - ply;
    var oppWins = exactWinPoints(b, opp);
    if (oppWins.length) {
      var blocks = cands.filter(function (c) { return oppWins.indexOf(c.idx) >= 0; });
      if (blocks.length) cands = blocks.slice(0, 3);
      else cands = oppWins.slice(0, 3).map(function (idx) { return { idx: idx, x: idx % N, y: (idx / N) | 0, atk: 0, def: 0, s: 0 }; });
    }
    var best = -Infinity, a = alpha;
    for (i = 0; i < cands.length; i++) {
      var c = cands[i];
      b[c.idx] = player; st.hash ^= ZOB[c.idx][player];
      var sc;
      if (checkWinFlat(b, c.idx, player)) sc = WIN_SCORE - ply;
      else if (depth <= 1) {
        // 强制着法延伸：造四/堵活四以上的着法多看一层，避免「差一层就被杀」的视野盲区（有总次数上限防爆炸）
        if (ply < 10 && st.extLeft > 0 && (c.atk >= 110000 || c.def >= 1000000)) { st.extLeft--; sc = -negamax(b, 1, -beta, -a, opp, player, ply + 1, st); }
        else sc = evaluate(b, player, opp);
      }
      else sc = -negamax(b, depth - 1, -beta, -a, opp, player, ply + 1, st);
      b[c.idx] = 0; st.hash ^= ZOB[c.idx][player];
      if (sc > best) best = sc;
      if (sc > a) a = sc;
      if (a >= beta) break;
    }
    if (st.tt.size < 200000) st.tt.set(key, { depth: depth, score: best, flag: best <= alpha ? 2 : (best >= beta ? 1 : 0) });
    return best;
  }

  // 贪心一手（测试陪练用：只看单点攻防，不做搜索）
  function greedyMove(board2d, color) {
    var b = toFlat(board2d);
    var opp = color === 1 ? 2 : 1;
    var stones = 0; for (var i = 0; i < CELLS; i++) if (b[i]) stones++;
    if (stones === 0) return { x: 7, y: 7 };
    var c = genCandidates(b, color, opp, 1, 1.0)[0];
    return { x: c.x, y: c.y };
  }
  // 给玩家的提示着法（按困难级别算一手）
  function hintMove(board2d, color) { return searchRoot(board2d, color, 'hard'); }

  return {
    N: N,
    LEVELS: LEVELS,
    findBestMove: searchRoot,
    greedyMove: greedyMove,
    hintMove: hintMove,
    pointScore: function (board2d, x, y, p) { return pointScore(toFlat(board2d), x, y, p); },
    evaluate: function (board2d, p) { return evaluate(toFlat(board2d), p, p === 1 ? 2 : 1); },
    checkWin: function (board2d, x, y, p) { return checkWinFlat(toFlat(board2d), y * N + x, p); }
  };
})();
`;

// ============ Durable Object：联机房间 ============
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
    this.moves = [];
    this.turn = 1;
    this.winner = 0;
    this.draw = false;
    this.creatorColor = 1;
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
      this.sendTo(pair[1], { type: "welcome", player, moves: this.moves, turn: this.turn });
      if (this.sessions.length === 2) this.broadcast({ type: "start", turn: this.turn });
      else this.sendTo(pair[1], { type: "waiting" });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }

  opponentOf(player) { return this.sessions.find(s => s.player !== player); }

  webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const att = ws.serializeAttachment() || {};
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
        this.broadcast({ type: "gameover", winner: this.winner, reason: "resign", loser: player });
        break;
      }
      case "draw_req": if (opponent) this.sendTo(opponent.socket, { type: "draw_req" }); break;
      case "draw_ack": {
        this.draw = true;
        this.broadcast({ type: "gameover", winner: 0, reason: "draw" });
        break;
      }
      case "draw_deny": {
        const requester = this.sessions.find(s => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "draw_deny" });
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

// ============ 前端页面 ============
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
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
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
    if (msg.type === 'leave') { if (!gameOver) { setStatus('对方已离开'); toast('对方已离开房间'); } }
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
  var id = Math.random().toString(36).slice(2, 8);
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
