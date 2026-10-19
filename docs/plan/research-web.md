# Web 移植与 Stockfish 生态调研

> 调研日期：2026-10-19  
> 配套阅读：[象棋前端生态与 Pikafish 的 Web 边界](/plan/research)  
> 范围：Stockfish 的浏览器化经验、Pikafish 上游构建、三构建、Worker/pthread、NNUE 双入口、缓存、COOP/COEP 与 Vercel/GitHub Pages 双部署  
> 原则：能在一手来源核实的事实与“设计推断”分开写；没有上下文的性能数字不作为承诺

> **实施期更正（重要）**：本文调研时假设“未隔离时可自动降级到单线程、无需 `SharedArrayBuffer`”。
> 实现后确认这**不成立**：上游 `ThreadPool` 通过 `thread_native.h` 调用 `pthread_create` 创建主搜索线程，
> 因此带 `-pthread` 编译的任何构建（含 `single-*`）都需要 `SharedArrayBuffer`，即页面必须跨源隔离。
> `single-*` 的含义是“引擎 1 线程 + 较小堆上限”，而非“无需隔离”。缺失隔离时能力探测直接抛
> `BUILD_UNAVAILABLE`。以[系统架构](/plan/architecture)第 4、14 节为准。

## 0. 结论先行

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 能不能在浏览器跑完整 Pikafish | **能**，已有可工作的参考实现：662 KB wasm + 约 50 MB 网络，4 线程 Chromium 约 1.4 MNPS | `brianhliou/pikafish-wasm` |
| 要不要自己写引擎 | **不要**。编译官方 C++，固定 commit + 最小 patch | 上游 Makefile 已支持 `wasm32` |
| 构建几个版本 | **三个**：线程+SIMD、单线程+SIMD、单线程无 SIMD | 覆盖多线程桌面、单线程/低内存设备、无 SIMD 的旧浏览器 |
| 引擎放哪里 | 专用 Worker；pthread 再派生 Worker | Emscripten pthread 模型 |
| 网络怎么发 | **核心包不带权重**；支持 `netUrl` 下载缓存与 `netData` 随应用打包 | 体积 + 分发条件 |
| 多线程怎么启用 | 页面必须 `crossOriginIsolated` 且 `SharedArrayBuffer` 可用；**任何构建都以此为硬前提**（见顶部更正） | 浏览器安全模型 |
| 部署在哪 | **Vercel 主站**直接设 COOP/COEP；**GitHub Pages 镜像**用 `coi-serviceworker` | 两套托管能力不同 |
| Stockfish 经验能不能照搬 | 架构可以借鉴；LICENSE 兼容，但仍优先自研，避免把宿主适配绑死 | 许可证 + 可维护性 |
| 最大风险 | 不是“跑不起来”，而是**首次 50 MB 加载、移动端内存、线程降级、非法输入导致 Worker 退出** | 参考实现 + 源码 |

## 1. Stockfish 生态给出的答案

### 1.1 `stockfish.js`：把“完整引擎”和“可用的包”分开

截至 2026-10 的公开信息：

| 项 | 事实 | 对本案的意义 |
| --- | --- | --- |
| 包 | `stockfish.js` v19.0.1 | 最广泛使用的浏览器 Stockfish 封装之一 |
| 构建 | 完整版、lite 版；单线程/多线程变体 | 不是“一个 wasm 打天下”，而是按场景分发 |
| 体积 | 完整版约 94 MB；lite 约 1.6–1.7 MB | 体积主要由 NNUE 决定 |
| 工具链 | 其发布说明使用 Emscripten 6.0.9 | 工具链可以比参考实现新，但必须回归 |
| 建议 | README 建议大多数应用用 **lite + 单线程** | 大多数产品不需要“满血引擎” |

**关键教训**：浏览器引擎的“包体积”与“棋力”是两条曲线。Stockfish 用 lite 网络把首屏压到 MB 级；Pikafish 目前**没有官方 lite 网络**，所以 50 MB 首载是 v0.1 必须正面处理的现实，而不是可以忽略的细节。

