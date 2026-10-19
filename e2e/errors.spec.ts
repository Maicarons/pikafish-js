import { expect, test } from '@playwright/test';
import { waitForReady } from './support';

test('NNUE 下载失败时给出可恢复的错误', async ({ page }) => {
  await page.route('**/pikafish.nnue', (route) => route.abort());
  await page.goto('/');

  await expect(page.locator('#errorBanner')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#errorText')).not.toBeEmpty();
  await expect(page.locator('#retryButton')).toBeVisible();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
});

test('缓存中的权重损坏后会重新下载并恢复', async ({ page }) => {
  await page.goto('/?build=single-simd');
  await waitForReady(page);

  const sha256 = await page.evaluate(async () => {
    const response = await fetch('engine/engine.json');
    const manifest = (await response.json()) as { net: { sha256: string } };
    return manifest.net.sha256;
  });

  // Poison the cache the way a half-written or tampered entry would.
  await page.evaluate(async (sha) => {
    const cache = await caches.open('pikafish-net-v1');
    await cache.put(
      new Request(`https://pikafish-js.local/net/${sha.toLowerCase()}`),
      new Response(new Uint8Array(4096).fill(9), {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
  }, sha256);

  await page.reload();
  const state = await waitForReady(page);

  // It noticed the mismatch, dropped the entry and downloaded again.
  expect(state.engineInfo?.netCached).toBe(false);
  expect(state.engineInfo?.netBytes).toBeGreaterThan(40_000_000);
  await expect(page.locator('#errorBanner')).toBeHidden();
});

test('未知的构建参数回退到自动选择', async ({ page }) => {
  await page.goto('/?build=not-a-build');
  const state = await waitForReady(page);

  expect(state.buildChoice).toBe('auto');
  expect(state.build).toBeTruthy();
  await expect(page.locator('#errorBanner')).toBeHidden();
});

test('构建资源缺失时报错而不是一直转圈', async ({ page }) => {
  await page.route('**/engine/single-nosimd/**', (route) => route.abort());
  await page.goto('/?build=single-nosimd');

  await expect(page.locator('#errorBanner')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  await expect(page.locator('#retryButton')).toBeVisible();
});
