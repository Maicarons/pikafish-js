# 技术调研：象棋前端生态与 Pikafish 的 Web 边界

> 调研日期：2026-10-19  
> 数据快照：GitHub 仓库元数据、npm registry、Pikafish `master` 源码（commit 以 2026-10-18 推送版本为准）  
> 范围：棋盘 UI、规则与记谱、FEN/UCI、开局库、残局库、在线实现、可访问性  
> 原则：只写能在一手来源中核实的内容；无法核实的一律标注“未验证/未找到”
>
> 配套阅读：[Web 移植与 Stockfish 生态](/plan/research-web)。本页聚焦“象棋侧”的库与规则边界；构建、线程、缓存与部署细节在配套页。

## 0. 结论先行

| 层次 | 结论 | 依据强度 |
| --- | --- | --- |
| 棋盘 UI | 没有一个“维护活跃 + 自带象棋棋子/CSS + 可访问 + 有规则”的现成库。`chessgroundx` 最成熟但偏通用变体；`xiangqiground` 轻量但 2024 年后停更；`xiangqiboardjs` 已 6 年未更新 | 强（仓库/npm 元数据 + README） |
| 规则 | 没有同时覆盖“完整合法着法 + 中文记谱 + 长将长捉裁决 + 稳定维护”的库。`elephantops` 结构最好但极新；`@weshell/xiangqi.js` 功能最全但 2026-09 才发布 | 强（npm/README） |
| 中文记谱 | 成熟、独立、被广泛使用的 npm 转换库**未找到**。现有实现要么绑定在规则库里，要么是站点内部模块 | 强（npm 检索 + 站点构建产物） |
| FEN/UCI | Pikafish 使用 6 字段 FEN（第 5 字段是“无吃子步数”，不是国际象棋的半回合钟）与 `a0`–`i9` 坐标；非法 FEN/走法会让引擎直接退出 | 强（源码 `position.cpp` / `uci.cpp`） |
| 规则裁决 | 引擎内部**会**在搜索中判断 120 步（60 回合）、重复、长将/长捉，但**没有 UCI 选项、没有裁决 API**；GUI 仍须自己维护历史并给出终局结论 | 强（源码 `rule_judge` + 官方 Wiki 选项表） |
| 难度 | 当前 Pikafish **没有** `Skill Level` / `UCI_Elo` / 规则变体选项。难度必须由前端用深度、时限、MultiPV、随机失误等策略实现 | 强（官方 Wiki + 源码） |
| 开局库 | 源码与 UCI 选项中没有开局库接口；可用外部 JSON/PGN、`.obk` 工具链或 ChessDB API | 强（源码检索） |
| 残局库 | Pikafish 没有 EGTB 探测代码；公开的 FelicityEgtb 仍在开发且只覆盖极窄残局；浏览器内完整 EGTB 不可行 | 强（源码 + 仓库 README） |
| 许可 | 引擎 GPL-3.0；NNUE 权重“未经许可不得商用”；UI 候选库多为 GPL-3.0 | 强（仓库许可文件） |

### 0.1 对 `pikafish-js` 的选型建议

1. **棋盘 UI 自研**：以 SVG 绘制 9×10 棋盘，复用 `chessground`/`xiangqiground` 的交互模型（点击选中、拖拽、可走点高亮、上一步、动画），但不要把 GPL 棋盘库作为核心依赖。理由不是“重复造轮子”，而是现成库在**象棋资产、可访问性、规则联动**三件事上都不完整，且维护状态不足以支撑长期发布。
2. **规则独立成包**：`@pikafish-js/rules` 负责 FEN、合法着法、将军/将死/困毙、重复与长将长捉、120 步（60 回合）、子力不足。`elephantops` 可作为 API 设计与测试对照；`@weshell/xiangqi.js` 可作为中文记谱/裁决的第二实现做差分测试。
3. **记谱自研但先做“读”**：内部统一用 UCI/LAN（`h2e2`）；中文记谱只做展示层转换，输入解析后立刻转 UCI。必须用当前 FEN 消歧（同路同兵种需要“前/后”），不能做无上下文的正则替换。
4. **引擎按官方源码编译**：固定 commit、固定 Emscripten、固定网络 SHA；线程+SIMD / 单线程+SIMD / 单线程无 SIMD 三构建；核心 npm 包不携带网络。
5. **开局库/残局库不进 v0.1**：先留接口（`book.move(fen)`、`tablebase.probe(fen)`），不要让它们污染核心。

## 1. 调研方法与可信度

