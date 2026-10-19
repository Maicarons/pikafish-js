import { expect, test } from '@playwright/test';

type BenchRow = {
  build: string;
  appliedThreads: number;
  hashMB: number;
  initMs: number;
  depth: number;
  nodes: number;
  nps: number;
  bestmove: string;
  ok: boolean;
  error?: string;
};

type BenchReport = {
  done: boolean;
  movetime: number;
  fen: string;
  version: string;
  upstreamCommit: string;
  environment: string;
  rows?: BenchRow[];
  error?: string;
};

test('基准页跑完四种配置并给出机器可读结果', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/bench.html?movetime=300');

  await expect
    .poll(async () => page.evaluate(() => Boolean((window as unknown as { __bench?: { done: boolean } }).__bench?.done)), {
      timeout: 280_000,
    })
    .toBe(true);

  const report = await page.evaluate(() => (window as unknown as { __bench?: BenchReport }).__bench);
  expect(report?.error).toBeUndefined();
  expect(report?.rows).toHaveLength(4);
  for (const row of report?.rows ?? []) {
    expect(row.ok, `${row.build}: ${row.error ?? ''}`).toBe(true);
    expect(row.nps).toBeGreaterThan(10_000);
    expect(row.bestmove).toMatch(/^[a-i]\d[a-i]\d$/);
  }
  expect(report?.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);

  // The human-readable report must be there too, not just the hook.
  await expect(page.locator('#report table tbody tr')).toHaveCount(4);
});