### 1.2 lichess `stockfish-web`：生产级构建是“补丁 + 胶水 + CI”

| 项 | 事实 | 对本案的意义 |
| --- | --- | --- |
| 许可 | AGPL-3.0（npm 包元数据；仓库 README 写 GPL-3.0） | 与项目 AGPL 兼容；可参考/复用，但仍优先自研 |
| 形态 | ESM、patch-based build、多构建目标 | 与我们“submodule + patch”一致 |
| 优化 | `-O3 -DNDEBUG --closure=1` | Closure 可用，但必须做导出符号回归 |
| 线程 | `PTHREAD_POOL_SIZE=8` | 池大小要与 UI 的线程上限一致 |
| 自述 | README 明确说不是“拿来就能用”的通用库 | 浏览器化不是 `make` 一下，而是宿主适配工程 |

**关键教训**：真正难的是“入口函数、Worker 生命周期、资源加载、错误恢复、CI 产物校验”，不是编译本身。lichess 的工程化程度说明这条路可行，但也说明它需要专门的构建仓库，而不是把源码扔进前端项目。

### 1.3 历史 `stockfish.wasm`：单线程回退不是新问题

早期的 `stockfish.wasm` 在 SharedArrayBuffer 不可用时提供无共享内存构建。结论很直接：

- **单线程构建必须是一等公民**，不是“异常兜底”。
- 单线程不是“功能缺失”，只是速度下降；UI 不应因此隐藏分析/对弈功能。
- 线程探测失败时，应该发 `degraded` 事件，而不是抛错。

### 1.4 `brianhliou/pikafish-wasm`：最接近本项目的参考实现

这是目前公开的、专门把 Pikafish 编译到浏览器的工作，数据如下（来自其仓库与构建产物）：

| 项 | 值 |
| --- | --- |
| 上游 commit | `6a59ee2f7b105bff64d9efc2692591107787e2b1` |
| Emscripten | 3.1.74 |
| wasm | 662,419 B |
| JS glue | 80,121 B |
| NNUE | 50,706,378 B（约 48.4 MiB） |
| 网络架构签名 | `(62083, 1024, 32, 32, 1)` |
| 线程 | pthread；4 线程 Chromium 实测约 **1.4 MNPS** |
| `stop` 响应 | 约 **20 ms** |
| 内存参数 | `INITIAL_MEMORY=256MB`、`MAXIMUM_MEMORY=1GB`、`STACK_SIZE=3MB`、`PTHREAD_POOL_SIZE=8` |
| 部署要求 | COOP/COEP（多线程） |

> 上表的 `INITIAL_MEMORY=256MB` 是参考实现的选择，不是本方案的推荐值。本项目改为 `64MB`，并按构建设置不同的 `MAXIMUM_MEMORY`，以降低移动端首屏压力。

它证明了三件事：

1. 官方 Pikafish 的核心代码可以无侵入地编到 wasm；
2. 50 MB 网络在浏览器里可以加载并运行；
3. `stop` 的交互延迟可以做到“点下去就停”的量级。

它没有证明的是：移动端内存、低端设备、Safari/iOS、首次加载体验、长期维护。这些必须由本项目自己测。

## 2. 上游构建事实

### 2.1 Makefile 已经支持 wasm

Pikafish `master` 的 `src/Makefile`：

- `ARCH` 列表包含 `wasm32` 与 `wasm32-relaxed-simd`。
- `EXE` 在 wasm 下为 `pikafish.js`。
- wasm 分支的关键参数：

```make
CXXFLAGS += -pthread -msimd128 -DUSE_POPCNT -DUSE_SLOPPY_ATOMICS
LDFLAGS  += -pthread -sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=3MB
```

- 可选 `-mrelaxed-simd`。
- 上游**没有** npm 包、没有 ESM 封装、没有 CI 产物、没有浏览器入口；`main()` 仍然走标准输入输出。

### 2.2 为什么必须打 patch

