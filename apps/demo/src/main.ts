import {
  Game,
  PIECE_NAMES,
  applyMove,
  inBounds,
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
  type BuildAssets,
  type BuildName,
  type BuildSelection,
  type EngineVariant,
  type PikafishEngine,
  type ReadyInfo,
} from 'pikafish-js';
import { registerIsolationWorker } from './isolation.js';
// The engine host must be a *classic* worker: the Emscripten glue is loaded
// with `importScripts`, which module workers do not provide. A classic worker
// entry cannot be bundled by Vite's dev server, so we load the prebuilt,
// self-contained `engine.worker.js` that ships with the engine package.
// `?url` keeps it a plain asset, preserving the IIFE in production builds too.
import engineWorkerUrl from 'pikafish-js/engine.worker.js?url';
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

// Three WASM builds are shipped (see engine.json): the multi-threaded one is
// fastest but needs the most memory, the others are for weaker devices. `auto`
// picks by SIMD support and device memory.
const BUILD_CHOICES: Array<{ value: BuildSelection; label: string }> = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'threads-simd', label: buildLabel('threads-simd') },
  { value: 'single-simd', label: buildLabel('single-simd') },
  { value: 'single-nosimd', label: buildLabel('single-nosimd') },
];

// `?build=single-simd` wins over the stored preference so a link (or a test) can
// pin the build without touching localStorage.
function resolveBuildChoice(): BuildSelection {
  const requested = new URLSearchParams(location.search).get('build');
  const stored = requested ?? loadPreference<string>('build', 'auto');
  return BUILD_CHOICES.some((choice) => choice.value === stored)
    ? (stored as BuildSelection)
    : 'auto';
}

interface BuildManifest {
  js: string;
  wasm: string;
  bytes?: number;
}

interface EngineManifestEntry {
  label: string;
  netLabel: string;
  net: { url: string; size: number; sha256: string };
  builds: Record<string, BuildManifest>;
}

interface EngineManifest {
  version: string;
  upstreamCommit: string;
  emsdk: string;
  engines: Record<string, EngineManifestEntry>;
}

// The engine variant picks the weights, and with them the WebAssembly build:
// a net is only valid for the width it was trained for.  `strong` is the
// official 50 MB net, `lite` the distilled 25 MB one.
//
// The distilled net is the default: it is half the download and about a
// hundred Elo behind, which no human player will ever notice.  `?variant=`
// wins over the stored preference so a link (or a test) can pin it.
type VariantChoice = string;

