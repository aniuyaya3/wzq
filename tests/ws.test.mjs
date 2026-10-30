// 联机协议端到端测试：需先启动本地 Worker：npx wrangler dev --port 8788 --local
// 运行：WS_BASE=ws://127.0.0.1:8788 node tests/ws.test.mjs（连不上本地服务会直接失败）
// 覆盖：建房/加入、随机抽签定黑白、揭晓前禁落子、落子广播、悔棋、认输、第二局轮换先手、离开通知
const BASE = process.env.WS_BASE || 'ws://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✅ ' + name)) : (fail++, console.log('  ❌ ' + name + ' ' + extra)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const c = { name, msgs: [], waiters: [] };
  c.connect = (url) => new Promise((resolve, reject) => {
    c.ws = new WebSocket(url);
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      c.msgs.push(m);
      c.waiters = c.waiters.filter((w) => !w(m));
    };
    c.ws.onopen = () => resolve();
    c.ws.onerror = (e) => reject(new Error(name + ' ws error'));
  });
  c.send = (obj) => c.ws.send(JSON.stringify(obj));
  c.count = (t) => c.msgs.filter((m) => m.type === t).length;
  c.last = (t) => { const a = c.msgs.filter((m) => m.type === t); return a[a.length - 1]; };
  c.waitCount = (t, n, timeout = 4000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (c.count(t) >= n) { clearInterval(iv); resolve(c.last(t)); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error(name + ' 等待 ' + t + 'x' + n + ' 超时，已收到: ' + c.msgs.map((m) => m.type).join(','))); }
    }, 25);
  });
  c.waitFor = (type, timeout = 4000) => c.waitCount(type, 1, timeout);
  return c;
}

const room = 'test' + Math.floor(Math.random() * 900 + 100);
const A = client('玩家A');
const B = client('玩家B');
try {
  await A.connect(`${BASE}/room/${room}/ws`);
  const wa = await A.waitFor('welcome');
  ok('A welcome 为座位1', wa.seat === 1, JSON.stringify(wa));
  await A.waitFor('waiting');
  ok('A 收到 waiting', true);

  await B.connect(`${BASE}/room/${room}/ws`);
  const wb = await B.waitFor('welcome');
  ok('B welcome 为座位2', wb.seat === 2, JSON.stringify(wb));
  const sa = await A.waitFor('start');
  const sb = await B.waitFor('start');
  ok('双方收到 start 且颜色互补', (sa.color === 1 && sb.color === 2) || (sa.color === 2 && sb.color === 1), `A=${sa.color} B=${sb.color}`);
  const black = sa.color === 1 ? A : B;
  const white = sa.color === 1 ? B : A;
  ok('首局为随机抽签（first=true）', sa.first === true && sb.first === true);

  // 揭晓前落子应被拒绝
  black.send({ type: 'move', x: 3, y: 3 });
  await sleep(350);
  ok('揭晓前落子被拒绝', white.count('move') === 0 && black.count('move') === 0);
  await sleep(Math.max(0, sa.startAt - Date.now()) + 200);

  black.send({ type: 'move', x: 7, y: 7 });
  const ma = await A.waitCount('move', 1); const mb = await B.waitCount('move', 1);
  ok('落子广播双方一致', ma.x === 7 && ma.y === 7 && mb.x === 7 && mb.player === 1);

  white.send({ type: 'move', x: 8, y: 7 });
  await black.waitCount('move', 2);
  await white.waitCount('move', 2); // 等白方也收到自己落子的广播，避免公网延迟下计数未齐就采样
  ok('白棋落子广播到黑方', black.count('move') === 2);

  // 非法落子（占用点）应被服务端拒绝
  const before = white.count('move');
  black.send({ type: 'move', x: 7, y: 7 });
  await sleep(400);
  ok('占用点落子被拒绝', white.count('move') === before);

  // 悔棋协商：白方请求，黑方同意，回到白方上一手之前
  white.send({ type: 'undo_req' });
  await black.waitCount('undo_req', 1);
  black.send({ type: 'undo_ack' });
  const sync = await white.waitCount('sync', 1);
  ok('悔棋 sync 回退一手', sync.moves.length === 1 && sync.turn === 2, JSON.stringify(sync));

  // 认输：白方认输，黑方胜
  white.send({ type: 'resign' });
  const over = await black.waitCount('gameover', 1);
  ok('认输判负广播', over.winner === 1 && over.reason === 'resign', JSON.stringify(over));

  // 第二局轮换先手：白方请求重开，黑方同意，原白方应执黑
  white.send({ type: 'restart_req' });
  await black.waitCount('restart_req', 1);
  black.send({ type: 'restart_ack' });
  const s2a = await A.waitCount('start', 2);
  const s2b = await B.waitCount('start', 2);
  const whiteNewColor = (white === A ? s2a : s2b).color;
  ok('第二局轮换：原白方执黑', whiteNewColor === 1 && s2a.first === false, `white->${whiteNewColor}`);

  // 第三人应被拒（房间已满）
  const C = new WebSocket(`${BASE}/room/${room}/ws`);
  const cResult = await new Promise((resolve) => {
    C.onopen = () => resolve('opened');
    C.onerror = () => resolve('rejected');
    setTimeout(() => resolve('timeout'), 2500);
  });
  ok('第三人被拒', cResult === 'rejected', cResult);

  A.ws.close(); B.ws.close();

  // 离开通知：新房间里一方发 bye，另一方应立即收到且只收到一次 leave
  const room2 = 'bye' + Math.floor(Math.random() * 900 + 100);
  const D = client('退出方');
  const E = client('留守方');
  await D.connect(`${BASE}/room/${room2}/ws`);
  await E.connect(`${BASE}/room/${room2}/ws`);
  await E.waitCount('start', 1);
  D.send({ type: 'bye' });
  await E.waitCount('leave', 1);
  await sleep(600);
  ok('bye 离开通知只达一次', E.count('leave') === 1, 'leave x' + E.count('leave'));
  D.ws.close(); E.ws.close();
} catch (e) {
  fail++; console.log('  ❌ 异常：' + e.message);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
