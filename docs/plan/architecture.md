# 系统架构

> 目标读者：实现者与评审者。  
> 关联文档：[方案总览](/plan/overview) · [选型记录](/plan/decisions) · [技术调研](/plan/research) · [路线图](/plan/roadmap)

## 1. 设计原则

1. **引擎与界面解耦**：核心包不知道棋盘长什么样；UI 通过规则包与引擎通信。
2. **主线程不做重活**：搜索、网络加载、哈希校验全部在 Worker 中完成。
3. **能力探测优先于假设**：线程、SIMD、内存、缓存逐项探测，失败有明确降级路径。
4. **资源可复现**：上游 commit、网络 SHA-256、Emscripten 版本、构建参数全部版本化。
5. **失败可诊断**：每个错误都有稳定错误码、可操作提示与最近 UCI 日志。
6. **核心小、边界硬**：不把棋谱平台、开局库、联机对战塞进核心包。

## 2. 总体分层

```text
┌────────────────────────────── 应用层 ──────────────────────────────┐
│  演示站（Vite + 极简 SVG 棋盘）│  第三方应用（React / Vue / 原生 JS）│
└───────────────────────────────┬────────────────────────────────────┘
                                │ 公共 API：Promise / 事件 / AsyncIterable
┌───────────────────────────────▼────────────────────────────────────┐
│                      pikafish-js（主线程）                          │
│  控制器 · UCI 编解码 · 能力探测 · 资源加载 · 缓存 · 错误映射          │
└───────────────────────────────┬────────────────────────────────────┘
                                │ postMessage（结构化消息，非 UCI 字符串）
┌───────────────────────────────▼────────────────────────────────────┐
│                    engine.worker（专用 Worker）                     │
│  Emscripten 模块 · 网络写入 FS · pikafish_command · stdout 转发      │
└───────────────────────────────┬────────────────────────────────────┘
                                │ pthread（SharedArrayBuffer）
┌───────────────────────────────▼────────────────────────────────────┐
│             搜索线程池（1..8，Emscripten pthread workers）           │
└────────────────────────────────────────────────────────────────────┘

旁路：@pikafish-js/rules 在主线程运行，负责 FEN、合法着法、终局与循环裁决。
UI 只依赖规则包与公共 API，不直接解析引擎内部状态。
```

### 2.1 为什么是 Worker + pthread 两层

- **Worker** 隔离引擎崩溃、避免搜索卡住 UI，并让 `stop`/`dispose` 有明确的回收边界。
- **pthread** 是 Pikafish 自身的搜索线程模型。Emscripten 会把每个 pthread 映射为 Worker，因此浏览器里实际是“Worker 套 Worker”。
- 这也意味着 **引擎 Worker 的脚本 URL 必须可被 pthread worker 重新加载**，否则会出现“主引擎能跑、开多线程就 404”的经典问题。方案通过 Emscripten 的 `mainScriptUrlOrBlob` 显式传递。

## 3. 仓库与包结构

### 3.1 Monorepo 布局

```text
pikafish-js/
├─ docs/                         # VitePress 文档（本方案）
├─ apps/
│  └─ demo/                      # 演示站：极简 SVG 棋盘、对弈、分析
│     ├─ src/
│     │  ├─ board/               # 棋盘、棋子、交互、ARIA
│     │  ├─ panels/              # 难度、思考、棋谱、设置
│     │  ├─ assets/              # 原创/已记录来源的棋子与图标
│     │  └─ main.ts
│     └─ public/
├─ packages/
│  ├─ pikafish-js/               # 对外 npm 包
│  │  ├─ src/
│  │  │  ├─ index.ts             # 公共出口
│  │  │  ├─ engine.ts            # 控制器与状态机
│  │  │  ├─ protocol.ts          # 主线程 ↔ Worker 消息类型
│  │  │  ├─ uci/
│  │  │  │  ├─ parser.ts         # info/bestmove/option 解析
│  │  │  │  └─ encoder.ts        # position/go/setoption 编码
│  │  │  ├─ loader/
│  │  │  │  ├─ capabilities.ts  # SIMD / SAB / 内存探测
│  │  │  │  ├─ assets.ts        # wasm/js/网络加载
│  │  │  │  ├─ net-cache.ts     # Cache Storage
│  │  │  │  └─ integrity.ts     # SHA-256
│  │  │  ├─ worker/
│  │  │  │  └─ engine.worker.ts # 引擎宿主（classic worker）
│  │  │  ├─ errors.ts
│  │  │  └─ types.ts
│  │  ├─ assets/                 # 构建产物（gitignore，随 Release 分发）
│  │  └─ test/
│  └─ rules/                     # 规则、FEN、记谱、裁决
│     └─ src/
│        ├─ fen.ts
│        ├─ movegen.ts
│        ├─ legal.ts
│        ├─ adjudicate.ts
│        ├─ notation.ts
│        └─ pgn.ts
├─ patches/
│  └─ 0001-wasm-entrypoints.patch
├─ scripts/
│  ├─ build-wasm.sh              # Docker + emsdk，产出三构建
│  ├─ fetch-net.mjs              # 下载并校验官方网络
│  ├─ verify-net.mjs
│  └─ bench.mjs
├─ upstream/                     # git submodule，固定 commit
├─ engine.json                   # 版本/哈希/构建元数据
├─ vercel.json                   # Vercel COOP/COEP 响应头
└─ .github/workflows/
```

