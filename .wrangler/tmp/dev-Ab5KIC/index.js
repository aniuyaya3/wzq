var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-4NP897/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// src/engine.js
var ENGINE_JS = `
var GomokuAI = (function () {
  'use strict';
  var N = 15, CELLS = N * N;
  var WIN_SCORE = 100000000;
  // 5 \u683C\u7A97\u53E3\u52BF\u80FD\u8868\uFF1A\u7A97\u53E3\u5185\u53EA\u6709\u4E00\u65B9\u68CB\u5B50\u65F6\uFF0C\u6309\u5B50\u6570\u8BA1\u5206
  var WINDOW_TABLE = [0, 12, 140, 1500, 22000, 12000000];
  // \u8FDE\u5B50\u6BB5\u8BA1\u5206\uFF1A[count][openEnds]
  var RUN_TABLE = {
    5: [WIN_SCORE, WIN_SCORE, WIN_SCORE],
    4: [0, 160000, 1600000],
    3: [0, 7000, 70000],
    2: [0, 350, 3600],
    1: [0, 25, 180]
  };
  // \u5355\u65B9\u5411\u8FDE\u5B50\u8BA1\u5206\uFF08\u5355\u70B9\u8BC4\u4F30\u7528\uFF09
  function dirValue(count, open) {
    if (count >= 5) return 12000000;
    if (open === 0) return 0;
    if (count === 4) return open === 2 ? 1200000 : 110000;
    if (count === 3) return open === 2 ? 52000 : 5200;
    if (count === 2) return open === 2 ? 2600 : 260;
    return open === 2 ? 130 : 15;
  }
  var FOUR_LEVEL = 100000;   // >= \u6B64\u503C\u89C6\u4E3A\u300C\u56DB\u300D\u7EA7\u5A01\u80C1\uFF08\u6D3B\u56DB/\u51B2\u56DB\uFF09
  var THREE_LEVEL = 40000;   // >= \u6B64\u503C\u89C6\u4E3A\u300C\u6D3B\u4E09\u300D\u7EA7\u5A01\u80C1

  // ---------- \u9884\u8BA1\u7B97 5 \u683C\u7A97\u53E3 ----------
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

  // ---------- Zobrist \u54C8\u5E0C ----------
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

  // ---------- \u5355\u65B9\u5411\u5206\u6790\uFF1A\u8FDE\u5B50\u6570\u3001\u5F00\u653E\u7AEF\u3001\u8DF3\u4E00\u683C\u540E\u7684\u5EF6\u4F38\u5B50\u6570 ----------
  function analyzeDir(b, x, y, dx, dy, p) {
    var cnt = 1, open = 0, gapCnt = 0, s, nx, ny, run;
    for (s = 1; s >= -1; s -= 2) {
      nx = x + dx * s; ny = y + dy * s; run = 0;
      while (nx >= 0 && nx < N && ny >= 0 && ny < N && b[ny * N + nx] === p) { run++; nx += dx * s; ny += dy * s; }
      cnt += run;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N && b[ny * N + nx] === 0) {
        open++;
        // \u8DF3\u8FC7\u8FD9\u4E00\u4E2A\u7A7A\u4F4D\u518D\u770B\u5EF6\u4F38\uFF08\u8BC6\u522B XXX_X \u578B\u65AD\u70B9\uFF09
        var gx = nx + dx * s, gy = ny + dy * s, g = 0;
        while (gx >= 0 && gx < N && gy >= 0 && gy < N && b[gy * N + gx] === p) { g++; gx += dx * s; gy += dy * s; }
        if (g > gapCnt) gapCnt = g;
      }
    }
    return { count: cnt, open: open, gap: gapCnt };
  }

  // \u5355\u70B9\u4EF7\u503C\u7684\u300C\u65B9\u5411\u90E8\u5206\u300D\uFF1A\u8FDE\u5B50\u68CB\u578B + \u65AD\u70B9 + \u7EC4\u5408\u5A01\u80C1\uFF08\u4E0D\u542B\u7A97\u53E3\u52BF\u80FD\uFF09
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

  // \u5728 (x,y) \u4E3A p \u843D\u5B50\u540E\u7684\u5355\u70B9\u4EF7\u503C\uFF08\u542B\u7EC4\u5408\u5A01\u80C1\u52A0\u6210\uFF09
  function pointScore(b, x, y, p) {
    var idx = y * N + x, total = 0, i, k;
    // \u7A97\u53E3\u52BF\u80FD\uFF08\u542B\u65AD\u70B9\u68CB\u578B\uFF09
    var ws = CELL_WINDOWS[idx];
    for (i = 0; i < ws.length; i++) {
      var cells = WINDOWS[ws[i]], own = 0, opp = 0;
      for (k = 0; k < 5; k++) { var cv = b[cells[k]]; if (cv === p) own++; else if (cv !== 0) opp++; }
      if (opp === 0) total += WINDOW_TABLE[Math.min(own + 1, 5)];
    }
    total += dirOnlyScore(b, x, y, p);
    // \u4E2D\u5FC3\u4F4D\u7F6E\u5FAE\u5956\u52B1\uFF08\u5F00\u5C40\u5360\u4F4D\uFF09
    var cd = Math.abs(x - 7) + Math.abs(y - 7);
    total += Math.max(0, 14 - cd);
    return total;
  }
  // \u4E00\u65B9\u5F53\u524D\u7684\u6700\u5927\u5355\u70B9\u5A01\u80C1\uFF08\u4E0B\u4E00\u6B65\u80FD\u9020\u51FA\u7684\u6700\u5F3A\u68CB\u578B\uFF09
  function bestThreat(b, p) {
    var best = 0;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      if (b[y * N + x] !== 0 || !hasNeighbor(b, x, y)) continue;
      var v = dirOnlyScore(b, x, y, p);
      if (v > best) best = v;
    }
    return best;
  }

  // ---------- \u5168\u76D8\u8BC4\u4F30\uFF1A\u8FD4\u56DE player \u76F8\u5BF9 opponent \u7684\u5206\u5DEE ----------
  function evaluate(b, player, opp) {
    var score = 0, i, k, cells, own, opv, cv;
    for (i = 0; i < WINDOWS.length; i++) {
      cells = WINDOWS[i]; own = 0; opv = 0;
      for (k = 0; k < 5; k++) { cv = b[cells[k]]; if (cv === player) own++; else if (cv === opp) opv++; }
      if (own && opv) continue;
      if (own) score += WINDOW_TABLE[own];
      else if (opv) score -= WINDOW_TABLE[opv] * 11 / 10;
    }
    // \u8FDE\u5B50\u6BB5\u626B\u63CF\uFF08\u56DB\u4E2A\u65B9\u5411\u7684\u6BCF\u6761\u7EBF\uFF09
    var rp = runScan(b, player), ro = runScan(b, opp);
    score += rp.score - ro.score * 11 / 10;
    // \u7EC4\u5408\u5A01\u80C1\u52A0\u6210\uFF1A\u53CC\u56DB/\u56DB\u4E09/\u53CC\u4E09\u7531\u4E0D\u540C\u7EBF\u4E0A\u7684\u68CB\u6BB5\u7EC4\u5408\u800C\u6210\uFF0C\u9010\u6BB5\u8BA1\u5206\u4F1A\u4E25\u91CD\u4F4E\u4F30
    score += comboBonus(rp) - comboBonus(ro) * 11 / 10;
    // \u4E0B\u4E00\u6B65\u5A01\u80C1\uFF1A\u53CC\u65B9\u300C\u518D\u843D\u4E00\u5B50\u80FD\u9020\u51FA\u7684\u6700\u5F3A\u68CB\u578B\u300D\u4E4B\u5DEE\uFF08\u542B\u65AD\u70B9\u68CB\u578B\uFF0C\u9010\u6BB5\u626B\u63CF\u770B\u4E0D\u5230\uFF09
    score += (bestThreat(b, player) - bestThreat(b, opp) * 11 / 10) / 2;
    return score;
  }
  function comboBonus(r) {
    var v = 0;
    if (r.fours >= 2) v += 4000000;                    // \u53CC\u56DB\uFF1A\u65E0\u6CD5\u53CC\u5835
    else if (r.fours >= 1 && r.threes >= 1) v += 600000; // \u56DB\u4E09
    else if (r.threes >= 2) v += 380000;               // \u53CC\u4E09
    return v;
  }
  function runScan(b, p) {
    var total = 0, fours = 0, threes = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        // \u53EA\u4ECE\u7EBF\u7684\u8D77\u70B9\u5F00\u59CB\u626B\uFF1A\u524D\u4E00\u683C\u4E0D\u5728\u754C\u5185
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

  // ---------- \u5019\u9009\u70B9\u751F\u6210 ----------
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

  // \u7CBE\u786E\u6210\u4E94\u70B9\uFF1A\u843D\u5B50\u540E\u771F\u6210\u4E94\u7684\u70B9\uFF08\u542F\u53D1\u5206\u4F1A\u628A\u53CC\u56DB\u7B49\u7EC4\u5408\u4E5F\u53E0\u5230\u5343\u4E07\u7EA7\uFF0C\u4E0D\u80FD\u7528\u4E8E\u903B\u8F91\u5224\u5B9A\uFF09
  function isWinAfter(b, idx, p) { b[idx] = p; var r = checkWinFlat(b, idx, p); b[idx] = 0; return r; }
  function exactWinPoints(b, p) {
    var res = [];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var idx = y * N + x;
      if (b[idx] === 0 && hasNeighbor(b, x, y) && isWinAfter(b, idx, p)) res.push(idx);
    }
    return res;
  }

  // ---------- Negamax + Alpha-Beta + \u7F6E\u6362\u8868 ----------
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
      // \u5BF9\u65B9\u5360\u5929\u5143\u5219\u659C\u90BB\u62A2\u4F4D\uFF0C\u5426\u5219\u5360\u5929\u5143
      if (b[7 * N + 7] === opp) return { x: 6, y: 6, score: 0, depth: 0, nodes: 0, ms: 0 };
      return { x: 7, y: 7, score: 0, depth: 0, nodes: 0, ms: 0 };
    }
    var st = { nodes: 0, deadline: t0 + cfg.time, aborted: false, tt: new Map(), hash: hashBoard(b), cfg: cfg, extLeft: 28 };
    var best = null, reachedDepth = 0;
    var maxDepth = cfg.depth;
    // \u5168\u90E8\u96BE\u5EA6\u90FD\u8FED\u4EE3\u52A0\u6DF1\uFF1A\u8D85\u65F6\u5C31\u7528\u4E0A\u4E00\u5C42\u5DF2\u5B8C\u6210\u7684\u7ED3\u679C\uFF0C\u7EDD\u4E0D\u9000\u5316\u6210\u8D2A\u5FC3\u4E00\u624B
    for (var depth = 2; depth <= maxDepth; depth++) {
      // \u5DF2\u7528\u65F6\u95F4\u8FC7\u534A\u5219\u4E0D\u518D\u5F00\u542F\u65B0\u6DF1\u5EA6\uFF08\u5927\u6982\u7387\u641C\u4E0D\u5B8C\uFF0C\u4E0D\u5982\u4FDD\u4F4F\u5DF2\u6709\u7ED3\u679C\uFF09
      if (depth > 2 && Date.now() - t0 > cfg.time * 0.45) break;
      try {
        var r = negamaxRoot(b, aiColor, opp, depth, st);
        if (r && r.idx !== undefined) { best = r; reachedDepth = depth; }
      } catch (e) { st.aborted = true; }
      if (st.aborted || Date.now() > st.deadline) break;
      if (best && Math.abs(best.score) > WIN_SCORE / 2) break; // \u5DF2\u627E\u5230\u5FC5\u80DC/\u5FC5\u8D25\u7EBF
    }
    if (!best) { // \u515C\u5E95\uFF1A\u8D2A\u5FC3\u4E00\u624B
      var c = genCandidates(b, aiColor, opp, 1, cfg.defWeight)[0];
      best = { idx: c.idx, score: 0 };
    }
    var result = { x: best.idx % N, y: (best.idx / N) | 0, score: best.score, depth: reachedDepth, nodes: st.nodes, ms: Date.now() - t0 };
    // \u7B80\u5355\u96BE\u5EA6\uFF1A\u6982\u7387\u6027\u6B21\u4F18\u7740\u6CD5\uFF08\u50CF\u771F\u4EBA\u5931\u8BEF\uFF0C\u4F46\u4E0D\u9001\u6210\u4E94\u7684\u547D\uFF09
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
    // \u6211\u65B9\u6709\u7CBE\u786E\u6210\u4E94\u70B9\uFF1A\u76F4\u63A5\u8D62
    for (var i = 0; i < cands.length; i++) if (isWinAfter(b, cands[i].idx, player)) return { idx: cands[i].idx, score: WIN_SCORE - 1 };
    // \u5BF9\u65B9\u6709\u7CBE\u786E\u6210\u4E94\u70B9\u4E14\u6211\u65B9\u4E0D\u80FD\u7ACB\u5373\u8D62\uFF1A\u5FC5\u987B\u5835\uFF0C\u522B\u65E0\u9009\u62E9
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
    // \u7F6E\u6362\u8868
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
        // \u5F3A\u5236\u7740\u6CD5\u5EF6\u4F38\uFF1A\u9020\u56DB/\u5835\u6D3B\u56DB\u4EE5\u4E0A\u7684\u7740\u6CD5\u591A\u770B\u4E00\u5C42\uFF0C\u907F\u514D\u300C\u5DEE\u4E00\u5C42\u5C31\u88AB\u6740\u300D\u7684\u89C6\u91CE\u76F2\u533A\uFF08\u6709\u603B\u6B21\u6570\u4E0A\u9650\u9632\u7206\u70B8\uFF09
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

  // \u8D2A\u5FC3\u4E00\u624B\uFF08\u6D4B\u8BD5\u966A\u7EC3\u7528\uFF1A\u53EA\u770B\u5355\u70B9\u653B\u9632\uFF0C\u4E0D\u505A\u641C\u7D22\uFF09
  function greedyMove(board2d, color) {
    var b = toFlat(board2d);
    var opp = color === 1 ? 2 : 1;
    var stones = 0; for (var i = 0; i < CELLS; i++) if (b[i]) stones++;
    if (stones === 0) return { x: 7, y: 7 };
    var c = genCandidates(b, color, opp, 1, 1.0)[0];
    return { x: c.x, y: c.y };
  }
  // \u7ED9\u73A9\u5BB6\u7684\u63D0\u793A\u7740\u6CD5\uFF08\u6309\u56F0\u96BE\u7EA7\u522B\u7B97\u4E00\u624B\uFF09
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

// src/page.js
var HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#14100d">
<title>\u4E94\u5B50\u68CB \xB7 Gomoku</title>
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
  /* ---- \u5BF9\u5C40\u754C\u9762 ---- */
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
  /* ---- \u5F39\u5C42 / \u63D0\u793A ---- */
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
    <div class="logo">\u4E94\u5B50\u68CB<small>GOMOKU \xB7 \u4E94\u5B50\u8FDE\u73E0</small></div>
    <button class="icon-btn" id="soundBtn" title="\u58F0\u97F3\u5F00\u5173">\u{1F50A}</button>
  </header>

  <!-- ===== \u4E3B\u9875 ===== -->
  <section id="homeView">
    <div class="hero">
      <div class="stones">\u26AB\u26AA</div>
      <p>\u5F3A AI \u5BF9\u624B \xB7 \u653B\u9632\u517C\u5907<br>\u652F\u6301\u4EBA\u673A / \u53CC\u4EBA / \u5728\u7EBF\u8054\u673A\u5BF9\u6218</p>
    </div>
    <div style="height:14px"></div>
    <div class="modes">
      <button class="mode-btn active" data-mode="ai"><span class="ic">\u{1F916}</span><span class="nm">\u4EBA\u673A\u5BF9\u6218</span><span class="ds">\u6311\u6218\u5F3A AI</span></button>
      <button class="mode-btn" data-mode="local"><span class="ic">\u{1F465}</span><span class="nm">\u53CC\u4EBA\u5BF9\u6218</span><span class="ds">\u540C\u5C4F\u8F6E\u6D41</span></button>
      <button class="mode-btn" data-mode="online"><span class="ic">\u{1F310}</span><span class="nm">\u5728\u7EBF\u5BF9\u6218</span><span class="ds">\u623F\u95F4\u8054\u673A</span></button>
    </div>
    <div style="height:14px"></div>

    <div class="card setup show" id="setup-ai">
      <div>
        <div class="lbl">AI \u96BE\u5EA6</div>
        <div class="seg" id="diffSeg">
          <button data-diff="easy">\u7B80\u5355<small>\u65B0\u624B\u70ED\u8EAB</small></button>
          <button data-diff="normal" class="active">\u666E\u901A<small>\u5C0F\u6709\u6311\u6218</small></button>
          <button data-diff="hard">\u56F0\u96BE<small>\u653B\u9632\u517C\u5907</small></button>
          <button data-diff="master">\u5927\u5E08<small>\u6DF1\u8C0B\u8FDC\u8651</small></button>
        </div>
      </div>
      <div>
        <div class="lbl">\u4F60\u7684\u68CB\u5B50</div>
        <div class="seg" id="colorSeg">
          <button data-color="1" class="active">\u26AB \u6267\u9ED1 \xB7 \u5148\u884C</button>
          <button data-color="2">\u26AA \u6267\u767D \xB7 \u540E\u884C</button>
        </div>
      </div>
      <button class="primary" id="startAiBtn">\u5F00\u59CB\u5BF9\u5C40</button>
      <p class="tip">\u5927\u5E08\u96BE\u5EA6\u4F1A\u8FDB\u884C\u591A\u5C42\u641C\u7D22\uFF1A\u8BC6\u522B\u6D3B\u56DB\u3001\u51B2\u56DB\u3001\u6D3B\u4E09\u53CA\u53CC\u4E09 / \u56DB\u4E09\u7B49\u7EC4\u5408\u6740\u62DB\uFF0C\u5E76\u4F18\u5148\u5C01\u5835\u4F60\u7684\u5A01\u80C1\u3002\u60F3\u8D62\uFF0C\u5F97\u4E0B\u51FA\u53CC\u5934\u68CB\u3002</p>
    </div>

    <div class="card setup" id="setup-local">
      <p class="tip">\u4E24\u540D\u73A9\u5BB6\u5728\u540C\u4E00\u53F0\u8BBE\u5907\u4E0A\u8F6E\u6D41\u843D\u5B50\uFF0C\u9ED1\u68CB\u5148\u884C\u3002\u652F\u6301\u6094\u68CB\u3001\u63D0\u793A\u4E0E\u8BA4\u8F93\u3002</p>
      <button class="primary" id="startLocalBtn">\u5F00\u59CB\u53CC\u4EBA\u5BF9\u5C40</button>
    </div>

    <div class="card setup" id="setup-online">
      <div>
        <div class="lbl">\u521B\u5EFA\u623F\u95F4\u65F6\u4F60\u7684\u68CB\u5B50</div>
        <div class="seg" id="olColorSeg">
          <button data-color="1" class="active">\u26AB \u6267\u9ED1</button>
          <button data-color="2">\u26AA \u6267\u767D</button>
        </div>
      </div>
      <button class="primary" id="createRoomBtn">\u521B\u5EFA\u623F\u95F4</button>
      <div>
        <div class="lbl">\u6216\u8F93\u5165\u623F\u95F4\u53F7\u52A0\u5165</div>
        <div class="row">
          <input class="code" id="roomInput" placeholder="\u623F\u95F4\u53F7" maxlength="12" autocomplete="off">
          <button class="ghost-btn" id="joinRoomBtn" style="flex:0 0 108px">\u52A0\u5165</button>
        </div>
      </div>
      <p class="tip">\u628A\u623F\u95F4\u53F7\u53D1\u7ED9\u670B\u53CB\uFF0C\u5BF9\u65B9\u6253\u5F00\u672C\u9875\u9762\u8F93\u5165\u5373\u53EF\u5BF9\u6218\u3002\u8054\u673A\u652F\u6301\u6094\u68CB / \u91CD\u5F00 / \u548C\u68CB\u534F\u5546\u4E0E\u8BA4\u8F93\u3002</p>
    </div>

    <div style="height:14px"></div>
    <div class="card">
      <div class="lbl">\u4EBA\u673A\u6218\u7EE9\uFF08\u672C\u673A\u4FDD\u5B58\uFF09</div>
      <div class="stats">
        <div><b id="statW" style="color:var(--ok)">0</b><span>\u80DC</span></div>
        <div><b id="statD">0</b><span>\u5E73</span></div>
        <div><b id="statL" style="color:var(--danger)">0</b><span>\u8D1F</span></div>
        <div><b id="statRate">\u2014</b><span>\u80DC\u7387</span></div>
      </div>
    </div>
    <div style="height:14px"></div>
    <p class="tip" style="text-align:center">\u89C4\u5219\uFF1A15\xD715 \u68CB\u76D8\uFF0C\u9ED1\u68CB\u5148\u884C\uFF0C\u4EFB\u610F\u4E00\u65B9\u6A2A / \u7AD6 / \u659C\u8FDE\u6210\u4E94\u5B50\u83B7\u80DC\uFF08\u65E0\u7981\u624B\uFF09\u3002</p>
  </section>

  <!-- ===== \u5BF9\u5C40 ===== -->
  <section id="gameView">
    <div class="players">
      <div class="p-chip" id="chip1"><div class="stone-ic b"></div><div><div class="who" id="who1">\u9ED1\u68CB</div><div class="sub" id="sub1"></div></div></div>
      <div class="vs">VS</div>
      <div class="p-chip" id="chip2"><div class="stone-ic w"></div><div><div class="who" id="who2">\u767D\u68CB</div><div class="sub" id="sub2"></div></div></div>
    </div>
    <div id="statusBar">\u51C6\u5907\u4E2D\u2026</div>
    <div class="board-wrap"><canvas id="board"></canvas></div>
    <div class="meta-row">
      <span id="moveInfo">\u7B2C 0 \u624B \xB7 00:00</span>
      <label id="diffWrap" style="display:none">\u96BE\u5EA6
        <select id="diffSelect">
          <option value="easy">\u7B80\u5355</option>
          <option value="normal">\u666E\u901A</option>
          <option value="hard">\u56F0\u96BE</option>
          <option value="master">\u5927\u5E08</option>
        </select>
      </label>
    </div>
    <div class="room-bar" id="roomBar"><span>\u623F\u95F4\u53F7</span><code id="roomCode"></code><button id="copyRoomBtn">\u590D\u5236</button></div>
    <div class="toolbar">
      <button id="undoBtn">\u21A9 \u6094\u68CB</button>
      <button id="hintBtn">\u{1F4A1} \u63D0\u793A</button>
      <button id="restartBtn">\u{1F504} \u91CD\u5F00</button>
      <button id="moreBtn">\u22EF \u66F4\u591A</button>
    </div>
    <div class="history" id="history"></div>
  </section>
</div>

<div id="modalWrap"><div id="modal"><h3 id="modalTitle"></h3><p id="modalBody"></p><div class="btns" id="modalBtns"></div></div></div>
<div id="toast"></div>

<script>
${ENGINE_JS}
<\/script>
<script>
'use strict';
var N = 15;
var $ = function (id) { return document.getElementById(id); };
var canvas = $('board'), ctx = canvas.getContext('2d');

// ---------- \u6301\u4E45\u5316 ----------
function loadJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
var stats = loadJSON('gomoku-stats-v2', { w: 0, l: 0, d: 0 });
var soundOn = loadJSON('gomoku-sound', true);

// ---------- \u72B6\u6001 ----------
var mode = null;               // 'ai' | 'local' | 'online'
var board = null, moves = [], turn = 1, gameOver = false, resultCounted = false;
var myColor = 1, aiColor = 2, difficulty = 'normal', pickColorVal = 1, olColorVal = 1;
var ws = null, roomId = null, thinking = false, startTime = 0, timerId = null;
var hoverCell = null, previewCell = null, hintCell = null, hintTimer = null;
var winCells = [];
var selectedMode = 'ai';

function emptyBoard() { var b = []; for (var y = 0; y < N; y++) { var r = []; for (var x = 0; x < N; x++) r.push(0); b.push(r); } return b; }
function notation(x, y) { return 'ABCDEFGHIJKLMNO'.charAt(x) + (15 - y); }
function stoneName(p) { return p === 1 ? '\u9ED1\u68CB' : '\u767D\u68CB'; }

// ---------- \u58F0\u97F3 ----------
// \u843D\u5B50\u58F0\u4E0D\u7528\u8702\u9E23\u97F3\uFF0C\u6539\u4E3A\u5408\u6210\u300C\u68CB\u5B50\u6263\u6728\u76D8\u300D\u7684\u6572\u51FB\u58F0\uFF1A\u77ED\u4FC3\u566A\u58F0\u5494\u54D2 + \u4F4E\u9891\u6728\u8D28\u5171\u9E23
var audioCtx = null;
function ensureAudio() {
  if (!soundOn) return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}
// \u9996\u6B21\u624B\u52BF\u65F6\u89E3\u9501\u97F3\u9891\uFF08\u79FB\u52A8\u7AEF\u81EA\u52A8\u64AD\u653E\u7B56\u7565\u8981\u6C42\uFF09
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
    // \u5494\u54D2\uFF1A\u767D\u566A\u58F0\u77ED\u8109\u51B2\u8FC7\u5E26\u901A\uFF08\u77F3\u8D28\u8106\u54CD\uFF09
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
    // \u6728\u76D8\u5171\u9E23\uFF1A\u4F4E\u9891\u6B63\u5F26\u5FEB\u901F\u6ED1\u843D + \u8870\u51CF
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

// ---------- \u5F39\u5C42 / Toast ----------
function showModal(title, body, btns) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body || '';
  var box = $('modalBtns'); box.innerHTML = '';
  (btns || [{ label: '\u77E5\u9053\u4E86' }]).forEach(function (b) {
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

// ---------- \u72B6\u6001\u680F / \u4FE1\u606F ----------
function setStatus(html) { $('statusBar').innerHTML = html; }
function thinkingStatus() { setStatus('<span class="spin"></span>AI \u601D\u8003\u4E2D\u2026'); }
function turnStatus() {
  if (gameOver) return;
  if (mode === 'ai') setStatus(turn === myColor ? '\u8F6E\u5230\u4F60\u843D\u5B50' : 'AI \u601D\u8003\u4E2D\u2026');
  else if (mode === 'local') setStatus('\u8F6E\u5230' + stoneName(turn) + '\u843D\u5B50');
  else setStatus(turn === myColor ? '\u8F6E\u5230\u4F60\u843D\u5B50' : '\u7B49\u5F85\u5BF9\u65B9\u843D\u5B50\u2026');
}
function refreshChips() {
  $('chip1').classList.toggle('turn', !gameOver && turn === 1);
  $('chip2').classList.toggle('turn', !gameOver && turn === 2);
  var names;
  if (mode === 'ai') names = myColor === 1 ? ['\u4F60', 'AI'] : ['AI', '\u4F60'];
  else if (mode === 'local') names = ['\u73A9\u5BB6\u4E00', '\u73A9\u5BB6\u4E8C'];
  else names = myColor === 1 ? ['\u4F60', '\u5BF9\u624B'] : ['\u5BF9\u624B', '\u4F60'];
  $('who1').textContent = names[0] + ' \xB7 \u9ED1'; $('who2').textContent = names[1] + ' \xB7 \u767D';
  $('sub1').textContent = mode === 'ai' && myColor !== 1 ? diffName() : (mode === 'online' && myColor !== 1 ? '\u623F\u4E3B/\u5BF9\u624B' : '');
  $('sub2').textContent = mode === 'ai' && myColor === 1 ? diffName() : '';
  $('diffWrap').style.display = mode === 'ai' ? '' : 'none';
}
function diffName() { return { easy: '\u7B80\u5355 AI', normal: '\u666E\u901A AI', hard: '\u56F0\u96BE AI', master: '\u5927\u5E08 AI' }[difficulty]; }
function refreshMeta() {
  var sec = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  var mm = ('0' + Math.floor(sec / 60)).slice(-2), ss = ('0' + (sec % 60)).slice(-2);
  $('moveInfo').textContent = '\u7B2C ' + moves.length + ' \u624B \xB7 ' + mm + ':' + ss;
}
function renderHistory() {
  var h = $('history'); h.innerHTML = '';
  moves.forEach(function (m, i) {
    var el = document.createElement('span'); el.className = 'mv';
    el.innerHTML = (i + 1) + '. <b>' + (m.player === 1 ? '\u26AB' : '\u26AA') + notation(m.x, m.y) + '</b>';
    h.appendChild(el);
  });
  h.scrollLeft = h.scrollWidth;
}
function renderStats() {
  $('statW').textContent = stats.w; $('statL').textContent = stats.l; $('statD').textContent = stats.d;
  var tot = stats.w + stats.l + stats.d;
  $('statRate').textContent = tot ? Math.round(stats.w / tot * 100) + '%' : '\u2014';
}

// ---------- \u68CB\u76D8\u7ED8\u5236 ----------
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
  // \u76D8\u9762
  var g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#e3b26a'); g.addColorStop(0.5, '#d9a558'); g.addColorStop(1, '#c98f3f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(122,78,32,.16)'; ctx.lineWidth = 1;
  for (var t = 0; t < S; t += 7) { ctx.beginPath(); ctx.moveTo(0, t + 0.5); ctx.lineTo(S, t + 2.5); ctx.stroke(); }
  // \u5750\u6807
  ctx.fillStyle = 'rgba(90,55,18,.85)';
  ctx.font = '600 ' + Math.max(9, view.cell * 0.34) + 'px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (var i = 0; i < N; i++) {
    ctx.fillText('ABCDEFGHIJKLMNO'.charAt(i), px(i), view.pad * 0.42);
    ctx.fillText('ABCDEFGHIJKLMNO'.charAt(i), px(i), S - view.pad * 0.42);
    ctx.fillText(String(15 - i), view.pad * 0.42, px(i));
    ctx.fillText(String(15 - i), S - view.pad * 0.42, px(i));
  }
  // \u7F51\u683C
  ctx.strokeStyle = 'rgba(74,46,16,.92)'; ctx.lineWidth = 1;
  for (i = 0; i < N; i++) {
    ctx.beginPath(); ctx.moveTo(px(0), px(i)); ctx.lineTo(px(N - 1), px(i)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px(i), px(0)); ctx.lineTo(px(i), px(N - 1)); ctx.stroke();
  }
  ctx.lineWidth = 2; ctx.strokeRect(px(0), px(0), view.cell * (N - 1), view.cell * (N - 1));
  // \u661F\u4F4D
  ctx.fillStyle = 'rgba(74,46,16,.95)';
  [3, 7, 11].forEach(function (sx) { [3, 7, 11].forEach(function (sy) {
    ctx.beginPath(); ctx.arc(px(sx), px(sy), Math.max(2.4, view.cell * 0.1), 0, Math.PI * 2); ctx.fill();
  }); });
  if (!board) return;
  // \u63D0\u793A\u843D\u70B9
  if (hintCell && !gameOver) {
    ctx.strokeStyle = '#2f9e44'; ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.arc(px(hintCell.x), px(hintCell.y), view.cell * 0.52, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(47,158,68,.25)';
    ctx.beginPath(); ctx.arc(px(hintCell.x), px(hintCell.y), view.cell * 0.52, 0, Math.PI * 2); ctx.fill();
  }
  // \u9884\u89C8\uFF08\u89E6\u6478/\u60AC\u505C\uFF09
  var pv = previewCell || hoverCell;
  if (pv && !gameOver && board[pv.y][pv.x] === 0 && canHumanPlay()) drawStone(pv.x, pv.y, turn, 0.5, true);
  // \u68CB\u5B50
  for (i = 0; i < moves.length; i++) drawStone(moves[i].x, moves[i].y, moves[i].player, 1, false);
  // \u6700\u540E\u4E00\u624B\u6807\u8BB0
  if (moves.length) {
    var last = moves[moves.length - 1];
    ctx.fillStyle = '#e03131';
    ctx.beginPath(); ctx.arc(px(last.x), px(last.y), Math.max(2.6, view.cell * 0.11), 0, Math.PI * 2); ctx.fill();
  }
  // \u83B7\u80DC\u8FDE\u7EBF
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

// ---------- \u80DC\u8D1F ----------
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

// ---------- \u5BF9\u5C40\u6D41\u7A0B ----------
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
  if (myColor === 1) setStatus('\u4F60\u6267\u9ED1\u5148\u884C\uFF0C\u8BF7\u843D\u5B50');
  else { setStatus('AI \u6267\u9ED1\u5148\u884C'); setTimeout(aiTurn, 450); }
}
function startLocal() {
  mode = 'local'; myColor = 1;
  $('roomBar').classList.remove('show');
  showGame(); resetGame();
  setStatus('\u53CC\u4EBA\u5BF9\u6218 \xB7 \u9ED1\u68CB\u5148\u884C');
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
  if (winner === 0) { title = '\u{1F91D} \u5E73\u5C40'; body = reason === 'draw' ? '\u53CC\u65B9\u540C\u610F\u548C\u68CB\u3002' : '\u68CB\u76D8\u5DF2\u6EE1\uFF0C\u5E73\u5C40\u3002'; }
  else if (mode === 'ai') {
    mine = winner === myColor;
    title = mine ? '\u{1F389} \u4F60\u8D62\u4E86\uFF01' : '\u{1F916} AI \u83B7\u80DC';
    body = mine ? '\u6F02\u4EAE\uFF01\u4F60\u6218\u80DC\u4E86' + diffName() + '\u3002' : diffName() + '\u6280\u9AD8\u4E00\u7B79\uFF0C\u518D\u63A5\u518D\u5389\u3002';
  } else if (mode === 'local') { title = '\u{1F389} ' + stoneName(winner) + '\u83B7\u80DC'; body = '\u672C\u5C40\u5171 ' + moves.length + ' \u624B\u3002'; mine = true; }
  else {
    mine = winner === myColor;
    title = mine ? '\u{1F389} \u4F60\u8D62\u4E86\uFF01' : '\u5BF9\u65B9\u83B7\u80DC';
    body = reason === 'resign' ? (mine ? '\u5BF9\u65B9\u5DF2\u8BA4\u8F93\u3002' : '\u4F60\u5DF2\u8BA4\u8F93\u3002') : '\u672C\u5C40\u5171 ' + moves.length + ' \u624B\u3002';
  }
  if (winner !== 0) { if (mode !== 'ai' || mine) sndWin(); else sndLose(); vibrate([60, 40, 60]); }
  setStatus(title.replace(/\u{1F389}|\u{1F916}|\u{1F91D}/g, '').trim());
  if (mode === 'ai' && !resultCounted) {
    resultCounted = true;
    if (winner === 0) stats.d++; else if (winner === myColor) stats.w++; else stats.l++;
    saveJSON('gomoku-stats-v2', stats); renderStats();
  }
  setTimeout(function () {
    showModal(title, body, [
      { label: '\u518D\u6765\u4E00\u5C40', cb: function () { restartGame(); } },
      { label: '\u8FD4\u56DE\u4E3B\u9875', ghost: true, cb: function () { showHome(); } }
    ]);
  }, 650);
}

// ---------- \u6094\u68CB / \u91CD\u5F00 / \u8BA4\u8F93 / \u548C\u68CB / \u63D0\u793A ----------
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
  if (thinking) return toast('AI \u601D\u8003\u4E2D\uFF0C\u7A0D\u7B49\u4E00\u4E0B');
  if (mode === 'ai') {
    if (!moves.length) return toast('\u8FD8\u6CA1\u6709\u843D\u5B50');
    // \u64A4\u6389 AI \u7684\u5E94\u62DB + \u81EA\u5DF1\u4E0A\u4E00\u624B\uFF08\u82E5\u6700\u540E\u4E00\u624B\u662F\u81EA\u5DF1\u7684\u5219\u53EA\u64A4\u4E00\u624B\uFF09\uFF0C\u56DE\u5230\u81EA\u5DF1\u843D\u5B50\u524D
    var last = moves[moves.length - 1];
    if (last.player === aiColor) popMove();
    if (moves.length && moves[moves.length - 1].player === myColor) popMove();
    else if (last.player === myColor) { /* \u5DF2\u5728\u4E0A\u4E00\u884C\u64A4\u6389 */ }
    if (!moves.length && myColor === 2) { /* \u767D\u68CB\u5F00\u5C40\u524D\u65E0\u68CB\u53EF\u6094 */ }
    turn = myColor;
    afterUndoCleanup();
    setStatus('\u5DF2\u6094\u68CB\uFF0C\u8F6E\u5230\u4F60\u843D\u5B50');
    if (myColor === 2 && moves.length === 0) { setStatus('\u5DF2\u6094\u68CB\uFF0CAI \u91CD\u65B0\u5148\u884C'); setTimeout(aiTurn, 350); }
  } else if (mode === 'local') {
    if (!moves.length) return toast('\u8FD8\u6CA1\u6709\u843D\u5B50');
    var m = popMove(); turn = m.player;
    afterUndoCleanup(); turnStatus();
  } else if (mode === 'online') {
    if (!moves.length) return toast('\u8FD8\u6CA1\u6709\u843D\u5B50');
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'undo_req' })); toast('\u5DF2\u53D1\u9001\u6094\u68CB\u8BF7\u6C42'); }
  }
}
function restartGame() {
  if (mode === 'online') {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'restart_req' })); toast('\u5DF2\u53D1\u9001\u91CD\u5F00\u8BF7\u6C42\uFF0C\u7B49\u5F85\u5BF9\u65B9\u540C\u610F'); }
    return;
  }
  resetGame();
  if (mode === 'ai') {
    if (myColor === 1) setStatus('\u65B0\u5BF9\u5C40 \xB7 \u4F60\u6267\u9ED1\u5148\u884C');
    else { setStatus('\u65B0\u5BF9\u5C40 \xB7 AI \u5148\u884C'); setTimeout(aiTurn, 400); }
  } else setStatus('\u65B0\u5BF9\u5C40 \xB7 \u9ED1\u68CB\u5148\u884C');
}
function doResign() {
  if (gameOver) return;
  showModal('\u786E\u8BA4\u8BA4\u8F93\uFF1F', '\u8BA4\u8F93\u540E\u672C\u5C40\u5C06\u5224\u8D1F\u3002', [
    { label: '\u786E\u8BA4\u8BA4\u8F93', cb: function () {
        if (mode === 'online') { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resign' })); }
        else { gameOver = true; onGameEnd(turn === 1 ? 2 : 1, 'resign'); draw(); }
      } },
    { label: '\u7EE7\u7EED\u5BF9\u5C40', ghost: true }
  ]);
}
function doDrawOffer() {
  if (gameOver) return;
  if (mode === 'online') {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'draw_req' })); toast('\u5DF2\u53D1\u9001\u548C\u68CB\u8BF7\u6C42'); }
  } else {
    showModal('\u540C\u610F\u548C\u68CB\uFF1F', mode === 'ai' ? 'AI \u8868\u793A\uFF1A\u53EF\u4EE5\uFF0C\u672C\u5C40\u548C\u68CB\u3002' : '\u53CC\u65B9\u540C\u610F\u540E\u672C\u5C40\u548C\u68CB\u3002', [
      { label: '\u548C\u68CB', cb: function () { gameOver = true; onGameEnd(0, 'draw'); draw(); } },
      { label: '\u7EE7\u7EED\u5BF9\u5C40', ghost: true }
    ]);
  }
}
function doHint() {
  if (!canHumanPlay()) return toast('\u73B0\u5728\u4E0D\u80FD\u63D0\u793A');
  thinking = true; setStatus('\u6B63\u5728\u8BA1\u7B97\u63D0\u793A\u2026');
  var forColor = turn;
  setTimeout(function () {
    var res;
    try { res = GomokuAI.hintMove(board, forColor); } catch (e) { res = GomokuAI.greedyMove(board, forColor); }
    thinking = false;
    hintCell = { x: res.x, y: res.y };
    setStatus('\u63D0\u793A\uFF1A' + notation(res.x, res.y));
    draw();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hintCell = null; draw(); turnStatus(); }, 2600);
  }, 60);
}

// ---------- \u68CB\u76D8\u6307\u9488\u4EA4\u4E92\uFF08\u9F20\u6807\u60AC\u505C + \u89E6\u6478\u9884\u89C8\u540E\u677E\u624B\u843D\u5B50\uFF09 ----------
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

// ---------- \u5DE5\u5177\u680F ----------
$('undoBtn').onclick = doUndo;
$('hintBtn').onclick = doHint;
$('restartBtn').onclick = function () {
  if (mode === 'online') restartGame();
  else showModal('\u91CD\u65B0\u5F00\u59CB\uFF1F', '\u5F53\u524D\u5BF9\u5C40\u5C06\u88AB\u6E05\u7A7A\u3002', [
    { label: '\u91CD\u65B0\u5F00\u59CB', cb: restartGame },
    { label: '\u53D6\u6D88', ghost: true }
  ]);
};
$('moreBtn').onclick = function () {
  showModal('\u66F4\u591A\u64CD\u4F5C', '', [
    { label: '\u{1F3F3} \u8BA4\u8F93', cb: doResign },
    { label: '\u{1F91D} \u63D0\u8BAE\u548C\u68CB', cb: doDrawOffer },
    { label: '\u{1F3E0} \u8FD4\u56DE\u4E3B\u9875', ghost: true, cb: showHome },
    { label: '\u5173\u95ED', ghost: true }
  ]);
};
$('diffSelect').addEventListener('change', function () {
  difficulty = this.value;
  document.querySelectorAll('#diffSeg button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-diff') === difficulty);
  });
  refreshChips(); toast('\u96BE\u5EA6\u5DF2\u5207\u6362\u4E3A' + diffName());
});

// ---------- \u4E3B\u9875\u4EA4\u4E92 ----------
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
  this.textContent = soundOn ? '\u{1F50A}' : '\u{1F507}';
  if (soundOn) sndPlace();
};
$('soundBtn').textContent = soundOn ? '\u{1F50A}' : '\u{1F507}';

// ---------- \u8054\u673A ----------
function connectOnline(id, isCreator) {
  mode = 'online'; roomId = id;
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  var q = isCreator ? ('?color=' + olColorVal) : '';
  ws = new WebSocket(proto + '://' + location.host + '/room/' + id + '/ws' + q);
  showGame(); resetGame();
  $('roomBar').classList.add('show');
  $('roomCode').textContent = id;
  setStatus('\u6B63\u5728\u8FDE\u63A5\u670D\u52A1\u5668\u2026');
  ws.onopen = function () { setStatus('\u5DF2\u8FDE\u63A5\uFF0C\u7B49\u5F85\u5BF9\u624B\u52A0\u5165\u2026'); };
  ws.onmessage = function (ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'welcome') {
      myColor = msg.player;
      if (msg.moves && msg.moves.length) rebuildFromMoves(msg.moves);
      refreshChips();
    }
    if (msg.type === 'waiting') setStatus('\u7B49\u5F85\u5BF9\u624B\u52A0\u5165 \xB7 \u623F\u95F4\u53F7 ' + roomId);
    if (msg.type === 'start') { turn = msg.turn; refreshChips(); setStatus(myColor === 1 ? '\u5BF9\u5C40\u5F00\u59CB \xB7 \u4F60\u6267\u9ED1\u5148\u884C' : '\u5BF9\u5C40\u5F00\u59CB \xB7 \u5BF9\u65B9\u5148\u884C'); toast('\u5BF9\u624B\u5DF2\u52A0\u5165\uFF0C\u5BF9\u5C40\u5F00\u59CB'); }
    if (msg.type === 'move') {
      if (board[msg.y][msg.x] === 0) applyMove(msg.x, msg.y, msg.player);
      if (msg.winner) gameOver = true;
      if (msg.draw) { gameOver = true; onGameEnd(0, 'draw-full'); }
    }
    if (msg.type === 'sync') {
      rebuildFromMoves(msg.moves);
      gameOver = false; winCells = [];
      if (msg.note === 'undo') { setStatus('\u6094\u68CB\u6210\u529F'); toast('\u6094\u68CB\u6210\u529F'); }
      if (msg.note === 'restart') { startTime = Date.now(); setStatus('\u65B0\u5BF9\u5C40\u5F00\u59CB'); turnStatus(); }
      draw();
    }
    if (msg.type === 'gameover') {
      gameOver = true;
      onGameEnd(msg.winner, msg.reason);
      draw();
    }
    if (msg.type === 'undo_req') {
      showModal('\u5BF9\u65B9\u8BF7\u6C42\u6094\u68CB', '\u540C\u610F\u540E\u5C06\u56DE\u9000\u5230\u5BF9\u65B9\u4E0A\u4E00\u6B21\u843D\u5B50\u4E4B\u524D\u3002', [
        { label: '\u540C\u610F\u6094\u68CB', cb: function () { ws.send(JSON.stringify({ type: 'undo_ack' })); } },
        { label: '\u62D2\u7EDD', ghost: true, cb: function () { ws.send(JSON.stringify({ type: 'undo_deny' })); } }
      ]);
    }
    if (msg.type === 'undo_deny') toast('\u5BF9\u65B9\u62D2\u7EDD\u4E86\u6094\u68CB\u8BF7\u6C42');
    if (msg.type === 'restart_req') {
      showModal('\u5BF9\u65B9\u8BF7\u6C42\u91CD\u65B0\u5F00\u59CB', '\u540C\u610F\u540E\u5C06\u6E05\u7A7A\u68CB\u76D8\u91CD\u65B0\u5BF9\u5C40\u3002', [
        { label: '\u540C\u610F\u91CD\u5F00', cb: function () { ws.send(JSON.stringify({ type: 'restart_ack' })); } },
        { label: '\u62D2\u7EDD', ghost: true, cb: function () { ws.send(JSON.stringify({ type: 'restart_deny' })); } }
      ]);
    }
    if (msg.type === 'restart_deny') toast('\u5BF9\u65B9\u62D2\u7EDD\u4E86\u91CD\u65B0\u5F00\u59CB');
    if (msg.type === 'draw_req') {
      showModal('\u5BF9\u65B9\u63D0\u8BAE\u548C\u68CB', '\u540C\u610F\u540E\u672C\u5C40\u4EE5\u5E73\u5C40\u7ED3\u675F\u3002', [
        { label: '\u540C\u610F\u548C\u68CB', cb: function () { ws.send(JSON.stringify({ type: 'draw_ack' })); } },
        { label: '\u62D2\u7EDD', ghost: true, cb: function () { ws.send(JSON.stringify({ type: 'draw_deny' })); } }
      ]);
    }
    if (msg.type === 'draw_deny') toast('\u5BF9\u65B9\u62D2\u7EDD\u4E86\u548C\u68CB\u63D0\u8BAE');
    if (msg.type === 'leave') { if (!gameOver) { setStatus('\u5BF9\u65B9\u5DF2\u79BB\u5F00'); toast('\u5BF9\u65B9\u5DF2\u79BB\u5F00\u623F\u95F4'); } }
  };
  ws.onclose = function () { if (mode === 'online' && !gameOver) setStatus('\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF0C\u8BF7\u8FD4\u56DE\u4E3B\u9875\u91CD\u8BD5'); };
  ws.onerror = function () { toast('\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5'); };
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
  if (id.length < 4) return toast('\u8BF7\u8F93\u5165\u81F3\u5C11 4 \u4F4D\u623F\u95F4\u53F7');
  connectOnline(id, false);
};
$('copyRoomBtn').onclick = function () {
  var code = roomId || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(function () { toast('\u623F\u95F4\u53F7\u5DF2\u590D\u5236'); }, function () { toast('\u623F\u95F4\u53F7\uFF1A' + code); });
  } else toast('\u623F\u95F4\u53F7\uFF1A' + code);
};

// ---------- \u521D\u59CB\u5316 ----------
board = emptyBoard();
renderStats();
fitCanvas();
<\/script>
</body>
</html>`;

