---
layout: home

hero:
  name: pikafish-js
  text: 浏览器里的象棋引擎
  tagline: 基于 WebAssembly 的 Pikafish 前端包 · 纯前端人机对弈 · 本地局面分析 · 可离线运行
  actions:
    - theme: brand
      text: 阅读完整方案
      link: /plan/overview
    - theme: alt
      text: 技术调研
      link: /plan/research

features:
  - title: 真正的 Pikafish
    details: 不是简化版规则 AI。将官方 C++ 引擎与 NNUE 网络编译为 WebAssembly，在浏览器内运行完整棋力。
  - title: 零后端
    details: 引擎、规则与棋盘全部在本地运行。无需服务器、无需账号，对局数据不出浏览器。
  - title: 渐进增强
    details: 线程+SIMD、单线程+SIMD、单线程无 SIMD 三构建，按浏览器能力自动选择；三者都要求页面跨源隔离（COOP/COEP）。
  - title: 面向开发者
    details: 提供 Promise 化的 UCI 封装、流式分析、局面缓存与 TypeScript 类型，可嵌入任意 Web 应用。
  - title: 规则完整
    details: 覆盖将死、困毙、三次重复、自然限着与长将长捉裁决，遵循皮卡鱼《象棋程序竞赛规则》。
  - title: 开放
    details: 项目代码采用 AGPL-3.0-or-later；上游 Pikafish 为 GPL-3.0；NNUE 权重按自身声明使用，核心包不携带权重。
---

## 这是什么

`pikafish-js` 的目标是成为 **中国象棋领域的 stockfish.js**：把 [Pikafish](https://github.com/official-pikafish/Pikafish) 这颗强力的 UCI 象棋引擎装进浏览器，并提供一套稳定、可复用、对前端友好的 TypeScript API。

项目 v0.1 已实现：规则包、引擎包、演示站与三套 WASM 构建脚本均已落地。本网站既保留完整的技术方案（调研、架构、路线图、风险），也作为使用与部署说明。

<div class="tip custom-block" style="padding-top: 8px">

**阅读顺序建议**：先看 [方案总览](/plan/overview) 了解目标与关键决策，再看 [技术调研](/plan/research) 核对事实依据，最后阅读 [系统架构](/plan/architecture) 与 [路线图](/plan/roadmap)。

</div>

## 关键数字（来自 2026-10 的实测与上游资料）

| 指标 | 数值 | 来源 |
| --- | --- | --- |
| 引擎 wasm 体积 | 约 662 KB | `brianhliou/pikafish-wasm` v0.1.0 |
| NNUE 网络体积 | 约 48 MiB（当前官方 50,241,100 B） | 官方 `master-net`（2026-10-14） |
| 加载后内存 | 约 66 MiB（网络） | 参考实现实测 |
| 4 线程搜索速度 | 约 1.4 MNPS（Chromium） | 参考实现实测 |
| 停止响应 | 约 20 ms | 参考实现实测 |

> 这些数字会随硬件、浏览器与引擎版本变化。方案把“可重复的基准测试”列为里程碑验收项，而不是营销承诺。

## 项目边界

**做**：浏览器内人机对弈、局面分析、难度分级、棋谱与规则裁决、可嵌入的 npm 包与演示站。

**不做**：在线联机对战平台、服务器端引擎农场、比赛编排、作弊辅助、非象棋变体（如揭棋）支持。

## 许可证提示

引擎代码来自 Pikafish，上游采用 **GPL-3.0**；本项目代码采用 **AGPL-3.0-or-later**，二者可组合。NNUE 权重适用其自身声明，核心 npm 包不携带权重。演示站提供源代码入口。详见 [选型记录](/plan/decisions) 与 [风险与对策](/plan/risks)。
