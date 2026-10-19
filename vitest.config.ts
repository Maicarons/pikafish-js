import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        minForks: 1,
        maxForks: 1,
      },
    },
    fileParallelism: false,
  },
});
