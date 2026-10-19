import {
  Game,
  PIECE_NAMES,
  applyMove,
  isLegalMove,
  parseUcci,
  toChineseNotation,
  type Color,
  type Move,
  type MoveRecord,
  type Piece,
  type Square,
} from '@pikafish-js/rules';
import {
  buildLabel,
  createEngine,
  type AnalysisInfo,
  type PikafishEngine,
} from 'pikafish-js';
import './styles.css';

type Level = {
  name: string;
  depth: number;
  movetime: number;
  random?: boolean;
};

const LEVELS: Level[] = [
  { name: '入门 · 随机走子', depth: 1, movetime: 100, random: true },
  { name: '轻松 · 1 层', depth: 1, movetime: 180 },
  { name: '业余 · 3 层', depth: 3, movetime: 350 },
  { name: '进阶 · 5 层', depth: 5, movetime: 700 },
  { name: '高手 · 8 层', depth: 8, movetime: 1400 },
  { name: '大师 · 12 层', depth: 12, movetime: 2600 },
  { name: '特级大师 · 16 层', depth: 16, movetime: 5000 },
];

interface BuildManifest {
  js: string;
  wasm: string;
}

interface EngineManifest {
  version: string;
  upstreamCommit: string;
  emsdk: string;
  net: { url: string; size: number; sha256: string };
  builds: Record<string, BuildManifest>;
}

const MARGIN = 60;
const CELL = 97.5;
const BOARD_WIDTH = 900;
const BOARD_HEIGHT = 1000;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <div class="page">
    <header class="topbar">
      <a class="brand" href="./" aria-label="返回首页">
        <span class="brand-seal" aria-hidden="true">象</span>
        <span class="brand-text">
          <strong>Pikafish 象棋</strong>
          <small>浏览器内的中国象棋引擎</small>
        </span>
      </a>
      <div class="topbar-right">
        <span class="pill" id="netPill"><span class="pill-dot"></span>引擎加载中</span>
        <a class="icon-link" href="https://github.com/official-pikafish/Pikafish" target="_blank" rel="noreferrer" title="Pikafish 上游源码">GPL</a>
      </div>
    </header>

    <div id="errorBanner" class="error-banner" hidden>
      <span id="errorText"></span>
      <button id="retryButton" class="text-button" type="button">重新加载</button>
    </div>

    <main class="layout">
      <section class="panel board-panel" aria-label="棋盘">
        <div class="board-topline">
          <div class="player-chip" id="blackChip">
            <span class="chip-dot black"></span>
            <span>黑方</span>
          </div>
          <div class="turn-label" id="turnLabel">红方行棋</div>
          <div class="player-chip" id="redChip">
            <span>红方</span>
            <span class="chip-dot red"></span>
          </div>
        </div>

        <div class="board-frame">
          <div id="board" class="board" role="grid" aria-label="中国象棋棋盘"></div>
        </div>

        <div class="board-footer">
          <div class="status-line">
            <span id="statusDot" class="status-dot"></span>
            <span id="statusText">正在准备棋盘…</span>
          </div>
          <div class="board-tools">
            <button id="undoButton" class="tool-button" type="button">悔棋</button>
            <button id="hintButton" class="tool-button" type="button">提示</button>
            <button id="flipButton" class="tool-button" type="button">翻转</button>
          </div>
        </div>
      </section>

      <aside class="sidebar">
        <section class="panel">
          <div class="panel-heading">
            <h2>对局</h2>
            <span id="moveCount" class="subtle">0 回合</span>
          </div>
          <label class="field">
            <span>难度</span>
            <select id="difficulty"></select>
          </label>
          <div class="field">
            <span>执子</span>
            <div class="segmented" id="sideToggle" role="group" aria-label="选择执子颜色">
              <button type="button" data-side="w">红方</button>
              <button type="button" data-side="b">黑方</button>
            </div>
          </div>
          <button id="newGame" class="primary-button" type="button">新开一局</button>
        </section>

        <section class="panel">
          <div class="panel-heading">
            <h2>引擎</h2>
            <span id="engineBadge" class="badge">加载中</span>
          </div>
          <dl class="stats">
            <div><dt>构建</dt><dd id="statBuild">—</dd></div>
            <div><dt>线程</dt><dd id="statThreads">—</dd></div>
            <div><dt>置换表</dt><dd id="statHash">—</dd></div>
            <div><dt>NNUE</dt><dd id="statNet">—</dd></div>
          </dl>
          <p id="engineNote" class="muted">首次加载需要下载约 48 MB 的 NNUE 权重，之后会优先从缓存读取。</p>
        </section>

        <section class="panel">
          <div class="panel-heading">
            <h2>分析</h2>
            <label class="switch" title="开启实时分析">
              <input id="analysisToggle" type="checkbox" />
              <span class="switch-track"><span class="switch-thumb"></span></span>
            </label>
          </div>
          <div class="eval-line">
            <strong id="evalValue">--</strong>
            <span id="evalMeta" class="subtle">等待引擎</span>
          </div>
          <div id="pvList" class="pv-list">
            <p class="muted">开启分析后显示引擎主变。</p>
          </div>
        </section>

        <section class="panel moves-panel">
          <div class="panel-heading">
            <h2>棋谱</h2>
            <span id="resultBadge" class="badge result-badge" hidden></span>
          </div>
          <div id="moveList" class="move-list">
            <p class="muted">尚未行棋</p>
          </div>
        </section>
      </aside>
    </main>

    <footer class="footer">
      <span>Pikafish WebAssembly · 浏览器内推理，不发送棋局数据</span>
      <span class="footer-links">
        <a href="https://github.com/official-pikafish/Pikafish" target="_blank" rel="noreferrer">上游引擎</a>
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">AGPL-3.0</a>
        <a href="/docs/" target="_blank" rel="noreferrer">项目文档</a>
      </span>
    </footer>

    <div id="toast" class="toast" hidden role="status"></div>

    <div id="loadingOverlay" class="loading-overlay">
      <div class="loading-card">
        <span class="loading-seal" aria-hidden="true">象</span>
        <h2>正在加载 Pikafish</h2>
        <p id="loadingText">正在下载 NNUE 权重…</p>
        <div class="progress-track"><span id="progressBar" class="progress-bar"></span></div>
        <small id="loadingDetail">首次加载约 48 MB，之后会从缓存读取。</small>
      </div>
    </div>
  </div>
