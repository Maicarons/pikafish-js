# 方案选型记录

> 记录日期：2026-10-19  
> 方式：维护者通过 8 个选择题逐项拍板；本页保留选择、影响与被否决方案，作为后续实现的约束。  
> 关联：[方案总览](/plan/overview) · [系统架构](/plan/architecture) · [路线图](/plan/roadmap)

## 1. 选型结果

| # | 议题 | 选择 | 对方案的主要影响 |
| --- | --- | --- | --- |
| 1 | 引擎路线 | **编译官方 Pikafish C++** | 固定上游 commit + 最小 patch；保留完整 NNUE 棋力；不做 JS 重写 |
| 2 | 交付形态 | **Monorepo：core + rules + demo** | 核心包不绑定 UI；规则包独立测试；演示站作为参考实现 |
| 3 | 棋盘 UI | **极简自研，参考现有项目代码与素材** | 不把第三方棋盘作为运行时依赖；交互可借鉴，素材需记录来源 |
| 4 | 规则层 | **自研 TypeScript 规则包** | 按官方规则实现走法、终局、120 个半回合（60 回合）、长将/长捉与中文记谱 |
| 5 | NNUE 分发 | **运行时下载与随应用打包都支持** | `netUrl` 与 `netData` 两种入口；核心 npm 包默认不带权重 |
| 6 | 演示部署 | **Vercel + GitHub Pages** | Vercel 用响应头启用多线程；Pages 用 `coi-serviceworker` 并保留单线程回退 |
| 7 | 构建矩阵 | **三构建：线程+SIMD / 单线程+SIMD / 单线程无 SIMD** | 覆盖隔离页面、普通静态页与不支持 SIMD 的浏览器；CI 与测试矩阵相应扩大 |
| 8 | v0.1 范围 | **人机对弈 + 分析 + 7 档难度** | 不做联机、开局库、残局库；先把引擎、规则与棋盘打磨好 |

## 2. 对既有决策的修订

| 编号 | 原决策 | 修订后 |
| --- | --- | --- |
| D3 | 多线程 + 单线程双构建 | **三构建**：`threads-simd`、`single-simd`、`single-nosimd` |
| D5 | 运行时 fetch + Cache，不打进 npm 包 | **双入口**：`netUrl`（下载/缓存）或 `netData`（调用方打包）；核心包仍不带权重 |
| D6 | 自研轻量 SVG 棋盘 | **极简自研**；可参考现有项目交互与素材，但不引入运行时棋盘依赖 |
| D8 | GitHub Pages + `coi-serviceworker` | **Vercel + GitHub Pages 双部署**；Vercel 直接设 COOP/COEP，Pages 用 SW 注入 |
| D10 | GPL-3.0-or-later | **AGPL-3.0-or-later**；上游 GPL-3.0 代码可组合；NNUE 权重仍按其独立声明使用 |

> 许可策略按维护者决定执行：项目代码统一 **AGPL-3.0-or-later**，不再设置“许可审查”作为里程碑门禁；发布页保留源码获取方式、上游声明与权重来源说明。NNUE 权重不因代码采用 AGPL 而改变其自身声明。

## 3. 被否决的方案

| 议题 | 未选方案 | 否决原因 |
| --- | --- | --- |
| 引擎 | 纯 TypeScript 重写 | 无法复现 NNUE 棋力；搜索与规则工作量远超 v0.1 |
| 引擎 | 直接使用现成 wasm | 版本、构建参数与长期维护受制于第三方；不利于固定 commit 与补丁 |
| 交付 | 只做 core 引擎包 | 规则与棋盘需使用方自备，演示与验收成本高 |
| 交付 | 完整对局平台 | 联机、账号、开局库等超出 v0.1，后端与测试成本高 |
| 棋盘 | 直接依赖 `xiangqiground` / `chessgroundx` | 需要补象棋资源与交互；运行时依赖与样式耦合不利于“核心不绑 UI” |
| 规则 | 直接采用 `@weshell/xiangqi.js` | 规则语义（尤其“五十步”）需逐项核对，不能直接作为裁决层 |
| 网络 | 只随包分发 | 首载与包体过大；核心包不应强制携带权重 |
| 网络 | 只运行时下载 | 离线/内网/单文件部署不方便；无法满足“随应用打包”场景 |
| 部署 | 只 GitHub Pages | 首次访问需刷新；多线程体验不如直接设置响应头 |
| 部署 | 只 Vercel | 失去 GitHub 原生文档/发布链路与零成本镜像 |
| 构建 | 只单线程 | 放弃多线程性能；分析模式体验受限 |
| 构建 | 只双构建 | Safari 15.2–16.3 等无 SIMD 环境直接不可用 |

