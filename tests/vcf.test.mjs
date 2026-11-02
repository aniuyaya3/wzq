// VCF 威胁搜索测试：链式冲四必胜（需看 7 层）、链断无必胜、堵点成五反杀、防守拆链、根节点接入
// 运行：node tests/vcf.test.mjs
import vm from 'node:vm';
import { ENGINE_JS } from '../src/engine.js';

const ctx = vm.createContext({});
vm.runInContext(ENGINE_JS, ctx);
const AI = ctx.GomokuAI;
if (!AI) { console.error('❌ GomokuAI 未导出'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
const B = () => Array.from({ length: 15 }, () => Array(15).fill(0));
function put(b, list, p) { for (const [x, y] of list) b[y][x] = p; }
const clone = (b) => b.map((r) => r.slice());

// 干净链（手工逐项核过无第二条链）：三条线靠交点串联——
//  线A 横 y=3：攻 (3,3)(4,3)(5,3)，守 (2,3) 堵左端 → (6,3) 冲四，堵点 (7,3)
//  线B 竖 x=6：攻 (6,4)(6,5) + 首着 (6,3) 成三，守 (6,2) 堵上端 → (6,6) 冲四，堵点 (6,7)
//  线C 斜 ↘：攻 (7,7)(8,8) + 二着 (6,6) 成三 → (9,9)/(5,5) 成活四，下一手成五
//  兑现在攻方第 4 手（第 7 层）；每一步的造四手都唯一
function cleanChain(atk, def) {
  const b = B();
  put(b, [[3, 3], [4, 3], [5, 3], [6, 4], [6, 5], [7, 7], [8, 8], [12, 2], [2, 12]], atk);
  put(b, [[2, 3], [6, 2], [0, 0], [14, 14], [0, 14], [14, 0], [13, 1], [1, 13]], def);
  return b;
}
// 富局面（原 exp 局面）：除设计链外另藏一条竖线/大斜线链，求解器应照样找到 (8,7) 首着
function richBoard(atk, def) {
  const b = B();
  put(b, [[5, 7], [6, 7], [7, 7], [6, 5], [7, 6], [7, 10], [8, 9], [2, 2], [12, 12]], atk);
  put(b, [[4, 7], [5, 4], [0, 0], [14, 14], [0, 14], [14, 0], [13, 1], [1, 13]], def);
  return b;
}

// 沿求解器给的线走到底：攻方每步用求解器，守方轮流试「堵点 / 上一手周边乱走」，
// 任何分支下攻方都必须在限额内成五——验证求解结论可兑现（守方不堵成五点则下一手直接成五）
function simulateWin(b, atk, maxAtkMoves) {
  const def = atk === 1 ? 2 : 1;
  function defReplies(board, lastIdx) {
    const set = new Set();
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
      if (board[y][x] !== 0) continue;
      board[y][x] = atk;
      if (AI.checkWin(board, x, y, atk)) set.add(y * 15 + x); // 攻方成五点 = 守方必堵点
      board[y][x] = 0;
    }
    const lx = lastIdx % 15, ly = (lastIdx / 15) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = lx + dx, ny = ly + dy;
      if (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && board[ny][nx] === 0) set.add(ny * 15 + nx);
    }
    return [...set];
  }
  function rec(board, left) {
    const mv = AI.vcfWin(board, atk);
    if (!mv) return false;
    board[mv.y][mv.x] = atk;
    if (AI.checkWin(board, mv.x, mv.y, atk)) { board[mv.y][mv.x] = 0; return true; }
    if (left <= 1) { board[mv.y][mv.x] = 0; return false; }
    const replies = defReplies(board, mv.y * 15 + mv.x);
    let all = true;
    for (const ri of replies) {
      const rx = ri % 15, ry = (ri / 15) | 0;
      board[ry][rx] = def;
      if (AI.checkWin(board, rx, ry, def)) { all = false; }
      else if (!rec(board, left - 1)) { all = false; }
      board[ry][rx] = 0;
      if (!all) break;
    }
    board[mv.y][mv.x] = 0;
    return all;
  }
  return rec(clone(b), maxAtkMoves);
}

console.log('== VCF 求解器 ==');
{
  const b = cleanChain(1, 2);
  const t0 = Date.now();
  const w = AI.vcfWin(b, 1);
  const ms = Date.now() - t0;
  ok('干净链判必胜且首着为 (6,3)', !!w && w.x === 6 && w.y === 3, JSON.stringify(w));
  ok('求解耗时 < 500ms', ms < 500, `${ms}ms`);
  ok('模拟对弈：任意防守下 5 手内成五', simulateWin(b, 1, 5));
}
{
  const b = richBoard(1, 2);
  const w = AI.vcfWin(b, 1);
  ok('富局面判必胜且首着为 (8,7)', !!w && w.x === 8 && w.y === 7, JSON.stringify(w));
  ok('富局面模拟对弈 10 手内成五', simulateWin(b, 1, 10));
}
{
  // 链断：富局面预占两条链的关键点 (10,9) 与 (7,9) → 造四手枯竭 → 无必胜
  const b = richBoard(1, 2);
  b[9][10] = 2; b[9][7] = 2;
  ok('双链皆断后无必胜', AI.vcfWin(b, 1) === null);
}
{
  // 堵点成五反杀：白在 x=9 有 (9,3)(9,4)(9,5)(9,6)，黑冲四的堵点 (9,7) 恰是白的成五点
  // 且白另有成五点 (9,2)——黑其实已输，求解器不得误报必胜
  const b = B();
  put(b, [[5, 7], [6, 7], [7, 7], [2, 2]], 1);
  put(b, [[4, 7], [9, 3], [9, 4], [9, 5], [9, 6]], 2);
  ok('对方双成五点时不误报必胜', AI.vcfWin(b, 1) === null);
}
{
  const b = B(); put(b, [[7, 7]], 1); put(b, [[8, 8]], 2);
  ok('安静局面无必胜', AI.vcfWin(b, 1) === null && AI.vcfWin(b, 2) === null);
}

console.log('== VCF 接入大师 ==');
{
  const b = cleanChain(1, 2);
  const r = AI.findBestMove(b, 1, 'master');
  ok('大师走 VCF 首着 (6,3)', r.x === 6 && r.y === 3, `got ${r.x},${r.y}`);
}
{
  // 防守：白持干净链、黑先行——黑落子后白不得再有 VCF（拆链点存在：占 (6,3) 或 (6,6) 等）
  const b = cleanChain(2, 1);
  const r = AI.findBestMove(b, 1, 'master');
  b[r.y][r.x] = 1;
  ok('大师拆掉对方 VCF 链', AI.vcfWin(b, 2) === null, `black played ${r.x},${r.y}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
