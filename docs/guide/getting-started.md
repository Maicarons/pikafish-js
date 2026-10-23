# 快速开始

本指南用大约 30 分钟把一个真正能下棋的 Pikafish 引擎接进你的网页。所有代码都取自本仓库
`apps/demo` 的实际实现，不是伪代码。

::: tip 三个前提
先记住三件事，其余都是细节：

1. 引擎是**官方 Pikafish C++ 源码**编译出的 WebAssembly，没有用 JS 重写；
2. 页面必须**跨源隔离**（`crossOriginIsolated === true`），否则拿不到
   `SharedArrayBuffer`，引擎无法启动；
3. 50 MB 的 NNUE 权重**不进 npm 包**，运行时按 URL 下载并校验 SHA-256。
:::

## 1. 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | 安装与构建 |
| 打包器 | Vite 5+ / Rollup / Webpack | 需要能导入 `?url` 资源，或自己把 worker 脚本放进静态目录 |
| 浏览器 | Chrome 97+、Firefox 79+、Safari 16.4+ | 需要 WebAssembly、SIMD 与 `SharedArrayBuffer` |
| 引擎产物 | 三套 wasm/js + NNUE | 见第 2 步 |

> Safari 16.4 是 `WebAssembly` 编译所需 `'wasm-unsafe-eval'` 的最低版本。iOS 上内存更紧，
> 建议选 `single-simd` 构建并把 `hashMB` 控制在 32 以内。

## 2. 准备引擎产物

### 方案 A：使用发布产物（先跑通）

Release 里是逐个文件，不是压缩包：`<引擎>-<构建>.pikafish.js` 与 `.wasm`（例如
`strong-threads-simd.pikafish.wasm`），外加 `wasm-manifest.json` 与 `SHA256SUMS`。按下面
的结构放进演示站的 `public/engine/`：

```text
public/engine/
├── engine.json                 # 清单：每套引擎的构建、权重 URL 与字节数
├── pikafish*.nnue              # 六张权重（strong 用官方教师网）
├── strong/
│   └── {threads-simd,single-simd,single-nosimd}/{pikafish.js,pikafish.wasm}
├── lite/
├── w256/
├── w192/
├── w128/
└── w64/
```

`SHA256SUMS` 在发布页上，可用 `sha256sum -c SHA256SUMS` 复核。

### 方案 B：从源码构建（可复现）

```bash
# 1. 安装依赖
npm ci

# 2. 下载并校验固定版本的权重
npm run fetch:net

# 3. 编译十八套构建（六套引擎 × 三种能力，需要已激活的 Emscripten 3.1.74）
npm run build:wasm

# 4. 生成带 SHA256SUMS 的发布目录 dist/release
npm run package:wasm

# 5. 把引擎文件放进演示站的 public/engine
npm run assemble:demo
```

`scripts/build-wasm.sh` 会自己克隆上游仓库并切到 `engine.json` 里固定的 commit，再应用
`patches/pikafish-wasm.patch`。版本不一致时会直接报错，而不是“差不多能用”。

Emscripten 必须是 **3.1.74**。版本不同会改变 wasm 行为与体积，发布产物就不可复现了。

## 3. 安装依赖

```bash
npm i pikafish-js
# 需要规则与中文记谱时
npm i @pikafish-js/rules
```

`pikafish-js` 只包含代码：`dist/index.js`、类型声明，以及一个**预打包的 classic worker**
`dist/engine.worker.js`。权重需要你自己托管。

## 4. 让页面跨源隔离

开发与生产都必须发送这两个响应头：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite 开发服务器加两行配置即可：

```ts
// vite.config.ts
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

生产环境见[部署指南](./deployment.md)。**没有隔离时不要尝试“降级运行”**：三套构建都至少
需要一个 pthread，单线程构建指的是“引擎只用一个线程”，不是“不需要 `SharedArrayBuffer`”。

## 5. 创建引擎

```ts
import { createEngine } from 'pikafish-js';
// `?url` 让打包器把 worker 当静态资源输出，生产环境仍是 IIFE。
import workerUrl from 'pikafish-js/engine.worker.js?url';

