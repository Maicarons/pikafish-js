# pikafish-js

在浏览器中运行 [Pikafish](https://github.com/official-pikafish/Pikafish) 中国象棋引擎的前端 monorepo：纯前端人机对弈、本地局面分析，引擎以 WebAssembly 运行在专用 Worker 中，不上传任何棋局数据。

> 当前状态：**v0.1 实现完成**。规则包、引擎包、演示站与三套 WASM 构建脚本均已落地，文档位于 `docs/`。

## 仓库结构

```text
pikafish-js/
├─ packages/rules/        # @pikafish-js/rules：FEN、着法生成、裁决、中文记谱
├─ packages/engine/       # pikafish-js：引擎 Worker、UCI 协议、NNUE 加载
├─ apps/demo/             # @pikafish-js/demo：SVG 棋盘 + 人机对弈演示
├─ scripts/               # WASM 构建、NNUE 下载、资源打包与部署脚本
├─ patches/               # 上游 Pikafish 的浏览器入口补丁
├─ docs/                  # VitePress 项目文档（中文）
├─ upstream/              # 上游 Pikafish 源码（构建时生成，不提交）
└─ engine.json            # 上游 commit、emsdk、NNUE 与构建矩阵的钉版信息
```

## 快速开始

需要 Node 20+。若要运行演示，还需要 Emscripten 3.1.74（见下文）。

```bash
npm install

# 下载钉版的 NNUE 权重（约 48 MB，带 SHA-256 校验）
npm run fetch:net

# 需要 Emscripten 3.1.74 已激活
npm run build:wasm
npm run package:wasm          # 可选的发布产物

# 把 WASM / NNUE 复制进演示站 public 目录
npm run assemble:demo

# 开发模式
npm run dev
```

`npm run dev` 会先构建 rules 与 engine 包，再启动 Vite。Vite 开发服务器已经设置 COOP/COEP 响应头，因此多线程构建可用。

## 常用脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run typecheck` | 三个包的 TypeScript 检查 |
| `npm run test` | Vitest：规则 perft/裁决 + 引擎 UCI 解析 + 构建选择 |
| `npm run build:wasm` | 用 Emscripten 3.1.74 构建三套 WASM |
| `npm run package:wasm` | 生成带 `SHA256SUMS` 的发布资源 |
| `npm run fetch:wasm` | 从 GitHub Release 下载并校验 WASM 资源（Vercel 用） |
| `npm run fetch:net` | 下载并校验钉版 NNUE |
| `npm run assemble:demo` | 组装 `apps/demo/public/engine/` |
| `npm run docs:dev` / `docs:build` | VitePress 文档 |
| `npm run verify` | typecheck + test + build |

## 引擎与构建矩阵

| 构建 | 线程 | SIMD | 说明 |
| --- | --- | --- | --- |
| `threads-simd` | pthread 池 8 | 是 | 默认高性能构建 |
| `single-simd` | 按需 1 个 pthread | 是 | 单线程、512 MB 堆上限 |
| `single-nosimd` | 按需 1 个 pthread | 否 | 无 SIMD 设备兼容层 |

> **所有构建都要求页面的跨源隔离（COOP/COEP）与 `SharedArrayBuffer`。** Pikafish 的
> `ThreadPool` 至少需要一个 pthread；`single-*` 只是引擎单线程、堆更小，并不是无隔离
> 的降级路径。没有隔离时 `createEngine()` 会抛出 `BUILD_UNAVAILABLE` 并给出提示。

## 部署

- **Vercel（主演示）**：`vercel.json` 设置 COOP/COEP，构建脚本 `scripts/vercel-build.mjs` 会下载发布资源、组装演示与文档，输出到 `apps/demo/dist`。需要先发布一次 WASM release。
- **GitHub Pages**：`.github/workflows/pages.yml` 用 `setup-emsdk` 现场构建 WASM，演示站挂在根路径，文档挂在 `/docs/`，并用 `coi-serviceworker.js` 注入 COOP/COEP。
- **Release**：`.github/workflows/release.yml` 在 `v*` tag 上构建并上传 `SHA256SUMS` 与三套构建资源；Vercel 通过 `PIKAFISH_WASM_URL` 指定下载地址。

## 许可证与来源

- 项目代码：**AGPL-3.0-or-later**（见 `LICENSE`）。
- 上游引擎 Pikafish 为 GPL-3.0，补丁与构建方式记录在 `patches/`、`engine.json`。
- NNUE 权重来自 Pikafish `Networks` 仓库的 `master-net` 发布，适用其自身声明，不随 npm 包分发。
- 两个演示站页脚均提供上游源码与项目源码入口；网络交互场景下对应源码即本仓库。

## 文档

完整的项目方案位于 `docs/`：

- [方案总览](docs/plan/overview.md)
- [选型记录](docs/plan/decisions.md)
- [技术调研：象棋生态](docs/plan/research.md)
- [技术调研：Web 移植](docs/plan/research-web.md)
- [系统架构](docs/plan/architecture.md)
- [实施路线图](docs/plan/roadmap.md)
- [风险与对策](docs/plan/risks.md)
