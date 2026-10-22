---
layout: home

hero:
  name: pikafish-js
  text: 浏览器里的象棋引擎
  tagline: 基于 WebAssembly 的 Pikafish 前端包 · 纯前端人机对弈 · 本地局面分析 · 可离线运行
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 阅读完整方案
      link: /plan/overview

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
    details: 覆盖将死、困毙（判负）、三次重复、自然限着与子力不足；长将判负，完整的长捉分类留待 v0.2。
  - title: 开放
    details: 项目代码采用 AGPL-3.0-or-later；上游 Pikafish 为 GPL-3.0；NNUE 权重按自身声明使用，核心包不携带权重。
---

## 这是什么

`pikafish-js` 的目标是成为 **中国象棋领域的 stockfish.js**：把 [Pikafish](https://github.com/official-pikafish/Pikafish) 这颗强力的 UCI 象棋引擎装进浏览器，并提供一套稳定、可复用、对前端友好的 TypeScript API。

项目 v0.1 已实现：规则包、引擎包、演示站与三套 WASM 构建脚本均已落地。本网站既保留完整的技术方案（调研、架构、路线图、风险），也作为使用与部署说明。

<div class="tip custom-block" style="padding-top: 8px">

**想先跑起来**：直接看 [快速开始](/guide/getting-started)，30 分钟就能在自己的页面里下第一步棋。
**想先了解取舍**：从 [方案总览](/plan/overview) 开始，再看 [技术调研](/plan/research) 与
[系统架构](/plan/architecture)。

</div>

## 使用指南

| 文档 | 内容 |
| --- | --- |
| [快速开始](/guide/getting-started) | 准备构建产物、配置跨源隔离、创建引擎、落子，附常见错误对照表 |
| [API 参考](/guide/api) | 两个包的完整接口、事件、错误码与示例 |
| [部署指南](/guide/deployment) | Vercel、GitHub Pages、自托管的响应头、缓存与 CSP |
| [常见问题](/guide/faq) | 为什么必须隔离、两张网怎么选、手机与 iOS 怎么办 |
| [基准数据](/guide/benchmarks) | 六套构建在 Chromium、Firefox、WebKit 上的实测与复现方法 |

## 关键数字

**本项目实测（2026-10，Windows + Chromium，起始局面按 `movetime 3000` 搜索）**

| 指标 | 数值 |
| --- | --- |
| wasm 体积 | 654–658 KB（六套构建，gzip 约 230 KB）；另需约 81 KB JS 胶水 |
| NNUE 网络 | 官方 `master-net` 47.9 MiB（50,241,100 B，SHA-256 钉死）；本仓库蒸馏的 L1=512 网 24.0 MiB（25,136,309 B） |
| 首屏权重下载 | 默认蒸馏网约 24 MB；切回强力约 48 MB |
| 4 线程搜索 | 约 1.2–1.4 MNPS（depth 22–23，3.6–4.2 M 节点） |
| 单线程搜索 | 约 230–280 k NPS（depth 21–23）；无 SIMD 兼容构建约 38–41 k NPS |
| 引擎初始化 | 约 0.6–1.1 s（网络已缓存） |
| 演示站首屏 JS | 45 KB（gzip 16 KB），不含引擎与网络 |
| 六个构建 | 都已实测跑通 `uci → position → go → bestmove`；演示站页脚“基准测试”页面可复现全部数字 |

**上游与社区参考**：官方 Pikafish 仓库以 GPL-3.0 发布 C++ 源码；社区参考实现给出
662 KB wasm、约 50 MB 网络、4 线程约 1.4 MNPS（Chromium）的量级，与本项目实测同阶。

> 这些数字会随硬件、浏览器与引擎版本变化。方案把“可重复的基准测试”列为里程碑验收项，
> 而不是营销承诺。单线程 230–235 k NPS 略低于原定的 250 k 目标，已在[路线图](/plan/roadmap)
> 中如实标注。

## 项目边界

**做**：浏览器内人机对弈、局面分析、难度分级、棋谱与规则裁决、可嵌入的 npm 包与演示站。

**不做**：在线联机对战平台、服务器端引擎农场、比赛编排、作弊辅助、非象棋变体（如揭棋）支持。

## 许可证提示

引擎代码来自 Pikafish，上游采用 **GPL-3.0**；本项目代码采用 **AGPL-3.0-or-later**，二者可组合。NNUE 权重适用其自身声明，核心 npm 包不携带权重。演示站提供源代码入口。详见 [选型记录](/plan/decisions) 与 [风险与对策](/plan/risks)。