const engine = await createEngine({
  build: 'auto', // 按设备能力挑一套；也可写死 'threads-simd' 等
  builds: {
    'threads-simd': { js: '/engine/threads-simd/pikafish.js', wasm: '/engine/threads-simd/pikafish.wasm' },
    'single-simd': { js: '/engine/single-simd/pikafish.js', wasm: '/engine/single-simd/pikafish.wasm' },
    'single-nosimd': { js: '/engine/single-nosimd/pikafish.js', wasm: '/engine/single-nosimd/pikafish.wasm' },
  },
  netUrl: '/engine/pikafish.nnue',
  netSha256: 'bf3982711150bf2f8b49e99cd93421320f6ca914cfcf131dad5eb7f2402573ac',
  workerFactory: () => new Worker(workerUrl, { type: 'classic' }),
  onNetProgress: ({ loaded, total }) => {
    console.log(`权重 ${(loaded / total * 100).toFixed(0)}%`);
  },
});

console.log(engine.info); // { build, threads, hashMB, netBytes, netCached }
```

几个容易踩的点：

- worker **必须是 classic**（`type: 'classic'`）。预打包的 worker 是 IIFE，不是 ES module。
- 自定义 worker 用 `workerFactory` 或 `workerUrl`，不要试图在 `new Worker(...)` 里直接
  指向源码入口——Vite 开发模式不会打包 classic worker。
- 不传 `workerFactory` 时，库会从它自己的 `dist/engine.worker.js` 加载，适合拷贝节点的
  场景；浏览器里更推荐显式 `workerFactory`，路径最可控。

## 6. 搜索与落子

```ts
// 一次性搜索：等结果
const result = await engine.play({
  fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
  movetime: 800,
});
console.log(result.bestmove); // 例如 "h2e2"

// 流式分析：边搜边显示
const handle = await engine.analyze({ fen, depth: 22, multiPV: 3 });
for await (const info of handle.updates) {
  render(info.score, info.pv);
}
const { bestmove } = await handle.result;
```

`multiPV` 通过 `setoption` 设置，不会拼接到 `go` 命令里。想中途停止就调用
`handle.stop()` 或传入 `signal`（中止后 `result` 以 `SEARCH_ABORTED` 拒绝）。

## 7. 结合规则包

引擎只负责“给着法”，棋盘合法性、胜负与中文记谱交给 `@pikafish-js/rules`：

```ts
import { Game, toChineseNotation } from '@pikafish-js/rules';

const game = new Game(); // 默认开局
const move = game.moveUcci('b2e2');
console.log(move.notation); // 炮二平五
console.log(game.status()); // { over: false, ... }
```

引擎给的是 UCCI（`b2e2`），规则包用同一套坐标，可以直接落子。完整 API 见
[API 参考](./api.md)。

## 8. 常见错误

| 错误码 | 典型原因 | 处理 |
| --- | --- | --- |
| `BUILD_UNAVAILABLE` | 页面未跨源隔离 | 补 COOP/COEP，Pages 用 `coi-serviceworker.js` |
| `ASSET_LOAD_FAILED` | `js`/`wasm` 路径错、404 | 检查 `builds` 里的 URL 与 MIME（`.wasm` 需 `application/wasm`） |
| `NET_LOAD_FAILED` | 权重下载失败、离线 | 检查域名/CORS；提供重试 |
| `NET_HASH_MISMATCH` | 权重被改动或版本不匹配 | 对照 `engine.json` 的 SHA-256 重新托管 |
| `ENGINE_INIT_FAILED` | 权重写入 FS 失败或内存不足 | 移动端改用 `single-simd`、降低 `hashMB` |
| `ENGINE_CRASHED` | wasm 运行时崩溃 | 收集 `stderr` 日志与设备信息提 issue |

## 9. 完成检查

- [ ] `engine.info` 不为 `null`，`threads` 与预期一致
- [ ] 首次加载显示权重下载进度，刷新后 `netCached === true`
- [ ] 能完成一次 `movetime: 500` 的搜索并落子
- [ ] 断网后刷新给出可恢复的错误提示，而不是空白页
- [ ] 手机上选 `single-simd` 仍可对弈

接着读：[API 参考](./api.md) · [部署指南](./deployment.md) · [常见问题](./faq.md)