- **仓库数据**：GitHub REST API 的 `stargazers_count`、`license`、`pushed_at`，在 2026-10-19 读取。Star 数是快照，不是质量评价。
- **npm 数据**：`registry.npmjs.org` 的版本、许可、依赖、发布时间、README。
- **源码级核实**：下载 Pikafish `master` 源码压缩包（`codeload.github.com`，约 555 KB），直接检索 `src/`。因此“没有某个选项/模块”这类否定结论只对**该快照**成立。
- **在线站点**：只根据可下载的 HTML/JS 构建产物、公开仓库和站点自述判断；无法确认的一律写“未确认”。
- **未使用**：博客、百科、论坛回答作为事实来源（仅用于发现线索）。

## 2. 引擎边界：Pikafish 到底提供什么

### 2.1 版本、构建与许可

| 项目 | 事实 | 来源 |
| --- | --- | --- |
| 仓库 | `official-pikafish/Pikafish`，2161★，GPL-3.0，最后推送 2026-10-18 | <https://github.com/official-pikafish/Pikafish> |
| 语言/构建 | C++17，Makefile；`ARCH` 列表包含 `wasm32`、`wasm32-relaxed-simd`，`EXE` 在 wasm 下为 `pikafish.js` | 源码 `src/Makefile` |
| 图形界面 | 不包含；官方明确要求独立 GUI | 仓库 README |
| 权重 | 独立 `.nnue` 文件，通过 `EvalFile` 指定；权重仓库单独许可 | <https://github.com/official-pikafish/Networks> |
| 权重许可 | 仅限合法用途，**未经许可不得商用** | Networks 仓库许可说明 |

> 这意味着：`pikafish-js` 以 AGPL-3.0-or-later 发布，上游 GPL-3.0 引擎可与之组合；NNUE 权重有独立声明，不能当作可自由再分发的 MIT 资产。权重不进入核心 npm 包（体积 + 分发条件双重原因）。

### 2.2 UCI 选项全集（2026-10-18 `master`）

官方 Wiki 的选项表与源码一致，完整列表如下：

| 选项 | 类型/默认值 | 说明 |
| --- | --- | --- |
| `Debug Log File` | string，空 | 通信日志 |
| `NumaPolicy` | string，`auto` | NUMA 绑定 |
| `Threads` | spin，1，1–max(1024, 4×CPU) | 搜索线程数；浏览器应限制在 pthread 池大小内 |
| `Hash` | spin，16，1–33554432 | 哈希表 MB；wasm 受 32 位地址空间与设备内存限制，前端应钳制到 256–512 MB |
| `Clear Hash` | button | 清空哈希 |
| `Ponder` | check，false | 后台思考 |
| `MultiPV` | spin，1，1–128 | 多主变；上限为源码 `MAX_MOVES` |
| `Move Overhead` | spin，10，0–5000 | 网络/GUI 延迟补偿 |
| `nodestime` | spin，0，0–10000 | 按节点而非时间计时 |
| `UCI_ShowWDL` | check，false | 输出胜/和/负概率 |
| `EvalFile` | string，`pikafish.nnue` | 网络文件 |

**关键否定结论**：当前版本**没有** `Sixty Move Rule`、`Rule60MaxPly`、`Repetition Rule`、`AsianRule`/`SkyRule`/`ChineseRule`、`AllowChase`、`YitianRule`、`NoJudgement`、`Skill Level`、`UCI_Elo`、`Mate Threat Depth`、`DrawRule` 等选项。网上若出现这些名字，属于旧版本、分支或其它引擎，不能作为集成依据。

对前端的直接影响：

- **难度分级必须自己做**。可选手段：限制 `depth`/`movetime`、降低 `Threads`/`Hash`、用 `MultiPV` 取次优着、按等级注入随机失误、限制开局库选择。不要指望引擎给出“1200 分”的稳定棋力。
- **规则变体必须自己做**。亚洲规则/中国规则/天际规则的差异不能在引擎侧切换。
- **`UCI_ShowWDL` 可用**，适合做胜率条，但它是模型估计，不是裁决结果。

来源：<https://github.com/official-pikafish/Pikafish/wiki/UCI-&-Commands>、源码 `src/engine.cpp`。

### 2.3 FEN：六个字段，第 5 字段不是半回合钟

Pikafish 的 FEN 形态：

```text
rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1
```

字段依次为：

1. 棋子布局：从第 9 行到第 0 行，每行从 a 列到 i 列；大写红、小写黑；`1`–`9` 表示空位。
2. 行棋方：`w`（红）/ `b`（黑）。
3. 占位字段：Pikafish 解析时跳过（Wiki 示例为 `-`）。
4. 占位字段：Pikafish 解析时跳过（Wiki 示例为 `-`）。
5. `rule60`：自上次**吃子**以来的步数（ply），并叠加将军计数的修正；合法范围 **0–119**。
6. 完整回合数：从 1 开始。