function resolveVariantChoice(available: string[]): VariantChoice {
  const requested = new URLSearchParams(location.search).get('variant');
  const stored = requested ?? loadPreference<string>('variant', 'lite');
  if (available.includes(stored)) return stored;
  return available.includes('lite') ? 'lite' : (available[0] ?? 'strong');
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
          <div
            id="board"
            class="board"
            role="group"
            aria-label="中国象棋棋盘"
            aria-describedby="boardHelp"
          ></div>
        </div>

        <p id="boardHelp" class="visually-hidden">
          方向键在棋盘上移动焦点，回车或空格选择棋子与落子，Esc 取消选择。快捷键：U 悔棋、N 新开一局、H 提示、F 翻转。
        </p>

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
          <label class="field">
            <span>网络</span>
            <select id="engineSelect"></select>
          </label>
          <label class="field">
            <span>构建</span>
            <select id="buildSelect"></select>
          </label>
          <p class="muted tiny">切换网络或构建会重新加载页面；网络与构建是一套的，不能混用。</p>
          <dl class="stats">
            <div><dt>构建</dt><dd id="statBuild">—</dd></div>
            <div><dt>线程</dt><dd id="statThreads">—</dd></div>
            <div><dt>置换表</dt><dd id="statHash">—</dd></div>
            <div><dt>NNUE</dt><dd id="statNet">—</dd></div>
          </dl>
          <p id="engineNote" class="muted">首次加载需要下载 NNUE 权重，之后会优先从缓存读取。</p>
        </section>

        <section class="panel">
          <div class="panel-heading">
            <h2>分析</h2>
            <label class="switch" title="开启实时分析">
              <input id="analysisToggle" type="checkbox" aria-label="实时分析" />
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
        <a href="https://github.com/Maicarons/pikafish-js" target="_blank" rel="noreferrer">项目源码</a>
        <a href="https://github.com/official-pikafish/Pikafish" target="_blank" rel="noreferrer">上游引擎</a>
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">AGPL-3.0</a>
        <a href="bench.html">基准测试</a>
        <a href="docs/" target="_blank" rel="noreferrer">项目文档</a>
      </span>
    </footer>

    <div id="toast" class="toast" hidden role="status"></div>

    <p id="srStatus" class="visually-hidden" aria-live="polite"></p>

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
const buildSelect = must<HTMLSelectElement>('#buildSelect');
const engineSelect = must<HTMLSelectElement>('#engineSelect');
const srStatus = must<HTMLElement>('#srStatus');

let game = new Game();
let playerColor: Color = loadPreference<Color>('side', 'w') === 'b' ? 'b' : 'w';
let difficulty = clamp(loadPreference<number>('difficulty', 4), 1, LEVELS.length);
const buildChoice: BuildSelection = resolveBuildChoice();
let variantChoice: VariantChoice = 'strong';
const engineLabels: Record<string, string> = {};
let flipped = playerColor === 'b';
let selected: Square | null = null;
// Roving tabindex: exactly one square is tabbable, and the arrow keys move it so
// the whole board is reachable without 90 tab stops.
let focusSquare: Square = { file: 4, rank: playerColor === 'w' ? 0 : 9 };
let boardFocused = false;
let lastAnnouncement = '';
let legalTargets: Move[] = [];
let hintMove: Move | null = null;
let engine: PikafishEngine | null = null;
let engineReady = false;
let thinking = false;
let analysisOn = false;
const analysisRows = new Map<number, AnalysisInfo>();
let latestInfo: AnalysisInfo | null = null;
let activeAbort: AbortController | null = null;
let analysisAbort: AbortController | null = null;
let analysisFrame = 0;
let statusFrame = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

difficultySelect.innerHTML = LEVELS.map(
  (level, index) => `<option value="${index + 1}">${level.name}</option>`,
).join('');
difficultySelect.value = String(difficulty);
buildSelect.innerHTML = BUILD_CHOICES.map(
  (choice) => `<option value="${choice.value}">${choice.label}</option>`,
).join('');
buildSelect.value = buildChoice;
analysisToggle.checked = analysisOn;

boardEl.addEventListener('click', (event) => {
  const target = (event.target as Element | null)?.closest<HTMLButtonElement>('.square');
  if (!target) return;
  onSquare({
    file: Number(target.dataset.file),
    rank: Number(target.dataset.rank),
  });
});

// The squares are buttons, so Enter and Space already fire `click`; this only
// has to move the roving tabindex. Arrow directions follow what the user sees,
// which is why the step flips with the board.
boardEl.addEventListener('keydown', (event) => {
  const target = (event.target as Element | null)?.closest<HTMLButtonElement>('.square');
  if (!target) return;
  const file = Number(target.dataset.file);
  const rank = Number(target.dataset.rank);
  const step = flipped ? -1 : 1;
  let next: Square | null = null;

  if (event.key === 'ArrowRight') next = { file: file + step, rank };
  else if (event.key === 'ArrowLeft') next = { file: file - step, rank };
  else if (event.key === 'ArrowUp') next = { file, rank: rank + step };
  else if (event.key === 'ArrowDown') next = { file, rank: rank - step };
  else if (event.key === 'Escape') {
    selected = null;
    legalTargets = [];
    renderBoard();
    announce('已取消选择');
    return;
  }

  if (!next || !inBounds(next) || next.file > 8) return;
  event.preventDefault();
  focusSquare = next;
  focusSquareElement(next);
});

boardEl.addEventListener('focusin', () => {
  boardFocused = true;
});
boardEl.addEventListener('focusout', () => {
  boardFocused = false;
});

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  switch (event.key.toLowerCase()) {
    case 'u':
      undoButton.click();
      break;
    case 'n':
      newGameButton.click();
      break;
    case 'h':
      hintButton.click();
      break;
    case 'f':
      flipButton.click();
      break;
    case 'escape':
      // Escape must also work when focus is not on a square (e.g. on a button).
      if (selected) {
        selected = null;
        legalTargets = [];
        renderBoard();
        announce('已取消选择');
      }
      break;
    default:
  }
});

