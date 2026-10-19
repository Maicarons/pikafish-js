# 方案总览

> 版本：v0.1（2026-10-19）  
> 状态：选型完成，待实现  
> 适用范围：`pikafish-js` 首个公开版本（v0.1.0）

## 1. 执行摘要

`pikafish-js` 要把 **Pikafish**——目前最强的开源中国象棋引擎之一——编译成 WebAssembly，做成一个可在浏览器中直接运行的前端包。它面向两类使用者：

1. **应用开发者**：通过 npm 安装，几行代码就能在自己的网页里加入“人机对弈”或“局面分析”。
2. **终端用户**：通过项目自带的演示站，与引擎下棋、复盘、调节难度。

技术上，这不是从零写一个象棋 AI，而是把官方 C++ 引擎、NNUE 神经网络评估和 UCI 协议完整搬进浏览器，并在其上补齐前端真正需要的东西：加载器、Worker 桥、缓存、规则裁决、棋盘 UI 与工程化发布流程。

方案的核心判断是：**可行性已经被验证，难点不在“能不能跑”，而在“如何稳定、可维护、可交付地工程化”。**

- 上游 Pikafish 的 Makefile 已原生支持 `wasm32` 与 `wasm32-relaxed-simd` 目标。
- 社区已有可工作的参考实现：662 KB wasm、约 50 MB 固定网络、4 线程约 1.4 MNPS、`stop` 响应约 20 ms（Chromium）。
- Stockfish 生态（stockfish.js、lichess 的 `stockfish-web`）已经踩过线程、内存、网络加载与静态托管的坑，可以直接借鉴。
- 真正的风险集中在：NNUE 权重的独立声明、移动端内存、跨源隔离（COOP/COEP）、三构建测试成本、上游版本漂移，以及象棋规则裁决的复杂度。

因此，本项目采用“**薄封装、强约束、渐进增强**”的策略：核心包只做引擎与协议，不做大而全的棋类平台；所有高风险能力都有降级路径；所有上游依赖都固定版本并可复现构建。

## 2. 背景与机会

### 2.1 Pikafish 是什么

Pikafish 是一个免费、强大的 UCI 中国象棋引擎，派生自 Stockfish。它使用 NNUE 神经网络评估，棋力处于开源象棋引擎的第一梯队。上游仓库采用 GPL-3.0 许可，源码为 C++17，构建系统为 Makefile；网络权重在独立的 `Networks` 仓库滚动发布。

Pikafish **不包含图形界面**。官方明确说明：棋盘、交互、对局管理由独立 GUI 负责。这正是 `pikafish-js` 的位置。

### 2.2 为什么现在做

- **浏览器能力成熟**：WebAssembly SIMD 已在 Chrome 91+、Firefox 89+、Safari 16.4+ 可用；`SharedArrayBuffer` 在跨源隔离页面中稳定可用；Emscripten 的 pthread 支持已经过 Stockfish.js、lichess 等生产项目验证。
- **上游已铺路**：Pikafish 的 Makefile 已包含 wasm32 架构分支，说明维护者并不排斥 Web 目标。
- **生态存在空白**：桌面端象棋 GUI 很多，但“开箱即用的浏览器引擎 npm 包”几乎没有。现有 Web 项目多为各自为战的站点，缺少可复用、可维护、有类型与测试的公共库。
- **需求明确**：教学、残局练习、复盘分析、轻量对弈站点，都不希望维护后端引擎服务器。

### 2.3 可借鉴的先行者

| 项目 | 价值 | 局限 |
| --- | --- | --- |
| `nmrugg/stockfish.js` | 成熟的 WASM 构建矩阵、npm 分发、单线程/多线程/精简网络多种形态 | 面向国际象棋；完整版约 94 MB，加载体验差 |
| `lichess-org/stockfish-web` | 生产级 ESM 构建、pthread、SIMD、relaxed SIMD、网络加载 | 为 lichess 定制，明确说明“不易直接使用” |
| `brianhliou/pikafish-wasm` | 已把主线 Pikafish 编译到浏览器，给出实测数据与构建脚本 | 个人项目、仅 Worker 级 API、无规则/UI/发布体系 |
| `xiangqiai.com` 等在线站点 | 证明“浏览器内象棋引擎”有真实用户 | 闭源或与站点强耦合，无法复用 |

本项目的差异化不是“再做一个能跑的 demo”，而是**把已验证的可行性工程化**：类型、测试、缓存、降级、文档、发布、源码与来源声明。

## 3. 目标与非目标

### 3.1 目标（v0.1）