源码证据：

- `Position::set()` 连续跳过两个 token，然后读 `rule60` 与 `gamePly`；`rule60` 超出 `0..119` 直接报错。
- `Position::fen()` 输出 `... w - - <rule60> <fullmove>`。
- `do_move()` 中只有**吃子**会把 `rule60` 归零；兵推进**不**归零（这与国际象棋 FEN 的半回合钟语义不同）。
- 将军步数用 `check10[WHITE/BLACK]` 单独累计，裁决时再加回 `rule60`，所以它不是简单的“无吃子步数”。

对前端的直接影响：

- 从其它库导入 FEN 时，必须确认第 5 字段的含义。把国际象棋式 halfmove clock 直接塞进来，会让引擎提前/推迟判和。
- 想保留重复与长将历史，不能只发 `position fen ...`；必须发 `position fen <初始> moves <全部走法>`，或至少从某个有 `rule60` 的局面开始补足够历史。
- `rule60` 越大，NNUE 评估会被搜索侧缩放（`evaluate.cpp` 中按 `rule60` 调整），所以历史不是“可选优化”。

### 2.4 走法格式：`a0`–`i9`

- 文件 `a`–`i` 对应 9 路；行 `0`–`9` 对应 10 行，红方底线为 0，黑方底线为 9。
- UCI 走法为“起点+终点”，如 `b0c2`、`h2e2`、`h9g7`。
- 官方示例：`position startpos moves h2e2 h9g7`。
- 中文“炮二平五”对应红方右炮从 h2 到 e2，即 `h2e2`。

**非法输入会杀死进程**：`Engine::set_position()` 对非法 FEN 返回错误；对 `moves` 中任一非法走法返回 `Illegal move: ...`。UCI 层 `terminate_on_critical_error()` 打印 `info string CRITICAL ERROR` 后 `std::exit(1)`。官方 FAQ 也明确说：Pikafish 可能因错误 FEN 崩溃，GUI 必须自行校验。

因此前端必须在发 `position` 之前完成：

1. FEN 结构校验（9 行、每行 9 格、棋子数量/位置合法、`rule60` 范围）。
2. 走法合法性校验（用本地规则包，不依赖引擎）。
3. 失败时不要发给 Worker；否则 Worker 直接死掉，表现为“引擎无响应”。

### 2.5 引擎内部的规则裁决：有实现，但不是 API

源码 `Position::rule_judge()` 明确处理：

- **120 步（60 回合）**：`rule60 >= 120` 时判和；若无合法着法则判负（困毙）。
- **重复局面**：从当前状态向前按 2 ply 回看，命中同一 Zobrist key；三次重复或“根节点之前的二次重复”触发裁决。
- **长将/长捉**：若重复局面双方都没有连续将军，则调用 `detect_chases()` 做捉子检测；否则按将军方判负/判和。
- **子力不足**：`count<PAWN>() == 0` 时按残局子力分级判和。

但这是**搜索内部的评分/终止判断**，不是 UCI 命令；它不会在 `info` 中返回“这是长将，红负”。并且：

- 没有选项切换规则体系（亚洲规则/中国规则/天际规则等）。
- 没有“给我裁决结果”的查询命令。
- 裁决依赖 `position ... moves` 传入的历史；只给 FEN 时，引擎没有足够的 `StateInfo` 链。

结论：**引擎负责“下棋”，GUI 负责“判棋”**。前端规则包必须能独立给出：将死、困毙、三次重复、长将、长捉、120 步（60 回合）、子力不足，以及“是否可申诉/是否自动判负”的差异。

### 2.6 没有开局库，也没有残局库

对 `master` 源码全量检索：

- 没有 `book` / `opening` 相关模块或选项。
- 没有 `syzygy` / `tablebase` / `egtb` 探测代码；`search.h` 仅有一处从 Stockfish 遗留的注释提到 `syzygy_extend_pv()`，不是实现。
- UCI 选项表中也没有 `SyzygyPath` 之类入口。

所以开局库与残局库都必须由前端/外部服务提供。

## 3. 棋盘 UI 库对比

> Star/日期为 2026-10-19 快照；“最后提交”取默认分支 `pushed_at`。  
> “象棋能力”指 9×10 棋盘、楚河汉界、九宫、棋子角色，不等于“懂规则”。

### 3.1 总表