`;

const boardEl = must<HTMLDivElement>('#board');
const turnLabel = must<HTMLDivElement>('#turnLabel');
const statusText = must<HTMLSpanElement>('#statusText');
const statusDot = must<HTMLSpanElement>('#statusDot');
const netPill = must<HTMLSpanElement>('#netPill');
const redChip = must<HTMLDivElement>('#redChip');
const blackChip = must<HTMLDivElement>('#blackChip');
const moveCount = must<HTMLSpanElement>('#moveCount');
const moveList = must<HTMLDivElement>('#moveList');
const resultBadge = must<HTMLSpanElement>('#resultBadge');
const engineBadge = must<HTMLSpanElement>('#engineBadge');
const statBuild = must<HTMLElement>('#statBuild');
const statThreads = must<HTMLElement>('#statThreads');
const statHash = must<HTMLElement>('#statHash');
const statNet = must<HTMLElement>('#statNet');
const engineNote = must<HTMLParagraphElement>('#engineNote');
const evalValue = must<HTMLElement>('#evalValue');
const evalMeta = must<HTMLSpanElement>('#evalMeta');
const pvList = must<HTMLDivElement>('#pvList');
const analysisToggle = must<HTMLInputElement>('#analysisToggle');
const difficultySelect = must<HTMLSelectElement>('#difficulty');
const sideToggle = must<HTMLDivElement>('#sideToggle');
const undoButton = must<HTMLButtonElement>('#undoButton');
const hintButton = must<HTMLButtonElement>('#hintButton');
const flipButton = must<HTMLButtonElement>('#flipButton');
const newGameButton = must<HTMLButtonElement>('#newGame');
const errorBanner = must<HTMLDivElement>('#errorBanner');
const errorText = must<HTMLSpanElement>('#errorText');
const retryButton = must<HTMLButtonElement>('#retryButton');
const toastEl = must<HTMLDivElement>('#toast');
const loadingOverlay = must<HTMLDivElement>('#loadingOverlay');
const loadingText = must<HTMLParagraphElement>('#loadingText');
const loadingDetail = must<HTMLElement>('#loadingDetail');
const progressBar = must<HTMLSpanElement>('#progressBar');

let game = new Game();
let playerColor: Color = loadPreference<Color>('side', 'w') === 'b' ? 'b' : 'w';
let difficulty = clamp(loadPreference<number>('difficulty', 4), 1, LEVELS.length);
let flipped = playerColor === 'b';
let selected: Square | null = null;
let legalTargets: Move[] = [];
let hintMove: Move | null = null;
let engine: PikafishEngine | null = null;
let engineReady = false;
let thinking = false;
let analysisOn = false;
let analysisRows = new Map<number, AnalysisInfo>();
let latestInfo: AnalysisInfo | null = null;
let activeAbort: AbortController | null = null;
let analysisAbort: AbortController | null = null;
let analysisFrame = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

difficultySelect.innerHTML = LEVELS.map(
  (level, index) => `<option value="${index + 1}">${level.name}</option>`,
).join('');
difficultySelect.value = String(difficulty);
analysisToggle.checked = analysisOn;

boardEl.addEventListener('click', event => {
  const target = (event.target as Element | null)?.closest<HTMLButtonElement>('.square');
  if (!target) return;
  onSquare({
    file: Number(target.dataset.file),
    rank: Number(target.dataset.rank),
  });
});

difficultySelect.addEventListener('change', () => {
  difficulty = clamp(Number(difficultySelect.value), 1, LEVELS.length);
  savePreference('difficulty', difficulty);
  renderStatus();
});

sideToggle.addEventListener('click', event => {
  const target = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-side]');
  if (!target) return;
  const side = target.dataset.side;
  if (side !== 'w' && side !== 'b') return;
  if (side === playerColor) return;
  playerColor = side;
  flipped = side === 'b';
  savePreference('side', side);
  startNewGame();
});

undoButton.addEventListener('click', () => {
  if (thinking) return;
  stopAllSearches();
  if (!game.history.length) return;
  game.undo();
  while (game.history.length > 0 && game.turn !== playerColor) game.undo();
  selected = null;
  legalTargets = [];
  hintMove = null;
  analysisRows.clear();
  latestInfo = null;
  render();
  if (game.turn !== playerColor) void maybeEngineMove(180);
});

hintButton.addEventListener('click', () => {
  void showHint();
});

flipButton.addEventListener('click', () => {
  flipped = !flipped;
  renderBoard();
});

newGameButton.addEventListener('click', () => {
  startNewGame();
});

analysisToggle.addEventListener('change', () => {
  analysisOn = analysisToggle.checked;
  if (analysisOn) {
    void startAnalysis();
  } else {
    stopAnalysis();
    analysisRows.clear();
    latestInfo = null;
    renderAnalysis();
  }
});

retryButton.addEventListener('click', () => location.reload());

render();
void bootEngine();

async function bootEngine(): Promise<void> {
  setLoading('正在读取引擎清单…', 'engine/engine.json');
  try {
    await ensureIsolation();
    const manifestUrl = new URL('engine/engine.json', document.baseURI);
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`引擎清单加载失败：HTTP ${response.status}`);
    const manifest = (await response.json()) as EngineManifest;
    const netUrl = new URL(manifest.net.url, document.baseURI).href;

    setLoading('正在初始化 WebAssembly…', `${manifest.builds ? '三个构建可用' : ''}`);
    engine = await createEngine({
      builds: manifest.builds,
      netUrl,
      netSha256: manifest.net.sha256,
      workerFactory: () =>
        new Worker(new URL('./engine.worker.ts', import.meta.url), {
          type: 'classic',
          name: 'pikafish-engine',
        }),
      onNetProgress: progress => updateNetProgress(progress),
    });

    engineReady = true;
    engine.on('degraded', event => toast(event.reason));
    engine.on('error', error => showError(error.message));
    engine.on('stderr', line => {
      if (line.includes('ERROR') || line.includes('CRITICAL')) showError(line);
    });

    loadingOverlay.hidden = true;
    render();
    if (playerColor === 'b') void maybeEngineMove(260);
    if (analysisOn) void startAnalysis();
  } catch (error) {
    loadingOverlay.hidden = true;
    showError(error instanceof Error ? error.message : String(error));
    engineBadge.textContent = '不可用';
    netPill.innerHTML = '<span class="pill-dot off"></span>引擎不可用';
    renderStatus();
  }
}

function onSquare(square: Square): void {
  if (thinking || game.status().over) return;
  if (game.turn !== playerColor) return;

  if (selected) {
    const move = legalTargets.find(
      candidate =>
        candidate.to.file === square.file && candidate.to.rank === square.rank,
    );
    if (move) {
      commitMove(move);
      return;
    }
  }

  const piece = game.position.board[square.rank]?.[square.file] ?? null;
  if (piece?.color === playerColor && piece.color === game.turn) {
    selected = square;
    legalTargets = game.legalMovesFrom(square);
  } else {
    selected = null;
    legalTargets = [];
  }
  renderBoard();
}

function commitMove(move: Move): void {
  stopAnalysis();
  activeAbort?.abort();
  activeAbort = null;
  hintMove = null;
  if (hintTimer) clearTimeout(hintTimer);
  game.move(move);
  selected = null;
  legalTargets = [];
  analysisRows.clear();
  latestInfo = null;
  render();
  if (!game.status().over && game.turn !== playerColor) void maybeEngineMove(180);
}

async function maybeEngineMove(delayMs: number): Promise<void> {
  if (!engine || !engineReady || thinking || game.status().over || game.turn === playerColor) return;
  await sleep(delayMs);
  if (!engine || thinking || game.status().over || game.turn === playerColor) return;
  await engineMove();
}

async function engineMove(): Promise<void> {
  if (!engine || game.status().over || game.turn === playerColor || thinking) return;
  const currentGame = game;
  const level = LEVELS[difficulty - 1] ?? LEVELS[3]!;
  thinking = true;
  selected = null;
  legalTargets = [];
  renderStatus();
  renderControls();

  try {
    if (level.random) {
      await sleep(320);
      const moves = currentGame.legalMoves();
      const move = moves[Math.floor(Math.random() * moves.length)];
      if (move) currentGame.move(move);
      finishEngineMove(currentGame);
      return;
    }

    const controller = new AbortController();
    activeAbort = controller;
    analysisRows.clear();
    const handle = await engine.analyze({
      fen: currentGame.fen,
      depth: level.depth,
      movetime: level.movetime,
      signal: controller.signal,
    });

    for await (const info of handle.updates) {
      if (controller.signal.aborted) break;
      latestInfo = info;
      analysisRows.set(1, info);
      scheduleAnalysisRender();
      renderStatus(info);
    }

    const result = await handle.result;
    if (controller.signal.aborted) return;
    if (result.bestmove === '(none)') {
      finishEngineMove(currentGame);
      return;
    }
    const move = parseUcci(result.bestmove);
    if (!move || !currentGame.isLegal(move)) {
      throw new Error(`引擎返回了非法着法：${result.bestmove}`);
    }
    currentGame.move(move);
    finishEngineMove(currentGame);
  } catch (error) {
    if (!isAbortError(error)) showError(error instanceof Error ? error.message : String(error));
  } finally {
    if (activeAbort) activeAbort = null;
    thinking = false;
    render();
    if (analysisOn) void startAnalysis();
  }
}

function finishEngineMove(currentGame: Game): void {
  if (game !== currentGame) return;
  thinking = false;
  latestInfo = null;
  analysisRows.clear();
  render();
}

async function startAnalysis(): Promise<void> {
  if (!analysisOn || !engine || !engineReady || thinking || game.status().over) return;
  stopAnalysis();
  const controller = new AbortController();
  analysisAbort = controller;
  const currentGame = game;

  try {
    const handle = await engine.analyze({
      fen: currentGame.fen,
      depth: 22,
      multiPV: 3,
      signal: controller.signal,
    });
    for await (const info of handle.updates) {
      if (controller.signal.aborted || game !== currentGame) break;
      latestInfo = info;
      analysisRows.set(info.multipv ?? 1, info);
      scheduleAnalysisRender();
    }
  } catch (error) {
    if (!isAbortError(error)) showError(error instanceof Error ? error.message : String(error));
  } finally {
    if (analysisAbort === controller) analysisAbort = null;
  }
}

function stopAnalysis(): void {
  analysisAbort?.abort();
  analysisAbort = null;
  if (analysisFrame) {
    cancelAnimationFrame(analysisFrame);
    analysisFrame = 0;
  }
}

function stopAllSearches(): void {
  activeAbort?.abort();
  analysisAbort?.abort();
  activeAbort = null;
  analysisAbort = null;
  thinking = false;
  engine?.stop();
}

async function showHint(): Promise<void> {
  if (!engine || !engineReady || thinking || game.status().over) return;
  stopAnalysis();
  thinking = true;
  selected = null;
  legalTargets = [];
  renderStatus();
  renderControls();

  try {
    const handle = await engine.analyze({
      fen: game.fen,
      depth: 12,
      movetime: 1200,
    });
    for await (const info of handle.updates) {
      latestInfo = info;
      analysisRows.set(1, info);
      scheduleAnalysisRender();
    }
    const result = await handle.result;
    const move = parseUcci(result.bestmove);
    if (move) {
      hintMove = move;
      renderBoard();
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => {
        hintMove = null;
        renderBoard();
      }, 6000);
    }
  } catch (error) {
    if (!isAbortError(error)) showError(error instanceof Error ? error.message : String(error));
  } finally {
    thinking = false;
    renderStatus();
    renderControls();
    if (analysisOn) void startAnalysis();
  }
}

function startNewGame(): void {
  stopAllSearches();
  game = new Game();
  selected = null;
  legalTargets = [];
  hintMove = null;
  analysisRows.clear();
  latestInfo = null;
  if (hintTimer) clearTimeout(hintTimer);
  if (game.turn !== playerColor) {
    // Engine plays Red before the player gets the first move.
    void maybeEngineMove(300);
  }
  render();
}

function render(): void {
  renderBoard();
  renderStatus();
  renderControls();
  renderEngine();
  renderMoveList();
  renderAnalysis();
}

function renderBoard(): void {
  const last = game.lastMove;
  const checkColor = game.status().over ? null : game.turn;
  const squares: string[] = [];

  for (let rank = 0; rank < 10; rank++) {
    for (let file = 0; file < 9; file++) {
      const piece = game.position.board[rank]?.[file] ?? null;
      const displayFile = flipped ? 8 - file : file;
      const displayRank = flipped ? rank : 9 - rank;
      const left = ((MARGIN + displayFile * CELL) / BOARD_WIDTH) * 100;
      const top = ((MARGIN + displayRank * CELL) / BOARD_HEIGHT) * 100;
      const isSelected = selected?.file === file && selected.rank === rank;
      const isTarget = legalTargets.some(
        move => move.to.file === file && move.to.rank === rank,
      );
      const isLastFrom =
        last?.move.from.file === file && last?.move.from.rank === rank;
      const isLastTo = last?.move.to.file === file && last?.move.to.rank === rank;
      const isHintFrom =
        hintMove?.from.file === file && hintMove?.from.rank === rank;
      const isHintTo = hintMove?.to.file === file && hintMove?.to.rank === rank;
      const isCheck =
        !!piece &&
        piece.type === 'k' &&
        piece.color === checkColor &&
        game.isCheck(piece.color);

      const classes = [
        'square',
        isSelected ? 'selected' : '',
        isTarget ? (piece ? 'can-capture' : 'can-move') : '',
        isLastFrom ? 'last-from' : '',
        isLastTo ? 'last-to' : '',
        isHintFrom ? 'hint-from' : '',
        isHintTo ? 'hint-to' : '',
        isCheck ? 'in-check' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const label = piece
        ? `${piece.color === 'w' ? '红' : '黑'}${PIECE_NAMES[piece.type].red} ${squareLabel(file, rank)}`
        : `空 ${squareLabel(file, rank)}`;
      const legalLabel = isTarget ? '，可以走到' : '';
      squares.push(`
        <button
          type="button"
          class="${classes}"
          data-file="${file}"
          data-rank="${rank}"
          style="left:${left.toFixed(4)}%;top:${top.toFixed(4)}%"
          aria-label="${label}${legalLabel}"
        >
          ${piece ? `<span class="piece ${piece.color === 'w' ? 'red' : 'black'}">${PIECE_NAMES[piece.type].red}</span>` : ''}
          ${isTarget && !piece ? '<span class="move-dot"></span>' : ''}
        </button>
      `);
    }
  }

  boardEl.innerHTML = `
    <svg class="board-lines" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}" aria-hidden="true">
      ${renderBoardLines()}
      ${last ? renderMoveMarks(last) : ''}
      ${hintMove ? renderHintArrow(hintMove) : ''}
    </svg>
    <div class="squares">${squares.join('')}</div>
  `;
}

function renderBoardLines(): string {
  const right = MARGIN + 8 * CELL;
  const bottom = MARGIN + 9 * CELL;
  const lines: string[] = [];

  for (let rank = 0; rank < 10; rank++) {
    const y = MARGIN + rank * CELL;
    lines.push(`<line x1="${MARGIN}" y1="${y}" x2="${right}" y2="${y}" />`);
  }

  for (let file = 0; file < 9; file++) {
    const x = MARGIN + file * CELL;
    if (file === 0 || file === 8) {
      lines.push(`<line x1="${x}" y1="${MARGIN}" x2="${x}" y2="${bottom}" />`);
    } else {
      lines.push(`<line x1="${x}" y1="${MARGIN}" x2="${x}" y2="${MARGIN + 4 * CELL}" />`);
      lines.push(`<line x1="${x}" y1="${MARGIN + 5 * CELL}" x2="${x}" y2="${bottom}" />`);
    }
  }

  const palace = (topRank: number) => {
    const y1 = MARGIN + topRank * CELL;
    const y2 = MARGIN + (topRank + 2) * CELL;
    const x1 = MARGIN + 3 * CELL;
    const x2 = MARGIN + 5 * CELL;
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`);
    lines.push(`<line x1="${x2}" y1="${y1}" x2="${x1}" y2="${y2}" />`);
  };
  palace(0);
  palace(7);

  const riverY = MARGIN + 4.5 * CELL;
  lines.push(`<text class="river-text" x="${MARGIN + 1.5 * CELL}" y="${riverY}">楚 河</text>`);
  lines.push(`<text class="river-text" x="${MARGIN + 6.5 * CELL}" y="${riverY}">汉 界</text>`);

  for (const [file, rank] of [
    [1, 2],
    [7, 2],
    [1, 7],
    [7, 7],
  ] as const) {
    const x = MARGIN + file * CELL;
    const y = MARGIN + (9 - rank) * CELL;
    lines.push(`
      <g class="position-mark">
        <path d="M ${x - 12} ${y - 4} v -8 h 8 M ${x + 4} ${y - 12} h 8 v 8" />
        <path d="M ${x - 12} ${y + 4} v 8 h 8 M ${x + 4} ${y + 12} h 8 v -8" />
      </g>
    `);
  }

  return lines.join('');
}

