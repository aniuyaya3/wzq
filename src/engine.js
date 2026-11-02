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

  // ---------- 跨手持久缓存（zobrist 键；容量到顶在 searchRoot 整体清空） ----------
  var TT_PERSIST = new Map();   // 置换表：手与手之间复用上一手的搜索成果
  var EVAL_CACHE = new Map();   // 评估缓存：evaluate 只取决于局面与视角，可安全跨手复用

  // ---------- 近邻计数：near[i]>0 表示 i 在任一棋子 2 格（切比雪夫）内 ----------
  // 候选点/威胁点必在某子 2 格内（连子相邻、断点隔一格），用计数替代每点全邻域扫描；
  // 落子/回退时增量维护（±24 格），计数归零即离开候选集。
  function addNear(near, idx, delta) {
    var x = idx % N, y = (idx / N) | 0;
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
      var nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N) near[ny * N + nx] += delta;
    }
  }
  function buildNear(b) {
    var near = new Int16Array(CELLS);
    for (var i = 0; i < CELLS; i++) if (b[i]) addNear(near, i, 1);
    return near;
  }
  // 统一落子/回退：棋盘、哈希、近邻计数、方向数组四者同步，搜索/VCF 共用，避免状态不一致
  // 方向数组按 st.dir 增量维护（仅重算过落子点的 4 条线）；无 dir 的轻量 st（如 vcfWin 导出）跳过
  function placeStone(b, st, idx, p) {
    if (st.evalInc) { threatPhase(b, st, idx, -1); evalIncLines(b, st, idx, -1); }
    b[idx] = p; st.hash ^= ZOB[idx][p]; addNear(st.near, idx, 1);
    if (st.dir) updateDirLines(b, st.dir[p], idx, p);
    if (st.evalInc) { evalIncLines(b, st, idx, 1); threatPhase(b, st, idx, 1); }
  }
  function undoStone(b, st, idx, p) {
    if (st.evalInc) { threatPhase(b, st, idx, -1); evalIncLines(b, st, idx, -1); }
    b[idx] = 0; st.hash ^= ZOB[idx][p]; addNear(st.near, idx, -1);
    if (st.dir) updateDirLines(b, st.dir[p], idx, p);
    if (st.evalInc) { evalIncLines(b, st, idx, 1); threatPhase(b, st, idx, 1); }
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

  // ---------- 单方向分析（数组版）：连子数、开放端、跳一格后的延伸子数 ----------
  // 原 analyzeDir 对每个候选格逐方向步行扫描，是 genCandidates 的最大开销；
  // 改为按线预计算每个格子沿四方向的连续子数（fwd/bwd），单格分析降为查表，
  // 语义与步行版逐项等价（count/open/gap 定义不变），有等价性模糊测试兜底。
  // 数组放在模块级暂存区复用（搜索单线程、无重入），避免每节点大量分配。
  var STEPS = [1, 15, 16, 14]; // 与 DIRS 对应的扁平步长
  function newDirSet() {
    var s = { fwd: [], bwd: [] };
    for (var d = 0; d < 4; d++) { s.fwd.push(new Int16Array(CELLS)); s.bwd.push(new Int16Array(CELLS)); }
    return s;
  }
  var DIR_SCRATCH_P = newDirSet(), DIR_SCRATCH_O = newDirSet();
  function buildDirArrays(b, p, A) {
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1], fwd = A.fwd[d], bwd = A.bwd[d];
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        var px = x - dx, py = y - dy;
        if (px >= 0 && px < N && py >= 0 && py < N) continue; // 只从线的起点开始扫
        var len = 0, cx = x, cy = y;
        while (cx >= 0 && cx < N && cy >= 0 && cy < N) { len++; cx += dx; cy += dy; }
        var run = 0, i, ix;
        for (i = 0; i < len; i++) { ix = (y + dy * i) * N + (x + dx * i); run = b[ix] === p ? run + 1 : 0; bwd[ix] = run; }
        run = 0;
        for (i = len - 1; i >= 0; i--) { ix = (y + dy * i) * N + (x + dx * i); run = b[ix] === p ? run + 1 : 0; fwd[ix] = run; }
      }
    }
    return A;
  }
  // 落子/回退后增量刷新方向数组：只重算过 idx 的 4 条线（每条 ≤15 格两遍），
  // 使 genCandidates / bestThreat 在搜索中直接用 st.dir，不再每节点整盘重建
  function updateDirLines(b, A, idx, p) {
    var x0 = idx % N, y0 = (idx / N) | 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1], fwd = A.fwd[d], bwd = A.bwd[d];
      var sx = x0, sy = y0;
      while (sx - dx >= 0 && sx - dx < N && sy - dy >= 0 && sy - dy < N) { sx -= dx; sy -= dy; }
      var len = 0, cx = sx, cy = sy;
      while (cx >= 0 && cx < N && cy >= 0 && cy < N) { len++; cx += dx; cy += dy; }
      var run = 0, i, ix;
      for (i = 0; i < len; i++) { ix = (sy + dy * i) * N + (sx + dx * i); run = b[ix] === p ? run + 1 : 0; bwd[ix] = run; }
      run = 0;
      for (i = len - 1; i >= 0; i--) { ix = (sy + dy * i) * N + (sx + dx * i); run = b[ix] === p ? run + 1 : 0; fwd[ix] = run; }
    }
  }
  // 单点价值的「方向部分」：连子棋型 + 断点 + 组合威胁（不含窗口势能），四方向内联展开
  function dirOnlyFast(b, A, idx) {
    var x = idx % N, y = (idx / N) | 0;
    var total = 0, fourCount = 0, threeCount = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1], fwd = A.fwd[d], bwd = A.bwd[d];
      var runP = 0, runM = 0, open = 0, gap = 0, ex, ey, gx, gy, g;
      var nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N) runP = fwd[ny * N + nx];
      ex = x + dx * (runP + 1); ey = y + dy * (runP + 1);
      if (ex >= 0 && ex < N && ey >= 0 && ey < N && b[ey * N + ex] === 0) {
        open++;
        gx = ex + dx; gy = ey + dy;
        if (gx >= 0 && gx < N && gy >= 0 && gy < N) { g = fwd[gy * N + gx]; if (g > gap) gap = g; }
      }
      nx = x - dx; ny = y - dy;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N) runM = bwd[ny * N + nx];
      ex = x - dx * (runM + 1); ey = y - dy * (runM + 1);
      if (ex >= 0 && ex < N && ey >= 0 && ey < N && b[ey * N + ex] === 0) {
        open++;
        gx = ex - dx; gy = ey - dy;
        if (gx >= 0 && gx < N && gy >= 0 && gy < N) { g = bwd[gy * N + gx]; if (g > gap) gap = g; }
      }
      var count = 1 + runP + runM;
      var v = dirValue(count, open);
      if (count + gap >= 5 && open > 0) v = Math.max(v, 900000);
      else if (count + gap === 4 && open > 0) v = Math.max(v, 42000);
      total += v;
      if (v >= FOUR_LEVEL) fourCount++;
      else if (v >= THREE_LEVEL) threeCount++;
    }
    if (fourCount >= 2) total += 9000000;
    else if (fourCount === 1 && threeCount >= 1) total += 1100000;
    else if (threeCount >= 2) total += 420000;
    return total;
  }
  function dirOnlyScore(b, x, y, p) { return dirOnlyFast(b, buildDirArrays(b, p, DIR_SCRATCH_P), y * N + x); }

  // 单点价值的「窗口势能部分」
  function windowPart(b, idx, p) {
    var total = 0, ws = CELL_WINDOWS[idx], i, k, cells, own, opp, cv;
    for (i = 0; i < ws.length; i++) {
      cells = WINDOWS[ws[i]]; own = 0; opp = 0;
      for (k = 0; k < 5; k++) { cv = b[cells[k]]; if (cv === p) own++; else if (cv !== 0) opp++; }
      if (opp === 0) total += WINDOW_TABLE[Math.min(own + 1, 5)];
    }
    return total;
  }
  // 在 (x,y) 为 p 落子后的单点价值（含组合威胁加成）
  function pointScore(b, x, y, p) {
    var idx = y * N + x;
    var total = windowPart(b, idx, p) + dirOnlyScore(b, x, y, p);
    // 中心位置微奖励（开局占位）
    var cd = Math.abs(x - 7) + Math.abs(y - 7);
    total += Math.max(0, 14 - cd);
    return total;
  }
  // 一方当前的最大单点威胁（下一步能造出的最强棋型）
  // near 给定时只扫近邻集（与 hasNeighbor 全扫等价，省去每点 24 格邻域检查）
  // A 给定时用现成的方向数组（搜索中由 placeStone 增量维护），否则现建
  function bestThreat(b, p, near, A) {
    if (!A) A = buildDirArrays(b, p, DIR_SCRATCH_P);
    var best = 0;
    for (var i = 0; i < CELLS; i++) {
      if (b[i] !== 0 || (near ? !near[i] : !hasNeighbor(b, i % N, (i / N) | 0))) continue;
      var v = dirOnlyFast(b, A, i);
      if (v > best) best = v;
    }
    return best;
  }

  // ---------- 全盘评估：返回 player 相对 opponent 的分差 ----------
  function evaluate(b, player, opp, near, dir) {
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
    score += (bestThreat(b, player, near, dir ? dir[player] : null) - bestThreat(b, opp, near, dir ? dir[opp] : null) * 11 / 10) / 2;
    return score;
  }
  // 带缓存的评估：同一局面在迭代加深各轮、不同手之间反复出现，命中直接返回
  function evalCached(b, player, opp, st) {
    var key = st.hash ^ (player === 2 ? ZOB_TURN : 0);
    var v = EVAL_CACHE.get(key);
    if (v !== undefined) return v;
    v = st.evalInc ? evaluateInc(player, opp, st) : evaluate(b, player, opp, st.near, st.dir);
    if (EVAL_CACHE.size < 500000) EVAL_CACHE.set(key, v);
    return v;
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

  // ---------- 增量评估：evaluate 的三部分（窗口和 / 连段聚合 / 最大单点威胁）全部随落子维护 ----------
  // 叶子评估原本是全盘扫描（572 窗口 + 双向连段 + 双方 bestThreat），是节点成本的大头；
  // 改为 placeStone/undoStone 时只重算受影响的窗口、4 条线与威胁格，evaluate 降为 O(1)。
  // 与全盘版的等价性由随机落子/回退模糊测试逐值校验（允许浮点末位差）。
  // 单条线的连段统计：与 runScan 的逐线逻辑逐项同构
  function lineStats(b, startIdx, d, p) {
    var dx = DIRS[d][0], dy = DIRS[d][1];
    var cx = startIdx % N, cy = (startIdx / N) | 0;
    var total = 0, fours = 0, threes = 0, run = 0, openStart = 0, prevEmpty = false;
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
    return [total, fours, threes];
  }
  // sign=-1 用未变更的棋盘扣减旧贡献，sign=+1 用已变更的棋盘加回新贡献（place/undo 各调两次）
  function evalIncLines(b, st, idx, sign) {
    var E = st.evalInc, ws = CELL_WINDOWS[idx], i, wi, cells, k, cv, o1, o2;
    for (i = 0; i < ws.length; i++) {
      cells = WINDOWS[ws[i]]; o1 = 0; o2 = 0;
      for (k = 0; k < 5; k++) { cv = b[cells[k]]; if (cv === 1) o1++; else if (cv === 2) o2++; }
      if (o1 && !o2) E[1].W += sign * WINDOW_TABLE[o1];
      else if (o2 && !o1) E[2].W += sign * WINDOW_TABLE[o2];
    }
    for (var c = 1; c <= 2; c++) {
      for (var d = 0; d < 4; d++) {
        var dx = DIRS[d][0], dy = DIRS[d][1], x = idx % N, y = (idx / N) | 0;
        while (x - dx >= 0 && x - dx < N && y - dy >= 0 && y - dy < N) { x -= dx; y -= dy; }
        var s = lineStats(b, y * N + x, d, c);
        E[c].runScore += sign * s[0]; E[c].fours += sign * s[1]; E[c].threes += sign * s[2];
      }
    }
  }
  var THREAT_STAMP = new Int32Array(CELLS), THREAT_OP = 0, THREAT_CELLS = new Int32Array(CELLS);
  // 威胁频次维护：dirOnlyFast(格) 只取决于过该格的 4 条线与近邻身份，故受影响格 =
  // 过 idx 的 4 条线上的格 ∪ idx 周边 5×5（近邻身份变化）。delta=-1 变更前扣、+1 变更后加。
  function threatPhase(b, st, idx, delta) {
    THREAT_OP++;
    var n = 0, d, dx, dy, cx, cy, i, x0 = idx % N, y0 = (idx / N) | 0, ci2;
    for (d = 0; d < 4; d++) {
      dx = DIRS[d][0]; dy = DIRS[d][1];
      cx = x0; cy = y0;
      while (cx - dx >= 0 && cx - dx < N && cy - dy >= 0 && cy - dy < N) { cx -= dx; cy -= dy; }
      while (cx >= 0 && cx < N && cy >= 0 && cy < N) {
        ci2 = cy * N + cx;
        if (THREAT_STAMP[ci2] !== THREAT_OP) { THREAT_STAMP[ci2] = THREAT_OP; THREAT_CELLS[n++] = ci2; }
        cx += dx; cy += dy;
      }
    }
    for (var oy = -2; oy <= 2; oy++) for (var ox = -2; ox <= 2; ox++) {
      cx = x0 + ox; cy = y0 + oy;
      if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;
      ci2 = cy * N + cx;
      if (THREAT_STAMP[ci2] !== THREAT_OP) { THREAT_STAMP[ci2] = THREAT_OP; THREAT_CELLS[n++] = ci2; }
    }
    for (i = 0; i < n; i++) {
      var cell = THREAT_CELLS[i];
      if (b[cell] !== 0 || !st.near[cell]) continue;
      for (var c = 1; c <= 2; c++) {
        var T = st.evalInc[c], v = dirOnlyFast(b, st.dir[c], cell);
        if (delta > 0) {
          T.freq.set(v, (T.freq.get(v) || 0) + 1);
          if (v > T.max) T.max = v;
        } else {
          var left = (T.freq.get(v) || 0) - 1;
          if (left > 0) T.freq.set(v, left); else T.freq.delete(v);
          if (v === T.max && left <= 0) {
            var m = 0;
            T.freq.forEach(function (cnt, key) { if (key > m) m = key; });
            T.max = m;
          }
        }
      }
    }
  }
  function buildEvalInc(b, st) {
    var E = { 1: { W: 0, runScore: 0, fours: 0, threes: 0, freq: new Map(), max: 0 },
              2: { W: 0, runScore: 0, fours: 0, threes: 0, freq: new Map(), max: 0 } };
    st.evalInc = E;
    var i, k, cells, cv, o1, o2;
    for (i = 0; i < WINDOWS.length; i++) {
      cells = WINDOWS[i]; o1 = 0; o2 = 0;
      for (k = 0; k < 5; k++) { cv = b[cells[k]]; if (cv === 1) o1++; else if (cv === 2) o2++; }
      if (o1 && !o2) E[1].W += WINDOW_TABLE[o1];
      else if (o2 && !o1) E[2].W += WINDOW_TABLE[o2];
    }
    for (var c = 1; c <= 2; c++) {
      for (var d = 0; d < 4; d++) {
        var dx = DIRS[d][0], dy = DIRS[d][1];
        for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
          var px = x - dx, py = y - dy;
          if (px >= 0 && px < N && py >= 0 && py < N) continue;
          var s = lineStats(b, y * N + x, d, c);
          E[c].runScore += s[0]; E[c].fours += s[1]; E[c].threes += s[2];
        }
      }
      for (i = 0; i < CELLS; i++) {
        if (b[i] !== 0 || !st.near[i]) continue;
        var v = dirOnlyFast(b, st.dir[c], i), T = E[c];
        T.freq.set(v, (T.freq.get(v) || 0) + 1);
        if (v > T.max) T.max = v;
      }
    }
  }
  function evaluateInc(player, opp, st) {
    var P = st.evalInc[player], O = st.evalInc[opp];
    var score = P.W - O.W * 11 / 10;
    score += P.runScore - O.runScore * 11 / 10;
    score += comboBonus(P) - comboBonus(O) * 11 / 10;
    score += (P.max - O.max * 11 / 10) / 2;
    return score;
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
  function genCandidates(b, player, opp, limit, defWeight, near, dir) {
    var arrP = dir ? dir[player] : buildDirArrays(b, player, DIR_SCRATCH_P);
    var arrO = dir ? dir[opp] : buildDirArrays(b, opp, DIR_SCRATCH_O);
    var list = [];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var idx = y * N + x;
      if (b[idx] !== 0 || (near ? !near[idx] : !hasNeighbor(b, x, y))) continue;
      var center = Math.max(0, 14 - (Math.abs(x - 7) + Math.abs(y - 7)));
      // 窗口势能一次遍历同时算攻防两侧（窗口内只有己子时计己分、只有对方子时计对方分）
      var ws = CELL_WINDOWS[idx], wAtk = 0, wDef = 0, wi, k, cells, own, op2, cv;
      for (wi = 0; wi < ws.length; wi++) {
        cells = WINDOWS[ws[wi]]; own = 0; op2 = 0;
        for (k = 0; k < 5; k++) { cv = b[cells[k]]; if (cv === player) own++; else if (cv === opp) op2++; }
        if (op2 === 0) wAtk += WINDOW_TABLE[Math.min(own + 1, 5)];
        if (own === 0) wDef += WINDOW_TABLE[Math.min(op2 + 1, 5)];
      }
      var atk = wAtk + dirOnlyFast(b, arrP, idx) + center;
      var def = wDef + dirOnlyFast(b, arrO, idx) + center;
      list.push({ idx: idx, x: x, y: y, atk: atk, def: def, s: atk + def * defWeight });
    }
    list.sort(function (a, c) { return c.s - a.s; });
    if (list.length > limit) list.length = limit;
    return list;
  }

  // 精确成五点：落子后真成五的点（启发分会把双四等组合也叠到千万级，不能用于逻辑判定）
  function isWinAfter(b, idx, p) { b[idx] = p; var r = checkWinFlat(b, idx, p); b[idx] = 0; return r; }
  function exactWinPoints(b, p, near) {
    var res = [];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var idx = y * N + x;
      if (b[idx] === 0 && (near ? near[idx] > 0 : hasNeighbor(b, x, y)) && isWinAfter(b, idx, p)) res.push(idx);
    }
    return res;
  }

  // ---------- VCF 威胁搜索（连续冲四必胜求解） ----------
  // 原理：造四的一方每步只留给对方唯一的堵点（冲四只有一个成五点），对方被迫跟堵，
  // 分叉极小，因此能精确算到十几层——正好补常规搜索深度不够、被冲四链绝杀的盲区。
  // 对方对冲四不存在「反冲四」式解围：不堵成五点，下一手进攻方直接成五终局。
  // 唯一的例外是堵点恰好让防守方自己成五（堵着堵着赢了），求解里单独判掉。
  // 假设 idx 已落 p：经 idx 的 5 格窗口中恰含 4 个 p 且无异子的窗口，其空位即成五点
  function winPointsThrough(b, idx, p) {
    var res = [], seen = {}, ws = CELL_WINDOWS[idx], i, k, cells, own, empty, bad, cv;
    for (i = 0; i < ws.length; i++) {
      cells = WINDOWS[ws[i]]; own = 0; empty = -1; bad = false;
      for (k = 0; k < 5; k++) {
        cv = b[cells[k]];
        if (cv === p) own++;
        else if (cv === 0) empty = cells[k];
        else { bad = true; break; }
      }
      if (!bad && own === 4 && empty >= 0 && !seen[empty]) { seen[empty] = 1; res.push(empty); }
    }
    return res;
  }
  // 所有「落子后产生 ≥1 个成五点」的空点（造四手，含活四/冲四/断点四）
  function fourMoves(b, st, p) {
    var res = [];
    for (var i = 0; i < CELLS; i++) {
      if (b[i] !== 0 || !st.near[i]) continue;
      b[i] = p;
      if (winPointsThrough(b, i, p).length) res.push(i);
      b[i] = 0;
    }
    return res;
  }
  // 轮到 atk：返回必胜首着 idx；-1 已证明无必胜；-2 中止（超节点/超时，未知）。
  // 关键：中止靠返回值层层传递、绝不抛异常——异常会穿透递归、跳过沿途的 undoStone，
  // 在棋盘上留下幻影子，毒化本次 searchRoot 后续全部搜索（实测确诊的实战缺陷）。
  function vcfAtk(b, st, atk, def, left) {
    st.vcfNodes++;
    if (st.vcfNodes > 2500 || ((st.vcfNodes & 63) === 0 && Date.now() > st.vcfDeadline)) return -2;
    var wins = exactWinPoints(b, atk, st.near);
    if (wins.length) return wins[0]; // 已有成五点（上一手造出活四的兑现），不占进攻手数
    if (left <= 0) return -1;
    var defWins = exactWinPoints(b, def, st.near);
    if (defWins.length >= 2) return -1; // 对方已活四，这边来不及
    var moves = fourMoves(b, st, atk);
    if (defWins.length === 1) {
      var dw = defWins[0];
      moves = moves.filter(function (m) { return m === dw; }); // 必须落在对方成五点上边堵边攻
    }
    for (var mi = 0; mi < moves.length; mi++) {
      var m = moves[mi];
      placeStone(b, st, m, atk);
      var wps = winPointsThrough(b, m, atk);
      var ok = false, aborted = false;
      if (wps.length >= 2) ok = true; // 活四/双四：对方一手堵不完
      else if (wps.length === 1) {
        var block = wps[0];
        placeStone(b, st, block, def);
        // 堵点让防守方直接成五则此路不通；否则递归看后续冲四链
        if (!checkWinFlat(b, block, def)) {
          var sub = vcfAtk(b, st, atk, def, left - 1);
          if (sub === -2) aborted = true;
          else if (sub >= 0) ok = true;
        }
        undoStone(b, st, block, def);
      }
      undoStone(b, st, m, atk);
      if (aborted) return -2;
      if (ok) return m;
    }
    return -1;
  }
  // 三态：>=0 必胜首着；-1 已证明无必胜；-2 中止未知。防守判定只认 -1 为已证安全。
  function vcfSolve(b, st, atk, def, maxMoves, budgetMs) {
    st.vcfNodes = 0;
    st.vcfDeadline = Date.now() + budgetMs;
    return vcfAtk(b, st, atk, def, maxMoves);
  }
  // ---------- 难度 ----------
  var LEVELS = {
    easy:   { depth: 2, width: 8,  time: 350,  defWeight: 0.9,  blunder: 0.30 },
    normal: { depth: 4, width: 10, time: 1200, defWeight: 1.1,  blunder: 0 },
    hard:   { depth: 5, width: 11, time: 2000, defWeight: 1.22, blunder: 0 },
    master: { depth: 6, width: 12, time: 2800, defWeight: 1.28, blunder: 0, vcf: true }
  };

  // ---------- 着法排序：置换表着法 > killer > history > 启发分 ----------
  function addKiller(st, ply, idx) {
    var k = st.killers[ply] || (st.killers[ply] = []);
    if (k[0] !== idx) { k[1] = k[0]; k[0] = idx; }
  }
  function orderCands(cands, ttMove, ply, player, st) {
    var killers = st.killers[ply] || [];
    var hist = st.history[player];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i], bonus = 0;
      if (c.idx === ttMove) bonus = 100000000;
      else if (c.idx === killers[0] || c.idx === killers[1]) bonus = 80000;
      else bonus = Math.min(30000, hist[c.idx] >> 2);
      c.o = c.s + bonus;
    }
    cands.sort(function (a, b) { return b.o - a.o; });
  }

  // 根状态复原：把棋盘与 st 的派生状态（hash/near/dir/增量评估）一并重置到快照，
  // 防御任何异常路径（如 negamax 超时抛错跳过 undoStone）留下的残留污染后续逻辑
  function restoreRootState(b, st, snap) {
    b.set(snap);
    st.hash = hashBoard(b);
    st.near = buildNear(b);
    st.dir = { 1: buildDirArrays(b, 1, newDirSet()), 2: buildDirArrays(b, 2, newDirSet()) };
    buildEvalInc(b, st);
  }

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
    if (TT_PERSIST.size > 250000) TT_PERSIST.clear();
    if (EVAL_CACHE.size > 450000) EVAL_CACHE.clear();
    var st = { nodes: 0, deadline: t0 + cfg.time, aborted: false, tt: TT_PERSIST, hash: hashBoard(b), cfg: cfg, near: buildNear(b), killers: [], history: [null, new Int32Array(CELLS), new Int32Array(CELLS)], rootFilter: null, prevBest: -1, vcfNodes: 0, vcfDeadline: 0, dir: { 1: buildDirArrays(b, 1, newDirSet()), 2: buildDirArrays(b, 2, newDirSet()) } };
    buildEvalInc(b, st);
    var bSnap = b.slice();
    // VCF 先行（仅大师）：有连续冲四必胜直接兑现，不必等常规搜索慢慢推
    if (cfg.vcf) {
      var vcfWin = vcfSolve(b, st, aiColor, opp, 10, 200);
      if (vcfWin >= 0) return { x: vcfWin % N, y: (vcfWin / N) | 0, score: WIN_SCORE - 20, depth: 0, nodes: st.nodes, ms: Date.now() - t0, vcf: 1 };
      // 对方有 VCF 时预先算安全着法集合供根节点过滤（我落子只会削弱对方 VCF，判据单调、安全）
      var oppVcf = vcfSolve(b, st, opp, aiColor, 10, 200);
      if (oppVcf >= 0) {
        var pool = genCandidates(b, aiColor, opp, cfg.width + 4, cfg.defWeight, st.near, st.dir);
        var seenIdx = {}, pi, exIdx;
        for (pi = 0; pi < pool.length; pi++) seenIdx[pool[pi].idx] = 1;
        var extra = fourMoves(b, st, aiColor).concat(exactWinPoints(b, opp, st.near));
        for (pi = 0; pi < extra.length; pi++) {
          exIdx = extra[pi];
          if (!seenIdx[exIdx]) { seenIdx[exIdx] = 1; pool.push({ idx: exIdx, x: exIdx % N, y: (exIdx / N) | 0, atk: 0, def: 0, s: 0 }); }
        }
        var safe = [], unknown = [];
        for (pi = 0; pi < pool.length; pi++) {
          placeStone(b, st, pool[pi].idx, aiColor);
          var stillWin = vcfSolve(b, st, opp, aiColor, 12, 50);
          undoStone(b, st, pool[pi].idx, aiColor);
          if (stillWin === -1) { safe.push(pool[pi].idx); if (safe.length >= 8) break; }
          else if (stillWin === -2) unknown.push(pool[pi].idx);
        }
        // 首轮无已证安全着法时，对未知候选加大预算复核（区分真安全与没算完）
        if (!safe.length && unknown.length) {
          for (pi = 0; pi < unknown.length && pi < 4; pi++) {
            placeStone(b, st, unknown[pi], aiColor);
            var re = vcfSolve(b, st, opp, aiColor, 12, 150);
            undoStone(b, st, unknown[pi], aiColor);
            if (re === -1) safe.push(unknown[pi]);
          }
        }
        if (safe.length) st.rootFilter = new Set(safe);
        else {
          // 兜底：至少把根节点限制在对方杀链的关键格上（杀链首着本身 ∪ 其成五点），
          // 这些是必要防线——堵不住也比在别处落子强，交给搜索在其中择优
          var key = {};
          key[oppVcf] = 1;
          placeStone(b, st, oppVcf, opp);
          var kw = winPointsThrough(b, oppVcf, opp);
          undoStone(b, st, oppVcf, opp);
          for (pi = 0; pi < kw.length; pi++) key[kw[pi]] = 1;
          st.rootFilter = new Set(Object.keys(key).map(Number));
        }
      }    }
    restoreRootState(b, st, bSnap); // 预检只许读不许改：复原后主搜索面对的一定是真实局面
    var best = null, reachedDepth = 0;
    var maxDepth = cfg.depth;
    // 全部难度都迭代加深：超时就用上一层已完成的结果，绝不退化成贪心一手
    for (var depth = 2; depth <= maxDepth; depth++) {
      // 已用时间过半则不再开启新深度（大概率搜不完，不如保住已有结果）
      if (depth > 2 && Date.now() - t0 > cfg.time * 0.45) break;
      try {
        var r = negamaxRoot(b, aiColor, opp, depth, st);
        if (r && r.idx !== undefined) { best = r; reachedDepth = depth; st.prevBest = r.idx; }
      } catch (e) { st.aborted = true; }
      if (st.aborted || Date.now() > st.deadline) break;
      if (best && Math.abs(best.score) > WIN_SCORE / 2) break; // 已找到必胜/必败线
    }
    restoreRootState(b, st, bSnap); // 超时抛错可能跳过 undoStone，兜底/失误逻辑读盘面前先复原
    if (!best) { // 兜底：贪心一手
      var c = genCandidates(b, aiColor, opp, 1, cfg.defWeight, st.near, st.dir)[0];
      best = { idx: c.idx, score: 0 };
    }
    var result = { x: best.idx % N, y: (best.idx / N) | 0, score: best.score, depth: reachedDepth, nodes: st.nodes, ms: Date.now() - t0 };
    // 简单难度：概率性次优着法（像真人失误，但不送成五的命）
    if (cfg.blunder > 0 && Math.random() < cfg.blunder && stones > 2 && exactWinPoints(b, opp).length === 0) {
      var top = genCandidates(b, aiColor, opp, 6, cfg.defWeight, st.near, st.dir);
      if (top.length > 2) {
        var pick = top[1 + Math.floor(Math.random() * Math.min(3, top.length - 1))];
        if (pick && !isWinAfter(b, pick.idx, opp)) result = { x: pick.x, y: pick.y, score: 0, depth: reachedDepth, nodes: st.nodes, ms: Date.now() - t0 };
      }
    }
    return result;
  }

  function negamaxRoot(b, player, opp, depth, st) {
    var cands = genCandidates(b, player, opp, st.cfg.width + 4, st.cfg.defWeight, st.near, st.dir);
    // 我方有精确成五点：直接赢
    for (var i = 0; i < cands.length; i++) if (isWinAfter(b, cands[i].idx, player)) return { idx: cands[i].idx, score: WIN_SCORE - 1 };
    // 对方有精确成五点且我方不能立即赢：必须堵，别无选择
    var oppWins = exactWinPoints(b, opp, st.near);
    if (oppWins.length) {
      var blocks = cands.filter(function (c) { return oppWins.indexOf(c.idx) >= 0; });
      if (blocks.length) cands = blocks;
      else cands = oppWins.map(function (idx) { return { idx: idx, x: idx % N, y: (idx / N) | 0, atk: 0, def: 0, s: 0 }; });
    }
    // VCF/VCT 防守过滤：只留已证明能拆掉对方杀链的着法（与堵点限制取交集）；
    // 交集为空但对方无立即成五点时不能丢弃过滤——防线格常不在启发式候选里，
    // 直接以安全集为候选（否则整层防守会被静默绕过，实测踩过）
    if (st.rootFilter) {
      var f = cands.filter(function (c) { return st.rootFilter.has(c.idx); });
      if (f.length) cands = f;
      else if (!oppWins.length) {
        var fc2 = [];
        st.rootFilter.forEach(function (idx) { if (b[idx] === 0) fc2.push({ idx: idx, x: idx % N, y: (idx / N) | 0, atk: 0, def: 0, s: 0 }); });
        if (fc2.length) cands = fc2;
      }
    }
    // 迭代加深：上一轮的根节点最佳着法优先试，剪枝更早发生
    if (st.prevBest >= 0) {
      for (i = 0; i < cands.length; i++) {
        if (cands[i].idx === st.prevBest) { var t = cands.splice(i, 1)[0]; cands.unshift(t); break; }
      }
    }
    var alpha = -Infinity, best = null;
    for (i = 0; i < cands.length; i++) {
      var c = cands[i];
      placeStone(b, st, c.idx, player);
      var sc;
      if (checkWinFlat(b, c.idx, player)) sc = WIN_SCORE - 1;
      else if (depth <= 1) sc = evalCached(b, player, opp, st);
      else sc = -negamax(b, depth - 1, -Infinity, -alpha, opp, player, 1, st, 5);
      undoStone(b, st, c.idx, player);
      if (best === null || sc > best.score) best = { idx: c.idx, score: sc };
      if (sc > alpha) alpha = sc;
    }
    return best;
  }

  function negamax(b, depth, alpha, beta, player, opp, ply, st, ext) {
    st.nodes++;
    if ((st.nodes & 1023) === 0 && Date.now() > st.deadline) throw new Error('timeout');
    // 置换表：分数存的是归一化杀棋分（与所在层数无关），取回时按当前层数还原
    var key = st.hash ^ (player === 2 ? ZOB_TURN : 0);
    var hit = st.tt.get(key);
    var ttMove = hit ? hit.move : -1;
    if (hit && hit.depth >= depth) {
      var hs = hit.score;
      if (hs > WIN_SCORE / 2) hs -= ply; else if (hs < -WIN_SCORE / 2) hs += ply;
      if (hit.flag === 0) return hs;
      if (hit.flag === 1 && hs > alpha) alpha = hs;
      if (hit.flag === 2 && hs < beta) beta = hs;
      if (alpha >= beta) return hs;
    }
    var width = depth >= 3 ? st.cfg.width : Math.max(5, st.cfg.width - 5);
    var cands = genCandidates(b, player, opp, width, st.cfg.defWeight, st.near, st.dir);
    if (!cands.length) return evalCached(b, player, opp, st);
    for (var i = 0; i < cands.length; i++) if (isWinAfter(b, cands[i].idx, player)) return WIN_SCORE - ply;
    var oppWins = exactWinPoints(b, opp, st.near);
    if (oppWins.length) {
      var blocks = cands.filter(function (c) { return oppWins.indexOf(c.idx) >= 0; });
      if (blocks.length) cands = blocks.slice(0, 3);
      else cands = oppWins.slice(0, 3).map(function (idx) { return { idx: idx, x: idx % N, y: (idx / N) | 0, atk: 0, def: 0, s: 0 }; });
    }
    orderCands(cands, ttMove, ply, player, st);
    var best = -Infinity, bestIdx = -1, a = alpha, first = true;
    for (i = 0; i < cands.length; i++) {
      var c = cands[i];
      placeStone(b, st, c.idx, player);
      var sc;
      if (checkWinFlat(b, c.idx, player)) sc = WIN_SCORE - ply;
      else if (depth <= 1) {
        // 强制着法延伸：造四/堵活四以上的着法多看一层，避免「差一层就被杀」的视野盲区
        // 预算按路径计（每条线 ext 次），不再全局共享被先搜到的线吃光
        if (ply < 12 && ext > 0 && (c.atk >= 110000 || c.def >= 1000000)) sc = -negamax(b, 1, -beta, -a, opp, player, ply + 1, st, ext - 1);
        else sc = evalCached(b, player, opp, st);
      }
      else if (first) { sc = -negamax(b, depth - 1, -beta, -a, opp, player, ply + 1, st, ext); first = false; }
      else {
        // LMR：排序靠后的安静着法先折减一层零窗试探，超预期才逐级复核到全深；
        // 造四/堵四等强制着法、必须堵成五点的局面、已接近必杀分时不折减（防漏杀）
        var reduced = depth >= 3 && i >= 3 && !oppWins.length && c.atk < 110000 && c.def < 1000000 && a > -WIN_SCORE / 2 && a < WIN_SCORE / 2;
        if (reduced) {
          sc = -negamax(b, depth - 2, -a - 1, -a, opp, player, ply + 1, st, ext);
          if (sc > a) {
            sc = -negamax(b, depth - 1, -a - 1, -a, opp, player, ply + 1, st, ext);
            if (sc > a && sc < beta) sc = -negamax(b, depth - 1, -beta, -a, opp, player, ply + 1, st, ext);
          }
        } else {
          // PVS：首着全窗，其余先用零窗试探，超预期才全窗重搜
          sc = -negamax(b, depth - 1, -a - 1, -a, opp, player, ply + 1, st, ext);
          if (sc > a && sc < beta) sc = -negamax(b, depth - 1, -beta, -a, opp, player, ply + 1, st, ext);
        }
      }
      undoStone(b, st, c.idx, player);
      if (sc > best) { best = sc; bestIdx = c.idx; }
      if (sc > a) a = sc;
      if (a >= beta) {
        if (bestIdx >= 0) { addKiller(st, ply, bestIdx); st.history[player][bestIdx] += depth * depth; }
        break;
      }
    }
    if (st.tt.size < 250000) {
      var sv = best;
      if (sv > WIN_SCORE / 2) sv += ply; else if (sv < -WIN_SCORE / 2) sv -= ply;
      st.tt.set(key, { depth: depth, score: sv, flag: best <= alpha ? 2 : (best >= beta ? 1 : 0), move: bestIdx });
    }
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
    // VCF 求解（测试与诊断用）：atk 方有连续冲四必胜时返回首着 {x,y}，否则 null
    vcfWin: function (board2d, atkColor) {
      var b = toFlat(board2d);
      var st = { hash: hashBoard(b), near: buildNear(b), vcfNodes: 0, vcfDeadline: 0 };
      var r = vcfSolve(b, st, atkColor, atkColor === 1 ? 2 : 1, 10, 3000);
      return r >= 0 ? { x: r % N, y: (r / N) | 0 } : null;
    },
    pointScore: function (board2d, x, y, p) { return pointScore(toFlat(board2d), x, y, p); },
    evaluate: function (board2d, p) { return evaluate(toFlat(board2d), p, p === 1 ? 2 : 1); },
    checkWin: function (board2d, x, y, p) { return checkWinFlat(toFlat(board2d), y * N + x, p); }
  };
})();
`;
