# 实施路线图

> 关联：[方案总览](/plan/overview) · [系统架构](/plan/architecture) · [风险与对策](/plan/risks)

## 0. 当前实现状态（v0.1）

本路线图是制定时的计划。仓库当前已完成到如下程度，尚未完成的项在正文中标注：

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 方案与脚手架 | ✅ 完成 | 文档站、`engine.json`、许可证与来源说明齐备 |
| M1 WASM 构建 PoC | ✅ 完成 | 三构建用 emsdk 3.1.74 实际产出并跑通 UCI；`dist/release` 含 `SHA256SUMS`；体积与基准写入[系统架构](/plan/architecture)第 13 节与[基准数据](/guide/benchmarks) |
| M2 核心 API | ✅ 完成 | `pikafish-js` 包：`analyze/play/stop/dispose`、能力探测、缓存、错误码；19 项单测 |
| M3 规则与裁决 | ✅ 完成（v0.1 范围） | FEN、走法、将死/困毙/限着/重复/子力不足、中文记谱；长捉分类与 39 循环棋例留待 v0.2（当前按“循环即和、长将判负”） |
| M4 棋盘与演示 | ✅ 完成 | SVG 棋盘、7 档难度、分析、提示、悔棋、双部署配置；`bench.html` 可测三构建 |
| M5 稳定化 | ✅ 完成（本地） | 44 项单测、Chromium 20 项 e2e、Firefox/WebKit 冒烟全绿；`bench.yml` 周任务与 20% 回归告警已写；**尚未在真实 Actions runner 上执行** |
| M6 发布 | 🟡 待触发 | `release.yml` 在 `v*` tag 上打包三构建并创建 Release；`check-pack` 已校验 npm 包内容；仓库尚无远端，故 tag/部署未执行 |

> **关键实现差异 1**：Pikafish 的 `ThreadPool` 至少需要一个 pthread，因此**三套构建都要求页面跨源隔离**
> （COOP/COEP + `SharedArrayBuffer`）。原计划中的“无隔离时自动降级到单线程”在技术上不可行；
> `single-*` 构建表示引擎单线程、堆更小，而不是不需要隔离。详见[系统架构](/plan/architecture)第 4、14 节。
>
> **关键实现差异 2**：三套构建都必须**预分配** pthread 池。实测池为空时 `pthread_create()`
> 的按需创建会挂起，引擎初始化永远不返回；`single-*` 因此也带 `-sPTHREAD_POOL_SIZE=2`。

## 1. 总体节奏

| 阶段 | 周期 | 目标 | 可演示成果 |
| --- | --- | --- | --- |
| M0 方案与脚手架 | 1 周 | 决策冻结、文档上线 | 可访问的方案站 |
| M1 WASM 构建 PoC | 2 周 | 证明引擎可在浏览器稳定运行 | 最小对弈页 + 三构建基准数据 |
| M2 核心 API | 3 周 | 可发布的 TypeScript 包 | npm pack + 集成测试 |
| M3 规则与裁决 | 2 周 | 完整对局规则 | 规则测试集 + 棋例通过率 |
| M4 棋盘与演示 | 3 周 | 可用的产品体验 | Vercel + Pages 演示 |
| M5 稳定化 | 2 周 | 跨浏览器与移动端 | 兼容矩阵报告 |
| M6 发布 | 1 周 | v0.1.0 | npm + GitHub Release |

合计约 **13 周工作量**，加 1 周缓冲按 **14 周**排期。两人并行（引擎/规则 + 前端/API）可压缩到 **9–11 周**，但 M1 的构建探索不适合拆分。

> 估算前提：一名熟悉 TypeScript 与 Web 平台、具备基础 C++/Emscripten 调试能力的工程师，全职投入；不包含视觉设计外包时间。

## 2. 工作流与分支策略

- **主干开发**：`main` 始终可构建、可部署文档。
- **功能分支**：`feat/<scope>`、`fix/<scope>`、`chore/<scope>`；通过 PR 合并。
- **提交规范**：Conventional Commits（`feat:`、`fix:`、`docs:`、`build:`、`perf:`、`test:`）。
- **版本管理**：Changesets；`0.x` 阶段 minor 可含破坏性变更，但必须写迁移说明。
- **发布标签**：`v0.1.0`；标签触发 Release 工作流。
- **保护规则**：`main` 需要 1 个 review、CI 通过、线性历史（squash merge）。