上游是 CLI 程序：`main()` 进入 UCI 循环，从 `stdin` 读命令。浏览器里没有可阻塞的 `stdin`，也不能让主线程卡在 `getline`。因此需要最小 patch：

1. 暴露 `pikafish_initialize()`：初始化引擎、加载网络、返回错误码。
2. 暴露 `pikafish_command(const char*)`：把一条 UCI 命令送入 `UCIEngine::execute()`。
3. 把 `UCIEngine::loop()` 拆成可重入的 `execute()`，避免阻塞。
4. 可选：`pikafish_set_option()` 便捷入口。

这与参考实现的思路一致，patch 约几十行；应尽量保持可上游化，不引入业务逻辑。

### 2.3 单线程构建需要额外处理

上游 wasm 分支**默认带 `-pthread`**。要得到单线程构建，不能只删 `-pthread`：

- 需要去掉 pthread 池参数；
- 需要确认没有代码路径依赖 `SharedArrayBuffer`；
- 需要单独跑一遍 UCI/搜索回归；
- 建议在 CI 中把三个构建都跑 `bench`，避免“单线程能加载但搜索行为不同”。

## 3. 三构建与能力探测

### 3.1 产物矩阵

| 产物 | 线程 | SIMD | 适用环境 | v0.1 |
| --- | --- | --- | --- | --- |
| `pikafish-threads-simd` | pthread | 128-bit | 跨源隔离页面 | 默认高性能 |
| `pikafish-single-simd` | 无 | 128-bit | 跨源隔离的静态页面 | 单线程、较小堆上限 |
| `pikafish-single-nosimd` | 无 | 无 | Safari 15.2–16.3、旧 Android | 兼容层 |

推荐基线：**Chrome/Edge 91+、Firefox 89+、Safari 16.4+**（支持 WASM SIMD）。无 SIMD 构建覆盖更老的浏览器，但不承诺 NPS。

### 3.2 探测顺序

```text
1. WebAssembly 本身可用？ → 否则 UNSUPPORTED_ENV
2. WebAssembly.validate(SIMD 模块)？
   ├─ 否 → single-nosimd
   └─ 是 → 3
3. crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined'
   ├─ 是 → threads-simd
   └─ 否 → single-simd
4. navigator.deviceMemory（若存在）与 hardwareConcurrency
   → 决定默认 Threads / Hash
5. navigator.storage.estimate()
   → 决定是否提示“网络可能无法缓存”
```

注意：

- 不要用 UA 判断 SIMD/线程；UA 会撒谎，能力探测不会。
- `crossOriginIsolated` 为 `true` 但 `SharedArrayBuffer` 被策略禁用的情况仍可能存在，两者都要查。
- iOS 的 `deviceMemory` 往往缺失；按保守值处理，不要猜“设备很高端”。
- 无 SIMD 不是“不可用”，只是慢；UI 应显示“兼容模式”，而不是拒绝进入。

## 4. Worker 与 pthread：两层结构

### 4.1 为什么是两层

- **外层 Worker**：隔离引擎崩溃、避免搜索卡住 UI、提供 `stop`/`dispose` 的生命周期边界。
- **内层 pthread Worker**：Pikafish 自己的搜索线程；Emscripten 把每个 pthread 映射成一个 Worker。

结果就是“Worker 套 Worker”。这带来一个经典故障：主引擎能跑，开多线程后 pthread worker 找不到脚本，报 404。

### 4.2 `mainScriptUrlOrBlob` 是必需的

Emscripten 的 pthread worker 需要重新加载引擎脚本。打包器会给脚本加 hash、改路径，甚至内联成 blob，所以必须显式告诉 Emscripten：

```ts
const module = await Pikafish({
  locateFile: (f) => f.endsWith('.wasm') ? wasmUrl : f,
  mainScriptUrlOrBlob: jsUrl, // 关键
  // ...
})
```

如果不设置，常见表现是：`Threads=1` 正常，`Threads=4` 直接挂起或 404。

### 4.3 classic worker 还是 module worker