## 4. 实施约束

### 4.1 构建与选择

```text
跨源隔离 + SharedArrayBuffer 可用？
  ├─ 否 → 报 BUILD_UNAVAILABLE，提示 COOP/COEP 或 coi-serviceworker
  └─ 是 → 支持 SIMD？
            ├─ 是 → threads-simd（默认）或 single-simd（单线程/小内存）
            └─ 否 → single-nosimd
```

- 三个产物共享同一套 TS 加载器与 Worker 协议；差异只在 js/wasm 资源。
- 单线程构建仍链接 `-pthread`（`ThreadPool` 至少需要 1 个线程），只是线程池按需创建、堆上限更小。
- 无 SIMD 构建是**兼容层**，不承诺与 SIMD 构建相同的 NPS；UI 显示“兼容模式”。
- `Threads` 只在 `threads-simd` 中生效；其他构建强制为 1，并触发 `degraded` 事件。

### 4.2 网络双入口

```ts
// A. 运行时下载 + 缓存
await Pikafish.create({
  jsUrl, wasmUrl,
  netUrl: '/engine/pikafish.nnue',
  netSha256: '<sha256>'
})

// B. 随应用打包（Vite 示例）
import netUrl from './assets/pikafish.nnue?url'
const netData = await (await fetch(netUrl)).arrayBuffer()
await Pikafish.create({ jsUrl, wasmUrl, netData, netSha256: '<sha256>' })
```

- 核心 npm 包**不包含** `.nnue`；`netData` 由应用自行提供。
- `netUrl` 路径启用 Cache Storage；`netData` 路径跳过下载与缓存，提供 `netSha256` 时仍做 SHA-256 校验。
- 两种路径最终都写入 Emscripten FS 的 `/pikafish.nnue`。

### 4.3 双部署

| 平台 | 多线程 | 配置 | 用途 |
| --- | --- | --- | --- |
| Vercel | 直接可用 | `vercel.json` 设置 COOP/COEP | 主演示站、预览部署 |
| GitHub Pages | `coi-serviceworker` | SW 注入头；首次刷新 | 文档站、镜像演示、Release 入口 |

- Vercel 与 Pages 使用同一份前端构建；只通过 `DOCS_BASE` / `PUBLIC_NET_URL` 等环境变量区分。
- 两个站点都必须提供“单线程模式”入口；不能把多线程当作唯一可用路径。

### 4.4 极简 UI

- 仅保留：棋盘、落子、合法点、最后一着、将军提示、悔棋、重开、难度、思考面板、棋谱。
- 不做拟物贴图、复杂动画、账号、社交、广告。
- 交互与视觉可参考现有开源项目；代码与素材来源记录在 `docs/reference/sources.md` 或 `NOTICE`。
- 自研棋盘使用 SVG + CSS 变量；不引入 `chessgroundx` / `xiangqiground` 作为运行时依赖。

## 5. 复核触发

| 触发条件 | 动作 |
| --- | --- |
| iOS/低端 Android 在 `threads-simd` 下频繁 OOM | 评估增加移动端专用内存构建，或默认单线程 + 小 Hash |
| 无 SIMD 构建的测试/发布成本超过收益 | 降级为“可选产物”，不阻塞主发布 |
| Vercel 与 Pages 行为差异导致维护负担 | 保留 Vercel 为主演示，Pages 只发文档 + 单线程镜像 |
| 网络文件体积或架构变化 | 重新固定 SHA，更新 `engine.json` 与加载提示 |
| 上游 wasm 支持变化 | 重跑三构建与规则/基准回归 |

## 6. 关联文档

- [方案总览](/plan/overview)
- [系统架构](/plan/architecture)
- [实施路线图](/plan/roadmap)
- [风险与对策](/plan/risks)
- [Web 移植与 Stockfish 生态](/plan/research-web)