function renderMoveMarks(record: MoveRecord): string {
  const from = boardPoint(record.move.from);
  const to = boardPoint(record.move.to);
  return `
    <circle class="last-move-ring" cx="${from.x}" cy="${from.y}" r="38" />
    <circle class="last-move-ring target" cx="${to.x}" cy="${to.y}" r="38" />
  `;
}

function renderHintArrow(move: Move): string {
  const from = boardPoint(move.from);
  const to = boardPoint(move.to);
  return `
    <line class="hint-arrow" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />
    <circle class="hint-arrow-head" cx="${to.x}" cy="${to.y}" r="12" />
  `;
}

function boardPoint(square: Square): { x: number; y: number } {
  const displayFile = flipped ? 8 - square.file : square.file;
  const displayRank = flipped ? square.rank : 9 - square.rank;
  return {
    x: MARGIN + displayFile * CELL,
    y: MARGIN + displayRank * CELL,
  };
}

function renderStatus(info?: AnalysisInfo): void {
  const status = game.status();
  const turnName = game.turn === 'w' ? '红方' : '黑方';

  redChip.classList.toggle('active', !status.over && game.turn === 'w');
  blackChip.classList.toggle('active', !status.over && game.turn === 'b');
  turnLabel.textContent = status.over
    ? '对局结束'
    : thinking
      ? '引擎思考中'
      : `${turnName}行棋`;

  statusDot.className = 'status-dot';
  if (thinking) {
    statusDot.classList.add('thinking');
    const depthText = info?.depth ? ` · 深度 ${info.depth}` : '';
    statusText.textContent = `引擎思考中${depthText}`;
  } else if (status.over) {
    statusDot.classList.add(status.result === 'draw' ? 'draw' : 'over');
    statusText.textContent = resultSentence(status.result, status.reason);
  } else if (status.inCheck) {
    statusDot.classList.add('check');
    statusText.textContent = `${turnName}被将军`;
  } else {
    statusText.textContent = game.lastMove
      ? `上一步 ${game.lastMove.notation}`
      : '红方先行，点击棋子开始';
  }

  moveCount.textContent = `${Math.ceil(game.history.length / 2)} 回合`;
  resultBadge.hidden = !status.over;
  if (status.over) {
    resultBadge.textContent = resultSentence(status.result, status.reason);
  }
}

