// 增量评估等价性测试：随机落子/回退序列中，增量版 evaluateInc 必须与全盘扫描版
// evaluate 逐值一致（允许浮点末位差）。增量维护横跨窗口和/连段聚合/威胁频次三部分，
// 任一处增减不对称都会在这里现形。
// 运行：node tests/evalinc.test.mjs
import vm from 'node:vm';
import { ENGINE_JS } from '../src/engine.js';

const anchor = 'findBestMove: searchRoot,';
if (!ENGINE_JS.includes(anchor)) { console.error('❌ 注入锚点未命中'); process.exit(1); }
const src = ENGINE_JS.replace(anchor, anchor + '\n    __internals: { placeStone: placeStone, undoStone: undoStone, buildEvalInc: buildEvalInc, evaluate: evaluate, evaluateInc: evaluateInc, toFlat: toFlat, hashBoard: hashBoard, buildNear: buildNear, buildDirArrays: buildDirArrays, newDirSet: newDirSet },');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const I = ctx.GomokuAI.__internals;

function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(20261101);
const B2 = () => Array.from({ length: 15 }, () => Array(15).fill(0));

let checks = 0, maxDiff = 0, bad = 0;
for (let trial = 0; trial < 12; trial++) {
  const b2 = B2();
  const pre = 10 + Math.floor(rand() * 30);
  let turn = 1;
  for (let s = 0; s < pre; s++) {
    const x = 1 + Math.floor(rand() * 13), y = 1 + Math.floor(rand() * 13);
    if (b2[y][x]) continue;
    b2[y][x] = turn; turn = turn === 1 ? 2 : 1;
  }
  const b = I.toFlat(b2);
  const st = { hash: I.hashBoard(b), near: I.buildNear(b), dir: { 1: I.buildDirArrays(b, 1, I.newDirSet()), 2: I.buildDirArrays(b, 2, I.newDirSet()) } };
  I.buildEvalInc(b, st);
  const stack = [];
  const cmp = (tag) => {
    for (const p of [1, 2]) {
      const o = p === 1 ? 2 : 1;
      const full = I.evaluate(b, p, o, st.near, st.dir);
      const inc = I.evaluateInc(p, o, st);
      checks++;
      const d = Math.abs(full - inc);
      if (d > maxDiff) maxDiff = d;
      if (d > 0.01) { bad++; console.log(`  ❌ ${tag} player=${p} full=${full} inc=${inc}`); }
    }
  };
  cmp('init');
  for (let op = 0; op < 260; op++) {
    if (stack.length && rand() < 0.35) {
      const [idx, p] = stack.pop();
      I.undoStone(b, st, idx, p);
    } else {
      // 随机挑一个近邻空点落子
      let idx = -1;
      for (let t = 0; t < 40; t++) {
        const cand = Math.floor(rand() * 225);
        if (b[cand] === 0 && st.near[cand]) { idx = cand; break; }
      }
      if (idx < 0) continue;
      const p = stack.length % 2 === 0 ? 1 : 2;
      I.placeStone(b, st, idx, p);
      stack.push([idx, p]);
    }
    cmp('op' + op);
  }
}
console.log(`等价性校验 ${checks} 次，最大差 ${maxDiff.toExponential(2)}，超差 ${bad} 次`);
console.log(bad === 0 ? '结果：1 通过 / 0 失败' : '结果：0 通过 / 1 失败');
process.exit(bad ? 1 : 0);