buildSelect.addEventListener('change', () => {
  const value = buildSelect.value as BuildSelection;
  savePreference('build', value);
  const url = new URL(location.href);
  if (value === 'auto') url.searchParams.delete('build');
  else url.searchParams.set('build', value);
  // The build is decided while the engine worker boots, so switching means a
  // fresh page (the cached NNUE weights are reused).
  location.assign(url.href);
});

engineSelect.addEventListener('change', () => {
  const value = engineSelect.value;
  savePreference('variant', value);
  const url = new URL(location.href);
  url.searchParams.set('variant', value);
  // The weights and the WebAssembly build go together, so switching means a
  // fresh page as well.
  location.assign(url.href);
});

difficultySelect.addEventListener('change', () => {
  difficulty = clamp(Number(difficultySelect.value), 1, LEVELS.length);
  savePreference('difficulty', difficulty);
  renderStatus();
});

sideToggle.addEventListener('click', (event) => {
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
registerIsolationWorker();
void bootEngine();

async function bootEngine(): Promise<void> {
  setLoading('正在检查运行环境…', '跨源隔离（COOP/COEP）与 SharedArrayBuffer');
  try {
    await ensureIsolation();
    setLoading('正在读取引擎清单…', 'engine/engine.json');
    const manifestUrl = new URL('engine/engine.json', document.baseURI);
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`引擎清单加载失败：HTTP ${response.status}`);
    const manifest = (await response.json()) as EngineManifest;
    const available = Object.keys(manifest.engines);
    if (!available.length) throw new Error('引擎清单里没有可用的引擎。');
    variantChoice = resolveVariantChoice(available);
    engineSelect.innerHTML = available
      .map((name) => {
        const spec = manifest.engines[name];
        if (!spec) return '';
        return `<option value="${name}">${spec.label} · ${spec.netLabel}（${formatBytes(
          spec.net.size,
        )}）</option>`;
      })
      .join('');
    engineSelect.value = variantChoice;

    const variants: Record<string, EngineVariant> = {};
    for (const [name, spec] of Object.entries(manifest.engines)) {
      engineLabels[name] = spec.netLabel;
      variants[name] = {
        builds: spec.builds as Partial<Record<BuildName, BuildAssets>>,
        netUrl: new URL(spec.net.url, document.baseURI).href,
        netSha256: spec.net.sha256,
      };
    }

    setLoading('正在初始化 WebAssembly…', `${available.length} 套引擎可用`);
    engine = await createEngine({
      variants,
      variant: variantChoice,
      build: buildChoice,
      workerFactory: () =>
        new Worker(engineWorkerUrl, {
          type: 'classic',
          name: 'pikafish-engine',
        }),
      onNetProgress: (progress) => updateNetProgress(progress),
    });

    engineReady = true;
    engine.on('degraded', (event) => toast(event.reason));
    engine.on('error', (error) => showError(error.message));
    engine.on('stderr', (line) => {
      if (line.includes('ERROR') || line.includes('CRITICAL')) showError(line);
    });

    loadingOverlay.hidden = true;
    render();
    announce(`引擎就绪：${buildLabel(engine.build)}`);
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
      (candidate) => candidate.to.file === square.file && candidate.to.rank === square.rank,
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
  announceMove('落子 ');
  if (!game.status().over && game.turn !== playerColor) void maybeEngineMove(180);
}

async function maybeEngineMove(delayMs: number): Promise<void> {
  if (!engine || !engineReady || thinking || game.status().over || game.turn === playerColor)
    return;
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
      finishEngineMove(currentGame, Boolean(move));
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
      scheduleStatusRender();
    }

    const result = await handle.result;
    if (controller.signal.aborted) return;
    if (result.bestmove === '(none)') {
      finishEngineMove(currentGame, false);
      return;
    }
    const move = parseUcci(result.bestmove);
    if (!move || !currentGame.isLegal(move)) {
      throw new Error(`引擎返回了非法着法：${result.bestmove}`);
    }
    currentGame.move(move);
    finishEngineMove(currentGame, true);
  } catch (error) {
    if (!isAbortError(error)) showError(error instanceof Error ? error.message : String(error));
  } finally {
    if (activeAbort) activeAbort = null;
    thinking = false;
    render();
    if (analysisOn) void startAnalysis();
  }
}

