// 双活三识别常驻回归：冻结题库（tests/d3-positions.json，由 combo-recognition 同种子生成冻结）
// 防守题判「已处理」= 直接防住 / 抢先成自己的组合手 / 造四反制；进攻题判命中 = 打出组合手或更强。
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ENGINE_JS } from '../src/engine.js';

const ctx = vm.createContext({});
vm.runInContext(ENGINE_JS, ctx);
const AI = ctx.GomokuAI;
const N = 15;
const data = JSON.parse(readFileSync(new URL('./d3-positions.json', import.meta.url), 'utf8'));
const clone = (b) => b.map((r) => r.slice());
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function classifyAt(b, x, y, p) {
  let live3 = 0, four = 0;
  for (const [dx, dy] of DIRS) {
    let count = 1, open = 0;
    for (const s of [1, -1]) {
      let cx = x + dx * s, cy = y + dy * s;
      while (cx >= 0 && cx < N && cy >= 0 && cy < N && b[cy][cx] === p) { count++; cx += dx * s; cy += dy * s; }
      if (cx >= 0 && cx < N && cy >= 0 && cy < N && b[cy][cx] === 0) open++;
    }
    if (count >= 5) return { five: true, live3, four };
    if (count === 4 && open >= 1) four++;
    else if (count === 3 && open === 2) live3++;
  }
  return { five: false, live3, four };
}
function doubleThreeMoves(b, p) {
  const out = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (b[y][x] !== 0) continue;
    let nearS = false;
    for (let dy = -2; dy <= 2 && !nearS; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && nx < N && ny >= 0 && ny < N && b[ny][nx] !== 0) { nearS = true; break; } }
    if (!nearS) continue;
    b[y][x] = p;
    const c = classifyAt(b, x, y, p);
    b[y][x] = 0;
    if (!c.five && c.live3 >= 2) out.push([x, y]);
  }
  return out;
}
const isCombo = (c) => c.five || c.live3 >= 2 || (c.four >= 1 && c.live3 >= 1) || c.four >= 2;

let pass = 0, fail = 0;
let dHandled = 0;
for (const q of data.defense) {
  const r = AI.findBestMove(clone(q.b), q.def, 'master');
  const after = clone(q.b); after[r.y][r.x] = q.def;
  const c = classifyAt(after, r.x, r.y, q.def);
  const handled = !doubleThreeMoves(after, q.atk).length || isCombo(c) || c.four >= 1;
  if (handled) dHandled++;
}
let aHit = 0;
for (const q of data.attack) {
  const r = AI.findBestMove(clone(q.b), q.side, 'master');
  const after = clone(q.b); after[r.y][r.x] = q.side;
  if (isCombo(classifyAt(after, r.x, r.y, q.side))) aHit++;
}
console.log(`双活三识别：防守处理 ${dHandled}/${data.defense.length}，进攻命中 ${aHit}/${data.attack.length}`);
if (dHandled >= data.defense.length - 2) pass++; else { fail++; console.log('  防守处理率低于门槛（容差 2）'); }
if (aHit >= data.attack.length - 1) pass++; else { fail++; console.log('  进攻命中率低于门槛（容差 1）'); }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