### 3.2 为什么用 submodule + patch，而不是 vendor 整棵源码

- 仓库体积小，来源清晰，升级时 diff 明确。
- patch 只保留 Web 化必需的最小改动（入口函数、`loop()` 拆分），便于向上游提交 PR。
- 构建脚本直接对固定 commit 打补丁，避免“源码被悄悄改过”的不可追溯问题。

> 备选：用 `git subtree` 或 CI 中临时 clone。两者都可接受；方案选 submodule，因为贡献者能在本地直接看到上游代码与补丁上下文。

## 4. 引擎构建

### 4.1 产物矩阵

| 产物 | 线程 | SIMD | 适用环境 | 说明 |
| --- | --- | --- | --- | --- |
| `pikafish-threads-simd.js/.wasm` | pthread 池 8 | 128-bit | 跨源隔离页面 | 默认高性能构建 |
| `pikafish-single-simd.js/.wasm` | 按需 1 个 pthread | 128-bit | 跨源隔离页面 | 单线程、512 MB 堆上限 |
| `pikafish-single-nosimd.js/.wasm` | 按需 1 个 pthread | 无 | 无 SIMD 的设备 | 兼容层；不承诺 NPS |

> **所有构建都必须处于跨源隔离状态。** Pikafish 的 `ThreadPool` 至少会用一个
> `pthread_create()` 启动主搜索线程，脱离 `-pthread` 无法编译；因此“单线程”指的是
> 引擎只开 1 个搜索线程、使用更小的堆上限，而不是“不需要 SharedArrayBuffer”。
> 运行时按“SIMD → 线程数”选择：
>
> - 支持 SIMD：`threads-simd`（隔离页面默认）
> - 支持 SIMD 但用户/内存限制：`single-simd`
> - 不支持 SIMD：`single-nosimd`
>
> 没有跨源隔离时引擎不会静默降级，而是抛出 `BUILD_UNAVAILABLE` 并提示使用
> COOP/COEP 或 `coi-serviceworker`。推荐基线仍是 **Chrome/Edge 91+、Firefox 89+、Safari 16.4+**。

### 4.2 构建参数（以参考实现为基线）

以下参数来自已验证的 `brianhliou/pikafish-wasm` 构建脚本，并与上游 `src/Makefile` 的 `wasm32` 分支一致：

**线程 + SIMD**（默认高性能）：

```bash
em++ \
  src/*.cpp \
  -Isrc \
  -std=c++17 -O3 -funroll-loops -DNDEBUG \
  -DIS_64BIT -DNO_PREFETCH -DUSE_POPCNT \
  -DUSE_SSE2 -msse2 -DUSE_SSSE3 -mssse3 -DUSE_SSE41 -msse4.1 \
  -DUSE_SLOPPY_ATOMICS -msimd128 -pthread -Wno-pthreads-mem-growth \
  -sWASM=1 -sMODULARIZE=1 -sEXPORT_NAME=Pikafish \
  -sENVIRONMENT=web,worker \
  -sEXPORTED_FUNCTIONS=_pikafish_initialize,_pikafish_command,_main,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,FS \
  -sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1GB \
  -sSTACK_SIZE=3MB -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=2 \
  -sNO_EXIT_RUNTIME=1 -sINVOKE_RUN=0 \
  -o dist/pikafish-threads-simd.js
```

**单线程 + SIMD**：保留 `-pthread`（`ThreadPool` 必需），去掉 `-sPTHREAD_POOL_SIZE*`（线程按需创建），`MAXIMUM_MEMORY` 降为 `512MB`。

**单线程无 SIMD**：在单线程基础上再去掉 `-msimd128` 与 SSE 宏，其余保持一致。

关键点：

- `-sMODULARIZE` + `-sEXPORT_NAME=Pikafish` 让 Worker 能 `await Pikafish({...})`；默认输出 classic worker 可用的脚本，配合 `importScripts`。
- `-sENVIRONMENT=web,worker` 明确不支持 Node；Node 支持不在 v0.1 范围。
- `-sINITIAL_MEMORY=64MB` 与上游默认一致，比参考实现的 256 MB 更适合移动端；按需增长，避免一上来就压高水位。
- `-sMAXIMUM_MEMORY` 不是“立刻占用”，而是堆上限；线程构建 1 GB，单线程构建 512 MB，给 iOS 留出回退空间。
- `-sPTHREAD_POOL_SIZE=8` 预分配 8 个 pthread worker；`Threads` 超过 8 会快速失败，必须在 API 层钳制。
- `-sPTHREAD_POOL_SIZE_STRICT=2` 池耗尽时打印警告（值 `1` 才是直接报错）；`clampThreads()` 把 `Threads` 钳到 8，正常路径不会触发。
- `-Wno-pthreads-mem-growth` 关闭 shared memory + growth 的编译警告；运行时仍要处理 `HEAPU8` 视图失效。