function renderControls(): void {
  for (const button of sideToggle.querySelectorAll<HTMLButtonElement>('[data-side]')) {
    button.classList.toggle('active', button.dataset.side === playerColor);
  }
  undoButton.disabled = thinking || game.history.length === 0;
  hintButton.disabled = !engineReady || thinking || game.status().over;
  analysisToggle.disabled = !engineReady;
  boardEl.classList.toggle('locked', thinking || game.status().over || game.turn !== playerColor);
}

function renderEngine(): void {
  if (!engineReady || !engine) {
    engineBadge.textContent = '加载中';
    netPill.innerHTML = '<span class="pill-dot"></span>引擎加载中';
    return;
  }
  const info = engine.info;
  engineBadge.textContent = buildLabel(engine.build);
  netPill.innerHTML = `<span class="pill-dot ok"></span>引擎就绪`;
  statBuild.textContent = buildLabel(engine.build);
  statThreads.textContent = `${info?.threads ?? 1} 线程`;
  statHash.textContent = `${info?.hashMB ?? 0} MB`;
  const bytes = info?.netBytes ?? 0;
  statNet.textContent = `${formatBytes(bytes)}${info?.netCached ? ' · 缓存' : ''}`;
  engineNote.textContent = info?.netCached
    ? 'NNUE 权重来自浏览器缓存，本次没有重新下载。'
    : 'NNUE 权重已写入浏览器缓存，下次打开会更快。';
}

