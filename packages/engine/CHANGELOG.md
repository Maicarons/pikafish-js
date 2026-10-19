# pikafish-js

## 0.1.0

首个公开版本。

### 新增

- `createEngine()`：创建 classic Worker、加载 WebAssembly、写入 NNUE 权重并完成 UCI 握手。
- 三套构建：`threads-simd`、`single-simd`、`single-nosimd`，由 `chooseBuild()` 按设备能力选择。
- `analyze()` 流式搜索（`AsyncIterable<AnalysisInfo>`）与 `play()` 一次性搜索。
- 权重双分发：`netUrl`（Cache Storage + SHA-256 校验，损坏自愈）或 `netData`（`ArrayBuffer`）。
- 事件：`ready`、`netprogress`、`info`、`bestmove`、`line`、`stderr`、`degraded`、`error`。
- 结构化错误码，覆盖环境、资源、网络、哈希、初始化与搜索中止。

### 说明

- 三套构建都要求页面跨源隔离（COOP/COEP + `SharedArrayBuffer`）；`single-*` 指引擎单线程，
  不是“无需隔离”。
- 包内只有一个预打包的 classic worker：`pikafish-js/engine.worker.js`。
- 包内**不含** NNUE 权重。
