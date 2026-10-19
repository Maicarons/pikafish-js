# 部署指南

引擎能不能跑，取决于**页面是否跨源隔离**；跑得快不快，取决于构建选择与缓存。本文给出两种
官方部署方式、自托管配置与验证清单。

## 1. 为什么必须隔离

Pikafish 的每一套构建都会创建 pthread（`-sPTHREAD_POOL_SIZE` 预分配），而 pthread 需要
`SharedArrayBuffer`。浏览器只在**跨源隔离**的页面里暴露它：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`single-*` 构建的意思是“引擎只用 1 个线程、内存上限更小”，**不是**“不需要隔离”。缺少隔离时
`chooseBuild()` 抛 `BUILD_UNAVAILABLE`，演示站会直接显示说明，而不是假装能下棋。

> 代价：开启 COEP 后，所有跨源资源都必须带 `Cross-Origin-Resource-Policy` 或走 CORS。
> 本项目的引擎、权重、字体全部同源，所以没有额外配置。

## 2. Vercel（主演示站）

仓库根目录的 `vercel.json` 已经写好：

```json
{
  "buildCommand": "node scripts/vercel-build.mjs",
  "outputDirectory": "apps/demo/dist",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Resource-Policy", "value": "cross-origin" },
        { "key": "Content-Security-Policy", "value": "…" },
        { "key": "Referrer-Policy", "value": "no-referrer" },
        { "key": "X-Content-Type-Options", "value": "nosniff" }
      ]
    },
    { "source": "/engine/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
  ]
}
```

构建流程 `scripts/vercel-build.mjs`：

1. `fetch-wasm.mjs`：从发布产物下载三套构建，用 `SHA256SUMS` 逐个校验；
2. `fetch-net.mjs`：下载权重并校验 SHA-256；
3. `assemble-demo.mjs`：放进 `apps/demo/public/engine/`；
4. 构建 rules、engine、demo 与文档，并把文档挂到 `/docs/`。

产物地址默认是
`https://github.com/official-pikafish/pikafish-js/releases/latest/download`；仓库改名或自建
镜像时用环境变量覆盖：

```bash
PIKAFISH_WASM_URL=https://example.com/pikafish-wasm/v0.1.0 node scripts/vercel-build.mjs
```

Vercel 上的推荐设置：

| 项 | 值 |
| --- | --- |
| Framework Preset | Other |
| Build Command | `node scripts/vercel-build.mjs`（已在 `vercel.json`） |
| Output Directory | `apps/demo/dist`（已在 `vercel.json`） |
| Node.js | 20 或 24 |
| 环境变量 | 通常不需要；镜像场景加 `PIKAFISH_WASM_URL` |

> 首次部署会下载约 50 MB 权重。Vercel 的构建缓存对本项目帮助有限，真正的缓存发生在**浏览器**
> 的 Cache Storage（见第 5 节）。

## 3. GitHub Pages（文档 + 镜像）

Pages 不能自定义响应头，所以用 `coi-serviceworker` 在浏览器里补：

```text
apps/demo/public/coi-serviceworker.js   # 由 index.html 之外的模块注册
apps/demo/src/isolation.ts              # 注册、接管、只刷新一次
```

工作流程（`.github/workflows/pages.yml`）：

1. 安装 Emscripten 3.1.74，**从源码编译**三套构建（可复现）；
2. 下载校验权重，`assemble:demo`；
3. `VITE_BASE=/<repo>/ DOCS_BASE=/<repo>/docs/` 构建演示站与文档；
4. 文档产物挂到 `apps/demo/dist/docs/`，整体作为 Pages 产物发布。

首次访问的行为：页面加载 → 注册 Service Worker → 接管后**自动刷新一次** → `crossOriginIsolated`
变为 `true` → 引擎启动。刷新标记写在 `sessionStorage`，避免循环刷新。

已知限制：

- 首次访问多一次刷新，约 100–300 ms；
- `coi-serviceworker` 必须能注册（隐私模式、禁用 SW 的浏览器会失败，此时提示明确错误）；
- 子路径部署必须同时设置 `VITE_BASE` 与 worker 的相对路径；本项目使用
  `new URL('./coi-serviceworker.js', document.baseURI)`，因此 `/pikafish-js/` 下也正确。