这是一个容易踩的坑：

- `importScripts()` **只能在 classic worker** 中使用。
- 如果 Worker 以 `{ type: 'module' }` 创建，`importScripts` 会抛错。
- 解决办法二选一：
  1. 用 classic worker + `importScripts(jsUrl)`（本方案默认，最简单）；
  2. 用 module worker + `await import(jsUrl)`，但要求 Emscripten 产物是 ES module，且 pthread 侧行为要重新验证。

**不能**在 module worker 里写 `importScripts`，也不能假设“TypeScript 编译出来就自动兼容”。架构页的 Worker 示例按 classic worker 实现；如果改用 Vite 的 module worker，需要同步改加载方式。

### 4.4 池大小与线程上限

- `PTHREAD_POOL_SIZE=8` 表示预分配 8 个 pthread worker；`Threads` 超过池大小时，`PTHREAD_POOL_SIZE_STRICT=2` 会直接失败，避免静默卡死。
- 建议 API 层把 `Threads` 钳制到 `min(用户设置, 池大小, 推荐值)`。
- 桌面推荐 `min(4, max(1, cores - 1))`；移动端 2；单线程构建强制 1。
- 池越大，空闲 Worker 的内存开销越大；8 是参考实现的折中，不是硬性标准。

### 4.5 崩溃隔离与 watchdog

Pikafish 对非法 FEN/走法会 `std::exit(1)`（见[技术调研](/plan/research) 2.4）。`-sNO_EXIT_RUNTIME=1` 不能把这种退出变成可恢复异常。因此：

- 发送 `position` 前必须用规则包校验 FEN 与走法；
- Worker 退出时主线程要能收到 `exit`，自动重启一次；
- 搜索超过阈值没有 `bestmove`，判定无响应，重启 Worker；
- 重启后要重新 `setoption`、重新加载网络（或复用已缓存的字节）。

## 5. NNUE 网络：50 MB 的现实

### 5.1 事实

| 项 | 值 |
| --- | --- |
| 文件 | `pikafish.nnue`（官方 `master-net`，滚动更新） |
| 当前大小 | 50,241,100 B（2026-10-14，约 47.9 MiB） |
| 参考快照 | 50,706,378 B（约 48.4 MiB，`brianhliou/pikafish-wasm` 固定版本） |
| 加载后内存 | 约 66 MiB（参考实现） |
| 回退 | **没有** classical fallback；网络缺失/不匹配会失败 |
| 声明 | 权重有独立声明；项目代码的 AGPL 不改变它 |

### 5.2 加载策略

```text
Cache Storage 命中？
  ├─ 是 → 读取 → SHA-256 校验 → 写入 wasm FS
  └─ 否 → fetch(netUrl) → 流式进度 → 写缓存 → 校验 → 写入 wasm FS
                ↓
        pikafish_initialize() → 引擎加载 EvalFile
```

设计要点：

- **核心包不带权重**：体积 + 分发条件双重原因；`netData` 由应用自行打包。
- **两种入口**：`netUrl` 运行时下载并缓存；`netData` 直接传入 ArrayBuffer，适合离线/内网。
- **缓存键带 SHA**：`pikafish-net-<sha256>`；换网络自然失效。没有 SHA 时不做持久缓存。
- **校验默认开启**：两种入口都支持 `netSha256`；生产环境必须提供。
- **只保留一份持久副本**：Cache Storage 存响应；wasm 堆内是引擎副本；JS 的 `ArrayBuffer` 写完即释放。
- **进度可能不确定**：服务器没给 `Content-Length` 时，显示“已下载字节”而不是假百分比。

### 5.3 首载体验

50 MB 在桌面宽带是可接受的“一次下载”，在移动网络不是。产品上必须：

- 首次进入先说明“需要下载约 50 MB 引擎网络”，不要静默卡住；
- 提供下载进度、取消、失败重试；
- 下载完成后提示“已缓存，下次秒开”（前提是缓存未被清理）；
- 不要在首屏自动开始下载；让用户点击“开始对弈/分析”再加载；
- 低内存设备直接建议单线程 + 小 Hash。