## 3. 里程碑拆解

### M0 方案与脚手架（第 1 周）

**目标**：把“做什么、为什么、怎么验收”写成可评审的文档，并让文档站自动部署。

| # | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M0-1 | 建立 GitHub 仓库与目录 | 仓库、README、LICENSE 说明 | 克隆后可读 |
| M0-2 | 配置 VitePress | `docs/`、导航、搜索 | `npm run docs:build` 通过 |
| M0-3 | 配置 Pages + Vercel | `.github/workflows/docs.yml`、`vercel.json` | 两个站点可访问 |
| M0-4 | 冻结范围与决策 | 本方案 + [选型记录](/plan/decisions) | 评审通过 |
| M0-5 | 记录代码/素材来源与 AGPL 发布方式 | 来源清单、页脚源码入口 | 无阻断项 |
| M0-6 | 定义 `engine.json` 草案 | 版本元数据格式 | 字段评审通过 |

**退出条件**：文档站上线；API 草案与里程碑获得确认；许可证风险有明确处置方案。

---

### M1 WASM 构建 PoC（第 2–3 周）

**目标**：在真实浏览器中跑通完整 UCI 流程，拿到可信的性能与内存数据。

| # | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M1-1 | 固定上游 | submodule + commit + patch | 可重复 checkout |
| M1-2 | 构建脚本 | `scripts/build-wasm.sh` | 一条命令产出 wasm/js |
| M1-3 | 三构建 | threads-simd / single-simd / single-nosimd | 三个 wasm 均可加载 |
| M1-4 | Worker 最小宿主 | `demo/poc.html` | `uci` 返回选项列表 |
| M1-5 | UCI 冒烟 | `isready`、`position`、`go depth 12` | 返回合法 `bestmove` |
| M1-6 | 网络双入口 | `netUrl` + `netData` | 两条路径都能初始化 NNUE |
| M1-7 | 基准脚本 | NPS、首字延迟、内存 | 数据写入文档 |
| M1-8 | 失败场景 | 错误码与提示 | 404/MIME/哈希错误可诊断 |

**退出条件**：

- 4 线程构建在 Chromium 达到 **≥ 1.0 MNPS**（参考实现约 1.4 MNPS）。
- 单线程 SIMD 构建 **≥ 250k NPS**；无 SIMD 构建只要求“能完成一局”，不设 NPS 门槛。
- 三个 wasm 均可完成 `uci → isready → position → go depth 10 → bestmove`。
- wasm ≤ 1 MB/个；网络加载在缓存命中后 ≤ 3 秒。
- 连续 10 局无崩溃；`stop` 响应 ≤ 100 ms。
- 能解释并复现“无 COOP/COEP 时多线程不可用”的行为。

> M1 是项目最大的技术不确定性来源。若多线程在移动端内存上不稳定，优先采用 `single-simd`（单线程 + 较小堆上限）发布；它同样要求跨源隔离。

**M1 实测结果（开发机 Windows + Chromium，起始局面 `movetime 3000`，演示站 `bench.html` 可复现）**：

| 验收项 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 4 线程 NPS | ≥ 1.0 MNPS | 1.21–1.39 MNPS（depth 22–23） | ✅ |
| 单线程 SIMD NPS | ≥ 250 k | 230–280 k NPS（波动 ±15%） | ⚠️ 大致达到，需真机复测 |
| 无 SIMD 构建 | 能完成一局 | depth 15，38–41 k NPS | ✅（不设 NPS 门槛） |
| 三构建 `uci → position → go → bestmove` | 全部通过 | 全部通过 | ✅ |
| wasm ≤ 1 MB/个 | 654–658 KB | ✅ |
| 无隔离时报错 | 可诊断 | `BUILD_UNAVAILABLE` + 中文提示 | ✅ |
| `stop` 响应 ≤ 100 ms | 未单独计时 | 待补测 |
| 连续 10 局无崩溃 | 未执行 | M5 压测项 |

---

### M2 核心 API（第 4–6 周）

**目标**：把 PoC 变成可安装、可测试、可发布的 npm 包。

| # | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M2-1 | 包结构与构建 | tsup/rollup + 类型声明 | `npm pack` 可用 |
| M2-2 | 能力探测 | `capabilities.ts` | 单元测试覆盖矩阵 |
| M2-3 | 资源加载器 | 进度、超时、重试 | 断网/慢网可恢复 |
| M2-4 | 网络双入口 | `netUrl` / `netData` + SHA | 两条路径均有测试 |
| M2-5 | Worker 协议 | 类型化消息、错误码 | 协议测试 |
| M2-6 | UCI 编解码 | info/bestmove/option | 解析容错测试 |
| M2-7 | 公共 API | `create/analyze/play/stop/dispose` | API 文档 + 示例 |
| M2-8 | 取消与超时 | `AbortSignal` | 1 秒内释放 |
| M2-9 | 错误体系 | `PikafishError` | 每种错误有提示 |
| M2-10 | 体积控制 | size-limit | 核心 ≤ 35 KB gzip |
| M2-11 | 最小演示 | Vite 页面 | 能走一步棋 |

**退出条件**：

- 单元测试覆盖率 ≥ 80%（核心模块）。
- Chromium/Firefox 集成测试通过；Safari 手动冒烟通过。
- 缓存命中、取消、Worker 重启、重复 `dispose` 均有测试。
- API 冻结，进入 M3 后只修 bug 不加功能。

---

### M3 规则与裁决（第 7–8 周）

**目标**：让“下完一整局”在规则上站得住。

| # | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M3-1 | FEN 解析/序列化 | `fen.ts` | 官方示例往返一致 |
| M3-2 | 走法生成 | `movegen.ts` | 全子力覆盖 |
| M3-3 | 合法性过滤 | 将帅照面、送将、蹩马腿等 | 随机局面交叉校验 |
| M3-4 | 终局 | 将死、困毙、子力不足 | 单元测试 |
| M3-5 | 自然限着 | 120 步 + 将军计数 | 边界测试 |
| M3-6 | 三次重复 | 局面键与循环序列 | 官方棋例 |
| M3-7 | 长将/长捉 | 分类器 + 违规等级 | 39 例 ≥ 90% |
| M3-8 | 中文记谱 | 前后/中兵、进退平 | 记谱测试 |
| M3-9 | 对局对象 | `Game` 类、悔棋、重开 | 完整对局测试 |

**退出条件**：

- 将死/困毙/限着/子力不足 100% 通过。
- 官方 39 个循环棋例 ≥ 90% 通过；未通过项有明确原因与后续计划。
- 规则包不依赖 DOM/引擎，可在 Node 中单测。
- 若长将/长捉分类器延期：v0.1 采用“循环即和”，文档明确标注，功能不阻塞发布。

---

### M4 棋盘与演示（第 9–11 周）

**目标**：做出一个普通用户能完成整局的产品，而不是技术 Demo。

| # | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M4-1 | 极简 SVG 棋盘 | 棋盘、河界、九宫、坐标 | 视觉还原 |
| M4-2 | 走子交互 | 点击/拖拽、高亮、合法点 | 移动端可用 |
| M4-3 | 对局流程 | 先手/后手、难度、计时 | 完整一局 |
| M4-4 | 难度体系 | 深度/时间/多 PV 采样 | 7 档可感知差异 |
| M4-5 | 思考面板 | 深度、评分、PV、NPS | 实时更新 |
| M4-6 | 棋谱 | 中文记谱、复制、JSON | 可回放 |
| M4-7 | 悔棋/提示/认输 | 状态机 | 边界正确 |
| M4-8 | 分析模式 | 多 PV、评分条、箭头 | 可切换 |
| M4-9 | 响应式 | 360px–1440px | 无横向滚动 |
| M4-10 | 可访问性 | 键盘、ARIA、对比度 | Lighthouse ≥ 95 |
| M4-11 | 跨源隔离 | Vercel 头 + Pages `coi-serviceworker` | 两种部署、三种构建都能玩 |
| M4-12 | 双部署 | Vercel + Pages | 公网可访问 |

**退出条件**：

- 桌面与手机各完成 10 局，无非法着法/卡死。
- 难度 1 可被初学者击败，难度 7 具有明显压制力。
- 键盘可完成“选子—落子—悔棋—重开”。
- 页面无第三方追踪；网络面板只加载必要资源。

**M4-11 已本地验证**：两条隔离路径都在本机按公网布局实测通过。