### 4.3 上游补丁

参考实现的补丁约 60 行，核心是两件事：

1. 在 `main.cpp` 中为 `__EMSCRIPTEN__` 增加 `pikafish_initialize()` 与 `pikafish_command(const char*)` 两个 C 入口。
2. 把 `UCIEngine::loop()` 拆成 `execute(cmd)`，让浏览器可以逐条送入 UCI 命令，而不是阻塞在 `stdin`。

本项目的 patch 以该思路为基线，但会额外做两件事：

- 增加 `pikafish_set_option()` 的便捷入口（可选，减少字符串拼接错误）。
- 在 `pikafish_initialize()` 中把初始化失败（网络缺失、架构不匹配）转成明确的返回码，而不是直接 `exit()`，便于 Worker 上报错误码。

> 补丁应尽量保持“可上游化”：不引入项目特有的业务逻辑，只做浏览器宿主必需的最小适配。
>
> 注意：上游对非法 FEN/走法会调用 `std::exit(1)`，`-sNO_EXIT_RUNTIME=1` 不能把它变成可恢复异常。因此非法输入必须由规则包在发送前拦截；Worker 意外退出时由主线程重启并上报 `ENGINE_CRASHED`。

### 4.4 可复现性

- 工具链固定为 `emscripten/emsdk:3.1.74`（Docker 镜像 digest 也写入 `engine.json`）。
- 上游源码固定 commit；patch 固定内容哈希。
- 每次 Release 产出 `engine.json`、`SHA256SUMS`、`LICENSE`、`NOTICE`、`SOURCE.txt`（源码获取方式与 commit）。
- 不承诺 bit-for-bit 可复现（Emscripten 版本/环境可能影响字节），但承诺**输入可复现、产物可校验、行为可回归**。

## 5. NNUE 网络

### 5.1 事实基线

| 项 | 值 |
| --- | --- |
| 官方资产 | `official-pikafish/Networks` 的 `master-net`（滚动更新，无稳定 tag） |
| 当前体积 | 50,241,100 B（2026-10-14 更新，约 47.9 MiB） |
| 参考快照 | 50,706,378 B（约 48.4 MiB，`brianhliou/pikafish-wasm` 固定版本） |
| 内存中大小 | 约 66 MiB |
| 架构签名 | `(62083, 1024, 32, 32, 1)` |
| 默认文件名 | `pikafish.nnue`（`EvalFileDefaultName`） |
| 回退评估 | **没有** classical fallback；网络缺失/不匹配会失败 |

> `master-net` 是滚动资产，体积与 SHA 会变化。发布时必须固定一个具体 SHA，不能把“当前大小”写死为协议常量。

### 5.2 加载策略

```text
提供 netData？
  ├─ 是 → （可选）SHA-256 校验 → 写入 wasm FS
  └─ 否 → netUrl 必填
           Cache Storage 命中？
             ├─ 是 → 读取 Response → ArrayBuffer → SHA-256 校验
             └─ 否 → fetch(netUrl)
                      → 流式进度回调
                      → 写入 Cache Storage
                      → ArrayBuffer → SHA-256 校验
                            ↓
              module.FS.writeFile('/pikafish.nnue', bytes)
                            ↓
              pikafish_initialize() → 引擎加载 EvalFile
                            ↓
              stdout: "info string NNUE evaluation using pikafish.nnue (...)"
```

设计要点：

- **核心 npm 包不带权重**：网络文件约 50 MB，且适用独立声明。`npm pack` 只含代码与 wasm。
- **两种入口二选一**：`netUrl` 用于运行时下载；`netData` 用于随应用打包（内网、离线、单文件部署）。两者同时提供或都不提供都应在 `create()` 阶段报 `NET_SOURCE_INVALID`。
- **不默认热链上游**：`netUrl` 由调用方显式给出。默认从第三方 URL 拉取会带来可用性、CORS、带宽与版本漂移问题。
- **缓存键包含 SHA**：`pikafish-net-<sha256>`，升级网络时自然失效，避免“旧缓存配新引擎”。未提供 `netSha256` 时不做持久缓存（只走 HTTP 缓存），避免无法失效。
- **校验默认开启**：`netData` 与 `netUrl` 都支持 `netSha256`；未提供时给出警告，文档建议生产环境必须提供。
- **缓存只服务 URL 路径**：`netData` 由应用自己管理生命周期，库不复制到 Cache Storage。
- **只保留一份持久副本**：URL 路径下 Cache Storage 存响应；wasm 堆内是引擎自己的副本；JS `ArrayBuffer` 在校验和写入后释放。