function renderMoveList(): void {
  if (!game.history.length) {
    moveList.innerHTML = '<p class="muted">尚未行棋</p>';
    return;
  }
  const rows: string[] = [];
  for (let index = 0; index < game.history.length; index += 2) {
    const red = game.history[index];
    const black = game.history[index + 1];
    rows.push(`
      <div class="move-row">
        <span class="move-number">${index / 2 + 1}</span>
        <span class="move-cell">${red ? moveCell(red) : ''}</span>
        <span class="move-cell">${black ? moveCell(black) : ''}</span>
      </div>
    `);
  }
  moveList.innerHTML = rows.join('');
  moveList.scrollTop = moveList.scrollHeight;
}

function moveCell(record: MoveRecord): string {
  return `<span class="move-notation">${escapeHtml(record.notation)}</span><span class="move-ucci">${record.ucci}</span>`;
}

function renderAnalysis(): void {
  const rows = [...analysisRows.entries()].sort((a, b) => a[0] - b[0]).slice(0, 3);
  const primary = rows[0]?.[1] ?? latestInfo;

  if (!primary) {
    evalValue.textContent = '--';
    evalMeta.textContent = engineReady ? '等待分析' : '引擎加载中';
    pvList.innerHTML = '<p class="muted">开启分析后显示引擎主变。</p>';
    return;
  }

  evalValue.textContent = formatScore(primary);
  const nps = primary.nps ? ` · ${formatNps(primary.nps)}` : '';
  const depth = primary.depth ? `深度 ${primary.depth}` : '分析中';
  evalMeta.textContent = `${depth}${nps}`;

  pvList.innerHTML = rows
    .map(([index, info]) => {
      const pv = pvToChinese(info.pv);
      return `
        <div class="pv-row">
          <span class="pv-index">${index}</span>
          <span class="pv-score">${formatScore(info)}</span>
          <span class="pv-moves">${escapeHtml(pv || '计算中…')}</span>
        </div>
      `;
    })
    .join('');
}