function finishEngineMove(currentGame: Game, moved: boolean): void {
  if (game !== currentGame) return;
  thinking = false;
  latestInfo = null;
  analysisRows.clear();
  render();
  if (moved) announceMove('引擎走 ');
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
      announce(`提示：${toChineseNotation(game.position, move)}`);
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
  focusSquare = { file: 4, rank: playerColor === 'w' ? 0 : 9 };
  announce('已开始新的一局');
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
      const isFocus = focusSquare.file === file && focusSquare.rank === rank;
      const isTarget = legalTargets.some((move) => move.to.file === file && move.to.rank === rank);
      const isLastFrom = last?.move.from.file === file && last?.move.from.rank === rank;
      const isLastTo = last?.move.to.file === file && last?.move.to.rank === rank;
      const isHintFrom = hintMove?.from.file === file && hintMove?.from.rank === rank;
      const isHintTo = hintMove?.to.file === file && hintMove?.to.rank === rank;
      const isCheck =
        !!piece && piece.type === 'k' && piece.color === checkColor && game.isCheck(piece.color);

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
        ? `${piece.color === 'w' ? '红' : '黑'}${pieceGlyph(piece)} ${squareLabel(file, rank)}`
        : `空 ${squareLabel(file, rank)}`;
      const legalLabel = isTarget ? '，可以走到' : '';
      squares.push(`
        <button
          type="button"
          class="${classes}"
          data-file="${file}"
          data-rank="${rank}"
          tabindex="${isFocus ? '0' : '-1'}"
          style="left:${left.toFixed(4)}%;top:${top.toFixed(4)}%"
          aria-label="${label}${isSelected ? '，已选中' : ''}${legalLabel}"
        >
          ${piece ? `<span class="piece ${piece.color === 'w' ? 'red' : 'black'}">${pieceGlyph(piece)}</span>` : ''}
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

  // Re-rendering replaces every square, so a keyboard user would lose their
  // place after each move; put the focus back where it was.
  if (boardFocused) {
    boardEl
      .querySelector<HTMLButtonElement>('.square[tabindex="0"]')
      ?.focus({ preventScroll: true });
  }
}

function focusSquareElement(square: Square): void {
  boardEl.querySelector<HTMLButtonElement>('.square[tabindex="0"]')?.setAttribute('tabindex', '-1');
  const target = boardEl.querySelector<HTMLButtonElement>(
    `.square[data-file="${square.file}"][data-rank="${square.rank}"]`,
  );
  if (!target) return;
  target.setAttribute('tabindex', '0');
  target.focus({ preventScroll: true });
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

// Red and black use different glyphs for the same piece type (帅/将, 仕/士,
// 相/象, 兵/卒); `PIECE_NAMES` already carries both.
function pieceGlyph(piece: Piece): string {
  return PIECE_NAMES[piece.type][piece.color === 'w' ? 'red' : 'black'];
}

function renderStatus(info?: AnalysisInfo): void {
  const status = game.status();
  const turnName = game.turn === 'w' ? '红方' : '黑方';

  redChip.classList.toggle('active', !status.over && game.turn === 'w');
  blackChip.classList.toggle('active', !status.over && game.turn === 'b');
  turnLabel.textContent = status.over ? '对局结束' : thinking ? '引擎思考中' : `${turnName}行棋`;

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
    const active = button.dataset.side === playerColor;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
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
  const label = engineLabels[engine.variant];
  statNet.textContent = `${label ? `${label} · ` : ''}${formatBytes(bytes)}${
    info?.netCached ? ' · 缓存' : ''
  }`;
  engineNote.textContent = info?.netCached
    ? 'NNUE 权重来自浏览器缓存，本次没有重新下载。'
    : `首次加载下载了 ${formatBytes(bytes)} 的 NNUE 权重，已写入浏览器缓存，下次打开会更快。`;
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

// Engine `info` lines arrive far faster than the display refreshes, so status
// updates are coalesced into one render per animation frame.
function scheduleStatusRender(): void {
  if (statusFrame) return;
  statusFrame = requestAnimationFrame(() => {
    statusFrame = 0;
    renderStatus(latestInfo ?? undefined);
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
  announce(`错误：${message}`);
}

// Screen readers get one polite message per meaningful event. The visible status
// line is not a live region on purpose: it changes on every engine `info` line.
function announce(message: string): void {
  if (message === lastAnnouncement) return;
  lastAnnouncement = message;
  srStatus.textContent = message;
}

function announceMove(prefix: string): void {
  const status = game.status();
  const notation = game.lastMove?.notation ?? '';
  const suffix = status.over
    ? `，${resultSentence(status.result, status.reason)}`
    : status.inCheck
      ? '，将军'
      : '';
  announce(`${prefix}${notation}${suffix}`);
}

function toast(message: string, error = false): void {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', error);
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toastEl.hidden = true;
    },
    error ? 8000 : 4000,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'SEARCH_ABORTED')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The GitHub Pages shape cannot be isolated on the first visit: the worker
// registers, takes control and reloads.  Control arrives a moment before that
// reload, and the reload discards this script, so what has to be waited for is
// isolation itself rather than `controllerchange` — otherwise a machine where
// the worker activates just under the deadline shows the error instead of the
// reloaded, isolated page.
async function ensureIsolation(): Promise<void> {
  if (crossOriginIsolated) return;

  // Local, not module level: this function runs from the bootstrap at the top
  // of the module, before any `const` further down has been initialised.
  const timeoutMs = 15_000;

  // Without `serviceWorker` no reload is coming, so there is nothing to wait for.
  const deadline = Date.now() + (navigator.serviceWorker ? timeoutMs : 0);
  while (!crossOriginIsolated && Date.now() < deadline) {
    await sleep(100);
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
  return value.replace(/[&<>"']/g, (char) => {
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

// Read-only state hook for the end-to-end tests and the stress script. It is
// deliberately observation-only: tests drive the UI the way a user does, this
// just saves them from scraping the DOM to assert what happened.
Object.defineProperty(window, '__pikafish', {
  configurable: true,
  value: Object.freeze({
    get ready(): boolean {
      return engineReady;
    },
    get build(): string | null {
      return engine?.build ?? null;
    },
    get buildChoice(): BuildSelection {
      return buildChoice;
    },
    get variant(): string {
      return variantChoice;
    },
    get variantChoice(): string {
      return variantChoice;
    },
    get fen(): string {
      return game.fen;
    },
    get turn(): Color {
      return game.turn;
    },
    get thinking(): boolean {
      return thinking;
    },
    get playerColor(): Color {
      return playerColor;
    },
    get difficulty(): number {
      return difficulty;
    },
    get history(): string[] {
      return game.history.map((record) => record.ucci);
    },
    get selected(): Square | null {
      return selected;
    },
    get hint(): Move | null {
      return hintMove;
    },
    get status(): ReturnType<Game['status']> {
      return game.status();
    },
    get engineInfo(): ReadyInfo | null {
      return engine?.info ?? null;
    },
    get boardFocused(): boolean {
      return boardFocused;
    },
  }),
});

export {};
