# 复盘：v0.1.0

这份复盘记录 v0.1 实际交付了什么、哪些数字是实测的、哪些地方偏离了计划，以及下一步该先做什么。
原则同路线图：**功能可裁剪，质量不可裁剪**。

## 1. 交付物

| 类别 | 内容 | 状态 |
| --- | --- | --- |
| 引擎 | 官方 Pikafish `545c4e3` + 最小 Emscripten 入口补丁，三套构建 | 完成，可复现 |
| 引擎包 | `pikafish-js`：Worker 协议、构建选择、权重下载/校验/缓存、流式分析 | 完成 |
| 规则包 | `@pikafish-js/rules`：FEN、走子生成、将死/困毙/重复/60 回合、中文记谱 | 完成 |
| 演示站 | 人机对弈、7 档难度、分析面板、提示、悔棋、翻转、键盘、无障碍、基准页 | 完成 |
| 部署 | Vercel（COOP/COEP + CSP）与 GitHub Pages（`coi-serviceworker`） | 代码完成，未在真实域名验证 |
| 测试 | 44 个单元测试 + 20 个 Chromium e2e + Firefox/WebKit 冒烟 | 全部通过 |
| CI | lint/format/typecheck/unit/build/docs；WASM 构建；e2e 矩阵；周基准 | 工作流已写，尚未在 Actions 上跑过 |
| 文档 | 方案、调研、架构、路线图、风险、术语、上手、API、部署、FAQ、基准、复盘 | 完成 |
| 许可 | AGPL-3.0-or-later + NOTICE；npm 包内随附许可证 | 完成 |

## 2. 实测结果

**性能**（Windows 11，`hardwareConcurrency = 12`，无头浏览器，`movetime 1000`）：

| 构建 | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| `threads-simd@4` | 1.38 M NPS | 1.56 M NPS | 1.01 M NPS |
| `single-simd@1` | 388 k | 425 k | 317 k |
| `single-nosimd@1` | 91 k | 95 k | 85 k |

初始化 0.5–1.3 s，深度 15–21 层。详见[基准数据](guide/benchmarks.md)。

**体积**：wasm 654–658 KB（gzip ≈236 KB），胶水 81 KB（gzip ≈22 KB），权重 50,241,100 B。
npm 包 47 KB（引擎）/ 27 KB（规则），不含权重。

**兼容性**：三套构建在 Chromium、Firefox、WebKit 均完成“加载 → 搜索 → 落子 → 引擎应招”；
GitHub Pages 形态（无响应头）经 Service Worker 恢复隔离后同样通过。

## 3. 偏离计划的地方

### 3.1 难度实现比草案简单

草案想让 L1–L3 用 MultiPV 混合弱着（“30% 概率选次优”）。实际实现只保留两条路径：

- L1：100 ms 思考后**从全部合法着法中随机**；
- L2–L7：`depth` + `movetime` 双上限，始终走最佳着法。

原因：浅层搜索本身就会送子，再叠加“随机选次优”会让失误显得莫名其妙，玩家分不清是“引擎弱”
还是“程序坏了”。简化后档位差异单调、可解释，代价是低档位偶尔会走出“太像人”的连贯着法。

档位循环赛校准（product.md §5.3）没有执行，记为 v0.2 事项。

### 3.2 长将/长捉按“循环即和”处理

路线图已明确：v0.1 里同一局面三次重复时，若一方每步都在将军则判负，否则判和；完整的“长捉”
分类留到 v0.2。官方 39 循环棋例测试套件同样顺延。

这不是“实现不了”，而是测试成本远高于收益：每个棋例都要逐着分类，错一个类别就会误判胜负。

### 3.3 WASM 与 e2e 任务晚于首版代码

路线图 §4.2 里 `wasm`/`e2e` 两个 CI 任务在 M4 之后才补上。代价是：在 `ci.yml` 只有
typecheck/unit/build 的那段时间，“三套构建都能跑”只能靠本地手测。现在这两个任务已写入，并按
路径过滤（只有触及引擎相关目录的 PR 才跑），但仍然**没有在真实 GitHub Actions 上执行过**。

