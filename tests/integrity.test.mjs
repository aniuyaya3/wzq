// 状态完整性常驻测试：searchRoot 的 VCF 预检后、迭代加深后，棋盘子数必须与进入时一致。
// 教训来源：vcfAtk 曾用抛异常中止搜索，异常跳过 undoStone 在棋盘留下整条杀链的幻影子，
// 而 placeStone 同步维护 hash/near 使「hash 对 hash」校验测不出来——只有子数比对能现形。
// 运行：node tests/integrity.test.mjs
import vm from 'node:vm';
import { ENGINE_JS } from '../src/engine.js';

let src = ENGINE_JS;
const check = `
    var __now = 0; for (var __i = 0; __i < CELLS; __i++) if (b[__i]) __now++;
    if (__now !== stones) __viol++;
    __calls++;
`;
for (const anchor of ['restoreRootState(b, st, bSnap); // 预检只许读不许改', 'restoreRootState(b, st, bSnap); // 超时抛错可能跳过']) {
  if (!src.includes(anchor)) { console.error('❌ 校验锚点未命中：' + anchor); process.exit(1); }
  src = src.replace(anchor, check + anchor);
}
const ctx = vm.createContext({ console });
vm.runInContext('var __viol = 0, __calls = 0;', ctx);
vm.runInContext(src, ctx);
const AI = ctx.GomokuAI;
function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(31337);
const B = () => Array.from({ length: 15 }, () => Array(15).fill(0));
const clone = (b) => b.map((r) => r.slice());
for (let t = 0; t < 24; t++) {
  const b = B();
  const stones = 20 + Math.floor(rand() * 50);
  let turn = 1;
  for (let s = 0; s < stones; s++) {
    const x = 1 + Math.floor(rand() * 13), y = 1 + Math.floor(rand() * 13);
    if (b[y][x]) continue;
    b[y][x] = turn; turn = turn === 1 ? 2 : 1;
  }
  AI.findBestMove(clone(b), turn, 'master');
  AI.findBestMove(clone(b), turn, 'hard');
}
const v = vm.runInContext('({ viol: __viol, calls: __calls })', ctx);
console.log(`状态完整性校验 ${v.calls} 次，子数残留 ${v.viol} 次`);
console.log(v.viol === 0 && v.calls >= 40 ? '结果：1 通过 / 0 失败' : '结果：0 通过 / 1 失败');
process.exit(v.viol === 0 && v.calls >= 40 ? 0 : 1);