### 5.3 许可与分发

项目代码采用 **AGPL-3.0-or-later**；上游 Pikafish 为 GPL-3.0，可与 AGPL-3.0 组合。NNUE 权重有独立声明，不因代码许可而改变：

- 核心 npm 包**不包含** `pikafish.nnue`；使用 `netUrl` 或 `netData` 由应用提供。
- 应用若通过 `netData` 打包权重，需在自身发布物中保留来源与声明；库只在日志与文档中提示。
- 演示站托管网络时，在下载入口与页脚展示来源与使用范围。
- 本项目不设置“许可审查”作为发布门禁；发布清单保留源码获取方式、上游声明与权重来源即可。

## 6. 能力探测与降级

### 6.1 探测项

```ts
interface Capabilities {
  wasm: boolean
  simd: boolean
  threads: boolean          // crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
  crossOriginIsolated: boolean
  hardwareConcurrency: number
  deviceMemoryGB?: number   // navigator.deviceMemory，仅部分浏览器
  storageQuotaMB?: number   // navigator.storage.estimate()
}
```

- **SIMD**：用一段最小 SIMD 模块执行 `WebAssembly.validate()`，不要依赖 UA 字符串。
- **线程**：`crossOriginIsolated === true` 且 `SharedArrayBuffer` 可用，两者缺一不可。
- **内存**：优先 `navigator.deviceMemory`；没有时按 `hardwareConcurrency` 与浏览器类型估算，并保守取小。
- **存储**：`navigator.storage.estimate()`，低于阈值时提示“网络可能无法缓存”。

### 6.2 选择策略

| 条件 | 构建 | 默认 Threads | 默认 Hash |
| --- | --- | --- | --- |
| 未跨源隔离（无 COOP/COEP） | 直接报 `BUILD_UNAVAILABLE` | — | — |
| 不支持 SIMD | single-nosimd | 1（忽略设置） | 16 MB |
| 支持 SIMD + 跨源隔离 + 桌面 | threads-simd | `min(4, max(1, cores - 1))` | 64 MB |
| 支持 SIMD + 跨源隔离 + 移动 | threads-simd | 2 | 16 MB |
| 内存紧张（≤ 2 GB） | single-simd / single-nosimd | 1 | 16 MB |

- **先判断跨源隔离，再判断 SIMD**：隔离是硬前提，缺失时任何构建都无法运行；无 SIMD 时即使页面隔离，也只能用 `single-nosimd`。
- 用户显式设置优先，但会被构建能力钳制（例如单线程构建下 `Threads=4` 自动降为 1，并发出 `degraded` 事件）。
- 不允许 `Threads > PTHREAD_POOL_SIZE`，否则在 API 层直接报错或钳制。
- `Hash` 上限按设备能力设置（桌面 256 MB，移动 64 MB，iOS 32 MB），避免用户把内存打爆。

## 7. Worker 协议

### 7.1 消息类型

```ts
type NetSource =
  | { kind: 'url'; url: string; sha256?: string }
  | { kind: 'data'; data: ArrayBuffer; sha256?: string }

type MainToWorker =
  | { type: 'init'; jsUrl: string; wasmUrl: string; net: NetSource; threads: number; hashMB: number }
  | { type: 'command'; line: string }
  | { type: 'dispose' }

type WorkerToMain =
  | { type: 'progress'; phase: 'wasm' | 'net' | 'init'; loaded: number; total: number }
  | { type: 'ready'; engineInfo: string; netInfo: string; options: UciOption[] }
  | { type: 'line'; line: string }        // UCI stdout
  | { type: 'stderr'; line: string }
  | { type: 'error'; code: PikafishErrorCode; message: string; detail?: string }
  | { type: 'exit'; code: number }
```

- 主线程 ↔ Worker 使用结构化消息；只有 Worker → 引擎内部使用 UCI 字符串。
- 这样主线程可以做强类型解析，而 Worker 保持“薄”，不重复实现协议逻辑。

### 7.2 Worker 初始化伪代码

```ts
// engine.worker.ts（示意）
let command: ((line: string) => void) | null = null

self.onmessage = async (event) => {
  const msg = event.data
  if (msg.type === 'init') {
    try {
      const netPromise = msg.net.kind === 'url'
        ? fetchNet(msg.net.url, msg.net.sha256, progress)
        : Promise.resolve(msg.net.data)
      importScripts(msg.jsUrl)                    // 生成物：pikafish.js
      const factory = (self as any).Pikafish
      const module = await factory({
        locateFile: (f: string) => f.endsWith('.wasm') ? msg.wasmUrl : f,
        mainScriptUrlOrBlob: msg.jsUrl,           // 关键：pthread worker 复用同一脚本
        print: (line: string) => post({ type: 'line', line }),
        printErr: (line: string) => post({ type: 'stderr', line })
      })
      const net = await netPromise
      module.FS.writeFile('/pikafish.nnue', net)
      const init = module.cwrap('pikafish_initialize', 'number', [])
      const code = init()
      if (code !== 0) throw new EngineInitError(code)
      command = module.cwrap('pikafish_command', null, ['string'])
      post({ type: 'ready', ... })
    } catch (e) {
      post({ type: 'error', ... })
    }
  }
  if (msg.type === 'command') command?.(msg.line)
}
```

