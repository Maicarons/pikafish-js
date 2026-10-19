# 一手资料

> 访问日期：2026-10-19  
> 本页只列出来源；结论与引用见 [技术调研](/plan/research)。

## Pikafish 上游

| 资料 | 地址 |
| --- | --- |
| 源码仓库 | <https://github.com/official-pikafish/Pikafish> |
| Releases | <https://github.com/official-pikafish/Pikafish/releases> |
| 网络权重仓库 | <https://github.com/official-pikafish/Networks> |
| `master-net` 发布页 | <https://github.com/official-pikafish/Networks/releases/tag/master-net> |
| UCI 与命令 Wiki | <https://github.com/official-pikafish/Pikafish/wiki/UCI-&-Commands> |
| 编译 Wiki | <https://github.com/official-pikafish/Pikafish/wiki/Compiling-from-source> |
| 程序竞赛规则 | <https://pikafish.org/rule.html> |
| 官方网站 | <https://pikafish.org> |
| 许可证（GPL-3.0） | <https://github.com/official-pikafish/Pikafish/blob/master/Copying.txt> |

## 项目许可与部署

| 资料 | 地址 |
| --- | --- |
| GNU AGPL-3.0 | <https://www.gnu.org/licenses/agpl-3.0.html> |
| AGPL 与 GPLv3 的组合说明 | <https://www.gnu.org/licenses/agpl-3.0.html#section13> |
| Vercel 响应头配置 | <https://vercel.com/docs/project-configuration#headers> |
| GitHub Pages 自定义头限制 | <https://docs.github.com/pages> |

## 浏览器移植与 Stockfish 生态

| 资料 | 地址 | 用途 |
| --- | --- | --- |
| stockfish.js | <https://github.com/nmrugg/stockfish.js> | 构建矩阵、npm 分发、单线程/多线程经验 |
| lichess `stockfish-web` | <https://github.com/lichess-org/stockfish-web> | 生产级 ESM/pthread/SIMD 构建 |
| Pikafish WASM 参考实现 | <https://github.com/brianhliou/pikafish-wasm> | 已实测的 Pikafish 浏览器构建 |
| `coi-serviceworker` | <https://github.com/gzuidhof/coi-serviceworker> | 静态托管启用 COOP/COEP |
| `stockfish.wasm`（历史） | <https://github.com/lichess-org/stockfish.wasm> | 早期无共享内存构建 |
| Emscripten 文档 | <https://emscripten.org/docs/> | pthread、FS、模块参数 |

## 规范与浏览器能力

| 资料 | 地址 |
| --- | --- |
| WebAssembly SIMD 提案 | <https://github.com/WebAssembly/simd> |
| 跨源隔离指南（web.dev） | <https://web.dev/articles/cross-origin-isolation-guide> |
| MDN `SharedArrayBuffer` | <https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer> |
| MDN `crossOriginIsolated` | <https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated> |
| MDN `CacheStorage` | <https://developer.mozilla.org/docs/Web/API/CacheStorage> |
| VitePress 部署 | <https://vitepress.dev/guide/deploy> |

## 象棋前端生态

> 具体的库对比、维护状态与选型结论见 [技术调研](/plan/research)。以下为本次调研实际使用的一手来源。

| 类别 | 资料 | 地址 |
| --- | --- | --- |
| 棋盘 UI | chessground | <https://github.com/lichess-org/chessground> |
| 棋盘 UI | chessgroundx | <https://github.com/gbtami/chessgroundx> |
| 棋盘 UI | xiangqiground | <https://github.com/lucaferranti/xiangqiground> |
| 棋盘 UI | @weshell/xiangqiground | <https://www.npmjs.com/package/@weshell/xiangqiground> |
| 棋盘 UI | xiangqiboardjs | <https://github.com/lengyanyu258/xiangqiboardjs> |
| 棋盘 UI | react-xiangqiboard | <https://github.com/012e/react-xiangqiboard> |
| 规则/记谱 | elephantops | <https://github.com/lucaferranti/elephantops> |
| 规则/记谱 | xiangqi.js（lengyanyu258） | <https://github.com/lengyanyu258/xiangqi.js> |
| 规则/记谱 | @weshell/xiangqi.js | <https://www.npmjs.com/package/@weshell/xiangqi.js> |
| 规则/引擎参考 | xqwlight | <https://github.com/xqbase/xqwlight> |
| 开局库 | MRXqOpeningBook | <https://github.com/nguyenpham/MRXqOpeningBook> |
| 残局库 | FelicityEgtb | <https://github.com/nguyenpham/FelicityEgtb> |
| 云库 API | ChessDB | <https://www.chessdb.cn/cloudbookc_api_en.html> |
| 在线实现 | pychess | <https://github.com/pychess/pychess> |
| 在线实现 | mistboard 象棋分析 | <https://mistboard.com/analysis/xiangqi> |
| 在线实现 | 官方 Pikafish Web | <https://pikafish.com> |
| 可访问性 | WAI-ARIA APG Grid | <https://www.w3.org/WAI/ARIA/apg/patterns/grid/> |
| 可访问性 | WCAG 2.5.8 Target Size | <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html> |

## 引用原则

- 优先引用上游源码、官方文档、规范与实测记录。
- 性能数字必须注明设备、浏览器、版本与测试方法；没有上下文的速度数字不进入结论。
- 对无法核实的信息明确标注“未验证”，不把推测写成事实。