## 6. COOP/COEP 与双部署

### 6.1 为什么需要

多线程构建依赖 `SharedArrayBuffer`，而浏览器要求页面处于 **cross-origin isolated** 状态：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

没有这两个头，`crossOriginIsolated` 为 `false`，引擎无法启动（`pthread_create` 会失败），能力探测直接抛 `BUILD_UNAVAILABLE`。

### 6.2 双部署

**Vercel（主演示）**：用 `vercel.json` 直接设置响应头：

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**GitHub Pages（文档 + 镜像）**：不能自定义响应头，只能用 `coi-serviceworker` 注册同源 Service Worker 注入 COOP/COEP。代价：

- 首次访问需重载一次；SW 更新时可能再次重载；
- 会绕过 GitHub CDN 的常规缓存路径；
- 必须同源加载，不能从 CDN 引用；
- 所有跨源资源必须带 CORS/CORP。

如果 `coi-serviceworker` 失败，页面会明确报告“需要跨源隔离”；两个站点同时提供 `threads-simd` 与 `single-*` 构建入口。

### 6.3 跨源资源与 COOP 副作用

启用 `require-corp` 后，跨源资源必须带 CORP/CORS。因此：

- wasm/js/网络**尽量同源**托管；
- 如果网络放对象存储/CDN，必须配置 `Access-Control-Allow-Origin` 与 `Cross-Origin-Resource-Policy: cross-origin`；
- 第三方字体、图片、脚本、分析像素会被拦截，v0.1 全部自托管；
- `COOP: same-origin` 会切断 `window.opener`，本项目无 OAuth/支付弹窗，不受影响；
- `credentialless` 可缓解 no-cors 资源，但 **Safari 不支持**，不能作为唯一方案。

## 7. 内存与性能预算

### 7.1 参考数字

| 项 | 参考值 | 说明 |
| --- | --- | --- |
| wasm | 662 KB | 未压缩 |
| JS glue | 80 KB | 未压缩 |
| 网络文件 | 约 48 MiB | 当前官方 50,241,100 B；参考快照 50,706,378 B |
| 加载后内存 | 约 66 MiB | 网络加载后，未计 Hash/线程 |
| 4 线程速度 | 约 1.4 MNPS | Chromium，参考实现硬件 |
| `stop` | 约 20 ms | 参考实现 |

这些数字**不能直接当产品承诺**：不同 CPU、浏览器、线程数、Hash 大小都会改变结果。

### 7.2 预算表（设计目标）

| 场景 | Threads | Hash | 估算峰值 | 策略 |
| --- | --- | --- | --- | --- |
| 桌面，隔离 | 4 | 64 MB | 250–400 MB | 默认高性能 |
| 桌面，非隔离 | 1 | 32 MB | 150–250 MB | `single-simd` |
| 移动，隔离 | 2 | 16 MB | 150–250 MB | 保守 |
| iOS / 低内存（≤ 2 GB） | 1 | 8–16 MB | 120–200 MB | `single-simd` / `single-nosimd` |

> 估算是“网络 66 MiB + wasm 堆 + Hash + 线程栈 + 浏览器开销”的量级，不是实测。M1 必须用真实设备校准。

### 7.3 移动端注意

- iOS 对 wasm 内存与 Worker 数量更敏感；不要默认 4 线程。
- iOS 上超过约 **300 MB** 的 wasm 分配不可靠；`memory.grow()` 失败可能直接杀掉标签页，而不是抛可捕获异常。
- WebAssembly 内存上限建议按 **32767 页（2 GiB − 64 KiB）** 封顶，而不是 4 GiB；本项目线程构建用 1 GiB、单线程用 512 MiB，已是保守值。
- `memory64` 在 2026-10 仍不能作为基线（Chrome 133 / Firefox 134；Safari 仅 preview，iOS 不支持）。
- 后台切换可能挂起 Worker；回前台要检查引擎是否还活着。
- 低电量模式可能限制性能；不要用固定 NPS 做超时判断。

