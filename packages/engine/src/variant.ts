import type { BuildAssets, BuildName, PikafishOptions } from './types.js';

export interface ResolvedVariant {
  /** The name of the variant, e.g. `strong` or `lite`. */
  name: string;
  /** The WASM builds this variant offers. */
  builds: Partial<Record<BuildName, BuildAssets>> | undefined;
  /** The weights these builds need. */
  net: { url?: string; data?: ArrayBuffer | Uint8Array; sha256?: string };
}

/**
 * Picks the engine variant: its WebAssembly builds and the weights they need.
 *
 * A variant carries both because a net is only valid for the feature width it
 * was trained for, so the two cannot be chosen independently.  Without
 * variants the top-level `builds` and weights are used, exactly as before.
 */
export function resolveVariant(options: PikafishOptions): ResolvedVariant {
  const name = options.variant ?? 'default';
  const variant = options.variants?.[name];
  if (!variant) {
    return {
      name,
      builds: options.builds,
      net: { url: options.netUrl, data: options.netData, sha256: options.netSha256 },
    };
  }
  return {
    name,
    builds: variant.builds ?? options.builds,
    net: {
      url: variant.netUrl ?? options.netUrl,
      data: variant.netData ?? options.netData,
      sha256: variant.netSha256 ?? options.netSha256,
    },
  };
}