### 7.3 为什么不用 `stdin` 模拟

Emscripten 可以把 `stdin` 接到 `postMessage`，但需要额外的 JS 胶水与阻塞语义，且与 pthread 的交互更复杂。直接暴露 `pikafish_command()` 更可控，也避免 `getline` 在 Worker 中阻塞。

> Worker 打包方式必须与加载方式一致：`importScripts()` 只能用于 **classic worker**。若使用 `{ type: 'module' }`，应改为 `await import(jsUrl)`，并重新验证 pthread 的 `mainScriptUrlOrBlob` 行为。

## 8. UCI 会话管理

### 8.1 状态机

```text
created → initializing → ready ⇄ searching → stopping → ready
                                  │
                                  └→ crashed → disposed
```

规则：

- **一次只允许一个搜索**。新搜索开始前，若旧搜索仍在运行，先 `stop` 并等待 `bestmove`（带超时）。
- `position` 之前必须确保引擎处于 `ready`；`setoption` 在搜索中禁止直接发送，进入队列。
- `ucinewgame` 后必须 `isready`，并清空哈希（`setoption name Clear Hash`）。
- `dispose` 先 `stop`，再终止 Worker；pthread 池随 Worker 一起回收。

### 8.2 搜索请求

```ts
interface AnalyzeRequest {
  fen: string
  moves?: string[]              // UCI 着法，如 ['h2e2', 'h9g7']
  depth?: number
  nodes?: number
  movetime?: number
  infinite?: boolean
  multiPV?: number
  signal?: AbortSignal
}
```

编码顺序：

```text
[可选] setoption name MultiPV value N
position fen <fen> [moves ...]
go depth D | nodes N | movetime T | infinite
```

- `AbortSignal` 触发时发送 `stop`，并等待 `bestmove`；调用方拿到 `AbortError`。
- 若 1 秒内没有 `bestmove`，判定引擎无响应，强制重启 Worker 并抛出 `SEARCH_TIMEOUT`。
- `go infinite` 只允许在显式分析模式使用；普通对弈必须带 `movetime`/`depth`，避免泄漏线程。

### 8.3 `info` 解析

Pikafish 的 `info` 行包含：`depth`、`seldepth`、`multipv`、`score cp/mate`、`wdl`、`nodes`、`nps`、`hashfull`、`time`、`pv`、`currmove`、`string`。解析器需容忍：

- 字段顺序变化与未知字段。
- `score` 的 `lowerbound`/`upperbound`。
- `pv` 为空或包含非法着法（防御性丢弃）。
- `info string` 与结构化 `info` 混排。

### 8.4 结果

```ts
interface AnalysisResult {
  bestmove: string | null       // null 表示无合法着法
  ponder?: string
  score?: Score                 // { type: 'cp' | 'mate', value: number, bound?: 'lower' | 'upper' }
  depth?: number
  nodes?: number
  nps?: number
  timeMs?: number
  pv: string[][]
  info: AnalysisInfo[]          // 完整历史，便于回放
}
```

## 9. 公共 API 草案

```ts
import { Pikafish } from 'pikafish-js'

const engine = await Pikafish.create({
  jsUrl: '/engine/pikafish.js',
  wasmUrl: '/engine/pikafish.wasm',
  netUrl: '/engine/pikafish.nnue',
  netSha256: '7d13d735…900e',
  threads: 4,
  hashMB: 64,
  onProgress: (p) => console.log(p.phase, p.loaded / p.total)
})

engine.on('info', (info) => {
  // 更新思考面板：depth / score / pv / nps
})

const result = await engine.analyze({
  fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w',
  depth: 16,
  multiPV: 3
})

console.log(result.bestmove, result.score, result.pv)

// 对弈一步
const move = await engine.play({ fen, moves, movetime: 1000 })

await engine.dispose()
```

随应用打包网络时，把 `netUrl` 换成 `netData`：

```ts
import netUrl from './assets/pikafish.nnue?url'
const netData = await (await fetch(netUrl)).arrayBuffer()

const engine = await Pikafish.create({
  jsUrl: '/engine/pikafish.js',
  wasmUrl: '/engine/pikafish.wasm',
  netData,
  netSha256: '7d13d735…900e'
})
```

### 9.1 设计取舍

