# 术语表

| 术语 | 解释 |
| --- | --- |
| UCI | Universal Chess Interface，引擎与界面之间的文本协议。Pikafish 使用其中国象棋变体。 |
| FEN | Forsyth–Edwards Notation，局面字符串。 |
| NNUE | Efficiently Updatable Neural Network，Pikafish 使用的神经网络评估。 |
| NPS | Nodes Per Second，每秒搜索节点数。 |
| WASM | WebAssembly。 |
| SIMD | 单指令多数据；浏览器中通过 128 位向量加速 NNUE 计算。 |
| 无 SIMD 构建 | 不包含 `-msimd128` 的兼容产物，用于旧 Safari/旧 Android；能下棋，但速度明显较慢。 |
| SAB | `SharedArrayBuffer`，多线程 WASM 所需。 |
| COOP/COEP | `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`，用于启用跨源隔离。 |
| COI | Cross-Origin Isolated，`crossOriginIsolated === true` 的状态；多线程构建的前提。 |
| pthread | POSIX 线程；Emscripten 将其映射到 Web Worker。 |
| Threads | UCI 选项，搜索线程数。本项目按构建能力与 pthread 池大小钳制。 |
| Hash | UCI 选项，置换表大小（MB）。越大越占内存，不直接等于棋力。 |
| MultiPV | UCI 选项，一次输出多个主要变例；分析模式使用。 |
| PV | Principal Variation，引擎认为的最佳走法序列。 |
| `bestmove` | 引擎完成一次搜索后输出的最终着法。 |
| `rule60` | Pikafish 的自然限着计数，合法范围 0–119；吃子会重置。 |
| 自然限着 | 连续 120 个半回合（60 回合）未吃子判和；将军计数按官方规则处理。 |
| 长将 | 循环局面中一方每一步都将军，违规等级最高。 |
| 长捉 | 循环局面中一方每一步都捉同一子，违规等级次之。 |
| 三次重复 | 同一局面出现三次；裁决需结合长将/长捉规则，不能简单判和。 |
| 子力不足 | 双方剩余子力无法构成将死，判和。 |
| `netUrl` | 运行时网络权重地址；库负责下载、Cache Storage 缓存与 SHA-256 校验。 |
| `netData` | 调用方直接传入的 `ArrayBuffer`；适合随应用打包、离线或内网部署。 |
| 三构建 | `threads-simd`、`single-simd`、`single-nosimd` 三个 wasm/js 产物。 |
| `coi-serviceworker` | 通过 Service Worker 为无法设置响应头的静态站点注入 COOP/COEP 的 MIT 库。 |
| AGPL-3.0-or-later | 本项目代码的许可证；网络交互场景下需向用户提供对应源代码。 |
| GPL-3.0 | 上游 Pikafish 的许可证；可与 AGPL-3.0 组合。 |

更完整的协议与规则细节见 [系统架构](/plan/architecture) 与 [技术调研](/plan/research)。
