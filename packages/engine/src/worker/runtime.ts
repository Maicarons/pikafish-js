import type {
  EmscriptenModule,
  MainToWorker,
  PikafishFactory,
  WorkerNetSource,
  WorkerToMain,
} from './protocol.js';

const NET_PATH = '/pikafish.nnue';
const CACHE_NAME = 'pikafish-net-v1';

interface WorkerState {
  module: EmscriptenModule | null;
  command: ((line: string) => void) | null;
  ready: boolean;
}

export function startEngineWorker(scope: DedicatedWorkerGlobalScope): void {
  const state: WorkerState = { module: null, command: null, ready: false };
  const post = (message: WorkerToMain) => scope.postMessage(message);

  const fail = (code: string, error: unknown, fatal = false) => {
    post({
      type: 'error',
      code,
      message: error instanceof Error ? error.message : String(error),
      fatal,
    });
  };

  scope.addEventListener('message', async (event: MessageEvent<MainToWorker>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'init') {
      try {
        await initialize(message);
        post({ type: 'ready', netBytes: netBytes, netCached: cached });
      } catch (error) {
        fail(errorCode(error), error, true);
      }
      return;
    }

    if (message.type === 'command') {
      if (!state.ready || !state.command) {
        post({ type: 'error', code: 'ENGINE_INIT_FAILED', message: 'Engine is not ready.' });
        return;
      }
      try {
        state.command(message.command);
      } catch (error) {
        post({
          type: 'error',
          code: 'ENGINE_CRASHED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message.type === 'dispose') {
      state.ready = false;
      state.command = null;
      state.module = null;
      scope.close();
    }
  });

  let netBytes = 0;
  let cached = false;

  async function initialize(message: Extract<MainToWorker, { type: 'init' }>): Promise<void> {
    const result = await loadNet(message.net, message.verifyNet);
    netBytes = result.bytes.byteLength;
    cached = result.cached;

    importScripts(message.jsUrl);
    const factory = (scope as unknown as { Pikafish?: PikafishFactory }).Pikafish;
    if (typeof factory !== 'function') {
      throw Object.assign(new Error('Pikafish factory missing after importScripts().'), {
        code: 'ASSET_LOAD_FAILED',
      });
    }

    const module = await factory({
      locateFile: (file: string) => (file.endsWith('.wasm') ? message.wasmUrl : file),
      mainScriptUrlOrBlob: message.jsUrl,
      print: (line: string) => post({ type: 'line', line: String(line) }),
      printErr: (line: string) => post({ type: 'stderr', line: String(line) }),
      noInitialRun: true,
    });

    module.FS.writeFile(NET_PATH, result.bytes);
    const initializeEngine = module.cwrap('pikafish_initialize', null, []);
    const command = module.cwrap('pikafish_command', null, ['string']);
    state.module = module;
    state.command = command as (line: string) => void;
    initializeEngine();
    state.ready = true;
    post({
      type: 'net-progress',
      loaded: result.bytes.byteLength,
      total: result.bytes.byteLength,
      cached: result.cached,
    });
  }

  async function loadNet(
    source: WorkerNetSource,
    verify: boolean,
  ): Promise<{ bytes: Uint8Array; cached: boolean }> {
    if (source.kind === 'data') {
      const bytes = new Uint8Array(source.data);
      await verifyHash(bytes, source.sha256, verify);
      return { bytes, cached: false };
    }

    const cacheable = source.cache !== false && !!source.sha256 && typeof caches !== 'undefined';
    const key = cacheable ? cacheKey(source.sha256!) : null;
    if (key) {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(key);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        try {
          await verifyHash(bytes, source.sha256, verify);
          post({
            type: 'net-progress',
            loaded: bytes.byteLength,
            total: bytes.byteLength,
            cached: true,
          });
          return { bytes, cached: true };
        } catch (error) {
          // A corrupt or outdated cache entry must not brick the engine.
          await cache.delete(key).catch(() => undefined);
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error as { code?: unknown }).code === 'NET_HASH_MISMATCH'
          ) {
            post({ type: 'stderr', line: 'Cached NNUE failed verification; downloading again.' });
          } else {
            throw error;
          }
        }
      }
    }

    const response = await fetch(source.url);
    if (!response.ok) {
      throw Object.assign(new Error(`Network fetch failed: HTTP ${response.status}`), {
        code: 'NET_LOAD_FAILED',
      });
    }

    const total = Number(response.headers.get('content-length') ?? 0) || 0;
    let bytes: Uint8Array;
    if (!response.body) {
      bytes = new Uint8Array(await response.arrayBuffer());
      post({ type: 'net-progress', loaded: bytes.byteLength, total: total || bytes.byteLength });
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        loaded += value.byteLength;
        post({ type: 'net-progress', loaded, total });
      }
      bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    await verifyHash(bytes, source.sha256, verify);
    // Only verified weights are persisted, so a corrupted download can never
    // poison the cache. Building the response from `bytes` also avoids the
    // extra ~50 MB the stream tee created by `response.clone()`.
    if (key) {
      const cache = await caches.open(CACHE_NAME);
      await cache
        .put(
          key,
          new Response(toArrayBuffer(bytes), {
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
        )
        .catch(() => undefined);
    }
    return { bytes, cached: false };
  }
}

async function verifyHash(
  bytes: Uint8Array,
  expected: string | undefined,
  verify: boolean,
): Promise<void> {
  if (!expected || !verify) return;
  if (!globalThis.crypto?.subtle) {
    throw Object.assign(new Error('SHA-256 verification is unavailable in this context.'), {
      code: 'NET_HASH_MISMATCH',
    });
  }
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  const actual = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== expected.toLowerCase()) {
    throw Object.assign(new Error(`NNUE SHA-256 mismatch: expected ${expected}, got ${actual}`), {
      code: 'NET_HASH_MISMATCH',
    });
  }
}

function cacheKey(sha256: string): Request {
  return new Request(`https://pikafish-js.local/net/${sha256.toLowerCase()}`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'ENGINE_INIT_FAILED';
}