- **`create()` 而非构造函数**：加载是异步的，工厂函数能自然返回进度与错误。
- **`analyze()` 返回完整结果，事件提供流式更新**：同时满足“只要最佳着法”和“实时面板”两类需求。
- **不内建棋盘状态**：核心包只接收 FEN + moves；规则包负责对局状态。这样核心可以服务分析器、对弈、批量跑分等不同场景。
- **`AbortSignal` 而非自定义取消**：与 Fetch、React Query、现代框架一致。
- **错误码而非字符串**：便于 UI 做本地化与差异化处理。

### 9.2 事件

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `progress` | `LoadProgress` | 加载条 |
| `ready` | `{ engineInfo, netInfo, options }` | 启用 UI |
| `info` | `AnalysisInfo` | 思考面板 |
| `bestmove` | `{ move, ponder }` | 落子 |
| `degraded` | `{ reason }` | 提示单线程/性能下降 |
| `error` | `PikafishError` | 统一错误处理 |

## 10. 规则包与裁决

### 10.1 职责边界

| 能力 | 归属 | 说明 |
| --- | --- | --- |
| 走法生成/合法性 | rules | 不依赖引擎，纯 TS |
| 将死/困毙 | rules | 无合法着法 |
| 三次重复 | rules | 记录局面键（棋盘 + 行棋方） |
| 自然限着 | rules | 120 步未吃子，含将军计数规则 |
| 长将/长捉 | rules | 循环序列内逐着分类，按违规等级判决 |
| 子力不足 | rules | 仅剩将/士/象 |
| 搜索与着法建议 | engine | 引擎不负责裁决 |

### 10.2 裁决流程

```text
每走一步：
  1. 生成合法着法；若为空 → 将死/困毙
  2. 更新未吃子步数、将军计数
  3. 若仅剩将/士/象 → 和棋
  4. 若未吃子步 >= 120 → 和棋（先检查将死/困毙/三次重复优先级）
  5. 记录局面键；若同一局面第三次出现 → 取出循环序列
  6. 对循环序列逐着分类：长将(2) / 长捉(1) / 允许循环(0)
  7. 比较双方最高违规等级：高者负；相等则和
```

### 10.3 实现难点

- **“捉”的定义**不是“攻击”那么简单：要排除被吃后处于对方攻击、帅/兵攻击、未过河兵、同类互攻等情况；还要处理牵制。
- **循环序列的起止点**：从同一局面第一次出现到第三次出现，闭区间；不是从开局算。
- **将军计数**：自然限着中，每方最多计入 10 次将军；超过的将军及对应的应将不计入未吃子步数。
- **性能**：裁决只在终局候选时运行，不需要每步全量分析；但仍需保证 39 个官方棋例可复现。

> 策略：M3 先实现“将死/困毙/三次重复（保守判和）/120 步/子力不足”，M4 完成长将/长捉分类器，并用官方 39 个棋例做黄金测试。若分类器延期，v0.1 采用“循环即和”的保守策略，并在文档中明确标注，不阻塞发布。

### 10.4 记谱

- 内部统一使用 UCI 坐标（`a0`–`i9`），避免中文记谱的歧义。
- 展示层提供中文记谱（炮二平五、马8进7），按官方规则处理前/后/中兵等多子同线情况。
- PGN 导入导出放在 v0.2；v0.1 支持 JSON 棋谱与复制着法列表。

## 11. 加载时序

```text
create()
  │
  ├─ 探测能力 → 选择构建（threads-simd / single-simd / single-nosimd）→ 创建 Worker
  │
  ├─ 解析 net source：netUrl（下载/缓存）或 netData（调用方提供）
  ├─ 并行：加载 wasm/js（HTTP 缓存） + 加载网络（Cache Storage / 网络 / 内存）
  │        └─ 进度事件：wasm 5% → net 5..90% → init 90..100%
  │
  ├─ Worker: importScripts(js) → factory({ locateFile, mainScriptUrlOrBlob })
  ├─ Worker: FS.writeFile('/pikafish.nnue', bytes)
  ├─ Worker: pikafish_initialize()
  ├─ 主线程: 'uci' → 解析 options
  ├─ 主线程: 'isready' → 等待 'readyok'
  ├─ 校验 stdout: "NNUE evaluation using ..."
  └─ ready
```

失败路径与提示：

