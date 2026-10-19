# @pikafish-js/rules

自研 TypeScript 中国象棋规则包：FEN、合法着法、将军/将死/困毙、三次重复、120 半回合自然限着、子力不足和棋、中文记谱。

```ts
import { Game, START_FEN } from '@pikafish-js/rules';

const game = new Game(START_FEN);
const moves = game.legalMoves();
game.moveUcci('h2e2');
console.log(game.fen, game.status());
```

坐标约定：`rank 0` 是红方底线，`rank 9` 是黑方底线；UCCI 形如 `h2e2`。
