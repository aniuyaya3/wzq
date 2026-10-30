# 五子棋 · Gomoku

一个完整可玩的五子棋游戏，部署在 Cloudflare Workers 上：强 AI 人机对战、同屏双人对战、房间号在线联机对战。

## 玩法

- **人机对战**：4 档难度（简单 / 普通 / 困难 / 大师），可选执黑（先行）或执白
- **双人对战**：同一台设备轮流落子
- **在线对战**：创建房间把房间号发给朋友，对方输入即可加入；支持悔棋 / 重开 / 和棋协商与认输
- 规则：15×15 棋盘，黑棋先行，横 / 竖 / 斜任意连成五子获胜，无禁手
- 附带：落子提示、棋谱记录、对局计时、音效与震动、人机战绩统计（本机保存）

## AI 设计

AI 引擎位于 `src/engine.js` 的 `ENGINE_JS`（纯逻辑，可在浏览器与 Node 中运行）：

1. **棋型评估**：连子数 × 开放端计分，识别活四 / 冲四 / 活三 / 眠三等棋型，并识别「跳一格」断点棋型（如 `XX_X`）
2. **组合威胁**：单点评估阶段直接识别双四、四三、双三等必杀组合并给予高额加分——进攻能造杀，防守会抢占对方的组合点
3. **全盘评估**：5 格窗口势能 + 连子段扫描的双视角差值，防守方威胁加权（攻防兼备）
4. **搜索**：Negamax + Alpha-Beta 剪枝 + Zobrist 置换表；困难 / 大师使用迭代加深并设单步时间上限（大师约 2.6 秒内）
5. **强制着法裁剪**：对方存在成五点时，候选只保留堵点（除非自己能立即成五）
6. **难度分级**：简单带概率性次优着法模拟真人失误，但不会漏堵成五；普通 4 层、困难 5 层、大师最高 6 层搜索（均带迭代加深与单步时间上限）

## 移动端体验

- 棋盘按屏幕宽度自适应 + 设备像素比（DPR）高清渲染
- 触摸落子采用「按下预览 → 拖动微调 → 松手落子」，避免手指遮挡误触
- 底部拇指区工具栏、底部弹层菜单、安全区适配、棋盘坐标标注

## 本地开发与测试

```bash
npm run dev     # wrangler dev 本地运行
npm test        # AI 仿真测试：战术题 + 陪练对局 + 性能（node tests/ai.test.mjs，13 项）
npm run test:ui # UI 功能仿真：jsdom 驱动完整对弈链路（需先 npm install，15 项）
npm run deploy  # 部署到 Cloudflare Workers
```

## 结构

- `src/index.js`：Worker 入口 + Durable Object 联机房间（`GameRoom`）。注意：入口模块只能导出 handler 与 DO 类——workerd 会拒绝字符串等其它类型的顶层导出并导致整个 Worker 启动失败，因此引擎与页面拆为独立模块由入口 import
- `src/engine.js`：AI 引擎源码（`ENGINE_JS`）
- `src/page.js`：前端页面（内嵌引擎与全部 UI 逻辑）
- `tests/ai.test.mjs`：AI 引擎 Node 仿真测试（13 项）
- `tests/ui.test.mjs`：UI 功能仿真（jsdom，15 项）
- `tests/ws.test.mjs`：联机协议端到端测试（11 项；需先 `npx wrangler dev --port 8787 --local` 再 `npm run test:ws`）
- `tests/room.test.mjs`：房间状态恢复测试（20 项；模拟 Durable Object 休眠重建后从 storage + 存活连接恢复会话与棋谱，防「后进者被误判为房主」）
- 推送到 `main` 后由 GitHub Actions 自动部署（`.github/workflows/deploy.yml`）
