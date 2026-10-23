# pikafish-js

## 1.0.0

### Major Changes

- 三套引擎 × 三种能力共九套预构建：官方 L1=1024（50 MB）、精简 L1=512（25 MB）与新增的
  L1=256（12.6 MB），页面可以自己决定为首屏评估付多少下载量。演示站的网络选择器会列出
  三套，每套都是一个 `variants` 条目——权重只能被同宽度的引擎加载。浏览器只能编 256 的
  整数倍宽度（没有 AVX512 时上游稀疏输入层的约束），所以 12.6 MB 是 wasm 的下限。

  这是两个包第一次发布到 npm，因此版本号直接到 1.0.0，而不是 0.x 的自增。

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
