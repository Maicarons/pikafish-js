import type { BuildName, Capabilities, PikafishOptions } from './types.js';
import { PikafishError } from './types.js';

const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

export function detectCapabilities(): Capabilities {
  const global = globalThis as typeof globalThis & { deviceMemory?: number; crossOriginIsolated?: boolean };
  const webAssembly = typeof WebAssembly === 'object';
  let simd = false;
  if (webAssembly) {
    try {
      simd = WebAssembly.validate(SIMD_PROBE);
    } catch {
      simd = false;
    }
  }
  return {
    webAssembly,
    simd,
    crossOriginIsolated: global.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    deviceMemory: typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined,
    hardwareConcurrency: typeof navigator !== 'undefined' ? Math.max(1, navigator.hardwareConcurrency || 1) : 4,
  };
}

export function chooseBuild(capabilities: Capabilities, options: Pick<PikafishOptions, 'build' | 'builds'> = {}): BuildName {
  if (!capabilities.webAssembly) {
    throw new PikafishError('This browser does not support WebAssembly.', 'UNSUPPORTED_ENV');
  }

  // Every Pikafish build starts at least one pthread, so the page must be
  // cross-origin isolated for SharedArrayBuffer to exist at all. The "single"
  // builds use one engine thread and a smaller heap, they are not a way to run
  // without isolation.
  if (!capabilities.sharedArrayBuffer || !capabilities.crossOriginIsolated) {
    throw new PikafishError(
      'Pikafish requires cross-origin isolation (COOP/COEP) and SharedArrayBuffer. ' +
        'On static hosts, register coi-serviceworker.js before creating the engine.',
      'BUILD_UNAVAILABLE',
    );
  }

  const available = options.builds ? (Object.keys(options.builds) as BuildName[]) : [];
  const isAvailable = (build: BuildName) => available.length === 0 || available.includes(build);
  const requested = options.build && options.build !== 'auto' ? options.build : null;

  const order: BuildName[] = requested
    ? [requested, 'threads-simd', 'single-simd', 'single-nosimd']
    : capabilities.simd
      ? ['threads-simd', 'single-simd', 'single-nosimd']
      : ['single-nosimd'];

  for (const build of order) {
    if (!isAvailable(build)) continue;
    if (build !== 'single-nosimd' && !capabilities.simd) continue;
    return build;
  }

  throw new PikafishError('No compatible engine build is available.', 'BUILD_UNAVAILABLE');
}

export function recommendedThreads(capabilities: Capabilities): number {
  const memory = capabilities.deviceMemory ?? 8;
  const cores = capabilities.hardwareConcurrency;
  if (memory <= 4) return Math.min(2, cores);
  return Math.max(1, Math.min(4, cores - 1));
}

export function clampThreads(value: number | undefined, capabilities: Capabilities, build: BuildName): number {
  if (build !== 'threads-simd') return 1;
  const requested = Number.isFinite(value) && value ? Math.floor(value) : recommendedThreads(capabilities);
  return Math.max(1, Math.min(8, requested));
}

export function recommendedHash(capabilities: Capabilities, build: BuildName): number {
  const memory = capabilities.deviceMemory ?? 8;
  if (build !== 'threads-simd') return memory <= 4 ? 16 : 32;
  if (memory <= 4) return 16;
  return 64;
}

export function clampHash(value: number | undefined, capabilities: Capabilities, build: BuildName): number {
  const requested = Number.isFinite(value) && value ? Math.floor(value) : recommendedHash(capabilities, build);
  const memory = capabilities.deviceMemory ?? 8;
  const max = memory <= 2 ? 32 : memory <= 4 ? 64 : build === 'threads-simd' ? 256 : 128;
  return Math.max(1, Math.min(max, requested));
}

export function buildLabel(build: BuildName): string {
  switch (build) {
    case 'threads-simd':
      return '线程 + SIMD';
    case 'single-simd':
      return '单线程 + SIMD';
    case 'single-nosimd':
      return '兼容模式（无 SIMD）';
  }
}