| 库 | 包名 | 许可 | 最后提交 | Star | 框架/依赖 | 象棋能力 | 规则 | 记谱 | 动画/移动端 | 引擎集成难度 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chessground | `@lichess-org/chessground@10.4.2` | GPL-3.0-or-later | 2026-10-14 | 1381 | 无框架、零依赖 | 仅 8×8，国际象棋 | 无 | SAN/FEN | 有/有 | 需改棋盘几何，**不适合** | 只作为交互参考 |
| chessgroundx | `chessgroundx@10.7.5` | GPL-3.0 | 2026-10-19 | 46 | 零依赖 | 支持 9×10 等变体；含象棋记谱枚举；**无象棋棋子/CSS 资产** | 无 | 通用 FEN + 变体记谱 | 有/有 | 中：需自备资产与规则 | 现成库里最可靠，但偏“通用变体棋盘” |
| xiangqiground | `xiangqiground@0.1.0` | GPL-3.0-or-later | 2024-08-03（仅此一天） | 0 | 零依赖、TS | 9×10、楚河汉界、九宫、象棋角色 | **无**（README 明说 “No xiangqi logic inside”） | FEN | 有/有 | 低：API 清晰 | 轻量首选参考，但停更 |
| @weshell/xiangqiground | `@weshell/xiangqiground@1.1.1` | GPL-3.0-or-later | 2026-09-03 | 1（仓库） | 零依赖、TS | 9×10 + 中文/阿拉伯坐标 | 无（但预走棋校验蹩马腿/塞象眼/将帅对面） | FEN | 有/有 | 低 | 新 fork，功能贴合但未经验证 |
| xiangqiboardjs | 无官方 npm；镜像 `@nmng108/xiangqiboardjs@0.3.3` | MIT | 2020-07-20 | 60 | **jQuery** | 9×10 棋盘 | 无（“just a board”） | FEN | 有/有 | 中：需自己接规则 | 维护停滞，不建议新项目 |
| react-xiangqiboard | `react-xiangqiboard@0.1.12` | MIT | 2025-06-29 | 0 | React + react-dnd | 9×10 棋盘 | 无 | FEN | 有/有 | 中 | 无测试、无维护信号，不建议 |
| xqwlight | 非 npm | GPL-2.0 | 2025-05-14 | 246 | 纯 JS/C++ | 引擎 + 简易网页棋盘 | 有（引擎内置） | 自有 | 弱 | 低但老旧 | 适合作为规则/引擎对照，不是 UI 库 |
| 自研 SVG | — | 随项目 | — | — | 无 | 完全可控 | 由规则包提供 | 自定 | 自定 | 最低（长期） | **推荐** |

### 3.2 逐个说明

#### chessground / chessgroundx

- `chessground` 是 lichess 的 8×8 棋盘，维护活跃、API 成熟（`movable.dests`、`premove`、SVG 箭头、动画、触摸）。
- `chessgroundx` 是同一作者的变体分支，支持最多 16×16 的棋盘，README 截图直接展示 “Chessground Xiangqi and Shogi”；源码含 `Notation.XIANGQI_ARBNUM` / `XIANGQI_HANNUM` 等枚举。
- 但 npm 包只带 `chessground.base.css`、`.brown.css`、`.cburnett.css`，**没有象棋棋子与 9×10 专用 CSS**。要用就得自己做棋盘背景、九宫斜线、楚河汉界、棋子字形/图片。
- 两个库都是 GPL-3.0：`pikafish-js` 采用 AGPL-3.0-or-later，与 GPL-3.0 可组合；但仍不把它们作为运行时依赖，以避免 UI 绑定。

#### xiangqiground

- README 明确：10K gzipped、31K unzipped、零依赖、TypeScript、CSS-only 换肤、完整触摸支持、premove、FEN 导入导出。
- 明确“**No xiangqi logic inside**”，只负责显示与交互。
- 2024-08-03 单日发布 0.1.0，之后无提交；0★。适合读源码/借鉴 API，不适合作为长期依赖。
- API 极简：`ground.getFen()`、`ground.move('b0','c2')`、`toggleOrientation()`、`set({ fen })`。

#### @weshell/xiangqiground

- 2026-09-03 发布的 fork，零依赖，保留 chessground 的交互模型，把预走棋规则改成象棋走法（蹩马腿、塞象眼、将帅对面），坐标支持中文数字/阿拉伯数字。
- 仓库 `west-shell/xiangqiground` 2026-05-19 创建、1★，属于新项目；README 的安装命令写 `npm install xiangqiground`，但实际包名是 `@weshell/xiangqiground`，存在发布/文档不一致。
- 适合作为“象棋化 chessground”的参考实现；是否长期维护未知。

