import { expect, test } from '@playwright/test';
import { playCannonPage, plies, waitForIdle, waitForPlies, waitForReady } from './support';

// Long-running memory check (M5-3). Not part of the default run: `npm run test:stress`.
// Rounds are configurable so a nightly job can do 100 and a laptop can do 10.
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 10);

test('@stress 连续对局与搜索后内存不持续增长', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'performance.memory is a Chromium API');
  test.setTimeout(30 * 60_000);

  await page.goto('/?build=single-simd');
  await waitForReady(page, 180_000);
  await page.selectOption('#difficulty', '2');

  const samples: Array<{ round: number; heapMB: number }> = [];
  const readHeap = async () => {
    const bytes = await page.evaluate(
      () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
    );
    return Math.round((bytes / (1024 * 1024)) * 10) / 10;
  };

  for (let round = 1; round <= ROUNDS; round += 1) {
    await page.click('#newGame');
    await playCannonPage(page);
    await waitForPlies(page, 1, 120_000);
    await waitForIdle(page, 120_000);
    await waitForPlies(page, 2, 120_000);

    // Exercise the other long-lived paths too: a hint search and an undo.
    if (round % 5 === 0) {
      await page.click('#hintButton');
      await expect
        .poll(async () => page.locator('#board .hint-arrow').count(), { timeout: 120_000 })
        .toBeGreaterThan(0);
    }
    await page.click('#undoButton');
    await expect.poll(() => plies(page), { timeout: 30_000 }).toBe(0);

    samples.push({ round, heapMB: await readHeap() });
  }

  await test.info().attach('memory.json', {
    body: JSON.stringify({ rounds: ROUNDS, samples }, null, 2),
    contentType: 'application/json',
  });

  // Compare the first third with the last third: a leak shows up as a steady
  // climb, while normal GC sawtooth stays inside the allowance.
  const third = Math.max(1, Math.floor(samples.length / 3));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const early = mean(samples.slice(0, third).map(sample => sample.heapMB));
  const late = mean(samples.slice(-third).map(sample => sample.heapMB));

  expect(late, `heap went from ${early} MB to ${late} MB: ${JSON.stringify(samples)}`).toBeLessThan(
    early * 1.5 + 30,
  );
});