## 8. 构建、产物与发布

### 8.1 工具链固定

- 以参考实现验证过的 **Emscripten 3.1.74** 为基线；升级单独评审。
- 用 Docker 镜像 `emscripten/emsdk:3.1.74`，digest 写入 `engine.json`。
- 上游 submodule 固定 commit；patch 固定内容哈希。

### 8.2 构建参数

以架构页的基线为准，关键点：

- `-O3 -DNDEBUG`；线程+SIMD 与单线程+SIMD 用 `-msimd128`；无 SIMD 构建不加。
- `-sMODULARIZE=1 -sEXPORT_NAME=Pikafish`；不输出 ESM，保持 classic worker + `importScripts`。
- `-sENVIRONMENT=web,worker`；不承诺 Node。
- `-sEXPORTED_FUNCTIONS` 暴露 `pikafish_initialize`、`pikafish_command` 等。
- `-sINITIAL_MEMORY=64MB`、`-sSTACK_SIZE=3MB`；线程构建 `MAXIMUM_MEMORY=1GB`、池 8、`PTHREAD_POOL_SIZE_STRICT=2`；单线程 `MAXIMUM_MEMORY=512MB`。
- `-sNO_EXIT_RUNTIME=1`、`-sINVOKE_RUN=0`；但不要指望它拦住 `std::exit(1)`。

`--closure=1` 可选：lichess 在用，但对导出符号/字符串反射更敏感；启用后必须跑完整 UCI 回归。

### 8.3 产物清单

每次 Release 至少包含：

- `pikafish-threads-simd.js/.wasm`
- `pikafish-single-simd.js/.wasm`
- `pikafish-single-nosimd.js/.wasm`
- `engine.json`（上游 commit、emsdk、patch hash、net SHA、构建时间）
- `SHA256SUMS`
- `LICENSE`（AGPL-3.0-or-later）、`NOTICE`、`SOURCE.txt`（源码获取方式与上游 commit）
- 可选的 `bench.json`（三构建的基准结果）

网络文件**不进 Release 包**（体积 + 分发条件），只发布 SHA 与下载说明。

### 8.4 部署

- **Vercel**：项目根目录部署，`vercel.json` 设置 COOP/COEP；主演示站与预览部署都走同一配置。
- **GitHub Pages**：用 `DOCS_BASE` 适配仓库子路径；`coi-serviceworker` 必须放在站点根作用域，否则无法覆盖整个页面。
- wasm 以 `application/wasm` 提供；确认托管平台没有把它当 `application/octet-stream`。
- 静态资源加长缓存；HTML 不加长缓存。
- 两个站点页脚都提供“源代码”入口，满足 AGPL 的网络交互源码义务。

## 9. 对架构决策的确认与修正

| 决策 | 结论 | 补充 |
| --- | --- | --- |
| D3 三构建 | 采纳 | 线程+SIMD、单线程+SIMD、单线程无 SIMD；单线程是一等公民 |
| D4 Worker + pthread | 保留 | 明确 classic worker + `mainScriptUrlOrBlob` |
| D5 网络双入口 | 采纳 | `netUrl`（Cache + SHA）或 `netData`（应用打包）；核心包不带权重 |
| D8 Vercel + Pages | 采纳 | Vercel 直接设头；Pages 用 `coi-serviceworker`；都保留单线程 |
| D9 固定工具链 | 保留 | 3.1.74 基线；升级需回归 |
| D10 AGPL | 采纳 | 项目代码 AGPL-3.0-or-later；上游 GPL-3.0 可组合；权重独立声明 |
| 新增 | 输入校验前置 | 非法 FEN/走法会让引擎退出，不能靠 `NO_EXIT_RUNTIME` |
| 新增 | 池大小 = 线程上限 | 避免“开 9 线程卡死” |
| 新增 | 三构建都跑 bench | 防止单线程/无 SIMD 构建行为漂移 |