## 4. 自托管（nginx / Caddy / 对象存储）

nginx：

```nginx
types { application/wasm wasm; }

add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Embedder-Policy require-corp always;
add_header Cross-Origin-Resource-Policy cross-origin always;
add_header X-Content-Type-Options nosniff always;

location /engine/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}

location = /index.html {
  add_header Cache-Control "no-cache";
}
```

Caddy（配置为文本，VitePress 未内置 caddyfile 语法）：

```text
example.com {
  root * /srv/pikafish
  header {
    Cross-Origin-Opener-Policy same-origin
    Cross-Origin-Embedder-Policy require-corp
    Cross-Origin-Resource-Policy cross-origin
    X-Content-Type-Options nosniff
  }
  @engine path /engine/*
  header @engine Cache-Control "public, max-age=31536000, immutable"
  file_server
}
```

对象存储（S3/OSS/R2）通常不能加响应头：要么套一层 CDN 规则，要么按 GitHub Pages 的方式用
`coi-serviceworker`。

### 缓存策略

| 路径 | 策略 | 原因 |
| --- | --- | --- |
| `/engine/**` | `immutable`, 1 年 | 文件名与内容绑定，升级时换版本目录或加 hash |
| `/engine/engine.json` | `no-cache` | 升级权重/构建时要立刻生效 |
| `/assets/**` | `immutable`, 1 年 | Vite 带 hash |
| `/index.html` | `no-cache` | 指向新的 hash 资源 |
| `/pikafish.nnue` | `immutable` + Cache Storage | 浏览器侧还有一层，见下 |

引擎文件走 `immutable` 时，升级必须更换 URL（例如 `/engine/v0.1.0/...`），否则老用户会一直用
旧 wasm。

## 5. 权重缓存与离线

`netUrl` + `netSha256` 同时给出时，权重写入 Cache Storage（缓存名 `pikafish-net-v1`，键为
`https://pikafish-js.local/net/<sha256>`）。行为：

- 命中：直接读缓存并**再次校验 SHA-256**，不重复下载；
- 校验失败（写坏、被篡改、版本不符）：删除该条目并重新下载；
- 下载失败：`NET_LOAD_FAILED`，UI 提示重试；
- 刷新页面：命中缓存，`engine.info.netCached === true`。

想完全离线分发，改用 `netData` 传 `ArrayBuffer`（例如从 IndexedDB 或自带资源读取），此时
不经过网络也不需要 Cache Storage。

## 6. CSP

生产构建注入的 `Content-Security-Policy` 关键项：

```text
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
style-src 'self' 'unsafe-inline';
connect-src 'self';
```

- `'wasm-unsafe-eval'` 是 WebAssembly 编译所必需（Chrome 97+、Safari 16.4+）；没有它引擎直接
  起不来。
- `worker-src blob:` 给 pthread 子 worker 用。
- `style-src 'unsafe-inline'` 是因为棋盘 90 个落点用内联 `left/top` 定位；没有内联脚本。
- 开发模式**不注入** CSP：Vite 的 HMR 需要内联脚本与 websocket。构建产物才带严格策略。

## 7. 验证清单

部署后逐项确认：

```js
// 浏览器控制台
crossOriginIsolated; // true
typeof SharedArrayBuffer; // "function"
```

- [ ] `crossOriginIsolated === true`（Vercel 直接为真；Pages 首次访问自动刷新一次后为真）
- [ ] 响应头含 COOP/COEP：`curl -I https://你的域名/`
- [ ] 控制台无 CSP 违规
- [ ] 首次加载显示权重进度，刷新后 `netCached === true`
- [ ] 三套构建都能加载（`?build=threads-simd` 等）
- [ ] 关掉网络后刷新仍能开局（权重已缓存）
- [ ] 手机 Safari 用 `single-simd` 可以完整下一局

## 8. 回滚

- **代码**：Vercel/GitHub Pages 都能回退到上一个构建；
- **产物**：发布产物保留最近 3 个版本，`/engine/` 建议按版本分目录，回滚时改 `engine.json`；
- **npm**：不删除已发布版本，用 `npm deprecate` 标记问题版本并发布 patch。

相关：[快速开始](./getting-started.md) · [常见问题](./faq.md) · [基准数据](./benchmarks.md)
