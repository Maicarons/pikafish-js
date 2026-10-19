import { AsyncQueue } from './async-queue.js';
import {
  buildGoCommand,
  buildPositionCommand,
  formatOption,
  parseBestmove,
  parseInfoLine,
  validateFen,
  validateMove,
} from './uci.js';
import {
  clampHash,
  clampThreads,
  chooseBuild,
  detectCapabilities,
} from './capabilities.js';
import type {
  AnalysisInfo,
  BuildAssets,
  BuildName,
  Capabilities,
  EngineErrorCode,
  EngineEvent,
  EngineEventMap,
  GoParams,
  PikafishOptions,
  ReadyInfo,
  SearchHandle,
  SearchResult,
} from './types.js';
import { PikafishError } from './types.js';
import type { MainToWorker, WorkerNetSource, WorkerToMain } from './worker/protocol.js';

interface SearchState {
  id: number;
  queue: AsyncQueue<AnalysisInfo>;
  infos: AnalysisInfo[];
  lastInfo: AnalysisInfo | null;
  resolve: (result: SearchResult) => void;
  reject: (error: unknown) => void;
  result: Promise<SearchResult>;
  startedAt: number;
  aborted: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResolvedNet {
  workerNet: WorkerNetSource;
  transfer: Transferable[];
}

export class PikafishEngine {
  readonly capabilities: Capabilities;
  readonly build: BuildName;
  private worker: Worker;
  private readyInfo: ReadyInfo | null = null;
  private disposed = false;
  private currentSearch: SearchState | null = null;
  private staleSearches: SearchState[] = [];
  private searchId = 0;
  private readyWaiters: ReadyWaiter[] = [];
  private initResolve: ((info: ReadyInfo) => void) | null = null;
  private initReject: ((error: unknown) => void) | null = null;
  private initPromise: Promise<ReadyInfo> | null = null;
  private listeners = new Map<EngineEvent, Set<(payload: never) => void>>();
  private debugLines: string[] = [];
  private options: PikafishOptions;

  private constructor(worker: Worker, options: PikafishOptions, build: BuildName, capabilities: Capabilities) {
    this.worker = worker;
    this.options = options;
    this.build = build;
    this.capabilities = capabilities;
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
  }

  static async create(options: PikafishOptions = {}): Promise<PikafishEngine> {
    if (typeof Worker === 'undefined') {
      throw new PikafishError('Web Workers are required to run Pikafish.', 'UNSUPPORTED_ENV');
    }
    const capabilities = detectCapabilities();
    const build = chooseBuild(capabilities, options);
    const assets = resolveAssets(options, build);
    const net = resolveNet(options);

    let worker: Worker;
    try {
      if (options.workerFactory) {
        worker = options.workerFactory();
      } else {
        const workerUrl =
          options.workerUrl ?? new URL(/* @vite-ignore */ './engine.worker.js', import.meta.url);
        worker = new Worker(workerUrl, { type: 'classic', name: 'pikafish-engine' });
      }
    } catch (error) {
      throw new PikafishError('Failed to create the Pikafish worker.', 'WORKER_ERROR', error);
    }

    const engine = new PikafishEngine(worker, options, build, capabilities);
    try {
      await engine.initialize(assets, net);
      return engine;
    } catch (error) {
      engine.dispose();
      throw error;
    }
  }

  static isSupported(): boolean {
    return typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
  }

  get info(): ReadyInfo | null {
    return this.readyInfo;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get debugLog(): readonly string[] {
    return this.debugLines;
  }

  on<K extends EngineEvent>(event: K, listener: (payload: EngineEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => this.off(event, listener);
  }

  off<K extends EngineEvent>(event: K, listener: (payload: EngineEventMap[K]) => void): void {
    this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  async setOption(name: string, value: string | number | boolean): Promise<void> {
    this.assertAlive();
    this.command(formatOption(name, value));
    await this.ready();
  }

  async ready(timeoutMs = 15000): Promise<void> {
    this.assertAlive();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.readyWaiters.findIndex(waiter => waiter.timer === timer);
        if (index >= 0) this.readyWaiters.splice(index, 1);
        reject(new PikafishError('Timed out waiting for readyok.', 'ENGINE_INIT_FAILED'));
      }, timeoutMs);
      this.readyWaiters.push({ resolve, reject, timer });
      this.command('isready');
    });
  }

