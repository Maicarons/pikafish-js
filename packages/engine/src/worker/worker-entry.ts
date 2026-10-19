import { startEngineWorker } from './runtime.js';

startEngineWorker(self as unknown as DedicatedWorkerGlobalScope);
