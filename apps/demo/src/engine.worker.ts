import { startEngineWorker } from 'pikafish-js/worker-runtime';

startEngineWorker(self as unknown as DedicatedWorkerGlobalScope);
