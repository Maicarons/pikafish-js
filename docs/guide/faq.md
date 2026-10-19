# 常见问题

## 运行环境

### 为什么页面必须跨源隔离？

Pikafish 用 pthread 做多线程搜索，而 pthread 需要 `SharedArrayBuffer`。浏览器出于
Spectre 一类的侧信道防护，只在**跨源隔离**（COOP `same-origin` + COEP `require-corp`）的
页面里暴露它。

三套构建都至少创建一个 pthread，所以没有“降级到单线程就不用隔离”的方案。单线程构建指的是
**引擎内部只开 1 个搜索线程、内存上限更小**。

### 为什么首次访问 GitHub Pages 会刷新一次？

Pages 不能设置响应头。`coi-serviceworker.js` 先注册为 Service Worker，接管页面后由它注入
COOP/COEP，然后页面必须**重新加载一次**才能变成隔离状态。刷新标记写在 `sessionStorage`，
只刷一次，不会循环。

Vercel（或任何能设响应头的地方）没有这一步。

### 支持哪些浏览器？

Chrome 97+、Edge 97+、Firefox 79+、Safari 16.4+。底线是 WebAssembly + SIMD +
`SharedArrayBuffer`。Safari 16.4 之前缺少 WebAssembly 所需的 CSP 关键字，引擎无法编译。

CI 用 Playwright 在 Chromium、Firefox 与 WebKit（Safari 内核）上各跑一遍三套构建，但
**没有真机 iOS 测试**，这一点在路线图里记为已知缺口。

### 手机能跑吗？

能。iOS/Android 上建议：

- 构建选 `single-simd`；
- `hashMB` 16–32；
- 难度别超过 5（避免长时间思考导致发热降频）；
- 页面切到后台时停止无限分析。

`single-nosimd` 只用于不支持 SIMD 的旧浏览器，深度明显更低。

## 引擎与权重

### 为什么不用 JavaScript 重写引擎？

象棋引擎的棋力来自几十年积累的搜索算法与 NNUE 评估，重写等于重新验证所有细节，而且很难保持
与官方一致。本项目直接编译**官方 Pikafish C++ 源码**（固定 commit），只加一个极小的
Emscripten 入口补丁，因此棋力与上游同步，规则问题也能追溯到上游。

### 权重为什么有 48 MB？能小一点吗？

NNUE 是神经网络评估函数，`master-net` 约 50,241,100 字节。它是引擎棋力的主要来源，压缩空间
有限（本身就是紧凑的二进制）。

可以换更小的网络，但那就不是“官方 Pikafish 默认配置”了，棋力会下降，也需要重新验证 NNUE
架构行是否匹配。v0.1 只支持官方 `master-net`。

权重**不进 npm 包**：`pikafish-js` 的 tarball 约 47 KB，权重由使用方按 URL 托管，并可用
SHA-256 校验。

### 权重会下载几次？

一次。`netUrl` + `netSha256` 会给权重写入 Cache Storage（键含 SHA-256），之后命中缓存，不再
走网络。每次命中仍会重新校验哈希，避免用了写坏的副本。

想完全离线分发，用 `netData` 传 `ArrayBuffer`（例如从 IndexedDB 或应用资源读取）。

### 为什么我的 NPS 比文档低很多？

文档里的数字标注了设备、浏览器与 `movetime`。常见原因：

- 用了 `single-nosimd`（NNUE 退化为标量，只有约 1/4 速度）；
- 无头/省电模式或后台标签页被降频；
- 同时开了多个引擎实例，互相抢线程；
- 移动端热降频。

先看 `engine.info.build` 与 `engine.info.threads`，再看[基准数据](./benchmarks.md)。

## 规则与对局

### 长将、长捉怎么判？

v0.1 采用简化裁决：**同一局面出现三次时，若某一方每一步都在将军，判该方负；否则判和**。
完整的“长捉”分类（车捉、马捉、兵捉、联合捉子等）留给 v0.2。

这是路线图里明确的范围裁剪（“v0.1 循环即和，v0.2 完整裁决”），不是遗漏。中国象棋裁判规则
的完整实现需要逐着分类，测试成本很高。

### 困毙算和棋吗？

不算。中国象棋里**困毙判负**：一方无子可动即输，这与国际象棋的 stalemate 是平局不同。规则包
按象棋处理。

### 能和棋吗？

会。三种情况和棋：

- 三次重复且无人长将；
- 120 个半回合无吃子；
- 只剩将（士象）。

### 引擎给的着法在棋盘上不合法？

引擎输出 UCCI（`b2e2`），坐标与规则包一致：rank 0 是红方底线。出现不一致通常是把 FEN 的行
棋方写错，或把“红方在下/黑方在下”的显示顺序当成了坐标。显示可以翻转，坐标永远不变。

## 工程实现

### 为什么 Worker 必须是 classic？

引擎包提供的是预打包的 IIFE worker（`dist/engine.worker.js`），它用 `importScripts` 加载
wasm 胶水。ES module worker 不支持 `importScripts`，而且 Vite 开发模式不会打包以 URL 方式引入
的 module worker 入口。

所以：`new Worker(workerUrl, { type: 'classic' })`，其中 `workerUrl` 来自
`import workerUrl from 'pikafish-js/engine.worker.js?url'`。

### 为什么 `multiPV` 不拼进 `go` 命令？

UCI 里 `MultiPV` 是**选项**，要 `setoption name MultiPV value 3`，之后每条 `info` 会带
`multipv N`。拼到 `go` 后面引擎会忽略或报错。

### 为什么自绘棋盘，而不用 chessgroundx / xiangqiground？

- 需求只有 9×10 落点、棋子、选中态、提示箭头，自绘 SVG 约 300 行；
- 第三方棋盘库的样式、无障碍与键盘行为都要再改造，反而更难控制；
- 少一个运行时依赖，Pages 子路径与 CSP 都更简单。

代价是要自己处理键盘导航与配色，这部分已经实现并有 e2e 覆盖。

### 为什么开启严格 CSP 后引擎起不来？

`script-src` 少了 `'wasm-unsafe-eval'`。WebAssembly 编译在这个 CSP 下需要它（Chrome 97+、
Safari 16.4+）。另外 pthread 子 worker 需要 `worker-src 'self' blob:`。

### 为什么构建时会自动下载权重？

`assemble:demo` 与 Vercel 构建需要把权重放进演示站。脚本会校验 SHA-256，长度不对或哈希不符
会直接失败，而不是带着坏权重上线。

## 许可与隐私

### AGPL 对我的项目意味着什么？

本项目代码以 **AGPL-3.0-or-later** 发布。如果你修改后作为网络服务提供给用户，需要按 AGPL
提供对应源码。只是通过 npm 依赖使用、不修改库本身，通常不触发额外义务，但**这不是法律意见**，
商业项目请自行评估或咨询律师。

上游 Pikafish 是 GPL-3.0，NNUE 权重适用其自身声明，详见仓库 `NOTICE` 与
[一手资料](../reference/sources.md)。

### 会收集数据吗？

不会。引擎、规则、棋盘全部在浏览器本地运行，没有后端接口，也不上报对局。演示站除了下载
wasm 与权重之外不发请求。