  async analyze(params: GoParams): Promise<SearchHandle> {
    this.assertAlive();
    validateFen(params.fen);
    for (const move of params.moves ?? []) validateMove(move);
    for (const move of params.searchMoves ?? []) validateMove(move);

    if (!params.depth && !params.movetime && !params.nodes && !params.infinite) {
      params = { ...params, depth: 12 };
    }
    if (params.signal?.aborted) {
      throw new PikafishError('Search aborted before it started.', 'SEARCH_ABORTED');
    }

    await this.cancelCurrent();
    await this.setOption('MultiPV', params.multiPV ?? 1);

    const queue = new AsyncQueue<AnalysisInfo>();
    let resolveResult!: (result: SearchResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<SearchResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => undefined);

    const search: SearchState = {
      id: ++this.searchId,
      queue,
      infos: [],
      lastInfo: null,
      resolve: resolveResult,
      reject: rejectResult,
      result,
      startedAt: now(),
      aborted: false,
      signal: params.signal,
    };

    if (params.signal) {
      search.abortListener = () => {
        if (this.currentSearch !== search) return;
        search.aborted = true;
        this.command('stop');
      };
      params.signal.addEventListener('abort', search.abortListener, { once: true });
    }

    this.currentSearch = search;
    this.command(buildPositionCommand(params.fen, params.moves ?? []));
    this.command(buildGoCommand(params));

    return {
      updates: queue,
      result,
      stop: () => this.stop(),
    };
  }

  async play(params: GoParams): Promise<SearchResult> {
    const handle = await this.analyze(params);
    return handle.result;
  }

  stop(): void {
    if (this.disposed || !this.currentSearch) return;
    this.command('stop');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failSearch(new PikafishError('Engine disposed.', 'DISPOSED'));
    for (const waiter of this.readyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new PikafishError('Engine disposed.', 'DISPOSED'));
    }
    this.initReject?.(new PikafishError('Engine disposed.', 'DISPOSED'));
    try {
      this.worker.postMessage({ type: 'dispose' } satisfies MainToWorker);
    } catch {
      // Worker may already be gone.
    }
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    this.worker.terminate();
    this.listeners.clear();
  }

  private async initialize(assets: BuildAssets, net: ResolvedNet): Promise<ReadyInfo> {
    this.initPromise = new Promise<ReadyInfo>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });

    const message: MainToWorker = {
      type: 'init',
      jsUrl: assets.js,
      wasmUrl: assets.wasm,
      build: this.build,
      verifyNet: this.options.verifyNet !== false,
      net: net.workerNet,
    };
    this.worker.postMessage(message, net.transfer);

    let initTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      initTimer = setTimeout(
        () => reject(new PikafishError('Timed out loading the engine or NNUE weights.', 'ENGINE_INIT_FAILED')),
        300000,
      );
    });
    const info = await Promise.race([this.initPromise, timeout]);
    if (initTimer) clearTimeout(initTimer);
    this.readyInfo = info;

    await this.commandAndReady('uci');
    const threads = clampThreads(this.options.threads, this.capabilities, this.build);
    const hash = clampHash(this.options.hashMB, this.capabilities, this.build);
    this.readyInfo = { ...info, threads, hashMB: hash };
    await this.setOption('Threads', threads);
    await this.setOption('Hash', hash);
    await this.setOption('MultiPV', 1);

    if (this.options.build && this.options.build !== 'auto' && this.options.build !== this.build) {
      this.emit('degraded', {
        reason: `${this.options.build} is unavailable; using ${this.build}.`,
        build: this.build,
      });
    }
    if (!this.options.netSha256 && this.options.netUrl) {
      this.emit('stderr', 'NNUE SHA-256 was not supplied; integrity verification is disabled.');
    }
    return this.readyInfo;
  }

  private async commandAndReady(command: string): Promise<void> {
    this.command(command);
    await this.ready();
  }

  private command(line: string): void {
    if (this.disposed) return;
    if (this.options.debug) this.debugLines.push(`> ${line}`);
    try {
      this.worker.postMessage({ type: 'command', command: line } satisfies MainToWorker);
    } catch (error) {
      this.failSearch(new PikafishError('Failed to send a command to the engine.', 'ENGINE_CRASHED', error));
    }
  }

  private async cancelCurrent(): Promise<void> {
    const search = this.currentSearch;
    if (!search) return;
    this.command('stop');
    let settled = false;
    void search.result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.race([
      search.result.catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 2000)),
    ]);
    if (this.currentSearch === search) this.currentSearch = null;
    if (!settled) {
      // The engine did not answer `stop` in time. Its `bestmove` is still in
      // flight, so remember this search: when that late line arrives it must be
      // attributed here, not to the search that replaces it.
      search.aborted = true;
      this.staleSearches.push(search);
    }
  }

  private finishSearch(bestmove: string, ponder?: string): void {
    const stale = this.staleSearches.shift();
    const search = stale ?? this.currentSearch;
    if (!search) return;
    if (!stale) this.currentSearch = null;
    if (search.abortListener && search.signal) {
      search.signal.removeEventListener('abort', search.abortListener);
    }
    const result: SearchResult = {
      bestmove,
      ...(ponder ? { ponder } : {}),
      info: search.infos,
      lastInfo: search.lastInfo,
      elapsedMs: Math.max(0, now() - search.startedAt),
    };
    if (search.aborted) {
      const error = new PikafishError('Search aborted.', 'SEARCH_ABORTED');
      search.queue.fail(error);
      search.reject(error);
      return;
    }
    search.queue.close();
    search.resolve(result);
    this.emit('bestmove', result);
  }

  private failSearch(error: PikafishError): void {
    const searches = [this.currentSearch, ...this.staleSearches].filter(
      (search): search is SearchState => search != null,
    );
    this.currentSearch = null;
    this.staleSearches = [];
    if (!searches.length) return;
    for (const search of searches) {
      if (search.abortListener && search.signal) {
        search.signal.removeEventListener('abort', search.abortListener);
      }
      search.queue.fail(error);
      search.reject(error);
    }
    this.emit('error', error);
  }

  private handleMessage = (event: MessageEvent<WorkerToMain>): void => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'net-progress': {
        const progress = { loaded: message.loaded, total: message.total, cached: message.cached };
        this.options.onNetProgress?.(progress);
        this.emit('netprogress', progress);
        break;
      }
      case 'ready': {
        const info: ReadyInfo = {
          build: this.build,
          threads: 1,
          hashMB: 0,
          netBytes: message.netBytes,
          netCached: message.netCached,
        };
        this.initResolve?.(info);
        this.initResolve = null;
        this.initReject = null;
        break;
      }
      case 'stderr':
        if (this.options.debug) this.debugLines.push(`< ${message.line}`);
        this.emit('stderr', message.line);
        break;
      case 'error': {
        const error = new PikafishError(message.message, message.code as EngineErrorCode, message);
        if (!this.readyInfo) {
          this.initReject?.(error);
          this.initReject = null;
          this.initResolve = null;
        } else {
          this.failSearch(error);
          this.emit('error', error);
        }
        break;
      }
      case 'line':
        this.handleLine(message.line);
        break;
    }
  };

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    if (this.options.debug) this.debugLines.push(`< ${line}`);
    this.emit('line', line);
    this.options.onLine?.(line);

    if (line === 'readyok') {
      const waiter = this.readyWaiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      return;
    }

    const best = parseBestmove(line);
    if (best) {
      this.finishSearch(best.bestmove, best.ponder);
      return;
    }

    const info = parseInfoLine(line);
    if (info) {
      const search = this.currentSearch;
      if (search) {
        search.infos.push(info);
        search.lastInfo = info;
        search.queue.push(info);
      }
      this.options.onInfo?.(info);
      this.emit('info', info);
    }
  }

  private handleWorkerError = (event: ErrorEvent): void => {
    const error = new PikafishError(event.message || 'Engine worker crashed.', 'ENGINE_CRASHED', event);
    if (!this.readyInfo) {
      this.initReject?.(error);
      this.initReject = null;
    } else {
      this.failSearch(error);
    }
    this.emit('error', error);
  };

  private handleMessageError = (event: MessageEvent): void => {
    const error = new PikafishError('Could not deserialize a worker message.', 'WORKER_ERROR', event);
    this.emit('error', error);
  };

  private emit<K extends EngineEvent>(event: K, payload: EngineEventMap[K]): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        (listener as (value: EngineEventMap[K]) => void)(payload);
      } catch {
        // Listener errors must not break the engine loop.
      }
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new PikafishError('Engine has been disposed.', 'DISPOSED');
  }
}

