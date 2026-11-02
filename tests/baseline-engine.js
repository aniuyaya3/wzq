// AI 引擎源码字符串（纯逻辑，可在浏览器与 Node 中运行；由 page.js 注入页面，测试直接导入本模块）
// 注意：不要把本模块的导出加到 Worker 入口 src/index.js 的顶层导出里——workerd 要求入口模块的
// 命名导出只能是 handler 或 Durable Object 类，多余的导出（如字符串常量）会导致整个 Worker 启动失败。
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
