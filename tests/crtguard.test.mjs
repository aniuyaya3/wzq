// 造双线四点（C10 型）攻防常驻回归：冻结题库 crt-positions.json
// 判据为与引擎实现无关的暴力窗口法（本文件自带），断言：
//   defense    守方落子后，攻方再无造双线四点的着法
//   offense    攻方落子即造双线四点，或直接成活四
//   race       双方都有造点时，先手方抢下自己的造点
//   counter    守方或造冲四反制、或直接破坏造点
// 注：实战第 39 手的原局不在题内——彼时盘上已有多张独立杀网交叠（引擎自报必败分），
// 一手校验无力回天；本校验的职责是让「造双线四点」在干净局面下不再复现。
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
const ENGINE_JS = src.match(/const ENGINE_JS = `([\s\S]*?)`;/)[1];
const GomokuAI = new Function(ENGINE_JS + '; return GomokuAI;')();
const cases = JSON.parse(fs.readFileSync(new URL('./crt-positions.json', import.meta.url), 'utf8'));

const COLS = 'ABCDEFGHIJKLMNO';
const nm = (x, y) => COLS[x] + (15 - y);
const xy = s => ({ x: COLS.indexOf(s[0]), y: 15 - parseInt(s.slice(1)) });
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function winPoints(b, x, y, p) {
  const s = new Set();
  for (const [dx, dy] of DIRS) for (let off = -4; off <= 0; off++) {
    let own = 0, empty = null, bad = false;
    for (let k = 0; k < 5; k++) {
      const cx = x + (off + k) * dx, cy = y + (off + k) * dy;
      if (cx < 0 || cx >= 15 || cy < 0 || cy >= 15) { bad = true; break; }
      const v = b[cy][cx];
      if (v === p) own++; else if (v === 0) { if (empty) { bad = true; break; } empty = cx + ',' + cy; } else { bad = true; break; }
    }
    if (!bad && own === 4 && empty) s.add(empty);
  }
  return s;
}
function live4Detail(b, p) {
  const out = [];
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    if (b[y][x] !== 0) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < 15 && ny >= 0 && ny < 15 && b[ny][nx] !== 0) near = true;
    }
    if (!near) continue;
    b[y][x] = p;
    if (winPoints(b, x, y, p).size >= 2) {
      const keys = new Set();
      for (const [dx, dy] of DIRS) for (let off = -4; off <= 0; off++) {
        let own = 0, bad = false;
        for (let k = 0; k < 5; k++) {
          const cx = x + (off + k) * dx, cy = y + (off + k) * dy;
          if (cx < 0 || cx >= 15 || cy < 0 || cy >= 15) { bad = true; break; }
          const v = b[cy][cx];
          if (v === p) own++; else if (v !== 0) { bad = true; break; }
        }
        if (!bad && own === 4) keys.add(dx + ',' + dy + ':' + (dx === 1 && dy === 0 ? y : dx === 0 ? x : dy === 1 ? y - x : x + y));
      }
      out.push({ x, y, keys: [...keys] });
    }
    b[y][x] = 0;
  }
  return out;
}
function crtMoves(b, p) {
  const out = [];
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    if (b[y][x] !== 0) continue;
    let three = false;
    for (const [dx, dy] of DIRS) for (let off = -4; off <= 0 && !three; off++) {
      let own = 0, bad = false;
      for (let k = 0; k < 5; k++) {
        const cx = x + (off + k) * dx, cy = y + (off + k) * dy;
        if (cx < 0 || cx >= 15 || cy < 0 || cy >= 15) { bad = true; break; }
        const v = b[cy][cx];
        if (v === p) own++; else if (v !== 0) { bad = true; break; }
      }
      if (!bad && own >= 2) three = true;
    }
    if (!three) continue;
    b[y][x] = p;
    const det = live4Detail(b, p);
    b[y][x] = 0;
    if (det.length >= 2) {
      let hit = false;
      outer: for (let a = 0; a < det.length; a++) for (let c = 0; c < det.length; c++) {
        if (a !== c && det[a].keys.some(k1 => det[c].keys.some(k2 => k1 !== k2))) { hit = true; break outer; }
      }
      if (hit) out.push({ x, y });
    }
  }
  return out;
}
function build(c) {
  const b = Array.from({ length: 15 }, () => Array(15).fill(0));
  c.black.forEach(s => { const p = xy(s); b[p.y][p.x] = 1; });
  c.white.forEach(s => { const p = xy(s); b[p.y][p.x] = 2; });
  return b;
}
const clone = b => JSON.parse(JSON.stringify(b));

let pass = 0, total = 0;
for (const c of cases) {
  total++;
  const b = build(c);
  const atk = c.attack, def = atk === 1 ? 2 : 1;
  let ok = false, detail = '';
  if (c.type === 'defense') {
    const pre = crtMoves(b, atk);
    const m = GomokuAI.findBestMove(clone(b), def, 'master');
    const a = clone(b); a[m.y][m.x] = def;
    const left = crtMoves(a, atk);
    ok = pre.length > 0 && left.length === 0;
    detail = `守 ${nm(m.x, m.y)}，题面造点 ${pre.map(q => nm(q.x, q.y)).join('/') || '无!'}`;
  } else if (c.type === 'offense') {
    const crtSet = crtMoves(b, atk).map(q => nm(q.x, q.y));
    const l4Set = live4Detail(b, atk).map(q => nm(q.x, q.y));
    const m = GomokuAI.findBestMove(clone(b), atk, 'master');
    ok = crtSet.includes(nm(m.x, m.y)) || l4Set.includes(nm(m.x, m.y));
    detail = `攻 ${nm(m.x, m.y)}，造点手 ${crtSet.join('/')}`;
  } else if (c.type === 'race') {
    const m = GomokuAI.findBestMove(clone(b), atk, 'master');
    ok = nm(m.x, m.y) === c.create;
    detail = `先手 ${nm(m.x, m.y)}，期望抢造点 ${c.create}`;
  } else if (c.type === 'counter') {
    const m = GomokuAI.findBestMove(clone(b), def, 'master');
    const a = clone(b); a[m.y][m.x] = def;
    ok = nm(m.x, m.y) === c.four || crtMoves(a, atk).length === 0;
    detail = `守 ${nm(m.x, m.y)}（冲四 ${c.four} 或破坏造点）`;
  }
  if (ok) pass++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}（${c.type}）：${detail}`);
}
console.log(`crtguard: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
