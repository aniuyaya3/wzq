// UI 功能仿真（jsdom）：页面脚本零报错、开局/落子/AI 应招/提示/悔棋全链路
// 运行前先装依赖：npm install（jsdom 在 devDependencies）；运行：npm run test:ui
import { JSDOM } from 'jsdom';
import { HTML_PAGE } from '../src/page.js';

const html = HTML_PAGE;
const errors = [];
const drawCalls = { arc: 0, fillRect: 0, fillText: 0 };

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    // Canvas 2D 桩：记录绘制调用，返回链式可用的假对象
    const grad = { addColorStop() {} };
    const ctxStub = new Proxy({}, {
      get(t, k) {
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
        if (k === 'measureText') return () => ({ width: 10 });
        if (typeof k === 'string') return (...a) => { if (drawCalls[k] !== undefined) drawCalls[k]++; };
        return undefined;
      },
      set() { return true; },
    });
    window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
    window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));
  },
});
const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✅ ' + name)) : (fail++, console.log('  ❌ ' + name + ' ' + extra)); };

await sleep(300);

// 布局桩：棋盘容器宽 400
const wrap = document.querySelector('.board-wrap');
Object.defineProperty(wrap, 'clientWidth', { value: 400, configurable: true });
const canvas = document.getElementById('board');
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0 });
window.dispatchEvent(new window.Event('resize'));
await sleep(100);

console.log('== 首页结构 ==');
ok('标题存在', !!document.querySelector('.logo'));
ok('三张模式卡', document.querySelectorAll('.mode-btn').length === 3);
ok('难度四档', document.querySelectorAll('#diffSeg button').length === 4);
ok('战绩卡渲染', document.getElementById('statW') !== null);

console.log('== 开局与对弈 ==');
document.getElementById('startAiBtn').click();
await sleep(150);
ok('对局界面显示', document.getElementById('gameView').classList.contains('show'));
ok('状态提示玩家落子', document.getElementById('statusBar').textContent.includes('先行') || document.getElementById('statusBar').textContent.includes('落子'), document.getElementById('statusBar').textContent);
ok('棋盘已绘制（圆弧/文字调用）', drawCalls.arc >= 9 && drawCalls.fillText >= 60, JSON.stringify(drawCalls));

function pointer(type, x, y) {
  const ev = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  canvas.dispatchEvent(ev);
}
const pad = 400 / 16, cell = (400 - 2 * pad) / 14;
const at = (gx, gy) => [pad + gx * cell, pad + gy * cell];
let [cx, cy] = at(7, 7);
pointer('pointerdown', cx, cy); pointer('pointerup', cx, cy);
await sleep(100);
ok('玩家落子成功', window.moves && window.moves.length === 1, 'moves=' + (window.moves || []).length);
await sleep(2500); // AI（普通，限时1.2s）应招
ok('AI 已应招', window.moves && window.moves.length === 2, 'moves=' + (window.moves || []).length);
ok('棋谱条有 2 条', document.getElementById('history').children.length === 2);
ok('手数显示第 2 手', document.getElementById('moveInfo').textContent.includes('第 2 手'), document.getElementById('moveInfo').textContent);
[cx, cy] = at(8, 7);
pointer('pointerdown', cx, cy); pointer('pointerup', cx, cy);
await sleep(2500);
ok('第二轮对弈完成（4 手）', window.moves && window.moves.length === 4, 'moves=' + (window.moves || []).length);

console.log('== 提示与悔棋 ==');
document.getElementById('hintBtn').click();
await sleep(2500);
ok('提示给出坐标', document.getElementById('statusBar').textContent.includes('提示'), document.getElementById('statusBar').textContent);
document.getElementById('undoBtn').click();
await sleep(100);
ok('悔棋撤回一轮（剩 2 手）', window.moves && window.moves.length === 2, 'moves=' + (window.moves || []).length);

console.log('== 错误检查 ==');
ok('页面脚本零报错', errors.length === 0, errors.join(' | '));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