#### xiangqiboardjs

- README 自述“just a board”，“does not understand anything about how the game of xiangqi is played”，并明确不是合法着法校验器、不是 PGN 解析器、不是引擎。
- 依赖 jQuery；最后提交 2020-07-20（约 6 年无更新）。
- `xiangqiboard` 这个名字在 npm 上返回 404；官方通过 GitHub/CDN 分发，npm 上的 `@nmng108/xiangqiboardjs` 是第三方镜像。
- 仍有大量旧教程引用，但新项目不应采用。

#### react-xiangqiboard

- 0★，MIT，React 18 + react-dnd；`package.json` 的测试脚本是 `echo "Error: no test specified" && exit 1`，即没有测试。
- 2025-06-29 后无更新；适合做 React 演示，不适合作为核心依赖。

#### xqwlight

- 246★，GPL-2.0，最后提交 2025-05-14。它是“引擎 + 简易界面”的完整示例（HTML5/JS 版本），不是可组合的 UI 库。
- 价值在于：规则实现、局面表示、简单 AI 的对照；也可作为“无 wasm 时的降级引擎”参考，但棋力与 Pikafish 不在一个量级。

### 3.3 现成库的共同缺口

1. **资产**：没有库同时提供“象棋棋子 + 棋盘纹理 + 九宫/楚河汉界”的完整 CSS；chessgroundx 尤其需要自备。
2. **可访问性**：README 只提触摸/拖拽，没有键盘导航、ARIA grid、读屏播报的 API 或示例。
3. **规则联动**：所有库都要求外部传入 `movable.dests`；没有“选中棋子后自动算合法着法”的能力。
4. **记谱**：坐标标签与走法记谱是两件事；没有库负责中文记谱转换。
5. **维护**：真正活跃的只有 chessground/chessgroundx；象棋专用库要么停更，要么刚发布。

## 4. 规则与记谱库

### 4.1 总表

| 库 | 许可 | 发布/维护 | 能力 | 中文记谱 | 风险 |
| --- | --- | --- | --- | --- | --- |
| `elephantops@0.1.1` | GPL-3.0-or-later | 2024-08-04；仓库 2025-01-01 后无提交，0★ | chessops 的象棋移植：FEN、合法着法、终局、子力不足、UCCI、SAN、PGN、棋谱树 | **未找到** | 极新、无中文记谱、重复/长捉覆盖未验证 |
| `@weshell/xiangqi.js@1.0.3` | BSD-2-Clause | 2026-09-11；仓库 2026 年新建 | FEN/PGN、合法着法（蹩马腿/塞象眼/将帅对面）、将军/将杀/困毙、长将、三次重复、五十步、WXF/ICCS/LAN/中文 | **有** | 太新；规则正确性未独立验证；包名与 README 不一致 |
| `xiangqi.js`（lengyanyu258） | BSD-2-Clause | 2025-08-17；44★ | 走法生成、合法性、FEN、PGN；ICCS/SAN 英文记谱 | **无** | 未发布到 npm（`xiangqi.js` 404） |
| `chinese-chess@1.0.0` | ISC | 2022-06-13 | 未评估 | 未验证 | 长期无更新 |

### 4.2 elephantops

- npm 描述 “Xiangqi rules and operations”，README 明确是 **chessops 的象棋移植**，作者署名包含 chessops 作者 Niklas Fiekas。
- 能力：FEN 读写、`SquareSet` 位棋盘、合法着法、终局/结果、子力不足、局面校验、攻击/射线、UCCI 走法、SAN、PGN（含异步流式解析、棋谱树、评论/时钟/图形）。
- 依赖仅 `@badrap/result`；ESM/CJS 双格式；TypeScript 类型完整。
- 缺口：**没有中文记谱**；重复局面/长将长捉是否完整实现，README 未明确列出，需读源码或跑测试确认。
- 0★、2024-08 后基本停更，但不能因此否定其设计质量；它是最适合“读 + 借 + 必要时 fork”的规则库。

### 4.3 `@weshell/xiangqi.js`

- 2026-09-03 首次发布、2026-09-11 更新到 1.0.3；BSD-2-Clause；41 个文件、约 810 KB 未压缩。
- README 声称支持：
  - 记谱：WXF（`C2.5`）、ICCS（`B0-C2`）、LAN（`b0c2`）、中文（`炮二平五`）。
  - 规则：蹩马腿、塞象眼、将帅对面；将军、将杀、困毙；长将、三次重复、五十步。
    - 注意：README 写的是“五十步”，而象棋官方自然限着是 **120 步（60 回合）**；它的“五十步”很可能是国际象棋习惯的残留，不能直接当作本项目裁决层。
  - PGN 读写、悔棋、NAG 注释、perft。
