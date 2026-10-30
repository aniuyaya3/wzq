// AI 引擎仿真测试：战术题 + 陪练对局 + 性能
// 运行：node tests/ai.test.mjs
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
function playGame(first, second, maxMoves = 140) {
  // first/second: (board,color)=>{x,y}
  const b = B(); let turn = 1; const seq = [];
  for (let i = 0; i < maxMoves; i++) {
    const fn = turn === 1 ? first : second;
    const mv = fn(b, turn);
    if (!mv || b[mv.y][mv.x] !== 0) return { winner: -1, moves: seq, error: `illegal move by ${turn}: ${JSON.stringify(mv)}` };
    b[mv.y][mv.x] = turn; seq.push({ ...mv, p: turn });
    if (AI.checkWin(b, mv.x, mv.y, turn)) return { winner: turn, moves: seq };
    turn = turn === 1 ? 2 : 1;
  }
  return { winner: 0, moves: seq };
}
const smart = (level) => (b, c) => AI.findBestMove(b, c, level);
const greedy = (b, c) => AI.greedyMove(b, c);

console.log('== 战术题 ==');
// 1. 立即成五：黑四连 (7,7)-(10,7)，AI 执黑补一端成五
{
  const b = B(); put(b, [[7, 7], [8, 7], [9, 7], [10, 7]], 1); put(b, [[7, 9], [8, 9]], 2);
  const r = AI.findBestMove(b, 1, 'hard');
  ok('有五必成五', (r.x === 6 && r.y === 7) || (r.x === 11 && r.y === 7), `got ${r.x},${r.y}`);
}
// 2. 必堵成五：白冲四 (7,7)-(10,7)，左端被黑堵，只能堵右端 (11,7)
{
  const b = B(); put(b, [[7, 7], [8, 7], [9, 7], [10, 7]], 2); put(b, [[6, 7]], 1); put(b, [[3, 3]], 1);
  const r = AI.findBestMove(b, 1, 'hard');
  ok('冲四必堵唯一点', r.x === 11 && r.y === 7, `got ${r.x},${r.y}`);
}
// 3. 防活三：白活三 (7,7)-(9,7)，AI 必须落在两端之一或造出四威胁
{
  const b = B(); put(b, [[7, 7], [8, 7], [9, 7]], 2); put(b, [[7, 5]], 1);
  const r = AI.findBestMove(b, 1, 'hard');
  const ends = [[6, 7], [10, 7], [5, 7], [11, 7]];
  ok('活三必防（堵端/压制）', ends.some(([x, y]) => x === r.x && y === r.y), `got ${r.x},${r.y}`);
}
// 4. 四三杀着：黑在 (10,7) 可成冲四，同时 (7,4)(7,5)(7,6) 纵向活三 → (7,7) 为四三点？
//    构造：横向黑 (8,7)(9,7)(10,7) 活三 + 纵向黑 (7,4)(7,5)(7,6) 活三，交点 (7,7) 成双三；
//    更强：横向已有四缺一：(8,7)(9,7)(10,7)(11,7) 中间缺 (10,7) 不连续，改用经典四三：
//    横向 (7,7)(8,7)(9,7) + 纵向 (10,4)(10,5)(10,6)，点 (10,7) 同时成四（横向活四）与三 → 必走 (10,7)
{
  const b = B(); put(b, [[7, 7], [8, 7], [9, 7], [10, 4], [10, 5], [10, 6]], 1);
  put(b, [[3, 12], [4, 12]], 2);
  const r = AI.findBestMove(b, 1, 'hard');
  ok('识别四三/双三杀点', r.x === 10 && r.y === 7, `got ${r.x},${r.y}`);
}
// 5. 对方双三将成：白在 (7,7) 可成双三，AI 必须抢占该点（或造四反杀）
//    白横 (8,7)(9,7) 纵 (7,8)(7,9)，交点 (7,7) 是双三点
{
  const b = B(); put(b, [[8, 7], [9, 7], [7, 8], [7, 9]], 2); put(b, [[12, 12]], 1);
  const r = AI.findBestMove(b, 1, 'hard');
  ok('对方双三点必抢占', r.x === 7 && r.y === 7, `got ${r.x},${r.y}`);
}
// 6. 断点棋型：白 X X _ X (7,7)(8,7)(10,7)，AI 须堵 (9,7) 断点
{
  const b = B(); put(b, [[7, 7], [8, 7], [10, 7]], 2); put(b, [[6, 7]], 1); put(b, [[2, 2]], 1);
  const score = AI.pointScore(b, 9, 7, 2);
  const r = AI.findBestMove(b, 1, 'hard');
  ok('断点成四点价值高', score >= 40000, `score=${score}`);
  // 堵断点是标准解；不堵则必须保证白填断点成冲四后黑仍不被强杀（可反抢节奏）
  let okBlock = (r.x === 9 && r.y === 7);
  if (!okBlock) {
    b[r.y][r.x] = 1; b[7][9] = 2; // 黑落子 + 白填断点成四
    const resp = AI.findBestMove(b, 1, 'hard');
    okBlock = resp.score > -10000000; // 黑有应招，未被判死
  }
  ok('AI 堵断点或有反制', okBlock, `got ${r.x},${r.y}`);
}

console.log('== 性能 ==');
{
  // 安静的中盘局面（无现成活四/成五点），考验真实搜索深度
  const b = B();
  put(b, [[7, 7], [9, 8], [6, 10], [11, 6], [4, 12]], 1);
  put(b, [[8, 8], [7, 10], [10, 9], [5, 6], [12, 12]], 2);
  const t0 = Date.now(); const r = AI.findBestMove(b, 1, 'master');
  const ms = Date.now() - t0;
  console.log(`  大师中盘一手：${ms}ms depth=${r.depth} nodes=${r.nodes} -> ${r.x},${r.y}`);
  ok('大师单步 < 4000ms', ms < 4000, `${ms}ms`);
  ok('大师搜索深度 >= 4', r.depth >= 4, `depth=${r.depth}`);
}

console.log('== 陪练对局（搜索 AI vs 贪心 AI）==');
{
  const g1 = playGame(smart('normal'), greedy);
  console.log(`  普通(黑) vs 贪心(白)：winner=${g1.winner} moves=${g1.moves.length} ${g1.error || ''}`);
  ok('普通执黑不输给贪心', g1.winner === 1 || g1.winner === 0, `winner=${g1.winner}`);
  const g2 = playGame(smart('hard'), greedy);
  console.log(`  困难(黑) vs 贪心(白)：winner=${g2.winner} moves=${g2.moves.length} ${g2.error || ''}`);
  ok('困难执黑不输给贪心', g2.winner === 1 || g2.winner === 0, `winner=${g2.winner}`);
  const g3 = playGame(greedy, smart('hard'));
  console.log(`  贪心(黑) vs 困难(白)：winner=${g3.winner} moves=${g3.moves.length} ${g3.error || ''}`);
  ok('困难执白不输给贪心', g3.winner === 2 || g3.winner === 0, `winner=${g3.winner}`);
}

console.log('== 自我对弈完整性 ==');
{
  const g = playGame(smart('normal'), smart('normal'));
  console.log(`  普通 vs 普通：winner=${g.winner} moves=${g.moves.length} ${g.error || ''}`);
  ok('自对弈无非法着法且终局', g.winner !== -1 && g.moves.length >= 9);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