| 编号 | 目标 | 可验证结果 |
| --- | --- | --- |
| G1 | 在浏览器运行完整 Pikafish | 能完成 `uci` / `isready` / `position` / `go` / `stop` 全流程，输出合法 `bestmove` |
| G2 | 提供开发者友好的 API | `await Pikafish.create()`、`analyze()`、`play()`、流式 `info`、`AbortSignal` 取消 |
| G3 | 纯前端人机对弈 | 演示站可完成一整局，包含难度、悔棋、重开、棋谱 |
| G4 | 规则完整 | 将死、困毙、三次重复、自然限着、长将/长捉裁决有明确实现与测试 |
| G5 | 渐进增强 | 三构建覆盖有/无 `SharedArrayBuffer`、有/无 SIMD；移动端可用 |
| G6 | 可维护 | 上游 commit、网络 SHA、Emscripten 版本全部固定；一条命令可复现构建 |
| G7 | 许可与来源 | 项目代码 AGPL-3.0-or-later；上游 GPL-3.0 可组合；核心 npm 包不携带权重，权重来源与声明清晰 |

### 3.2 非目标（v0.1 明确不做）

- 在线联机对战、匹配、房间、观战。
- 服务器端引擎集群或云端分析。
- 比赛编排、裁判系统、ELO 排名。
- 揭棋、朝鲜象棋、将棋等非标准象棋变体。
- 开局库、残局库（EGTB）的打包与分发。
- 任何形式的作弊辅助、自动对弈挂机、规避平台检测。
- 原生桌面/移动 App 封装。

> 这些能力可以在核心稳定后，以插件或独立包的形式扩展；不在首个版本的范围里。

## 4. 目标用户与场景

### 4.1 用户画像

| 用户 | 需求 | 本项目提供的价值 |
| --- | --- | --- |
| Web 开发者 | 在现有站点加入象棋 AI | npm 包 + TypeScript 类型 + 框架无关 API |
| 象棋教学内容站 | 残局演示、分支分析 | 多 PV 分析、局面评分、可取消搜索 |
| 象棋爱好者 | 与强引擎下棋 | 演示站、难度分级、悔棋与提示 |
| 开源贡献者 | 参与引擎 Web 化 | 清晰的构建脚本、基准与文档 |

### 4.2 核心用户旅程

1. 开发者在自己的 Vite/Next/Vue 项目中 `npm i pikafish-js`。
2. 把 `pikafish.wasm`、`pikafish.js` 放到静态资源目录；网络可选择运行时下载（`netUrl`），或随应用打包后以 `netData` 传入。
3. 调用 `Pikafish.create({ wasmUrl, netUrl })`，监听加载进度；离线场景使用 `netData`。
4. 用 `engine.play({ fen, moves, level })` 获得一步棋；或用 `engine.analyze()` 做复盘。
5. 页面卸载时 `engine.dispose()`，Worker 与 pthread 全部回收。

## 5. 产品形态

### 5.1 交付物

| 交付物 | 形式 | 说明 |
| --- | --- | --- |
| 核心库 | npm 包 `pikafish-js` | 加载器、Worker、UCI 桥、缓存、类型 |
| 规则库 | npm 包 `@pikafish-js/rules`（可合并） | FEN、走法、合法性与裁决 |
| 引擎产物 | GitHub Release 资产 | 三构建 wasm/js + SHA256SUMS + 源码说明 |
| 演示站 | Vercel（主）+ GitHub Pages（镜像） | 棋盘 UI、人机对弈、分析面板 |
| 文档 | VitePress | 方案、API、部署、FAQ、许可证 |
| 构建工具 | `scripts/` + Docker | 固定 emsdk，可复现 |

### 5.2 版本与兼容策略

- 核心库遵循 SemVer；`0.x` 阶段允许 minor 版本破坏性变更，但必须写迁移说明。
- 每个核心库版本在 `engine.json` 中声明其匹配的 Pikafish commit、网络 SHA-256 与 Emscripten 版本。
- 加载时校验网络与引擎的兼容性；不匹配时给出可操作的错误信息，而不是静默变弱。
- 上游升级节奏：每季度评估一次；安全/规则修复可提前。

## 6. 关键决策

> 详细论证见 [技术调研](/plan/research) 与 [系统架构](/plan/architecture)。这里只记录结论。