| 部署路径 | 本地等价环境 | 结果 |
| --- | --- | --- |
| Vercel | `vite preview`（带 `vercel.json` 同款 COOP/COEP 头），根路径 | `crossOriginIsolated === true`，引擎就绪 |
| GitHub Pages | 无响应头的静态服务器 + 仓库子路径 `/pikafish-js/` | Service Worker 注册并接管后 `crossOriginIsolated === true`，引擎就绪；`/pikafish-js/docs/` 文档站样式与导航正常 |

未覆盖项：真实域名下的首次访问（SW 首访需刷新一次）、`bench.yml`（未实现），以及 M4-12 的公网可访问性——仓库尚未配置
远端，`pages.yml` / `vercel.json` 的部署链路只能在推送后复核。

---

### M5 稳定化（第 12–13 周）

**目标**：把“能用”变成“敢发布”。

| # | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M5-1 | 三构建浏览器矩阵 | 自动化 + 手工报告 | 矩阵全绿 |
| M5-2 | iOS/Safari 专项 | 内存、触摸、无 SIMD 回退 | 无崩溃 |
| M5-3 | 压测 | 100 局、内存曲线 | 无持续增长 |
| M5-4 | 错误 UX | 断网、缓存损坏、OOM | 可恢复 |
| M5-5 | 安全审查 | 输入校验、CSP、依赖 | 无高危 |
| M5-6 | 文档完善 | API、部署、FAQ | 新手可集成 |
| M5-7 | 基准报告 | 三构建设备矩阵数据 | 写入文档 |
| M5-8 | 发布信息核对 | 素材来源、AGPL 源码入口、权重声明 | 链接可用 |

**退出条件**：

- 无 P1/P2 缺陷；P3 有明确排期。
- Chrome/Firefox/Safari/iOS/Android 冒烟通过；三构建至少各完成一次加载与搜索。
- 峰值内存与 NPS 达到目标或有书面偏差说明。
- 从零开始的开发者能在 30 分钟内完成集成。

---

### M6 发布（第 14 周）

| # | 任务 | 产出 | 验收 |
| --- | --- | --- | --- |
| M6-1 | 版本与变更日志 | v0.1.0 | Changesets 生成 |
| M6-2 | npm 发布 | `pikafish-js@0.1.0` | `npm pack` 内容正确 |
| M6-3 | GitHub Release | 三构建 wasm/js/校验和/源码说明 | 可下载、可校验 |
| M6-4 | 演示站 | Vercel + Pages | 两个地址可用 |
| M6-5 | 公告 | README、Release Notes | 清楚说明限制 |
| M6-6 | 复盘 | 问题清单与 v0.2 计划 | 归档 |

## 4. CI/CD

### 4.1 工作流划分

| 工作流 | 触发 | 内容 | 时长目标 |
| --- | --- | --- | --- |
| `pages.yml` | push main / 手动 | 构建三构建 wasm，部署演示站（`/`）+ 文档（`/docs/`）到 GitHub Pages | < 15 分钟 |
| `ci.yml` | PR / push main | typecheck、单测、构建（不依赖 wasm 产物） | < 5 分钟 |
| `bench.yml` | — | **未实现**（见下） | — |
| `release.yml` | tag `v*` | 全量测试、打包、npm 发布、GitHub Release | < 20 分钟 |

> **关于 `bench.yml`**：计划中的自动基准工作流没有实现。原因是它的两个用途都已由更可靠的方式覆盖：
> 绝对性能只能在真实设备上测量，GitHub Runner 的噪声使其无法作为发布依据（计划本身也只把它当
> “回归告警”）；而可复现的测量入口改成了演示站的 `bench.html`——它在**用户自己的浏览器**里跑完
> 三套构建，输出可粘贴的 Markdown，比 Runner 数字更有意义。若之后需要回归告警，再按 `ci.yml`
> 的 job 结构补一个 Playwright 版本即可。

> Vercel 通过 Git 集成自动构建预览与生产环境；如需在 Actions 中显式部署，再加一个 `vercel deploy` 工作流，二者不要重复触发同一环境。

### 4.2 `ci.yml` 关键点

> **实现状态**：仓库当前的 `ci.yml` 只包含 `verify` 一个 job（typecheck → test → build →
> docs build），约 2 分钟。下表中的 `wasm` 与 `e2e` job 尚未实现：三套 wasm 的构建已经在
> `pages.yml` 与 `release.yml` 中执行，而 Playwright 端到端矩阵（含无隔离/无 SIMD 上下文）
> 仍是待办项。此处保留原始设计，便于后续补齐。

