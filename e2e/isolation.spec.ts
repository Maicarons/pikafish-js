import { expect, test } from '@playwright/test';
import { PLAIN_ORIGIN, screen, waitForReadyAcrossReloads } from './support';

// The second server (see playwright.config.ts) sends no COOP/COEP, which is the
// GitHub Pages situation.

test('@smoke GitHub Pages 形态：service worker 恢复隔离后可对弈', async ({ page }) => {
  await page.goto(`${PLAIN_ORIGIN}/`);
  await waitForReadyAcrossReloads(page);

  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const state = await screen(page);
  expect(state?.ready).toBe(true);
  // The service worker passes the weights through, so the engine must have them.
  expect(state?.engineInfo?.netBytes).toBeGreaterThan(40_000_000);
});

test('没有 COOP/COEP 且 service worker 不可用时给出明确错误', async ({ page }) => {
  // A browser with service workers unavailable, on a host without headers.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
  });
  await page.goto(`${PLAIN_ORIGIN}/`);

  await expect(page.locator('#errorBanner')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#errorText')).toContainText('跨源隔离');
  await expect(page.locator('#retryButton')).toBeVisible();
  await expect(page.locator('#loadingOverlay')).toBeHidden();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
});

test('Vercel 形态：响应头已带隔离与 CSP', async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/index.html`);
  expect(response.status()).toBe(200);

  const headers = response.headers();
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');

  const html = await response.text();
  // Vite HTML-escapes the attribute, so `&#39;` stands in for `'`.
  const policy = (html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  // Inline styles are used to place the 90 squares; inline scripts are not.
  const scriptSrc = policy
    .split(';')
    .find((directive) => directive.trim().startsWith('script-src'));
  expect(scriptSrc).not.toContain('unsafe-inline');
});
