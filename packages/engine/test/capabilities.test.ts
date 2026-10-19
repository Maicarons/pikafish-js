import { describe, expect, it } from 'vitest';
import {
  buildLabel,
  chooseBuild,
  clampHash,
  clampThreads,
  recommendedThreads,
} from '../src/capabilities.ts';
import type { BuildName, Capabilities } from '../src/types.ts';
import { PikafishError } from '../src/types.ts';

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    webAssembly: true,
    simd: true,
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    hardwareConcurrency: 8,
    ...overrides,
  };
}

const allBuilds: Record<BuildName, { js: string; wasm: string }> = {
  'threads-simd': { js: 'threads.js', wasm: 'threads.wasm' },
  'single-simd': { js: 'simd.js', wasm: 'simd.wasm' },
  'single-nosimd': { js: 'plain.js', wasm: 'plain.wasm' },
};

describe('chooseBuild', () => {
  it('prefers the threaded build when SIMD and isolation are available', () => {
    expect(chooseBuild(capabilities(), { builds: allBuilds })).toBe('threads-simd');
  });

  it('requires cross-origin isolation for every build', () => {
    expect(() =>
      chooseBuild(capabilities({ crossOriginIsolated: false }), { builds: allBuilds }),
    ).toThrow(PikafishError);
    expect(() =>
      chooseBuild(capabilities({ sharedArrayBuffer: false }), { builds: allBuilds }),
    ).toThrow(PikafishError);
  });

  it('drops SIMD when it is not supported', () => {
    expect(chooseBuild(capabilities({ simd: false }), { builds: allBuilds })).toBe('single-nosimd');
  });

  it('honours an explicit build when available', () => {
    expect(chooseBuild(capabilities(), { build: 'single-nosimd', builds: allBuilds })).toBe(
      'single-nosimd',
    );
  });

  it('falls back when the requested build is missing', () => {
    expect(
      chooseBuild(capabilities({ simd: false }), { build: 'threads-simd', builds: allBuilds }),
    ).toBe('single-nosimd');
    expect(
      chooseBuild(capabilities(), {
        build: 'threads-simd',
        builds: { 'single-simd': { js: 'simd.js', wasm: 'simd.wasm' } },
      }),
    ).toBe('single-simd');
  });

  it('throws when no build can run', () => {
    expect(() => chooseBuild(capabilities({ webAssembly: false }))).toThrow(PikafishError);
    expect(() =>
      chooseBuild(capabilities({ simd: false }), {
        builds: { 'single-simd': { js: 'simd.js', wasm: 'simd.wasm' } },
      }),
    ).toThrow(PikafishError);
  });
});

describe('limits', () => {
  it('clamps threads to a single thread on non-threaded builds', () => {
    expect(clampThreads(8, capabilities(), 'single-simd')).toBe(1);
    expect(clampThreads(8, capabilities(), 'threads-simd')).toBe(8);
    expect(clampThreads(200, capabilities(), 'threads-simd')).toBe(8);
  });

  it('derives sensible thread counts', () => {
    expect(recommendedThreads(capabilities({ deviceMemory: 2, hardwareConcurrency: 8 }))).toBe(2);
    expect(recommendedThreads(capabilities({ deviceMemory: 16, hardwareConcurrency: 8 }))).toBe(4);
  });

  it('clamps the hash table to the build and device', () => {
    expect(clampHash(1024, capabilities({ deviceMemory: 2 }), 'threads-simd')).toBe(32);
    expect(clampHash(undefined, capabilities({ deviceMemory: 16 }), 'single-simd')).toBe(32);
  });

  it('labels builds in Chinese', () => {
    expect(buildLabel('threads-simd')).toContain('线程');
    expect(buildLabel('single-nosimd')).toContain('兼容');
  });
});