### 3.4 基准回归用“上一次运行”而不是提交基线

原计划提交一份基准表作为基线。实际做法改成：每周任务下载**上一次成功运行**的 artifact 作为
基线。原因是跨机器的 NPS 差异（±20% 以上）会让提交的基线永远误报；同 runner 比较才有意义。
阈值 20% 只告警不失败。

## 4. 踩过的坑（值得写下来）

| 现象 | 根因 | 解法 |
| --- | --- | --- |
| `pthread_create()` 永久挂起 | `-sPTHREAD_POOL_SIZE` 不足，按需创建在主线程上死锁 | 三套构建都预分配线程池，`PTHREAD_POOL_SIZE_STRICT=2` |
| Vite 开发模式 worker 不打包 | classic worker 的 URL 入口不经过打包器 | 发布预打包 IIFE，用 `?url` 引入 |
| 页面能加载但引擎不启动 | 没有跨源隔离，`SharedArrayBuffer` 不存在 | 开发/生产都发 COOP/COEP；Pages 用 SW |
| 严格 CSP 下 wasm 编译被拒 | 缺 `'wasm-unsafe-eval'` | 构建时注入，开发模式不注入 |
| 两个页面共用的 chunk 叫 `engine.worker-*.js` | Rollup 按模块命名共享 chunk | `chunkFileNames: 'assets/chunk-[hash].js'` |
| 覆盖 `apps/demo/public/engine` 时报 `EBUSY` | Windows 上浏览器/开发服务器占用文件 | 先写 `.tmp` 再重命名，失败重试 |
| `emsdk_env.sh` 在中文 Windows 控制台崩溃 | `UnicodeEncodeError`（GBK） | 手动设置 `EMSDK`/`EM_CONFIG`/PATH，用 `em++.bat` |
| 分析开关点不到 | checkbox `opacity:0; pointer-events:none` | 点 `.switch-track`；同时补 `aria-label` |

## 5. 已知缺口

1. **没有远端仓库**：Pages/Vercel/Release 的完整链路、真实域名下的首次访问、Service Worker
   在 HTTPS 上的行为，都只在本地等价环境验证过。
2. **没有 iOS 真机**：WebKit 桌面版通过，但 iOS 的内存上限与后台回收策略更激进。
3. **没有 39 循环棋例套件**与长捉分类（v0.2）。
4. **npm 尚未发布**：包内容已验证（`check-pack`），但 `npm publish --provenance` 未执行。
5. **基准只在开发机与本地 Playwright 跑过**：CI runner 的数字还需要积累几周才有参考价值。
6. **没有真人对局数据**：难度曲线是设计出来的，不是调出来的。

## 6. 下一步（v0.2 建议顺序）

1. 建远端仓库 → 跑通 Pages/Vercel/Release → 打 `v0.1.0` tag → 发布 npm；
2. 39 循环棋例 + 长捉分类，先把规则正确性补齐；
3. 档位循环赛校准，用数据调 `LEVELS`；
4. iOS 真机与低端 Android 冒烟，补内存曲线；
5. 主变/局面保存（PGN/FEN 分享）、复盘视图；
6. 视需要提供更小的 NNUE 变体，并在文档里明确棋力差异。

## 7. 一点观察

真正花时间的不是“把引擎编译成 wasm”，而是让它**在别人的浏览器里可靠地跑起来**：隔离、CSP、
worker 类型、缓存校验、错误提示、移动端内存。这些在 Node 里跑分时完全看不见。

所以本项目的测试重点放在了浏览器矩阵与失败路径上（无隔离、权重下载失败、缓存损坏、构建缺失），
而不是再写一遍 movegen 的单元测试。规则包的 44 个测试里，重复局面、长将、非法输入这些“边界”
占了大半，也是同一个道理。