| 编号 | 决策 | 选择 | 主要理由 | 被否决的方案 |
| --- | --- | --- | --- | --- |
| D1 | 引擎来源 | 直接编译官方 Pikafish | 保留完整棋力与 NNUE；上游已支持 wasm32 | 用 JS 重写规则 AI（棋力与维护都不可接受） |
| D2 | 编译工具链 | Emscripten（固定 emsdk 3.1.74 起步） | pthread、SIMD、文件系统、成熟生态 | 手写 WASM、WASI（无 pthread/FS 便利） |
| D3 | 线程与 SIMD 模型 | 三构建：线程+SIMD、单线程+SIMD、单线程无 SIMD | 隔离页面性能最大化；普通静态页可用；无 SIMD 浏览器仍能下棋 | 只做单线程（损失性能）、只做双构建（Safari 15.2–16.3 等不可用） |
| D4 | 运行位置 | 专用 Web Worker | 不阻塞 UI；崩溃隔离；便于取消与回收 | 主线程（长搜索卡顿） |
| D5 | 网络加载 | 支持 `netUrl` 运行时下载+缓存，也支持 `netData` 随应用打包；**核心 npm 包不带权重** | 兼顾首载、离线、许可与可替换网络 | 只随包分发（包体/首载过大）、只运行时下载（离线/内网不便） |
| D6 | 棋盘 UI | 极简自研 SVG 棋盘；参考现有项目交互与素材，核心包不绑定 UI | 可控、可访问、体积小；避免运行时 UI 依赖 | 直接依赖 chessground 分支/第三方棋盘库 |
| D7 | 规则职责 | 独立的 TypeScript 规则包，按官方《象棋程序竞赛规则》实现 | 引擎不负责裁决；UI 需要合法着法与终局判断 | 只依赖引擎输出（无法判定长将/长捉） |
| D8 | 文档与演示托管 | Vercel（直接设置 COOP/COEP）+ GitHub Pages（`coi-serviceworker`）；两者都保留单线程回退 | Vercel 提供完整体验；Pages 保持 GitHub 原生、零成本镜像 | 只用 Pages（首访刷新/性能）、只自建服务器（成本与运维） |
| D9 | 上游版本 | 固定 commit + 固定网络 SHA，显式升级 | 可复现、可回滚、避免“今天能跑明天不能跑” | 跟随 master（不可复现） |
| D10 | 许可证策略 | 项目代码 **AGPL-3.0-or-later**；上游 GPL-3.0 可组合；NNUE 权重按其自身声明使用 | 与上游及参考项目兼容；网络分发条款清晰 | 单一 MIT/Apache（与上游不兼容） |

## 7. 范围与优先级

### 7.1 MVP（v0.1）

- 引擎：三构建（线程+SIMD / 单线程+SIMD / 单线程无 SIMD）、网络双入口、UCI 全流程。
- API：`create`、`ready`、`setOption`、`analyze`、`play`、`stop`、`dispose`、事件订阅。
- 规则：FEN、合法着法、将死/困毙、三次重复、120 步自然限着、子力不足和棋。
- UI：极简自研棋盘、走子、提示、悔棋、重开、难度、棋谱、思考信息。
- 工程：CI 三构建、浏览器矩阵测试、基准、文档、Vercel + GitHub Pages 双部署。

### 7.2 后续版本

- v0.2：完整长将/长捉裁决、PGN 导入导出、局面编辑、分析报告导出。
- v0.3：开局库适配（外部文件，不内置）、多引擎实例、Node.js 支持完善。
- v1.0：API 稳定、性能优化、可访问性达标、生态示例。

## 8. 里程碑摘要

| 里程碑 | 周期 | 关键交付 | 退出条件 |
| --- | --- | --- | --- |
| M0 方案与脚手架 | 1 周 | 本方案、文档站、仓库规范 | 文档可部署；决策评审通过 |
| M1 WASM 构建 PoC | 2 周 | 三构建、补丁、基准脚本 | 浏览器内完成一局；三种模式都能加载 |
| M2 核心 API | 3 周 | `pikafish-js` 包、Worker、双网络入口 | 单元/集成测试通过；API 冻结 |
| M3 规则与裁决 | 2–3 周 | 规则包、官方棋例测试 | 39 个棋例 ≥ 90% 通过 |
| M4 棋盘与演示 | 3 周 | 极简自研 UI、难度、棋谱、双部署 | 完整对局；移动端可用 |
| M5 稳定化 | 2 周 | 兼容矩阵、压测、错误 UX | 无 P1 缺陷；Safari/iOS 通过 |
| M6 发布 | 1 周 | v0.1.0、Release、npm | 可复现构建；许可证检查通过 |

总计约 **12–14 周**（单人全职；两人并行可压缩到 8–10 周）。详细任务拆解见 [实施路线图](/plan/roadmap)。

## 9. 成功指标

### 9.1 工程指标

