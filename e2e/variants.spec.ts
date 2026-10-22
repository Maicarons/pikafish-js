import { expect, test } from '@playwright/test';
import { playCannonPage, screen, waitForIdle, waitForPlies, waitForReady } from './support';

interface Manifest {
  engines: Record<
    string,
    {
      label: string;
      net: { url: string; size: number; sha256: string };
      builds: Record<string, unknown>;
    }
  >;
}

async function manifest(page: import('@playwright/test').Page): Promise<Manifest> {
  const response = await page.request.get('/engine/engine.json');
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Manifest;
}

test('@smoke 精简引擎可以加载并完成一次搜索', async ({ page }) => {
  const { engines } = await manifest(page);
  const lite = engines.lite;
  // The distilled net is published with a release; a build without it simply
  // ships the strong engine.
  test.skip(!lite, 'this build has no distilled net');

  await page.goto('/?variant=lite');
  const ready = await waitForReady(page);
  expect(ready.variant).toBe('lite');
  expect(ready.engineInfo?.netBytes).toBe(lite.net.size);
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  await expect(page.locator('#errorBanner')).toBeHidden();

  await page.selectOption('#difficulty', '2');
  await playCannonPage(page);
  await waitForPlies(page, 1);
  await waitForIdle(page);
  await waitForPlies(page, 2);

  const state = await screen(page);
  expect(state?.history[0]).toBe('b2e2');
  expect(state?.turn).toBe('w');
});

test('@smoke 默认使用精简引擎，并可以用链接切回强力', async ({ page }) => {
  const { engines } = await manifest(page);
  test.skip(!engines.lite, 'this build has no distilled net');

  await page.goto('/');
  const ready = await waitForReady(page);
  expect(ready.variant).toBe('lite');
  expect(ready.engineInfo?.netBytes).toBe(engines.lite.net.size);

  await page.goto('/?variant=strong');
  const strong = await waitForReady(page);
  expect(strong.variant).toBe('strong');
  expect(strong.engineInfo?.netBytes).toBe(engines.strong.net.size);
});

test('网络选择器列出清单里的所有引擎', async ({ page }) => {
  const { engines } = await manifest(page);
  await page.goto('/');
  await waitForReady(page);

  const options = await page.locator('#engineSelect option').allTextContents();
  expect(options.length).toBe(Object.keys(engines).length);
  for (const name of Object.keys(engines)) {
    expect(options.some((label) => label.includes(engines[name].label))).toBeTruthy();
  }
});
