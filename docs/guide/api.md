# API 参考

两个包各管一件事：

- **`pikafish-js`**：Worker 生命周期、UCI 协议、构建选择、权重下载与校验。
- **`@pikafish-js/rules`**：FEN、走子合法性、胜负判定、中文记谱。**不依赖 Worker**，可以在
  Node、Web Worker、主线程任何地方跑。

## `pikafish-js`

### `createEngine(options?): Promise<PikafishEngine>`

创建 Worker、加载 wasm、写入 NNUE 权重并完成 `uci`/`isready` 握手。成功后返回可用引擎。

```ts
import { createEngine } from 'pikafish-js';

const engine = await createEngine({
  netUrl: '/engine/pikafish.nnue',
  netSha256: 'bf3982…73ac',
  builds: {
    'single-simd': { js: '/engine/single-simd/pikafish.js', wasm: '/engine/single-simd/pikafish.wasm' },
  },
});
```

#### `PikafishOptions`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `build` | `'auto' \| BuildName` | `'auto'` | 指定构建；设备不支持时抛 `BUILD_UNAVAILABLE` |
| `builds` | `Partial<Record<BuildName, BuildAssets>>` | — | 三套构建的 JS/WASM URL |
| `variants` | `Record<string, EngineVariant>` | — | 具名引擎配置（各自的构建与权重） |
| `variant` | `string` | — | 选哪一套 `variants`；不填就用上面的 `builds` 与权重 |
| `jsUrl` / `wasmUrl` | `string` | — | 只提供一套构建时的简写 |
| `netUrl` | `string` | — | 权重 URL；与 `netData` 二选一 |
| `netData` | `ArrayBuffer \| Uint8Array` | — | 直接传入权重字节（自带分发） |
| `netSha256` | `string` | — | 权重 SHA-256；强烈建议提供 |
| `cacheNet` | `boolean` | 有 URL 且有 SHA 时 `true` | 写入 Cache Storage |
| `workerUrl` | `string \| URL` | 包内 `engine.worker.js` | 自定义 classic worker |
| `workerFactory` | `() => Worker` | — | 自己创建 worker（推荐） |
| `threads` | `number` | 按构建与设备 | 引擎线程数，会被安全上限裁剪 |
| `hashMB` | `number` | 按设备 | 置换表大小（MB） |
| `multiPV` | `number` | `1` | 候选着法数量 |
| `verifyNet` | `boolean` | `true` | 关闭后跳过 SHA-256 校验（不建议） |
| `debug` | `boolean` | `false` | 保留原始 UCI 行 |
| `onInfo` | `(info) => void` | — | 每条 `info` 的回调；流式接口优先 |
| `onLine` | `(line) => void` | — | 原始输出行 |
| `onNetProgress` | `(progress) => void` | — | `{ loaded, total, cached? }` |

权重来源二选一，都不给会抛 `NET_SOURCE_INVALID`：

```ts
// URL：走 Cache Storage，支持进度与离线
await createEngine({ netUrl: '/engine/pikafish.nnue', netSha256: sha });

// 自带分发：从 IndexedDB / 打包资源读出来的 ArrayBuffer
await createEngine({ netData: buffer, netSha256: sha });
```

#### 具名引擎配置（`variants`）

权重是跟**特征宽度**绑死的：L1=1024 的教师网和 L1=512 的蒸馏网不能互相加载，引擎会
按 arch hash 拒绝。所以「用哪张网」和「用哪套 wasm」必须一起决定，`variants` 就是把
这两样捆在一起：

```ts
const engine = await createEngine({
  variants: {
    strong: {
      builds: { 'single-simd': { js: '/engine/strong/single-simd/pikafish.js', wasm: '…' } },
      netUrl: '/engine/pikafish.nnue',
      netSha256: 'bf3982…73ac',
    },
    lite: {
      builds: { 'single-simd': { js: '/engine/lite/single-simd/pikafish.js', wasm: '…' } },
      netUrl: '/engine/pikafish-lite.nnue',
      netSha256: 'ac223f6d…97f',
    },
  },
  variant: 'lite',
});
```

`variant` 选中的那一套决定构建与权重；没写 `variants` 时行为与从前完全一样
（用顶层的 `builds` 与权重）。`engine.variant` 可以读回当前用的那一套的名字。

