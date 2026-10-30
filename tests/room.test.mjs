// GameRoom 状态恢复 + 先手规则测试：模拟 Durable Object 休眠唤醒/实例重建——
// 同一份 storage + 仍存活的 WebSocket 上构造新 GameRoom，房间必须能续上；
// 并覆盖开局随机黑棋（1.5 秒揭晓拦截）、后续局轮换先手、旧格式/旧连接兼容。
import { GameRoom } from '../src/index.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✅ ' + name)) : (fail++, console.log('  ❌ ' + name + ' ' + extra)); };
// 控制随机抽签结果：<0.5 → 座位1执黑，否则座位2执黑
let randVal = 0.2;
Math.random = () => randVal;

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
    this._alarm = null;
    const data = this._data;
    const self = this;
    this.putCount = 0;
    this.alarmSetCount = 0;
    this.storage = {
      async get(k) { return data.get(k); },
      async put(k, v) { self.putCount++; data.set(k, v); },
      async delete(k) { data.delete(k); },
      async setAlarm(t) { self.alarmSetCount++; self._alarm = t; },
      async getAlarm() { return self._alarm; },
      async deleteAlarm() { self._alarm = null; },
    };
  }
  acceptWebSocket(ws) { this._sockets.push(ws); }
  getWebSockets() { return this._sockets.filter((s) => !s.closed); }
  blockConcurrencyWhile(fn) { this._blocked = fn(); }
  async ready() { await this._blocked; }
}
async function newRoom(state, drawMs = 0) { const r = new GameRoom(state, {}); r.drawMs = drawMs; await state.ready(); return r; }
const req = (qs) => new Request('http://local/room/abcd/ws' + (qs || ''));

const state = new FakeState();
let room = await newRoom(state);

// 1. 房主建房：座位 1，颜色待抽签（0）
await room.fetch(req(''));
const sA = state._sockets[0];
ok('房主 welcome 为座位1、颜色未定', sA.last('welcome')?.seat === 1 && sA.last('welcome')?.color === 0);
ok('房主收到 waiting', sA.types().includes('waiting'));

// 2. 模拟回收重建：新实例必须从 storage + 存活连接恢复出房主
room = await newRoom(state);
ok('重建后恢复房主会话', room.sessions.length === 1 && room.sessions[0].seat === 1);

// 3. 第二人加入：触发首局抽签（randVal=0.2 → 座位1执黑）
await room.fetch(req(''));
const sB = state._sockets[1];
ok('加入者 welcome 为座位2', sB.last('welcome')?.seat === 2);
ok('双方收到 start', !!sA.last('start') && !!sB.last('start'));
ok('抽签：座位1执黑、座位2执白', sA.last('start')?.color === 1 && sB.last('start')?.color === 2);
ok('start 带有揭晓时间', typeof sA.last('start')?.startAt === 'number');

// 4. 对弈两手
await room.webSocketMessage(sA, JSON.stringify({ type: 'move', x: 7, y: 7 }));
await room.webSocketMessage(sB, JSON.stringify({ type: 'move', x: 7, y: 8 }));
ok('两手均广播', sA.types().filter((t) => t === 'move').length === 2 && sB.types().filter((t) => t === 'move').length === 2);

// 5. 中盘再次重建：棋局必须续上
room = await newRoom(state);
ok('中盘重建恢复 2 手棋谱', room.moves.length === 2 && room.turn === 1, JSON.stringify(room.moves));
ok('中盘重建恢复双会话与黑座', room.sessions.length === 2 && room.blackSeat === 1);
await room.webSocketMessage(sA, JSON.stringify({ type: 'move', x: 8, y: 7 }));
ok('重建后续弈广播正常', sB.last('move')?.x === 8 && room.moves.length === 3);

// 6. 认输在重建后的实例上生效并持久化
await room.webSocketMessage(sB, JSON.stringify({ type: 'resign' }));
ok('认输广播 gameover', sA.last('gameover')?.winner === 1);
room = await newRoom(state);
ok('终局状态持久化', room.winner === 1 && room.moves.length === 3);

