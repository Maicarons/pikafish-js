import type { BuildName } from '../types.js';

export type WorkerNetSource =
  | { kind: 'url'; url: string; sha256?: string; cache?: boolean }
  | { kind: 'data'; data: ArrayBuffer; sha256?: string };

export type MainToWorker =
  | {
      type: 'init';
      jsUrl: string;
      wasmUrl: string;
      net: WorkerNetSource;
      verifyNet: boolean;
      build: BuildName;
    }
  | { type: 'command'; command: string }
  | { type: 'dispose' };

export type WorkerToMain =
  | { type: 'net-progress'; loaded: number; total: number; cached?: boolean }
  | { type: 'ready'; netBytes: number; netCached: boolean }
  | { type: 'line'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'error'; code: string; message: string; fatal?: boolean };

export interface EmscriptenModule {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
  };
  cwrap(
    name: string,
    returnType: string | null,
    argTypes: string[],
  ): (...args: unknown[]) => unknown;
}

export type PikafishFactory = (options: Record<string, unknown>) => Promise<EmscriptenModule>;