### `PikafishEngine`

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `info` | `ReadyInfo \| null` | 就绪后为 `{ build, threads, hashMB, netBytes, netCached }` |
| `isDisposed` | `boolean` | 是否已释放 |
| `debugLog` | `readonly string[]` | `debug: true` 时的原始日志 |
| `on` | `(event, listener) => () => void` | 返回取消订阅函数 |
| `off` | `(event, listener) => void` | 移除监听 |
| `setOption` | `(name, value) => Promise<void>` | 透传 UCI 选项，如 `'Threads'`、`'Hash'`、`'MultiPV'` |
| `ready` | `(timeoutMs?) => Promise<void>` | 等待 `readyok`，默认 15 s |
| `analyze` | `(params: GoParams) => Promise<SearchHandle>` | 流式搜索 |
| `play` | `(params: GoParams) => Promise<SearchResult>` | 等搜索结束，返回最佳着法 |
| `stop` | `() => void` | 停止当前搜索 |
| `dispose` | `() => void` | 终止 Worker、释放内存；之后一切调用抛 `DISPOSED` |

#### `GoParams`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `fen` | `string` | 必填，UCCI FEN |
| `moves` | `string[]` | 从 FEN 起继续走的历史着法 |
| `depth` | `number` | 深度上限 |
| `movetime` | `number` | 思考时间（ms） |
| `nodes` | `number` | 节点上限 |
| `infinite` | `boolean` | 无限分析，需手动 `stop()` |
| `multiPV` | `number` | 本次搜索的候选数 |
| `searchMoves` | `string[]` | 限制候选着法 |
| `signal` | `AbortSignal` | 中止后 `result` 以 `SEARCH_ABORTED` 拒绝 |

#### `SearchHandle`

```ts
const handle = await engine.analyze({ fen, depth: 22, multiPV: 3 });

// 1) 流式读取
for await (const info of handle.updates) {
  console.log(info.depth, info.score, info.pv);
}

// 2) 或等最终结果
const { bestmove, lastInfo, elapsedMs } = await handle.result;

// 3) 随时停止
handle.stop();
```

`updates` 在 `bestmove` 到达后自然结束；`result` 只解析一次，可以多次 `await`。

#### `AnalysisInfo`

`depth`、`seldepth`、`multipv`、`score`（`{ type: 'cp' | 'mate', value, bound? }`）、`wdl`、
`nodes`、`nps`、`hashfull`、`tbhits`、`time`、`pv`（UCCI 数组）、`currmove`、`string`、`raw`。
所有字段除 `raw` 外都可能缺省，UI 必须容错。

### 事件

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `ready` | `ReadyInfo` | 初始化完成 |
| `netprogress` | `NetProgress` | 权重下载/读取进度 |
| `info` | `AnalysisInfo` | 每条 `info` |
| `bestmove` | `SearchResult` | 搜索结束 |
| `line` | `string` | 原始输出行 |
| `stderr` | `string` | 引擎 stderr |
| `degraded` | `{ reason, build }` | 线程/内存被裁剪 |
| `error` | `PikafishError` | 任何异步错误 |

```ts
const off = engine.on('degraded', ({ reason }) => toast(reason));
off(); // 取消订阅
```

### 能力探测与构建选择

```ts
import { detectCapabilities, chooseBuild, buildLabel } from 'pikafish-js';

const caps = detectCapabilities();
// { webAssembly, simd, crossOriginIsolated, sharedArrayBuffer, hardwareConcurrency, deviceMemory? }

const build = chooseBuild(caps, { build: 'auto' });
console.log(buildLabel(build)); // 多线程 + SIMD
```

`chooseBuild` 在缺少隔离或 WebAssembly 时抛 `BUILD_UNAVAILABLE` / `UNSUPPORTED_ENV`，不会
静默降级。`recommendedThreads`、`recommendedHash`、`clampThreads`、`clampHash` 供 UI 显示
建议值。

### UCI 工具函数

| 函数 | 用途 |
| --- | --- |
| `parseInfoLine(line)` | 解析 `info …`，返回 `AnalysisInfo \| null` |
| `parseBestmove(line)` | 解析 `bestmove …`，返回 `{ bestmove, ponder? } \| null` |
| `validateFen(fen)` | 校验 FEN 形状 |
| `validateMove(move)` | 校验 UCCI 着法文本 |
| `AsyncQueue` | 库内部用的异步队列，可复用 |

### 错误

```ts
import { PikafishError } from 'pikafish-js';

try {
  await createEngine({ netUrl });
} catch (error) {
  if (error instanceof PikafishError) {
    switch (error.code) {
      case 'BUILD_UNAVAILABLE': /* 未隔离 */ break;
      case 'NET_LOAD_FAILED': /* 网络 */ break;
      default: report(error);
    }
  }
}
```

错误码：`UNSUPPORTED_ENV`、`BUILD_UNAVAILABLE`、`WORKER_ERROR`、`ASSET_LOAD_FAILED`、
`NET_SOURCE_INVALID`、`NET_LOAD_FAILED`、`NET_HASH_MISMATCH`、`NET_WRITE_FAILED`、
`ENGINE_INIT_FAILED`、`ENGINE_CRASHED`、`INVALID_FEN`、`INVALID_MOVE`、`INVALID_OPTION`、
`SEARCH_ABORTED`、`DISPOSED`。