**不要照搬的东西**：

- 把完整 50 MB 网络塞进核心 npm 包。
- 用 `stdin` 模拟 UCI（阻塞语义在 Worker 里更难控）。
- 假设 `-sNO_EXIT_RUNTIME=1` 能让非法输入“不退出”。
- 把 `INITIAL_MEMORY` 设成 256 MB 还指望 iOS 稳定。

## 10. 未验证 / 待实测

| 项 | 状态 |
| --- | --- |
| 662 KB / 80 KB 的 gzip/brotli 后体积 | **已实测**，见下表 |
| Safari/iOS 上 4 线程与 1 GB 内存上限 | 未实测 |
| Safari 15.2–16.3 的无 SIMD 构建 | 未实测 |
| GitHub Pages + `coi-serviceworker` 的实际兼容性 | **已实测（本地等价环境）**：无响应头的静态服务器 + 仓库子路径下，SW 注册、接管、注入 COOP/COEP 后 `crossOriginIsolated` 为 true，三套构建均可玩；真实域名下的首次访问（需刷新一次）仍待部署后确认 |
| `--closure=1` 对 Pikafish 导出符号的影响 | 未使用该开关，未实测 |
| 池为空时的按需 pthread 创建 | **已实测：挂起**。`PTHREAD_POOL_SIZE` 未设置时，`pthread_create()` 触发的 worker 握手永不完成，引擎初始化既不返回也不报错；因此三套构建都改为预分配池 |
| 50 MB 网络在移动网络的完成率/放弃率 | 未实测 |
| 参考实现 1.4 MNPS 的具体 CPU/浏览器版本 | 未完整披露 |
| `stockfish.js` v19.0.1 的完整构建矩阵 | 以发布说明为准，未逐项复现 |

### 10.1 本项目产物实测（2026-10，emsdk 3.1.74，`-O3`）

| 产物 | 原始 | gzip -9 | brotli -q11 |
| --- | --- | --- | --- |
| `threads-simd` wasm | 657,901 B | 235,889 B | 180,259 B |
| `threads-simd` JS 胶水 | 81,124 B | 22,356 B | 19,722 B |
| `single-simd` wasm | 657,900 B | 235,888 B | 180,274 B |
| `single-simd` JS 胶水 | 81,122 B | 22,355 B | 19,760 B |
| `single-nosimd` wasm | 654,299 B | 234,494 B | 178,538 B |
| `single-nosimd` JS 胶水 | 81,122 B | 22,355 B | 19,760 B |

> wasm 的压缩比约 2.8:1。静态托管（Vercel/GitHub Pages）默认对 `.wasm` 开 gzip/brotli，
> 因此首访下载量约为 230 KB（gzip）而不是 660 KB。

## 11. 来源

| 主题 | 地址 |
| --- | --- |
| stockfish.js | <https://github.com/nmrugg/stockfish.js> |
| lichess stockfish-web | <https://github.com/lichess-org/stockfish-web> |
| 历史 stockfish.wasm | <https://github.com/lichess-org/stockfish.wasm> |
| Pikafish WASM 参考实现 | <https://github.com/brianhliou/pikafish-wasm> |
| Pikafish 源码 | <https://github.com/official-pikafish/Pikafish> |
| Pikafish 编译 Wiki | <https://github.com/official-pikafish/Pikafish/wiki/Compiling-from-source> |
| Pikafish 网络 | <https://github.com/official-pikafish/Networks> |
| coi-serviceworker | <https://github.com/gzuidhof/coi-serviceworker> |
| 跨源隔离指南 | <https://web.dev/articles/cross-origin-isolation-guide> |
| Emscripten 文档 | <https://emscripten.org/docs/> |
| MDN SharedArrayBuffer | <https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer> |
| MDN crossOriginIsolated | <https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated> |
| Vercel 响应头文档 | <https://vercel.com/docs/project-configuration#headers> |
| MDN CacheStorage | <https://developer.mozilla.org/docs/Web/API/CacheStorage> |