- 工程信号：有 ESLint、Vitest、Rollup、API Extractor、覆盖率脚本；Node ≥ 20。
- 风险：
  - 项目极新，没有公开的第三方采用/审计；规则细节（尤其长捉、重复）需要差分测试。
  - README 写 `npm install xiangqi.js`，但 npm 上 `xiangqi.js` 是 404，实际包名是 `@weshell/xiangqi.js`；说明文档与发布未完全对齐。
  - 与 `xiangqiground` 一样，属于同一作者 2026 年的新项目，长期维护未知。

### 4.4 `xiangqi.js`（lengyanyu258）

- 44★，BSD-2-Clause，最后提交 2025-08-17；与 `xiangqiboardjs` 同一作者，设计上配套使用。
- 走法/PGN 使用 ICCS/SAN 英文记谱（README 示例 `1. h2e2 h9g7`），**不做中文记谱**。
- 未发布到 npm；只能从 GitHub 引入或自行打包。
- 适合作为“稳定的英文记谱规则实现”对照，不适合作为中文产品的唯一规则层。

### 4.5 中文记谱转换的工程要点

中文记谱不是简单的“坐标重命名”，转换必须以**当前局面**为上下文：

- 需要知道棋子种类、所在路、目标路、进/退/平，以及红黑双方的数字方向。
- 同一路有多个同种棋子时，必须用“前/后”（必要时“前中后”）消歧；仅凭走法字符串无法还原。
- 红方用中文数字、黑方用阿拉伯数字是常见约定，但不同平台/棋谱标准存在差异；解析时要允许两种。
- 士/象/马的“进/退”目标路与直线棋子不同，不能套用同一公式。
- 建议内部统一存 UCI（`h2e2`），中文记谱只做 `toChinese(fen, move)` / `parseChinese(fen, text)`，并做 round-trip 测试。

结论：**没有找到可独立依赖的成熟中文记谱 npm 包**。`@weshell/xiangqi.js` 是唯一在 README 中明确宣称完整支持中文/WXF/ICCS/LAN 的库，但太新；其余要么只做 ICCS/SAN，要么是站点内部实现（例如 mistboard 构建产物中的 `xiangqi-notation` chunk，并不是 npm 包）。

### 4.6 规则职责矩阵

| 事项 | Pikafish | 前端规则包 | UI |
| --- | --- | --- | --- |
| 合法着法生成 | 有（内部） | **必须有**（不能依赖引擎） | 用 `dests` 高亮 |
| FEN 解析/校验 | 严格但会退出 | **必须有** | 展示 |
| 将死/困毙 | 搜索中判断 | **必须有** | 弹窗/禁用输入 |
| 三次重复 | 搜索中判断 | **必须有**（维护历史） | 提示 |
| 长将/长捉 | 搜索中判断（亚洲规则逻辑） | **必须有**（可配置规则体系） | 裁决说明 |
| 120 步（60 回合） | `rule60 >= 120` | **必须有**（注意吃子才归零） | 步数提示 |
| 子力不足 | 有 | **必须有** | 提示 |
| 难度/Elo | **无** | 策略层 | 选择器 |
| 开局库 | **无** | 可选 | 选择/禁用 |
| 残局库 | **无** | 可选/远程 | 提示 |

## 5. 开局库

### 5.1 Pikafish 侧

- 源码与 UCI 选项中没有开局库模块，也没有 `OwnBook`/`BookFile` 之类选项。
- 开局库属于 GUI/前端职责。

### 5.2 可选格式

| 方案 | 说明 | 优点 | 风险 |
| --- | --- | --- | --- |
| JSON/TS 模块 | `{ fen: [move, ...] }` 或按 Zobrist 索引 | 类型安全、可按需加载、易审查 | 需要自己生成/校验；体积随覆盖增长 |
| PGN 棋谱 | 用 PGN 解析器构建前缀树 | 人类可读、工具多 | 运行时解析慢；需要去重/加权 |
| `.obk` | Xiangqi Wizard 系开局库格式 | 现成库多 | 格式说明零散，**未找到正式规范**；主要是 C++ 工具链 |
| ChessDB API | 在线查询开局/最佳着 | 无需本地数据 | 依赖网络、隐私/可用性、许可需确认 |

`nguyenpham/MRXqOpeningBook`（MIT，C++11）提供构建/探测 `.obk` 的工具，并能解析中文/WXF 记谱，但它不是 JS 库，浏览器内需要重写或预生成 JSON。