| 失败点 | 错误码 | 用户提示 |
| --- | --- | --- |
| 浏览器不支持 wasm | `UNSUPPORTED_ENV` | 请升级浏览器 |
| 页面未跨源隔离 / 无 SIMD 构建缺失 | `BUILD_UNAVAILABLE` | 用 COOP/COEP 或 `coi-serviceworker` 开启隔离 |
| Worker 抛出未捕获异常 | `WORKER_ERROR` | 重启引擎；查看控制台 |
| wasm/js 404 或 MIME 错 | `ASSET_LOAD_FAILED` | 检查静态资源路径与 `application/wasm` |
| 网络入口缺失/冲突 | `NET_SOURCE_INVALID` | 只提供 `netUrl` 或 `netData` 之一 |
| 网络下载失败 | `NET_LOAD_FAILED` | 检查 `netUrl`、CORS 与网络 |
| 网络 SHA 不匹配 | `NET_HASH_MISMATCH` | 清除缓存并重新下载（已自动重试一次） |
| 权重写入虚拟文件系统失败 | `NET_WRITE_FAILED` | 降低 `Hash`、换更小的网络文件 |
| 引擎初始化失败 | `ENGINE_INIT_FAILED` | 网络与引擎版本不匹配，检查 `engine.json` |
| 引擎崩溃/退出 | `ENGINE_CRASHED` | 自动重启 Worker 并重放当前局面 |
| FEN/走法非法 | `INVALID_FEN` / `INVALID_MOVE` | 校正输入（上游会 `exit(1)`，因此必须前置校验） |
| 搜索被中止 | `SEARCH_ABORTED` | 正常路径，不提示 |
| 显式设置被能力钳制 | （`degraded` 事件，非错误） | 提示“已按设备能力调整线程/Hash” |

## 12. 缓存与存储

### 12.1 网络缓存

```ts
const cache = await caches.open('pikafish-net-v1')
const hit = await cache.match(cacheKey)
if (!hit) {
  const res = await fetch(netUrl)
  await cache.put(cacheKey, res.clone())
}
const bytes = new Uint8Array(await (await cache.match(cacheKey))!.arrayBuffer())
```

- Cache Storage 在 Window 与 Worker 均可用；不需要 Service Worker。
- 仅 `netUrl` 路径使用缓存；`netData` 由调用方管理，库不写入 Cache Storage。
- 缓存键：`/__pikafish_net__/<sha256>`，避免与业务缓存冲突。
- 配额不足时（`QuotaExceededError`）降级为仅 HTTP 缓存，并提示。

### 12.2 wasm/js

- 由浏览器 HTTP 缓存负责；自托管时使用内容哈希文件名 + `immutable`。
- 演示站可用 Service Worker 预缓存，但**库本身不注册 SW**（避免与宿主应用冲突）。

### 12.3 清理

- `Pikafish.clearCache()`：删除本项目命名空间下的 Cache Storage 条目。
- 版本升级时保留旧网络缓存一段时间，允许回滚；在 `engine.json` 中声明兼容范围。

## 13. 性能与内存预算

| 项 | 估算 | 说明 |
| --- | --- | --- |
| wasm 代码 | ~0.66 MB | 参考实现实测 662,419 B |
| JS 胶水 | ~80 KB | 参考实现实测 80,121 B |
| 网络文件 | 约 48 MiB | 当前官方 50,241,100 B；参考快照 50,706,378 B |
| 网络解压后 | ~66 MiB | 引擎加载后常驻 wasm 堆 |
| INITIAL_MEMORY | 64 MiB | 与上游默认一致，按需增长 |
| MAXIMUM_MEMORY | 1 GiB（线程）/ 512 MiB（单线程） | 超出即失败，避免浏览器被杀 |
| Hash（默认） | 16 MiB | 桌面建议 64 MiB；iOS 32 MiB |
| pthread 栈 | 8 × 3 MiB = 24 MiB | 预分配池 |
| 峰值 RSS（桌面 4 线程） | ~250–400 MB | 需实测校准 |
| 峰值 RSS（移动单线程） | ~150–250 MB | 需实测校准 |

> 上述为预算，不是承诺。M1 必须在目标设备上测量 `performance.memory`（Chrome）与 DevTools Memory，并把结果写回文档。

### 13.1 低内存策略

1. 设备内存 ≤ 2 GB：强制单线程 + Hash 16 MB。
2. 网络加载前检查 `storage.estimate()`；空间不足则提示“仅本次使用，不缓存”。
3. 页面隐藏（`visibilitychange`）时停止无限分析，释放搜索线程。
4. 连续多局后重建 Worker，防止碎片化累积。

## 14. 跨源隔离与部署

### 14.1 需要的响应头

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

启用后 `crossOriginIsolated === true`，`SharedArrayBuffer` 可用，多线程构建才能启动。

### 14.2 双部署

**Vercel（主演示）**：直接在 `vercel.json` 设置响应头，页面天然处于跨源隔离状态。

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

**GitHub Pages（文档 + 镜像演示）**：不能自定义响应头，使用 [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) 在 Service Worker 中注入 COOP/COEP：

- 必须作为独立同源文件加载，不能从 CDN 引用，也不能被打进 bundle；
- 首次访问会重载一次；SW 更新时可能再次重载；
- 会绕过 GitHub CDN 的常规缓存路径，网络加载体验不如 Vercel；
- 所有跨源子资源必须带 CORS/CORP，否则会被拦截；
- Service Worker 不可用或未生效时，引擎会明确报错并提示改用 Vercel 部署，而不是假装降级到“无隔离的单线程模式”（Pikafish 无法在没有 SharedArrayBuffer 的情况下运行）。

