// 新旧大师对打竞技场：交替执黑、种子化多样开局、等时预算，统计胜率与单步耗时
// 用法：node tests/arena.mjs --games 12 --offset 0 --time 1000 --out arena-s0.json
//   games/offset 决定本分片负责的局号区间（局号决定种子与执黑方），多分片并行后合并统计
import vm from 'node:vm';
import { writeFileSync } from 'node:fs';
// NEW_PATH 可指向变体引擎（如 ./variant-ext16.js）做单变量对照实验，默认产品引擎
const { ENGINE_JS: NEW_JS } = await import(process.env.NEW_PATH || '../src/engine.js');
const { ENGINE_JS: OLD_JS } = await import('./baseline-engine.js');

function loadEngine(js) {
  const ctx = vm.createContext({});
  vm.runInContext(js, ctx);
  return ctx.GomokuAI;
}
const NEW = loadEngine(NEW_JS);
const OLD = loadEngine(OLD_JS);

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const GAMES = parseInt(args.games || '12', 10);
const OFFSET = parseInt(args.offset || '0', 10);
const TIME = parseInt(args.time || '1000', 10);
const OUT = args.out || 'arena-out.json';
NEW.LEVELS.master.time = TIME;
OLD.LEVELS.master.time = TIME;

// 可复现的伪随机（mulberry32）
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const B = () => Array.from({ length: 15 }, () => Array(15).fill(0));
const clone = (b) => b.map((r) => r.slice());

// 开局：6 手中心随机（种子决定）+ 贪心自对弈补到 18 子，形成均衡中盘再交给大师对打；
// 贪心阶段若分出胜负说明开局已爆，换种子重试
function opening(seed) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rand = rng(seed + attempt * 100003);
    const b = B(); let turn = 1, placed = 0;
    while (placed < 6) {
      const x = 4 + Math.floor(rand() * 7), y = 4 + Math.floor(rand() * 7);
      if (b[y][x] !== 0) continue;
      b[y][x] = turn; placed++; turn = turn === 1 ? 2 : 1;
    }
    let exploded = false;
    while (placed < 18) {
      const m = OLD.greedyMove(clone(b), turn);
      if (OLD.checkWin(b, m.x, m.y, turn)) { exploded = true; break; }
      b[m.y][m.x] = turn; placed++; turn = turn === 1 ? 2 : 1;
    }
    if (!exploded) return b;
  }
  return null;
}

function playGame(gameIdx) {
  const newIsBlack = gameIdx % 2 === 0;
  const b = opening(1000 + gameIdx * 77);
  if (!b) return { game: gameIdx, winner: 'error', plies: 0, newIsBlack };
  let turn = 1, plies = 0;
  const timeMs = { new: 0, old: 0 }, moves = { new: 0, old: 0 };
  while (plies < 160) {
    const isNew = (turn === 1) === newIsBlack;
    const ai = isNew ? NEW : OLD;
    const before = clone(b);
    const t0 = Date.now();
    const r = ai.findBestMove(clone(b), turn, 'master');
    const dt = Date.now() - t0;
    if (isNew) { timeMs.new += dt; moves.new++; } else { timeMs.old += dt; moves.old++; }
    if (!r || b[r.y][r.x] !== 0) return { game: gameIdx, winner: 'error', plies, newIsBlack };
    b[r.y][r.x] = turn; plies++;
    if (ai.checkWin(b, r.x, r.y, turn)) {
      // 胜因分类：终局前一刻胜方是否已有 VCF（冲四链绝杀 vs 磨死）；引擎无 vcfWin 导出时跳过
      const winType = (typeof NEW.vcfWin === 'function' && NEW.vcfWin(before, turn)) ? 'vcf' : 'grind';
      return { game: gameIdx, winner: isNew ? 'new' : 'old', plies, newIsBlack, timeMs, moves, winType };
    }
    turn = turn === 1 ? 2 : 1;
  }
  return { game: gameIdx, winner: 'draw', plies, newIsBlack, timeMs, moves };
}

const results = [];
for (let g = OFFSET; g < OFFSET + GAMES; g++) {
  const t0 = Date.now();
  const r = playGame(g);
  r.wallSec = Math.round((Date.now() - t0) / 1000);
  results.push(r);
  console.log(`game ${g}: winner=${r.winner} plies=${r.plies} newBlack=${r.newIsBlack} wall=${r.wallSec}s`);
  // 每局落盘一次：进程被运行时回收时已完成的局不丢失，重跑可续
  writeFileSync(new URL(OUT, import.meta.url), JSON.stringify({ time: TIME, results }, null, 1));
}
writeFileSync(new URL(OUT, import.meta.url), JSON.stringify({ time: TIME, results }, null, 1));
const nw = results.filter((r) => r.winner === 'new').length;
const ow = results.filter((r) => r.winner === 'old').length;
const dr = results.filter((r) => r.winner === 'draw').length;
console.log(`分片小结：新胜 ${nw} / 旧胜 ${ow} / 和 ${dr} / 共 ${results.length}`);
