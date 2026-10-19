# 贡献指南

先读这一页再动手。本项目有两个“不能碰坏”的东西：**引擎行为与上游一致**、**浏览器里真的能跑**。

## 环境

| 项目 | 要求 | 备注 |
| --- | --- | --- |
| Node.js | ≥ 20（CI 用 24） | |
| npm | ≥ 10 | 用 workspaces |
| Emscripten | **3.1.74** | 仅在需要重新编译 wasm 时 |
| Playwright 浏览器 | Chromium / Firefox / WebKit | `npx playwright install` |

Emscripten 版本必须精确匹配：换版本会改变 wasm 行为与体积，发布产物就不具备可复现性。

Windows 上如果 `emsdk_env.sh` 因控制台编码崩溃，可手动设置 `EMSDK`、`EM_CONFIG`、`EMSDK_NODE`、
`EMSDK_PYTHON` 并调用 `EMXX=em++.bat bash scripts/build-wasm.sh`。

## 常用命令

```bash
npm ci                  # 安装
npm run dev             # 演示站开发服务器（先构建两个包）
npm run test            # 单元测试（vitest）
npm run lint            # ESLint
npm run format:check    # Prettier 检查（只查代码）
npm run typecheck       # 各包 + e2e
npm run verify          # typecheck + test + build
npm run test:e2e        # 构建后跑浏览器矩阵
npm run site            # 组装三套 wasm 并构建演示站
npm run docs:dev        # 文档站
npm run bench           # 浏览器基准（需先 npm run site）
```

单个测试：

```bash
npx vitest run packages/rules/test/adjudication.test.ts
npx playwright test e2e/demo.spec.ts --grep "键盘"
```

## 目录

```text
packages/rules      @pikafish-js/rules  纯 TS 规则、裁决、记谱（无 Worker）
packages/engine     pikafish-js         Worker 协议、构建选择、权重、UCI 解析
apps/demo           演示站             Vite + 原生 DOM，自绘 SVG 棋盘
e2e                 Playwright 用例     两个本地服务器：隔离 / 无响应头
scripts             构建与校验脚本      wasm、权重、发布、基准、包内容、链接
patches             上游补丁            只允许最小入口，不得改搜索/评估逻辑
docs                中文文档            VitePress，纳管到 sidebar 才可发布
```

**不提交** wasm、NNUE 权重、`dist/`、`assets/` 与 `upstream/`。它们由脚本与 CI 产出。

## 改动类型与要求

| 改动 | 必须附带 |
| --- | --- |
| 规则、裁决、记谱 | 单测；边界输入（非法 FEN、非法着法、重复局面） |
| Worker 协议、权重加载 | 对应 e2e；失败路径（404、哈希不符、缓存损坏） |
| 演示站 UI | e2e；键盘可达性与 `aria` 不被破坏 |
| 构建参数 | 三套构建全部重编，更新 `engine.json` 的体积与 `.md` 里的实测数据 |
| 文档 | `node scripts/check-links.mjs` 通过；新页面加入 sidebar |

### 上游补丁

`patches/pikafish-wasm.patch` 只做三件事：导出 `pikafish_initialize`、把 `main()` 的初始化流程
拆成可重复调用的函数、让 `stderr` 可被重定向。**不得**修改搜索、评估、NNUE 加载逻辑——否则
“官方引擎”这个前提就不成立了。

升级上游时：

1. 改 `engine.json` 的 `upstream.commit`；
2. 重新生成补丁并确认只包含入口改动；
3. 重跑三套构建、规则回归、基准与浏览器冒烟；
4. 更新 `NOTICE` 与文档里的版本号。

## 代码风格

- TypeScript `strict`，公共 API 有类型与注释；避免 `any`，确实需要时写明原因。
- **代码注释用英文，文档与 UI 文案用中文**：注释面向维护者，文档面向使用者。
- 提交信息用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀，说明“为什么”而不是“改了什么”。
- Prettier 只格式化代码。`docs/**/*.md` 与 `README.md` 被排除，因为 Prettier 按字符数填充表格，
  会把手工对齐的中文表弄乱。改 Markdown 时对齐靠手，别跑 `prettier --write .` 覆盖它。
- 不要引入 `chessgroundx` / `xiangqiground`：自绘棋盘是设计决策，理由见
  [常见问题](/guide/faq)。

提交前 `lint-staged` 会对暂存的代码跑 ESLint + Prettier，CI 再跑一遍全量。

## 测试边界

- **单元测试**：规则包不碰 DOM，所有分支都应可测。
- **e2e**：Playwright 的 `workers: 1`、`fullyParallel: false`，因为每个用例都要起真实 wasm 与
  50 MB 权重。Chromium 跑全量，Firefox/WebKit 只跑 `@smoke`；`@stress` 默认排除。
- **基准**：只在同一台机器、同一 `movetime`、同一浏览器之间比较。跨环境数字没有意义，CI 的基线
  取“上一次成功运行”（见 `.github/workflows/bench.yml`）。

不要把“本机能跑”当验证：引擎的问题几乎都只在别人的浏览器里出现（隔离、CSP、worker 类型、缓存）。

## 提 Issue

- 引擎相关请附：`engine.info`（构建、线程、Hash）、`crossOriginIsolated`、浏览器与版本、
  操作系统、`stderr` 日志。
- 崩溃请附复现步骤与 FEN。
- 规则判定错误请附 FEN + 着法序列 + 期望结果，最好能写成一条单测。

标签约定：`area/engine`、`area/api`、`area/rules`、`area/ui`、`area/docs`，以及
`priority/high`、`priority/low`。维护者会补全，提交时不必纠结。

## 提 PR

1. 从 `main` 切分支，一个 PR 只做一件事；
2. 描述里写清背景、改动与**验证方式**（跑了哪些命令、哪些浏览器）；
3. UI 改动附截图或短视频；
4. CI 全绿再请求评审；`wasm` 与 `e2e` 任务只在相关路径变更时运行，若被跳过请在本地补跑并说明。

## 许可

提交即表示同意以 **AGPL-3.0-or-later** 发布你的贡献，并确认你有权这样做。上游 Pikafish 为
GPL-3.0，NNUE 权重适用其自身声明，详见 `NOTICE` 与[一手资料](/reference/sources)。
