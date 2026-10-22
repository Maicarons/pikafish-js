import { describe, expect, it } from 'vitest';
import { resolveVariant } from '../src/variant.ts';
import type { BuildName } from '../src/types.ts';

const strongBuilds: Record<BuildName, { js: string; wasm: string }> = {
  'threads-simd': { js: 'strong/threads.js', wasm: 'strong/threads.wasm' },
  'single-simd': { js: 'strong/simd.js', wasm: 'strong/simd.wasm' },
  'single-nosimd': { js: 'strong/plain.js', wasm: 'strong/plain.wasm' },
};

const liteBuilds: Record<BuildName, { js: string; wasm: string }> = {
  'threads-simd': { js: 'lite/threads.js', wasm: 'lite/threads.wasm' },
  'single-simd': { js: 'lite/simd.js', wasm: 'lite/simd.wasm' },
  'single-nosimd': { js: 'lite/plain.js', wasm: 'lite/plain.wasm' },
};

describe('resolveVariant', () => {
  it('uses the top-level assets when no variant is named', () => {
    const resolved = resolveVariant({
      builds: strongBuilds,
      netUrl: '/engine/pikafish.nnue',
      netSha256: 'abc',
    });
    expect(resolved.name).toBe('default');
    expect(resolved.builds).toBe(strongBuilds);
    expect(resolved.net.url).toBe('/engine/pikafish.nnue');
    expect(resolved.net.sha256).toBe('abc');
  });

  it('takes the builds and the weights of the named variant', () => {
    const resolved = resolveVariant({
      variants: {
        strong: { builds: strongBuilds, netUrl: '/engine/pikafish.nnue' },
        lite: { builds: liteBuilds, netUrl: '/engine/pikafish-lite.nnue', netSha256: 'def' },
      },
      variant: 'lite',
    });
    expect(resolved.name).toBe('lite');
    expect(resolved.builds).toBe(liteBuilds);
    expect(resolved.net.url).toBe('/engine/pikafish-lite.nnue');
    expect(resolved.net.sha256).toBe('def');
  });

  it('falls back to the top-level assets for an unknown variant', () => {
    const resolved = resolveVariant({
      builds: strongBuilds,
      netUrl: '/engine/pikafish.nnue',
      variants: { lite: { builds: liteBuilds, netUrl: '/engine/pikafish-lite.nnue' } },
      variant: 'nope',
    });
    expect(resolved.name).toBe('nope');
    expect(resolved.builds).toBe(strongBuilds);
    expect(resolved.net.url).toBe('/engine/pikafish.nnue');
  });

  it('keeps the top-level weights when a variant has none of its own', () => {
    const resolved = resolveVariant({
      netUrl: '/engine/pikafish.nnue',
      netSha256: 'abc',
      variants: { lite: { builds: liteBuilds } },
      variant: 'lite',
    });
    expect(resolved.net.url).toBe('/engine/pikafish.nnue');
    expect(resolved.net.sha256).toBe('abc');
  });
});