| 指标 | 目标 | 测量方式 |
| --- | --- | --- |
| wasm 体积 | ≤ 1 MB（不含网络） | 构建产物 |
| 4 线程 NPS | ≥ 1.0 MNPS（2023 年后主流笔记本，Chromium） | 固定局面、固定深度基准 |
| 单线程 NPS | ≥ 250k NPS（同上） | 同上 |
| 冷启动到可搜索 | ≤ 3 秒（网络已缓存） | 演示站埋点（本地） |
| 网络首次加载 | ≤ 10 秒（50 Mbps） | 本地基准 |
| 峰值内存 | ≤ 400 MB（4 线程 + 64 MB Hash） | `performance.measureUserAgentSpecificMemory()` / DevTools |
| 停止响应 | ≤ 100 ms | 自动化测试 |
| 核心包体积 | ≤ 30 KB gzip（不含 wasm/网络） | `size-limit` |

### 9.2 质量指标

- 规则测试：官方 39 个循环棋例 ≥ 90% 通过；将死/困毙/限着 100% 通过。
- 浏览器矩阵：Chrome/Edge、Firefox、Safari、iOS Safari、Android Chrome 全部通过冒烟测试。
- 可访问性：演示站 Lighthouse Accessibility ≥ 95；键盘可完成一整步。
- 稳定性：连续 100 局无崩溃、无内存持续增长。
- 文档：API 100% 有类型与示例；部署文档覆盖 COOP/COEP。

### 9.3 采用指标（非硬性）

- npm 周下载量、GitHub Star、Issue 首次响应时间。
- 下游项目数量（通过依赖图或自报）。

## 10. 资源与成本

| 项目 | 估算 | 说明 |
| --- | --- | --- |
| 人力 | 1 人 × 12–14 周 | 前端/TS 为主，需少量 C++/Emscripten 能力 |
| CI | GitHub Actions 免费额度 | WASM 构建较重，建议仅在 tag/PR 关键路径运行 |
| 托管 | Vercel + GitHub Pages | 主演示与文档镜像；均按免费额度评估 |
| 网络分发 | 自托管或对象存储 | 约 50 MB；注意带宽、缓存与权重来源声明 |
| 发布信息 | 随发布更新 | AGPL 源码入口、上游 commit、权重来源与声明 |

## 11. 立即行动（M0）

1. 建立 GitHub 仓库、分支保护、Issue/PR 模板与 Discussions。
2. 启用 GitHub Pages 与 Vercel 项目，确认文档站与演示站自动部署。
3. 固定 Pikafish commit、网络 SHA 与 emsdk 版本，写入 `engine.json`。
4. 在 Docker 中跑通 `ARCH=wasm32` 构建，产出线程+SIMD、单线程+SIMD、单线程无 SIMD 三个 wasm。
5. 用最小 Worker 页面验证 `uci → isready → position → go depth 12 → bestmove`，并测试 `netUrl` / `netData` 两条路径。
6. 确定网络托管方案与 `vercel.json` / `coi-serviceworker` 配置。
7. 冻结 v0.1 API 草案与规则测试集，记录 UI 参考素材来源。

## 12. 关键风险摘要

| 风险 | 影响 | 首要对策 |
| --- | --- | --- |
| NNUE 权重独立声明 | 高 | 核心包不带权重；双入口加载；显著提示来源与使用范围 |
| 移动端内存不足 | 高 | 单线程/无 SIMD 构建、Hash 上限、延迟加载、设备探测 |
| 静态托管无 COOP/COEP | 中 | Vercel 直接设头；Pages 用 `coi-serviceworker`；始终保留单线程回退 |
| 三构建矩阵成本 | 中 | 共享加载器；CI 矩阵化；无 SIMD 只做冒烟与规则回归 |
| 上游漂移/网络不兼容 | 中 | 固定 commit 与 SHA；CI 校验；升级测试 |
| 长将/长捉裁决复杂 | 中 | 独立规则包；官方棋例驱动；分阶段交付 |
| 线程/内存导致崩溃 | 中 | 固定 emsdk；压力测试；Worker 重启与错误边界 |
| AGPL 源码义务 | 中 | 发布源码与构建脚本；演示站提供源码入口 |

完整清单与触发条件见 [风险与对策](/plan/risks)。

## 13. 相关文档

- [选型记录：8 项拍板与修订](/plan/decisions)
- [产品设计：对局、难度、分析与可访问性](/plan/product)
- [技术调研：象棋生态与引擎边界](/plan/research)
- [技术调研：Web 移植与 Stockfish 生态](/plan/research-web)
- [系统架构：模块、数据流与 API](/plan/architecture)
- [实施路线图：任务、验收与 CI/CD](/plan/roadmap)
- [风险与对策：登记册与预案](/plan/risks)
- [术语表](/reference/glossary) · [一手资料](/reference/sources)