```yaml
jobs:
  quality:
    steps:
      - npm ci
      - npm run lint
      - npm run typecheck
      - npm run test -- --coverage
      - npm run build
      - npx size-limit

  wasm:
    strategy:
      matrix:
        target: [threads-simd, single-simd, single-nosimd]
    steps:
      - checkout（含 submodule）
      - 缓存 setup-emsdk 层
      - npm run build:wasm
      - 上传 wasm/js 产物（供 e2e 使用）

  e2e:
    needs: [wasm, quality]
    steps:
      - 启动静态服务器（带 COOP/COEP 与不带两套）
      - Playwright：Chromium / Firefox / WebKit
      - 冒烟：三构建分别加载 → uci → go depth 10 → bestmove
```

- **路径过滤**：只有 `upstream/`、`patches/`、`scripts/build-wasm.sh` 变化时才重建 wasm；其余 PR 复用缓存产物。
- **缓存策略**：emsdk Docker 镜像与 Emscripten 缓存目录；wasm 产物按 commit + patch 哈希 + target 缓存。
- **测试服务器**：必须覆盖“带 COOP/COEP”（线程与单线程构建）和“不带”（应明确报 `BUILD_UNAVAILABLE`）两类页面；无 SIMD 构建用 Chromium 的禁用 SIMD 启动参数或真机验证。

### 4.3 基准工作流

- 固定局面集（开局、复杂中局、残局各 3 个）。
- 固定深度/节点数，记录 NPS、耗时、峰值内存。
- GitHub Runner 噪声大：只做**回归告警**（同一 runner 上相对下降 > 20%），不作为绝对性能发布依据。
- 结果作为 artifact 保存，并在文档中维护一份“参考设备”数据。

## 5. 测试策略

| 层级 | 工具 | 覆盖 |
| --- | --- | --- |
| 单元 | Vitest | UCI 解析、FEN、走法、裁决、能力探测、缓存键 |
| 集成 | Vitest + happy-dom / 真实 Worker | 加载器、Worker 协议、取消、重启 |
| 端到端 | Playwright | 加载→搜索→落子→终局；有/无隔离、有/无 SIMD 三种上下文 |
| 规则黄金测试 | Vitest | 官方 39 个循环棋例、限着边界、记谱 |
| 性能 | 自定义脚本 | NPS、首字延迟、内存、产物大小 |
| 压测 | Playwright + 循环 | 100 局、Worker 重建、内存曲线 |
| 兼容 | BrowserStack/本地真机 | iOS Safari、Android Chrome、桌面三浏览器 |

### 5.1 防御性测试

- FEN 注入：超长字符串、非法字符、缺少行棋方。
- 着法注入：非法坐标、空着、重复 `go`。
- 网络异常：404、MIME 错误、CORS 拒绝、SHA 不匹配、下载中断。
- 资源异常：缓存配额满、Cache Storage 被禁用。
- 生命周期：`dispose` 后调用 API、重复 `dispose`、页面隐藏/恢复。

## 6. 发布流程

```text
1. 冻结代码 → 更新 engine.json（commit / net sha / emsdk）
2. 全量测试 + 基准 + 兼容冒烟
3. changeset version → 生成 CHANGELOG
4. 构建产物 → 生成 SHA256SUMS
5. git tag v0.1.0 → release.yml
6. npm publish --provenance
7. GitHub Release 上传三构建 wasm/js/checksums/source 说明
8. 部署演示站（Vercel + Pages）→ 公告
9. 观察 72 小时 issue / 崩溃报告
```

### 6.1 发布清单

- [ ] `package.json` 版本与 tag 一致，`license` 为 `AGPL-3.0-or-later`
- [ ] `engine.json` 的 commit / net SHA / emsdk 正确
- [ ] 三构建 wasm/js 校验和可复算
- [ ] npm 包不含 `.nnue`
- [ ] LICENSE（AGPL）、NOTICE、上游与权重来源说明齐全
- [ ] 演示站页脚有“源代码”入口
- [ ] 演示站两种模式（线程/单线程）与三种构建都可玩
- [ ] 文档中的 API 与实现一致
- [ ] 回滚方案与上一版本产物可访问

### 6.2 回滚

