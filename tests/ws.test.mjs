// 联机协议端到端测试：需先启动本地 Worker：npx wrangler dev --port 8787 --local
// 运行：node tests/ws.test.mjs（连不上本地服务会直接失败）
const BASE = 'ws://127.0.0.1:8787';
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
  c.waitCount = (t, n, timeout = 3000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (c.count(t) >= n) { clearInterval(iv); resolve(c.last(t)); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error(name + ' 等待 ' + t + 'x' + n + ' 超时，已收到: ' + c.msgs.map((m) => m.type).join(','))); }
    }, 25);
  });
  c.waitFor = (type, timeout = 3000) => c.waitCount(type, 1, timeout);
  return c;
}

const room = 'test' + Math.floor(Math.random() * 900 + 100);
const A = client('房主');
const B = client('加入者');
try {
  await A.connect(`${BASE}/room/${room}/ws?color=1`);
  const wa = await A.waitFor('welcome');
  ok('房主 welcome 且为黑棋', wa.player === 1, JSON.stringify(wa));
  await A.waitFor('waiting');
  ok('房主收到 waiting', true);

  await B.connect(`${BASE}/room/${room}/ws`);
  const wb = await B.waitFor('welcome');
  ok('加入者 welcome 且为白棋', wb.player === 2, JSON.stringify(wb));
  await A.waitFor('start'); await B.waitFor('start');
  ok('双方收到 start', true);

  A.send({ type: 'move', x: 7, y: 7 });
  const ma = await A.waitCount('move', 1); const mb = await B.waitCount('move', 1);
  ok('落子广播双方一致', ma.x === 7 && ma.y === 7 && mb.x === 7 && mb.player === 1);

  B.send({ type: 'move', x: 8, y: 7 });
  await A.waitCount('move', 2);
  ok('白棋落子广播到房主', A.count('move') === 2);

  // 非法落子（占用点）应被服务端拒绝
  const before = B.count('move');
  A.send({ type: 'move', x: 7, y: 7 });
  await sleep(500);
  ok('占用点落子被拒绝', B.count('move') === before);

  // 悔棋协商：B 请求，A 同意，回到 B 上一手之前（只剩 A 的第一手 + 轮到 B）
  B.send({ type: 'undo_req' });
  await A.waitCount('undo_req', 1);
  A.send({ type: 'undo_ack' });
  const sync = await B.waitCount('sync', 1);
  ok('悔棋 sync 回退一手', sync.moves.length === 1 && sync.turn === 2, JSON.stringify(sync));

  // 认输：B 认输，房主胜
  B.send({ type: 'resign' });
  const over = await A.waitCount('gameover', 1);
  ok('认输判负广播', over.winner === 1 && over.reason === 'resign', JSON.stringify(over));

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
  await D.connect(`${BASE}/room/${room2}/ws?color=1`);
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