// 7. 第二局轮换先手：重开后黑座翻转，原白方执黑先行
await room.webSocketMessage(sB, JSON.stringify({ type: 'restart_req' }));
ok('重开请求转发', sA.last('restart_req') !== undefined || sA.types().includes('restart_req'));
await room.webSocketMessage(sA, JSON.stringify({ type: 'restart_ack' }));
ok('第二局轮换：座位2执黑', sB.last('start')?.color === 1 && sA.last('start')?.color === 2 && room.blackSeat === 2);
await room.webSocketMessage(sA, JSON.stringify({ type: 'move', x: 1, y: 1 }));
ok('未轮到的一方落子被拒绝', room.moves.length === 0);
await room.webSocketMessage(sB, JSON.stringify({ type: 'move', x: 1, y: 1 }));
ok('新黑方可以先行', room.moves.length === 1 && room.moves[0].player === 1);

// 8. 抽签另一面：randVal=0.8 → 座位2（加入者）执黑
randVal = 0.8;
const stateR = new FakeState();
const roomR = await newRoom(stateR);
await roomR.fetch(req(''));
await roomR.fetch(req(''));
ok('抽签：座位2执黑', stateR._sockets[0].last('start')?.color === 2 && stateR._sockets[1].last('start')?.color === 1);
randVal = 0.2;

// 9. 揭晓前落子被拦截（drawMs=1500 的真实房间）
const stateG = new FakeState();
const roomG = await newRoom(stateG, 1500);
await roomG.fetch(req(''));
await roomG.fetch(req(''));
const gBlack = roomG.blackSeat === 1 ? stateG._sockets[0] : stateG._sockets[1];
await roomG.webSocketMessage(gBlack, JSON.stringify({ type: 'move', x: 5, y: 5 }));
ok('揭晓前（1.5s 内）落子被服务端拒绝', roomG.moves.length === 0);

// 10. 离开通知：bye 立即通知且只通知一次；直接断线也通知一次
const state3 = new FakeState();
let room3 = await newRoom(state3);
await room3.fetch(req(''));
await room3.fetch(req(''));
const uA = state3._sockets[0], uB = state3._sockets[1];
await room3.webSocketMessage(uA, JSON.stringify({ type: 'bye' }));
ok('bye 后对方收到 leave', uB.types().filter((t) => t === 'leave').length === 1);
ok('bye 后会话摘除', room3.sessions.length === 1 && room3.sessions[0].seat === 2);
await room3.webSocketClose(uA);
ok('bye 后再 close 不重复通知', uB.types().filter((t) => t === 'leave').length === 1);

// 11. 直接断线（无 bye）：对方收到一次 leave；重建后断线同样能通知
const state4 = new FakeState();
let room4 = await newRoom(state4);
await room4.fetch(req(''));
await room4.fetch(req(''));
const vA = state4._sockets[0], vB = state4._sockets[1];
room4 = await newRoom(state4); // 模拟回收重建后再断线
vB.close();
await room4.webSocketClose(vB);
ok('重建后断线仍通知对方', vA.types().filter((t) => t === 'leave').length === 1);
ok('断线后会话摘除', room4.sessions.length === 1);

// 12. 过期清理：活动后闹钟设在约 12 小时后；无人时 alarm 清空房间；有人时顺延
const H12 = 12 * 60 * 60 * 1000;
const state5 = new FakeState();
let room5 = await newRoom(state5);
await room5.fetch(req(''));
await room5.fetch(req(''));
const wA = state5._sockets[0], wB = state5._sockets[1];
await room5.webSocketMessage(wA, JSON.stringify({ type: 'move', x: 3, y: 3 }));
ok('活动后闹钟约在 12 小时后', typeof state5._alarm === 'number' && Math.abs(state5._alarm - (Date.now() + H12)) < 10000, String(state5._alarm));
await room5.alarm(); // 房内还有连接时不应清理
ok('有人在房内时 alarm 不清理', room5.moves.length === 1 && state5._data.has('room'));
ok('有人在时闹钟顺延', Math.abs(state5._alarm - (Date.now() + H12)) < 10000);
wA.close(); wB.close();
await room5.alarm();
ok('无人时 alarm 删除房间记录', !state5._data.has('room'));
room5 = await newRoom(state5);
ok('清理后重建为空房间', room5.moves.length === 0 && room5.winner === 0 && room5.gameSeq === 0);