- npm：`npm deprecate` 标记问题版本，发布 patch；不删除已发布版本。
- GitHub Release：保留历史产物；新增 `WITHDRAWN` 说明，不静默篡改。
- 演示站：可回退到上一个构建产物（保留最近 3 个）。

## 7. 上游同步

| 频率 | 动作 |
| --- | --- |
| 每月 | 检查 Pikafish commit 与 `master-net` 更新；记录 diff |
| 每季度 | 评估升级：构建、规则回归、基准、浏览器冒烟 |
| 安全/规则修复 | 随时评估，走加速通道 |

升级步骤：

1. 更新 submodule 到目标 commit。
2. 重放 patch；若冲突，优先向上游提交通用修复。
3. 更新网络文件与 SHA；校验架构行。
4. 跑全量测试、39 棋例、基准。
5. 更新 `engine.json` 与文档；发布 minor/patch。

> 原则：**宁可落后一个版本，也不发布不可复现的构建。**

## 8. 工程规范

### 8.1 代码

- TypeScript `strict`；公共 API 不允许 `any`。
- ESLint + Prettier；提交前 lint-staged。
- 模块边界：`loader` 不依赖 `engine`；`rules` 不依赖 Worker；UI 不直接 import 引擎内部。
- 所有公共导出有 TSDoc 示例。

### 8.2 文档

- 每个里程碑更新对应文档页，而不是最后补。
- API 变更必须同时更新类型、示例、CHANGELOG。
- 性能数字必须附设备、浏览器版本、测试方法。

### 8.3 Issue / PR

- Issue 模板：Bug（环境、复现、日志）、Feature（场景、收益）、Question。
- PR 模板：变更摘要、测试证据、许可证影响、截图（UI）。
- 标签：`area/engine`、`area/api`、`area/rules`、`area/ui`、`area/docs`、`priority/*`。
- Definition of Done：测试通过、文档更新、无新增 lint 警告、许可证影响已评估。

## 9. 关键依赖与前置条件

| 依赖 | 用途 | 风险 | 备用 |
| --- | --- | --- | --- |
| Emscripten 3.1.74 | 编译 | 版本行为差异 | 固定 Docker；升级需回归 |
| Pikafish commit | 引擎 | 上游变更 | 固定 commit；季度升级 |
| 官方网络 | 评估 | 许可/更新 | 固定 SHA；自托管 |
| GitHub Actions | CI | 额度/排队 | 本地脚本可复现 |
| Vercel | 主演示 | 平台配额/构建配置 | GitHub Pages 镜像 |
| GitHub Pages | 文档与镜像 | 无响应头 | 用 `coi-serviceworker` 注入 COOP/COEP |

## 10. 首两周执行清单

**第 1 周（M0）**

- [ ] 建仓库、分支保护、Issue/PR 模板
- [ ] 文档站部署成功
- [ ] 固定 Pikafish commit 与 emsdk
- [ ] 起草 `engine.json`
- [ ] 记录 AGPL 发布方式与 UI 素材来源

**第 2 周（M1 前半）**

- [ ] Docker 构建跑通
- [ ] 应用 wasm patch
- [ ] 产出三个 wasm（threads-simd / single-simd / single-nosimd）
- [ ] 最小 Worker 页面加载成功
- [ ] `uci` / `isready` 通过

**第 3 周（M1 后半）**

- [ ] 三构建跑通（threads-simd / single-simd / single-nosimd）
- [ ] 网络经 `netUrl` 与 `netData` 写入 FS，搜索成功
- [ ] 基准数据记录
- [ ] 失败场景与错误提示
- [ ] M1 评审：继续 / 降级 / 调整

## 11. 排期风险与缓冲

| 风险 | 影响 | 缓冲 |
| --- | --- | --- |
| 多线程在 Safari/iOS 不稳定 | M1/M5 延期 | 单线程优先发布 |
| 长将/长捉实现超预期 | M3 延期 | v0.1 循环即和，v0.2 完整裁决 |
| 棋盘 UI 反复 | M4 延期 | 先做“可用”而非“好看” |
| 网络文件托管与来源声明 | M6 阻塞 | 演示站自托管 + 下载入口展示来源 |
| 上游更新导致网络不兼容 | 返工 | 固定版本，季度升级 |

> 排期采用“功能可裁剪、质量不可裁剪”的原则：任何延期优先砍范围（例如暂缓分析模式、PGN），不降低规则正确性与错误处理标准。
