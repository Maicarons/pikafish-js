# 基准数据

所有数字都来自**仓库自带的基准页**（`bench.html`，演示站页脚“基准测试”），不是估算，也不
是 Node 里的模拟。换一台设备也能用同一条命令复现。

## 怎么测

- 页面：`/bench.html?movetime=1000`
- 局面：初始局面（`?fen=` 可换）
- 每次搜索固定 `movetime`，四种配置依次跑：`threads-simd@4`、`threads-simd@1`、
  `single-simd@1`、`single-nosimd@1`
- 每种配置新建一个引擎实例，因此“初始化”包含 wasm 编译、pthread 池创建与权重写入
- NPS 取该次搜索最后一条 `info` 的节点数 / 时间

自动化入口：

```bash
# 需要先构建好演示站（npm run site）与 Playwright 浏览器
node scripts/bench.mjs --movetime 1000 --out bench-results/local.json

# 换浏览器
node scripts/bench.mjs --browser firefox --movetime 1000 --out bench-results/firefox.json
node scripts/bench.mjs --browser webkit  --movetime 1000 --out bench-results/webkit.json
```

## 三浏览器对比

同一台机器（Windows 11，`navigator.hardwareConcurrency = 12`），同一时间，`movetime 1000`，
无头浏览器。引擎构建为 v0.1.0（上游 `545c4e3`，Emscripten 3.1.74）。

| 构建 | 线程 | Hash | Chromium 156 | Firefox 157 | WebKit 27.2 |
| --- | --- | --- | --- | --- | --- |
| `threads-simd` | 4 | 64 MB | **1.38 M** NPS（深度 20） | **1.56 M** NPS（深度 20） | **1.01 M** NPS（深度 18） |
| `threads-simd` | 1 | 64 MB | 341 k（19） | 429 k（21） | 278 k（19） |
| `single-simd` | 1 | 32 MB | 388 k（20） | 425 k（20） | 317 k（20） |
| `single-nosimd` | 1 | 32 MB | 91 k（15） | 95 k（15） | 85 k（15） |

初始化时间：Chromium 0.5–1.3 s，Firefox 0.6–1.3 s，WebKit 1.1 s 左右。

几点观察：

- **4 线程是唯一“明显更快”的选项**，大约是单线程的 3.5–4 倍；再往上加线程收益递减（象棋搜索
  并行度有限，且每个线程都要自己的栈）。
- **单线程时 `single-simd` 往往略快于 `threads-simd@1`**：后者为 8 个 pthread 预留了池与地址
  空间，`single-simd` 只预留 2 个。手机/低内存设备应优先选它。
- **`single-nosimd` 是兼容层，不是省电模式**：NNUE 推理退化为标量，深度卡在 15 左右，只保证
  “能完整下一局”。只有不支持 SIMD 的浏览器才该用它。
- 浏览器之间差异约 ±20%，Firefox 在多线程下最快，WebKit 最慢；同机重复测量波动约 ±15%。

## 长思考（movetime 3000）

单条记录，用于看深度上限与 4 线程的收益（开发者机 Chromium，非无头）：

| 构建 | 线程 | 深度 | 节点数 | NPS | 初始化 |
| --- | --- | --- | --- | --- | --- |
| `threads-simd` | 4 | 23 | 4,166,538 | 1.39 M | 0.59 s |
| `threads-simd` | 1 | 23 | 825,172 | 275 k | 0.83 s |
| `single-simd` | 1 | 22 | 837,028 | 279 k | 0.84 s |
| `single-nosimd` | 1 | 15 | 115,242 | 38 k | 0.84 s |

> 这是单次采集的一条记录，可复现但不可当作承诺。

## 体积与传输

六套构建的文件大小（`npm run package:wasm` 产出，`SHA256SUMS` 可复核）：两套引擎
（`strong` = L1=1024，`lite` = L1=512）× 三种能力构建。

| 文件 | 原始 | gzip | brotli |
| --- | --- | --- | --- |
| `*.pikafish.wasm`（任一套） | 654,299–657,901 B | ≈ 236 KB | ≈ 180 KB |
| `*.pikafish.js` | 81,122–81,124 B | ≈ 22 KB | ≈ 19 KB |
| `pikafish.nnue`（教师，strong） | 50,241,100 B | —（已是压缩格式） | — |
| `pikafish-lite.nnue`（蒸馏，lite） | 25,136,309 B | —（已是压缩格式） | — |

**首次访问的真实成本**：默认用蒸馏网时约 24 MB（权重）+ 约 0.25 MB（wasm 压缩后）；
切回强力引擎则是约 48 MB + 约 0.25 MB。权重只下载一次，之后走 Cache Storage；
刷新时只做一次 SHA-256 校验（约 0.3–0.8 s）。

因此“首屏快”不等于“引擎快”：真正的门槛是那张网。演示站如实显示下载进度，不做假加载。

两张网对应两套 wasm，不能混用：权重是按特征宽度（`L1`）训练出来的，宽度对不上时引擎
会按 arch hash 拒绝加载。所以切换网络要连引擎构建一起换。

## 内存

| 项 | 线程构建 | 单线程构建 |
| --- | --- | --- |
| `INITIAL_MEMORY` | 64 MiB | 64 MiB |
| `MAXIMUM_MEMORY` | 1 GiB | 512 MiB |
| Hash（默认） | 64 MiB | 32 MiB |
| pthread 栈 | 8 × 3 MiB | 2 × 3 MiB |
| 权重复制后常驻 | ≈ 66 MiB | ≈ 66 MiB |

权重的**下载**与**常驻**是两件事：引擎初始化时把网读进内存后就删掉了 WASM 文件系统里
那份副本（引擎只在需要重新加载网时才读文件，而它从不重新加载），所以 50 MB 的网不会
在页面上常驻。

iOS Safari 对每个标签页的内存更敏感：选 `single-simd`，Hash 降到 16–32 MB，并在
`visibilitychange` 时停止无限分析。

## 回归监控

`.github/workflows/bench.yml` 每周一跑一次（也可手动触发，可传 `movetime`）：

- 在 CI 的 `ubuntu-latest` 上从源码构建三套 wasm，跑 `bench.html`；
- 下载**上一次成功运行**的报告作为基线（同一类 runner，数字可比）；
- 任一配置 NPS 下降超过 **20%** 时输出 `::warning::` 并写进 Job Summary；
- 报告作为 `bench-report` artifact 保留 90 天。

阈值是告警而不是失败：CI 机器共享、噪声大，硬失败会变成“狼来了”。真正的判断看趋势。

## 什么时候该重测

- 升级上游 Pikafish commit 或 Emscripten 版本；
- 调整编译参数（内存、`-O` 级别、SIMD）；
- 改动 Worker 协议或 NNUE 加载路径；
- 引入新的构建目标（例如无 pthread 的 fallback）。

重测后把新数字写回本页，并注明设备、浏览器版本与 `movetime`——没有这三项的数字没有意义。
