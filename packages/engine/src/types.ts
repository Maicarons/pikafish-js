export type BuildName = 'threads-simd' | 'single-simd' | 'single-nosimd';

export interface BuildAssets {
  js: string;
  wasm: string;
  label?: string;
}

export type BuildSelection = 'auto' | BuildName;

export interface NetSourceUrl {
  kind: 'url';
  url: string;
  sha256?: string;
}

export interface NetSourceData {
  kind: 'data';
  data: ArrayBuffer;
  sha256?: string;
}

export type NetSource = NetSourceUrl | NetSourceData;

export interface Capabilities {
  webAssembly: boolean;
  simd: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  deviceMemory?: number;
  hardwareConcurrency: number;
}

export interface PikafishOptions {
  /** Explicit build, or `auto` based on SIMD / cross-origin isolation. */
  build?: BuildSelection;
  /** Map of build name to JS/WASM URLs. */
  builds?: Partial<Record<BuildName, BuildAssets>>;
  /** Single build shortcut when `builds` is omitted. */
  jsUrl?: string;
  wasmUrl?: string;
  /** Network weights: URL or in-memory data. Exactly one is required. */
  netUrl?: string;
  netData?: ArrayBuffer | Uint8Array;
  netSha256?: string;
  /** Cache downloaded weights in Cache Storage. Default true when netUrl + sha are set. */
  cacheNet?: boolean;
  /** Custom classic worker URL. Defaults to the packaged engine.worker.js. */
  workerUrl?: string | URL;
  /** Create the classic worker yourself (useful with Vite's `?worker` or `new Worker`). */
  workerFactory?: () => Worker;
  threads?: number;
  hashMB?: number;
  multiPV?: number;
  /** Skip SHA-256 verification (not recommended). */
  verifyNet?: boolean;
  debug?: boolean;
  /** Called for every UCI info line. */
  onInfo?: (info: AnalysisInfo) => void;
  onLine?: (line: string) => void;
  onNetProgress?: (progress: NetProgress) => void;
}

export interface GoParams {
  fen: string;
  moves?: string[];
  depth?: number;
  movetime?: number;
  nodes?: number;
  infinite?: boolean;
  multiPV?: number;
  searchMoves?: string[];
  /** Abort the search and reject the result. */
  signal?: AbortSignal;
}

export interface AnalysisInfo {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  score?: { type: 'cp' | 'mate'; value: number; bound?: 'lower' | 'upper' };
  wdl?: [number, number, number];
  nodes?: number;
  nps?: number;
  hashfull?: number;
  tbhits?: number;
  time?: number;
  pv?: string[];
  currmove?: string;
  currmovenumber?: number;
  string?: string;
  raw: string;
}

export interface SearchResult {
  bestmove: string;
  ponder?: string;
  info: AnalysisInfo[];
  lastInfo: AnalysisInfo | null;
  elapsedMs: number;
}

export interface SearchHandle {
  /** Stream of parsed `info` lines, ending after bestmove. */
  updates: AsyncIterable<AnalysisInfo>;
  /** Resolves with the bestmove and collected info. */
  result: Promise<SearchResult>;
  /** Stop the current search. */
  stop: () => void;
}

export interface ReadyInfo {
  build: BuildName;
  threads: number;
  hashMB: number;
  netBytes: number;
  netCached: boolean;
}

export interface NetProgress {
  loaded: number;
  total: number;
  cached?: boolean;
}

export type EngineEventMap = {
  ready: ReadyInfo;
  netprogress: NetProgress;
  info: AnalysisInfo;
  bestmove: SearchResult;
  line: string;
  stderr: string;
  degraded: { reason: string; build: BuildName };
  error: PikafishError;
};

export type EngineEvent = keyof EngineEventMap;

export type EngineErrorCode =
  | 'UNSUPPORTED_ENV'
  | 'BUILD_UNAVAILABLE'
  | 'WORKER_ERROR'
  | 'ASSET_LOAD_FAILED'
  | 'NET_SOURCE_INVALID'
  | 'NET_LOAD_FAILED'
  | 'NET_HASH_MISMATCH'
  | 'NET_WRITE_FAILED'
  | 'ENGINE_INIT_FAILED'
  | 'ENGINE_CRASHED'
  | 'INVALID_FEN'
  | 'INVALID_MOVE'
  | 'INVALID_OPTION'
  | 'SEARCH_ABORTED'
  | 'DISPOSED';

export class PikafishError extends Error {
  constructor(
    message: string,
    readonly code: EngineErrorCode,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PikafishError';
  }
}