### `pikafish-js/worker-runtime`

给“自己写 Worker 入口”的场景：在自建 worker 里 `import { startRuntime } from
'pikafish-js/worker-runtime'` 并调用 `startRuntime()`，然后 `importScripts` 加载 wasm 胶水
代码。大多数项目不需要它，直接用打包好的 `engine.worker.js` 即可。

## `@pikafish-js/rules`

### 坐标与 FEN

- 坐标 `a0`–`i9`，**rank 0 是红方底线**，rank 9 是黑方底线；红方在上、黑方在下与 UCCI 一致。
- FEN 与 UCCI 相同：第一段是 rank 9（黑方底线），`w`/`b` 表示行棋方。
- 初始局面 `START_FEN`：`rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1`。

```ts
import { parseFen, toFen, startPosition, pieceAt, boardKey, findKing } from '@pikafish-js/rules';

const position = parseFen(START_FEN);
const fen = toFen(position);
const redKing = findKing(position.board, 'w'); // { file: 4, rank: 0 }
```

`parseFen` 对非法输入抛 `RulesError`（来自 `board.ts`），不会构造半残棋盘。

### 走子

| 函数 | 说明 |
| --- | --- |
| `generateLegalMoves(position)` | 全部合法着法 |
| `legalMovesFrom(position, from)` | 某个棋子的合法着法 |
| `isLegalMove(position, move)` | 是否合法（含送将、将帅照面） |
| `applyMove(position, move)` | 返回新局面，不修改入参 |
| `isKingInCheck(position, color)` | 是否被将军 |
| `moveText(move)` / `moveFromText(position, text)` | `{ from, to }` ↔ `"b2e2"` |
| `parseUcci(text)` / `moveToUcci(move)` | 纯坐标转换，不做合法性判断 |

```ts
import { generateLegalMoves, isLegalMove, applyMove } from '@pikafish-js/rules';

const moves = generateLegalMoves(game.position); // 开局 44 步
applyMove(game.position, moves[0]!); // 不改原局面
```

### `Game`：带历史的对局

```ts
import { Game } from '@pikafish-js/rules';

const game = new Game();          // 或 new Game(fen)
game.moveUcci('b2e2');            // 炮二平五
game.move({ from: { file: 7, rank: 9 }, to: { file: 6, rank: 7 } });
game.undo();
game.status();                    // { over, result, reason, inCheck, legalMoves }
game.repetitionCount();
game.resign('w');
```

| 成员 | 说明 |
| --- | --- |
| `position` / `fen` / `turn` / `board` | 当前状态；`board` 是拷贝 |
| `history` | `MoveRecord[]`：`ucci`、`notation`、`piece`、`captured`、`check`、前后 FEN |
| `lastMove` | 最近一步或 `null` |
| `legalMoves()` / `legalMovesFrom(square)` / `isLegal(move)` | 合法性 |
| `isCheck(color?)` / `checkmate()` | 将军判断 |
| `move(move)` / `moveUcci(text)` | 落子，非法着法抛错；对局结束后抛 `over` |
| `undo()` | 撤销一步，返回被撤销的记录 |
| `resign(color)` | 认输 |
| `status()` | 带缓存的状态判定 |
| `repetitionCount()` | 当前局面（含行棋方）出现次数 |
| `clone()` | 深拷贝 |

`status()` 的 `reason` 取值：`checkmate`、`stalemate`、`repetition`、`perpetual-check`、
`sixty-move`、`insufficient`、`resign`、`timeout`。

判定规则（v0.1）：

- 将死、困毙均判负（象棋困毙算输，不是和棋）；
- 同一局面（含行棋方）出现三次：若某一方**每一步都在将军**，判该方负；否则判和；
- 120 个半回合无吃子判和；
- 只剩将（士象）判和。

### 中文记谱

```ts
import { toChineseNotation } from '@pikafish-js/rules';

toChineseNotation(game.position, { from: { file: 1, rank: 2 }, to: { file: 4, rank: 2 } });
// "炮二平五"
```

`moveWithCheckSuffix(notation, check, mate)` 负责追加 `+` / `#`。`Game` 返回的
`MoveRecord.notation` 已经包含后缀。

### 类型

`Color`（`'w' | 'b'`）、`PieceType`（`k a b n r c p`）、`Piece`、`Board`、`Square`、`Move`、
`Position`、`GameStatus`、`MoveRecord`，以及常量 `START_FEN`、`FILES`、`PIECE_NAMES`。

## 下一步

- [部署指南](./deployment.md)：COOP/COEP、Vercel、GitHub Pages、CSP
- [常见问题](./faq.md)：为什么必须隔离、权重为什么这么大、iOS 怎么办
- [基准数据](./benchmarks.md)：三套构建在各设备上的实测