// src/index.js
var GameRoom = class {
  static {
    __name(this, "GameRoom");
  }
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
  opponentOf(player) {
    return this.sessions.find((s) => s.player !== player);
  }
  webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
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
        this.broadcast({ type: "move", x, y, player, turn: this.turn, winner: this.winner, draw: this.draw });
        break;
      }
      case "undo_req":
        if (opponent) this.sendTo(opponent.socket, { type: "undo_req" });
        break;
      case "undo_ack": {
        const requester = this.sessions.find((s) => s.socket !== ws);
        if (!requester || this.moves.length === 0) return;
        while (this.moves.length > 0) {
          const last = this.moves.pop();
          this.turn = last.player;
          if (last.player === requester.player) break;
        }
        this.winner = 0;
        this.draw = false;
        this.broadcast({ type: "sync", moves: this.moves, turn: this.turn, winner: 0, note: "undo" });
        break;
      }
      case "undo_deny": {
        const requester = this.sessions.find((s) => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "undo_deny" });
        break;
      }
      case "restart_req":
        if (opponent) this.sendTo(opponent.socket, { type: "restart_req" });
        break;
      case "restart_ack": {
        this.moves = [];
        this.turn = 1;
        this.winner = 0;
        this.draw = false;
        this.broadcast({ type: "sync", moves: [], turn: 1, winner: 0, note: "restart" });
        break;
      }
      case "restart_deny": {
        const requester = this.sessions.find((s) => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "restart_deny" });
        break;
      }
      case "resign": {
        this.winner = player === 1 ? 2 : 1;
        this.broadcast({ type: "gameover", winner: this.winner, reason: "resign", loser: player });
        break;
      }
      case "draw_req":
        if (opponent) this.sendTo(opponent.socket, { type: "draw_req" });
        break;
      case "draw_ack": {
        this.draw = true;
        this.broadcast({ type: "gameover", winner: 0, reason: "draw" });
        break;
      }
      case "draw_deny": {
        const requester = this.sessions.find((s) => s.socket !== ws);
        if (requester) this.sendTo(requester.socket, { type: "draw_deny" });
        break;
      }
    }
  }
  webSocketClose(ws) {
    this.sessions = this.sessions.filter((s) => s.socket !== ws);
    this.broadcast({ type: "leave" });
  }
  checkWin(x, y, p) {
    const b = this.board();
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let c = 1;
      for (const s of [1, -1]) {
        let nx = x + dx * s, ny = y + dy * s;
        while (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && b[ny][nx] === p) {
          c++;
          nx += dx * s;
          ny += dy * s;
        }
      }
      if (c >= 5) return p;
    }
    return 0;
  }
  sendTo(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
    }
  }
  broadcast(obj) {
    for (const s of this.sessions) this.sendTo(s.socket, obj);
  }
};
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([a-z0-9]{4,12})\/ws$/i);
    if (match) {
      const stub = env.ROOM.get(env.ROOM.idFromName(match[1].toLowerCase()));
      return stub.fetch(url.toString(), request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_PAGE, {
        headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-cache" }
      });
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("Not found", { status: 404 });
  }
};

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-4NP897/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-4NP897/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  GameRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