function resolveAssets(options: PikafishOptions, build: BuildName): BuildAssets {
  const selected = options.builds?.[build];
  const shortcut = options.jsUrl && options.wasmUrl ? { js: options.jsUrl, wasm: options.wasmUrl } : null;
  const assets = selected ?? shortcut;
  if (!assets) {
    throw new PikafishError(`Missing JS/WASM assets for build ${build}.`, 'BUILD_UNAVAILABLE');
  }
  return { ...assets, js: absoluteUrl(assets.js), wasm: absoluteUrl(assets.wasm) };
}

function resolveNet(options: PikafishOptions): ResolvedNet {
  const hasUrl = typeof options.netUrl === 'string' && options.netUrl.length > 0;
  const hasData = options.netData != null;
  if (hasUrl === hasData) {
    throw new PikafishError('Provide exactly one of netUrl or netData.', 'NET_SOURCE_INVALID');
  }

  if (hasData) {
    const source = options.netData!;
    const data =
      source instanceof Uint8Array
        ? (source.slice().buffer as ArrayBuffer)
        : source.slice(0);
    return {
      workerNet: {
        kind: 'data',
        data,
        ...(options.netSha256 ? { sha256: options.netSha256.toLowerCase() } : {}),
      },
      transfer: [data],
    };
  }

  return {
    workerNet: {
      kind: 'url',
      url: absoluteUrl(options.netUrl!),
      ...(options.netSha256 ? { sha256: options.netSha256.toLowerCase() } : {}),
      cache: options.cacheNet !== false,
    },
    transfer: [],
  };
}

function absoluteUrl(value: string): string {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return base ? new URL(value, base).href : value;
  } catch {
    return value;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export async function createEngine(options: PikafishOptions = {}): Promise<PikafishEngine> {
  return PikafishEngine.create(options);
}