### 5.3 建议

- v0.1 **不做开局库**，只留 `Book` 接口。
- 如果要做，优先“预生成 JSON + 按 FEN 前缀索引”，不要把 `.obk` 解析器搬进浏览器。
- 商用产品要确认棋谱来源许可；不要直接抓取未授权棋谱。

## 6. 残局库（EGTB）

### 6.1 现状

| 项目 | 事实 | 来源 |
| --- | --- | --- |
| Pikafish | 无 EGTB 探测代码、无 `SyzygyPath` 选项 | 源码检索 |
| FelicityEgtb | MIT，C++17，**开发中**；README 明确“不是可直接使用的 EGTB”；象棋仅覆盖“一方无臂、另一方 1–2 个攻击子” | <https://github.com/nguyenpham/FelicityEgtb> |
| ChessDB | 提供在线 DTM/DTC 查询与 `queryrule` 裁决 API | <https://www.chessdb.cn/cloudbookc_api_en.html> |
| 完整库 | 未找到可自由下载、浏览器可用的完整象棋 EGTB | — |

### 6.2 浏览器可行性

- 象棋状态空间远大于国际象棋；完整 EGTB 的体积不是“几十 MB”级别，浏览器内全量加载不可行。
- 可行的路径：
  1. **远程查询**：ChessDB 的 `queryscore`/`querypv`/`queryrule`，按 FEN 请求；
  2. **少量定式**：把教学用残局（单马擒单士、炮兵胜士象全等）做成小型 JSON 规则/表；
  3. **服务端预计算**：自有后端按需返回，不进入前端包。
- 不建议在 v0.1 承诺“残局库”。如果要做，先明确“覆盖哪些子力组合、数据从哪来、许可是否允许再分发”。

## 7. 在线站点与技术栈

| 站点 | 可确认的技术事实 | 引擎位置 | wasm | 备注 |
| --- | --- | --- | --- | --- |
| <https://mistboard.com/analysis/xiangqi> | Vite/rolldown 构建的 SPA；资源中含 `xiangqi-notation` chunk 与本地 Pikafish wasm | **客户端** | 是 | 最接近本项目目标的公开实现 |
| <https://xiangqi.one> | Next.js RSC；自有 TypeScript 规则引擎；Pikafish 用于机器人/分析 | **未确认**（可能服务端） | 未确认 | 规则层闭源 |
| <https://pikafish.com> | 官方站点内嵌 Web 应用，页面自述 “AI runs on your device” | **客户端**（站点自述） | 是 | 以官方实现为准 |
| <https://pychess.org> | 客户端 `chessgroundx`；Fairy-Stockfish + `fairy-stockfish.wasm`；服务端 `fairyfishnet` | **混合** | 是 | 仓库 AGPL-3.0，316★ |
| <https://xiangqi.com> | 营销站为 Astro；对弈在 `play.xiangqi.com` 子域 | 未确认 | 未确认 | 不能从营销站推断对弈架构 |
| <https://www.chessdb.cn> | 云库/API 服务，不是棋盘 UI | 服务端 | 否 | 适合做查询后端 |

结论：

- “浏览器内跑完整 Pikafish”已有多个公开实例，**技术可行性没有疑问**。
- 但公开站点大多闭源，能直接复用的只有 pychess 的 `chessgroundx` + `fairy-stockfish.wasm` 组合；Pikafish 侧可参考 `brianhliou/pikafish-wasm`（GPL-3.0，662 KB wasm + 约 50.7 MB 固定快照网络，要求 COOP/COEP，4 线程约 1.4 MNPS）。
- 这些站点的存在不能证明“移动端体验好”或“可访问性好”；这两项仍需自己做。

## 8. 可访问性与移动端

### 8.1 现状

- `chessground`、`chessgroundx`、`xiangqiground` 的 README 都强调触摸/拖拽/动画，**没有**键盘导航、ARIA、读屏播报的说明或 API。
- 这意味着：如果直接用这些库，键盘用户和读屏用户基本无法完成“选中棋子 → 走到目标格”。
- 象棋棋盘的视觉结构（9 路 × 10 行、棋子落在交叉点而非格子中央）与普通表格不同，不能简单套 `table`。

### 8.2 建议实现

以 W3C ARIA APG 的 **Grid 模式**为基础（<https://www.w3.org/WAI/ARIA/apg/patterns/grid/>）：