其他托管（Cloudflare Pages、Netlify、Nginx）可用 `_headers` 或站点配置设置同样的头，不作为 v0.1 的必选路径。

> 项目代码采用 AGPL-3.0-or-later。两个演示站都必须在页脚提供“源代码”入口，满足网络交互场景下的源码提供义务。

### 14.3 CORS/CORP 清单

| 资源 | 要求 |
| --- | --- |
| wasm/js | 同源；跨源需 CORS |
| 网络文件 | 同源或 CORS；建议自托管 |
| 字体/图片/图标 | **自托管最稳**；跨源需 CORP/CORS |
| 第三方脚本/分析 | COEP 下会被拦截；v0.1 不引入 |
| iframe | 避免；COEP 下需子文档同样隔离 |
| OAuth 弹窗 | `COOP: same-origin` 会切断 `window.opener`；本项目无登录，不受影响 |

## 15. 安全

- **无默认遥测**：不发送对局、局面、设备指纹；调试日志仅在 `debug: true` 时本地输出。
- **输入校验**：FEN 长度上限、着法格式白名单、`multiPV`/`depth`/`movetime` 范围限制。
- **资源完整性**：网络 SHA-256；发布产物 SHA256SUMS；npm provenance。
- **CSP 兼容**：Emscripten 产物可能需要 `wasm-unsafe-eval`；文档给出示例，不使用 `eval` 的业务代码不受影响。
- **Service Worker**：库不自动注册；演示站的 SW 只作用于自身 scope。
- **拒绝作弊场景**：文档与演示明确“仅限合法用途”；不提供自动对弈、平台规避、隐藏窗口运行等功能。

## 16. 兼容矩阵

| 环境 | 最低版本 | 线程 | SIMD | 状态 |
| --- | --- | --- | --- | --- |
| Chrome / Edge | 91+ | ✅（需隔离） | ✅ | 主目标 |
| Firefox | 89+ | ✅（需隔离） | ✅ | 主目标 |
| Safari macOS | 16.4+ | ✅（需隔离） | ✅ | 主目标 |
| iOS Safari | 16.4+ | ✅（需隔离） | ✅ | 重点测试 |
| Android Chrome | 91+ | ✅（需隔离） | ✅ | 重点测试 |
| Node.js | 20+ | ❌ | ✅ | v0.1 不支持；测试用 Playwright |
| Safari 15.2–16.3 | 15.2+ | ❌ | ❌ | `single-nosimd` 兼容模式 |
| 无 SIMD 旧浏览器 | — | ❌ | ❌ | `single-nosimd`；显示“兼容模式” |

## 17. 可观测性与调试

- `debug: true`：把最近 200 条 UCI 行保存在环形缓冲区，错误时随错误对象导出。
- `engine.bench()`：运行固定局面/固定深度，返回 NPS、时间、内存（可用时）。
- 演示站提供“诊断”面板：能力探测结果、构建选择、线程数、Hash、网络缓存命中、首字延迟。
- 不在生产环境自动上报；如需监控，由宿主应用自行接入。

## 18. 关键架构决策记录（ADR 摘要）

| ADR | 决策 | 状态 |
| --- | --- | --- |
| ADR-001 | 使用官方 C++ 源码 + Emscripten，而非重写 | 接受 |
| ADR-002 | 三构建（线程+SIMD / 单线程+SIMD / 单线程无 SIMD），运行时探测选择 | 接受 |
| ADR-003 | 网络双入口：`netUrl` 或 `netData`；核心包不携带权重 | 接受 |
| ADR-004 | 引擎运行在专用 Worker，pthread 由 Emscripten 管理 | 接受 |
| ADR-005 | 核心包不包含 UI；极简棋盘与规则独立 | 接受 |
| ADR-006 | 规则裁决独立实现，按官方规则书 | 接受 |
| ADR-007 | 上游 commit/网络 SHA/emsdk 全部固定 | 接受 |
| ADR-008 | Vercel 主站 + GitHub Pages 镜像；Pages 用 coi-serviceworker | 接受 |
| ADR-009 | v0.1 不支持 Node；无 SIMD 浏览器使用兼容构建 | 接受 |
| ADR-010 | 项目代码 AGPL-3.0-or-later；上游 GPL-3.0 可组合 | 接受 |

## 19. 待定项

1. 是否为 iOS/低内存设备增加专用内存构建（更小 `MAXIMUM_MEMORY` 或延迟加载）。
2. 是否把规则包拆成独立 npm 包（取决于复用需求）。
3. 是否内置一个独立声明、体积更小的网络用于低内存设备（需验证架构兼容性与棋力）。
4. 是否向上游提交 WASM 入口补丁，减少长期维护成本。
5. 无 SIMD 构建是否长期保留，还是只作为过渡产物。
