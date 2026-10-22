# pikafish-js

## 0.2.0

### Minor Changes

- 新增 `variants` / `variant`：把「用哪张 NNUE 权重」和「用哪套 WebAssembly 构建」捆在
  一起选。权重是按特征宽度（`L1`）训练出来的，宽度对不上时引擎会按 arch hash 拒绝加载，
  所以这两者不能分开配置。`engine.variant` 可以读回当前那一套的名字。

  不传 `variants` 时行为与从前完全一致，顶层 `builds` 与权重的用法不变。

### Patch Changes

- 56e5b18: 引擎初始化完成后删除 WASM 文件系统里的 NNUE 副本，页面常驻内存少约 50 MB。引擎把网读进内存后就不再读文件（它验证网络时只比对路径），所以这份副本留着只是浪费。

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
