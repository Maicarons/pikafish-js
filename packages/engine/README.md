# pikafish-js

在浏览器中运行 [Pikafish](https://github.com/official-pikafish/Pikafish) 中国象棋引擎的 TypeScript 包。引擎以 WebAssembly 形式运行在专用 Web Worker 中，主线程只负责协议与状态。

- 完整 UCI 协议：`position`、`go`、`stop`、`setoption`
- 三种构建：`threads-simd`、`single-simd`、`single-nosimd`，按能力自动选择
- 所有构建都要求页面跨源隔离（COOP/COEP）；`single-*` 只是单线程、较小堆上限，不是无 SharedArrayBuffer 的降级路径
- NNUE 权重支持运行时下载（Cache Storage + SHA-256 校验）或直接传入 `ArrayBuffer`
- 运行时下载的权重不会打进本包；核心包只包含 JS 胶水与类型
- 引擎初始化后会把 WASM 文件系统里的权重副本删掉：引擎已经把网读进内存，留着那份只是白占 50 MB
- `analyze()` 返回可迭代的实时 `info` 流与最终 `bestmove`
- 许可证：AGPL-3.0-or-later

## 安装

```bash
npm install pikafish-js
```

本包不包含 `.wasm`、Emscripten 胶水 JS 或 NNUE 权重，需要自行构建或从项目发布产物获取。

## 最小示例

```ts
import { createEngine } from 'pikafish-js';
// Vite：把预构建 worker 作为静态资源取 URL（保持 classic + IIFE）
import workerUrl from 'pikafish-js/engine.worker.js?url';

const engine = await createEngine({
  builds: {
    'threads-simd': { js: '/engine/threads-simd/pikafish.js', wasm: '/engine/threads-simd/pikafish.wasm' },
    'single-simd': { js: '/engine/single-simd/pikafish.js', wasm: '/engine/single-simd/pikafish.wasm' },
    'single-nosimd': { js: '/engine/single-nosimd/pikafish.js', wasm: '/engine/single-nosimd/pikafish.wasm' },
  },
  netUrl: '/engine/pikafish.nnue',
  netSha256: '…',
  // 必须使用 classic worker：Emscripten 生成物通过 importScripts 载入。
  // Vite 用 ?url 保持 IIFE 产物；webpack 可直接用 new URL(裸包名, import.meta.url)。
  workerFactory: () => new Worker(workerUrl, { type: 'classic' }),
});

const handle = await engine.analyze({ fen: engine.info ? '…' : '', depth: 12 });
for await (const info of handle.updates) console.log(info.score, info.pv);
const { bestmove } = await handle.result;

engine.dispose();
```

## 主要 API

| 导出 | 说明 |
| --- | --- |
| `createEngine(options)` | 创建并初始化引擎；失败时抛出 `PikafishError` |
| `PikafishEngine.analyze(params)` | 返回 `{ updates, result, stop }` |
| `PikafishEngine.play(params)` | 只等待搜索结果 |
| `PikafishEngine.setOption(name, value)` | 设置 UCI 选项，内部等待 `readyok` |
| `PikafishEngine.ready()` | 发送 `isready` 并等待 `readyok` |
| `PikafishEngine.on(event, listener)` | `info`、`bestmove`、`netprogress`、`stderr`、`error`、`degraded` |
| `PikafishEngine.dispose()` | 终止 Worker 并释放资源 |

`workerFactory` 用于传入自定义 Worker 构造函数；不传时默认使用包内的 `engine.worker.js`。

## 权重来源

`netUrl` 与 `netData` 二选一，同时提供或都不提供会抛出 `NET_SOURCE_INVALID`。使用 `netUrl` 时建议同时提供 `netSha256`：

- 有 `sha256` 且浏览器支持 Cache Storage 时，权重下载后写入缓存，下次直接命中；
- 缓存内容校验失败会被丢弃并重新下载；
- 使用 `netData` 时权重通过 `postMessage` 转移进 Worker，适合内网或离线单文件部署。

本包不会内置 NNUE 权重，`npm publish` 的 `files` 只包含 `dist`。

## 多套引擎：权重与构建必须成对

权重是按**特征宽度**（`L1`）训练出来的：教师网是 L1=1024，蒸馏网是 L1=512，引擎会按
arch hash 拒绝宽度不符的权重。所以「用哪张网」和「用哪套 wasm」不能分开选，
`variants` 把两者捆在一起：

```ts
const engine = await createEngine({
  variants: {
    strong: {
      builds: { 'single-simd': { js: '/engine/strong/single-simd/pikafish.js', wasm: '…' } },
      netUrl: '/engine/pikafish.nnue',
      netSha256: '…',
    },
    lite: {
      builds: { 'single-simd': { js: '/engine/lite/single-simd/pikafish.js', wasm: '…' } },
      netUrl: '/engine/pikafish-lite.nnue',
      netSha256: '…',
    },
  },
  variant: 'lite',
});
```

不传 `variants` 时行为与从前完全一样（用顶层的 `builds` 与权重）。`engine.variant`
读回当前那一套的名字。

## 构建

包本身由 `tsup` 构建，Worker 由 `esbuild` 打包为单文件：

```bash
npm run build -w pikafish-js
```

WASM 产物需要使用 Emscripten 3.1.74 在仓库根目录运行 `npm run build:wasm`。

## 许可

AGPL-3.0-or-later。上游 Pikafish 引擎为 GPL-3.0，NNUE 权重保留其自身声明。