function scheduleAnalysisRender(): void {
  if (analysisFrame) return;
  analysisFrame = requestAnimationFrame(() => {
    analysisFrame = 0;
    renderAnalysis();
  });
}

function pvToChinese(pv: string[] | undefined): string {
  if (!pv?.length) return '';
  let position = game.position;
  const parts: string[] = [];
  for (const ucci of pv.slice(0, 10)) {
    const move = parseUcci(ucci);
    if (!move || !isLegalMove(position, move)) break;
    parts.push(toChineseNotation(position, move));
    position = applyMove(position, move);
  }
  return parts.join(' ');
}

function formatScore(info: AnalysisInfo): string {
  const score = info.score;
  if (!score) return '--';
  if (score.type === 'mate') {
    if (score.value === 0) return '杀';
    return `${score.value > 0 ? '+' : '−'}M${Math.abs(score.value)}`;
  }
  const value = score.value / 100;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatNps(nps: number): string {
  if (nps >= 1_000_000) return `${(nps / 1_000_000).toFixed(2)}M n/s`;
  if (nps >= 1_000) return `${(nps / 1_000).toFixed(0)}K n/s`;
  return `${nps} n/s`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function resultSentence(result: 'red' | 'black' | 'draw' | null, reason: string | null): string {
  if (!result) return '对局进行中';
  const winner = result === 'draw' ? '和棋' : result === 'red' ? '红方胜' : '黑方胜';
  const reasonText: Record<string, string> = {
    checkmate: '将死',
    stalemate: '困毙',
    repetition: '三次重复',
    'perpetual-check': '长将判负',
    'sixty-move': '自然限着',
    insufficient: '子力不足',
    resign: '认输',
    timeout: '超时',
  };
  return reason ? `${winner} · ${reasonText[reason] ?? reason}` : winner;
}

function squareLabel(file: number, rank: number): string {
  return `${'abcdefghi'[file]}${rank}`;
}

function updateNetProgress(progress: { loaded: number; total: number; cached?: boolean }): void {
  const total = progress.total || 0;
  const percent = total > 0 ? Math.min(100, (progress.loaded / total) * 100) : 0;
  progressBar.style.width = `${percent.toFixed(1)}%`;
  if (progress.cached) {
    loadingText.textContent = '正在读取缓存的 NNUE 权重…';
    loadingDetail.textContent = `${formatBytes(progress.loaded)}，无需重新下载`;
  } else {
    loadingText.textContent = '正在下载 NNUE 权重…';
    loadingDetail.textContent = total
      ? `${formatBytes(progress.loaded)} / ${formatBytes(total)}`
      : `${formatBytes(progress.loaded)}`;
  }
}

function setLoading(text: string, detail: string): void {
  loadingText.textContent = text;
  loadingDetail.textContent = detail;
}

function showError(message: string): void {
  errorText.textContent = message;
  errorBanner.hidden = false;
  loadingOverlay.hidden = true;
  toast(message, true);
}

function toast(message: string, error = false): void {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', error);
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, error ? 8000 : 4000);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'SEARCH_ABORTED')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureIsolation(): Promise<void> {
  if (crossOriginIsolated) return;
  if ('serviceWorker' in navigator) {
    // coi-serviceworker installs on the first visit and reloads once it takes
    // control; give it a moment before failing.
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', finish);
        resolve();
      };
      const timer = setTimeout(finish, 4000);
      navigator.serviceWorker.addEventListener('controllerchange', finish);
    });
  }
  if (!crossOriginIsolated) {
    throw new Error(
      '引擎需要跨源隔离（COOP/COEP）。请使用 Vercel 部署，或允许 coi-serviceworker 注册后刷新页面。',
    );
  }
}

function loadPreference<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`pikafish:${key}`);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(`pikafish:${key}`, JSON.stringify(value));
  } catch {
    // Private mode or storage disabled.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export {};