- 容器 `role="grid"`，10 个 `role="row"`，每行 9 个 `role="gridcell"`；每个格子有可读名称，例如“红炮，二路，底线”。
- **Roving tabindex**：整个棋盘只有一个格子在 Tab 序列中；方向键在格子间移动，Home/End 到行首/行尾，Ctrl+Home/Ctrl+End 到棋盘首尾。
- Enter/Space：选中/放下棋子；Escape：取消选择；选中后方向键移动焦点，目标格用 `aria-selected` 或自定义状态标记。
- 走子后用 `aria-live="polite"` 播报：“红方炮二平五，将军”；不要每帧播报引擎思考。
- 提供“跳到棋谱”“跳到引擎分析”等跳转链接；棋盘本身不劫持 Tab。
- 视觉：焦点环、选中态、可走点不能只靠颜色；对比度满足 WCAG AA。
- 动画：尊重 `prefers-reduced-motion`；关闭动画时仍要能感知上一步（高亮/文本）。
- 移动端：
  - 触控目标至少 24×24 CSS px（WCAG 2.5.8 AA），建议 44×44；
  - 拖拽时 `touch-action: none`，避免页面滚动；同时保留“点击选中 → 点击目标”的两段式操作；
  - 棋盘按容器宽度自适应，棋子用矢量/SVG，避免小屏位图模糊；
  - 横屏/竖屏都要保证 9×10 完整可见，不出现横向滚动。

> 这些是设计建议，不是对现有库的实测结论；现有库均未声明支持。

## 9. 未找到 / 不确定

| 项目 | 状态 |
| --- | --- |
| 成熟的独立中文记谱 npm 包 | **未找到**（除 `@weshell/xiangqi.js` 外） |
| `xiangqi-notation` npm 包 | **不存在**；mistboard 的 chunk 名不是包名 |
| Pikafish 的规则变体 UCI 选项 | **不存在于当前 master**；网传选项名不可用 |
| Pikafish 的内置开局库 | **未找到**（源码/选项均无） |
| Pikafish 的 EGTB 支持 | **未找到**（无探测代码/选项） |
| 完整、可自由分发的象棋 EGTB | **未找到** |
| `xiangqiboard` 官方 npm 包 | **不存在**（404）；只有第三方镜像 |
| `xiangqi.js` 官方 npm 包 | **不存在**（404）；`@weshell/xiangqi.js` 是另一项目 |
| chessgroundx 的象棋棋子/CSS | **未随包提供**；需自备 |
| 上述 UI 库的键盘/读屏支持 | **文档未声明**；未做源码级逐行确认 |
| xiangqi.one / xiangqi.com 的引擎位置 | **未确认** |
| `.obk` 格式的正式规范 | **未找到** |
| `chinese-chess@1.0.0` 的能力 | **未评估** |
| FelicityEgtb 的实际覆盖率/性能 | **未实测** |

## 10. 参考来源

| 主题 | 地址 |
| --- | --- |
| Pikafish 源码 | <https://github.com/official-pikafish/Pikafish> |
| Pikafish UCI/命令 | <https://github.com/official-pikafish/Pikafish/wiki/UCI-&-Commands> |
| Pikafish FAQ（错误 FEN 会崩溃） | <https://github.com/official-pikafish/Pikafish/wiki/Pikafish-FAQ> |
| Pikafish 权重 | <https://github.com/official-pikafish/Networks> |
| Pikafish WASM 参考实现 | <https://github.com/brianhliou/pikafish-wasm> |
| chessground | <https://github.com/lichess-org/chessground> |
| chessgroundx | <https://github.com/gbtami/chessgroundx> |
| xiangqiground | <https://github.com/lucaferranti/xiangqiground> |
| @weshell/xiangqiground | <https://www.npmjs.com/package/@weshell/xiangqiground> |
| xiangqiboardjs | <https://github.com/lengyanyu258/xiangqiboardjs> |
| xiangqi.js（lengyanyu258） | <https://github.com/lengyanyu258/xiangqi.js> |
| react-xiangqiboard | <https://github.com/012e/react-xiangqiboard> |
| xqwlight | <https://github.com/xqbase/xqwlight> |
| elephantops | <https://github.com/lucaferranti/elephantops> |
| @weshell/xiangqi.js | <https://www.npmjs.com/package/@weshell/xiangqi.js> |
| MRXqOpeningBook | <https://github.com/nguyenpham/MRXqOpeningBook> |
| FelicityEgtb | <https://github.com/leomil72/FelicityEgtb> |
| ChessDB API | <https://www.chessdb.cn/cloudbookc_api_en.html> |
| pychess | <https://github.com/pychess/pychess> |
| ARIA APG Grid | <https://www.w3.org/WAI/ARIA/apg/patterns/grid/> |
| WCAG 2.5.8 Target Size | <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html> |