// 13. restore 兜底：记录已过期（>12h）时不加载旧棋谱
const state6 = new FakeState();
state6._data.set('room', { moves: [{ x: 1, y: 1, player: 1 }], turn: 2, winner: 0, draw: false, creatorColor: 1, ts: Date.now() - H12 - 60000 });
const room6 = await newRoom(state6);
ok('过期记录不被恢复', room6.moves.length === 0 && !state6._data.has('room'));

// 14. 写入优化：闹钟节流 + 紧凑编码往返
const state7 = new FakeState();
let room7 = await newRoom(state7);
await room7.fetch(req(''));
await room7.fetch(req(''));
const xA = state7._sockets[0], xB = state7._sockets[1];
const cells = [[0, 0], [14, 14], [7, 7], [0, 14], [14, 0], [3, 5], [9, 2], [5, 11], [11, 8], [2, 2], [12, 12], [6, 6], [8, 8], [4, 4], [10, 10], [1, 7], [13, 7], [7, 1], [7, 13], [5, 5]];
for (let i = 0; i < cells.length; i++) {
  await room7.webSocketMessage(i % 2 === 0 ? xA : xB, JSON.stringify({ type: 'move', x: cells[i][0], y: cells[i][1] }));
}
ok('20 手全部落子', room7.moves.length === 20);
ok('闹钟被节流（setAlarm ≤ 3 次）', state7.alarmSetCount <= 3, '实际 ' + state7.alarmSetCount + ' 次');
const savedRec = state7._data.get('room');
ok('棋谱以紧凑字符串存储', savedRec.v === 2 && typeof savedRec.m === 'string' && savedRec.m.length === 20);
ok('紧凑记录体积显著小于 JSON 数组', JSON.stringify(savedRec).length < 380, JSON.stringify(savedRec).length + 'B');
room7 = await newRoom(state7);
ok('紧凑编码往返无损（含四角与 player 奇偶）',
  room7.moves.length === 20 && room7.moves.every((m, i) => m.x === cells[i][0] && m.y === cells[i][1] && m.player === (i % 2 === 0 ? 1 : 2)));

// 15. 旧格式（v1 JSON 数组）记录仍可恢复，且黑座按房主颜色推导
const state8 = new FakeState();
state8._data.set('room', { moves: [{ x: 2, y: 3, player: 1 }, { x: 4, y: 5, player: 2 }], turn: 1, winner: 0, draw: false, creatorColor: 2, ts: Date.now() });
const room8 = await newRoom(state8);
ok('旧格式记录兼容恢复', room8.moves.length === 2 && room8.moves[1].x === 4 && room8.creatorColor === 2);
ok('旧记录黑座推导（房主执白→座位2执黑）', room8.blackSeat === 2 && room8.started === true);

// 16. 旧版连接附件（只有 player 颜色）恢复时反推座位
const state9 = new FakeState();
state9._data.set('room', { v: 2, m: '', turn: 1, winner: 0, draw: false, creatorColor: 2, blackSeat: 2, gameSeq: 1, started: true, startAt: 0, ts: Date.now() });
const legacySock = new FakeWS();
legacySock.serializeAttachment({ player: 2 }); // 旧附件：此连接是执白的房主
state9._sockets.push(legacySock);
const room9 = await newRoom(state9);
ok('旧附件按颜色反推为座位1', room9.sessions.length === 1 && room9.sessions[0].seat === 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
