// GameRoom 状态恢复测试：模拟 Durable Object 休眠唤醒/实例重建——
// 同一份 storage + 仍存活的 WebSocket 上构造新 GameRoom，房间必须能续上。
// （线上事故：房主等待期间房间对象被回收重建，后进者被误判为房主，双方都执黑。）
import { GameRoom } from '../src/index.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✅ ' + name)) : (fail++, console.log('  ❌ ' + name + ' ' + extra)); };

class FakeWS {
  constructor() { this.sent = []; this.closed = false; this._att = undefined; }
  serializeAttachment(v) { this._att = v; }
  deserializeAttachment() { return this._att; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  types() { return this.sent.map((m) => m.type); }
  last(t) { const a = this.sent.filter((m) => m.type === t); return a[a.length - 1]; }
}
globalThis.WebSocketPair = class {
  constructor() { this[0] = new FakeWS(); this[1] = new FakeWS(); }
};
// Node 的 Response 不接受 101 状态码，这里只需 GameRoom.fetch 能构造返回值
globalThis.Response = class {
  constructor(body, init = {}) { this.status = init.status || 200; this.webSocket = init.webSocket; }
};
class FakeState {
  constructor() {
    this._data = new Map();
    this._sockets = [];
    const data = this._data;
    this.storage = { async get(k) { return data.get(k); }, async put(k, v) { data.set(k, v); } };
  }
  acceptWebSocket(ws) { this._sockets.push(ws); }
  getWebSockets() { return this._sockets.filter((s) => !s.closed); }
  blockConcurrencyWhile(fn) { this._blocked = fn(); }
  async ready() { await this._blocked; }
}
async function newRoom(state) { const r = new GameRoom(state, {}); await state.ready(); return r; }
const req = (qs) => new Request('http://local/room/abcd/ws' + (qs || ''));

const state = new FakeState();
let room = await newRoom(state);

// 1. 房主建房（执黑）
await room.fetch(req('?color=1'));
const sA = state._sockets[0];
ok('房主 welcome 执黑', sA.last('welcome')?.player === 1);
ok('房主收到 waiting', sA.types().includes('waiting'));

// 2. 模拟回收重建：新实例必须从 storage + 存活连接恢复出房主
room = await newRoom(state);
ok('重建后恢复房主会话', room.sessions.length === 1 && room.sessions[0].player === 1, JSON.stringify(room.sessions.map((s) => s.player)));
ok('重建后 creatorColor 仍为 1', room.creatorColor === 1);

// 3. 第二人加入（走重建后的实例）
await room.fetch(req(''));
const sB = state._sockets[1];
ok('加入者 welcome 执白', sB.last('welcome')?.player === 2, JSON.stringify(sB.last('welcome')));
ok('房主收到 start', sA.types().includes('start'));
ok('加入者收到 start', sB.types().includes('start'));

// 4. 对弈两手
await room.webSocketMessage(sA, JSON.stringify({ type: 'move', x: 7, y: 7 }));
await room.webSocketMessage(sB, JSON.stringify({ type: 'move', x: 7, y: 8 }));
ok('两手均广播', sA.types().filter((t) => t === 'move').length === 2 && sB.types().filter((t) => t === 'move').length === 2);

// 5. 中盘再次重建：棋局必须续上
room = await newRoom(state);
ok('中盘重建恢复 2 手棋谱', room.moves.length === 2 && room.turn === 1, JSON.stringify(room.moves));
ok('中盘重建恢复双会话', room.sessions.length === 2);
await room.webSocketMessage(sA, JSON.stringify({ type: 'move', x: 8, y: 7 }));
ok('重建后续弈广播正常', sB.last('move')?.x === 8 && room.moves.length === 3);

// 6. 认输在重建后的实例上生效并持久化
await room.webSocketMessage(sB, JSON.stringify({ type: 'resign' }));
ok('认输广播 gameover', sA.last('gameover')?.winner === 1);
room = await newRoom(state);
ok('终局状态持久化', room.winner === 1 && room.moves.length === 3);

// 7. 房主选白时，加入者执黑先行（含重建）
const state2 = new FakeState();
let room2 = await newRoom(state2);
await room2.fetch(req('?color=2'));
room2 = await newRoom(state2);
await room2.fetch(req(''));
const tA = state2._sockets[0], tB = state2._sockets[1];
ok('房主选白：加入者执黑', tB.last('welcome')?.player === 1);
await room2.webSocketMessage(tB, JSON.stringify({ type: 'move', x: 0, y: 0 }));
ok('执黑加入者可先行', tA.last('move')?.player === 1);

// 8. 离开通知：bye 立即通知且只通知一次；直接断线也通知一次
const state3 = new FakeState();
let room3 = await newRoom(state3);
await room3.fetch(req('?color=1'));
await room3.fetch(req(''));
const uA = state3._sockets[0], uB = state3._sockets[1];
await room3.webSocketMessage(uA, JSON.stringify({ type: 'bye' }));
ok('bye 后对方收到 leave', uB.types().filter((t) => t === 'leave').length === 1);
ok('bye 后会话摘除', room3.sessions.length === 1 && room3.sessions[0].player === 2);
await room3.webSocketClose(uA);
ok('bye 后再 close 不重复通知', uB.types().filter((t) => t === 'leave').length === 1);

// 9. 直接断线（无 bye）：对方收到一次 leave；重建后断线同样能通知
const state4 = new FakeState();
let room4 = await newRoom(state4);
await room4.fetch(req('?color=1'));
await room4.fetch(req(''));
const vA = state4._sockets[0], vB = state4._sockets[1];
room4 = await newRoom(state4); // 模拟回收重建后再断线
vB.close();
await room4.webSocketClose(vB);
ok('重建后断线仍通知对方', vA.types().filter((t) => t === 'leave').length === 1);
ok('断线后会话摘除', room4.sessions.length === 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
