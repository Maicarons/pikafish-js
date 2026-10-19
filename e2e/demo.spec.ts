import { expect, test } from '@playwright/test';
import {
  playCannonPage,
  plies,
  screen,
  square,
  waitForIdle,
  waitForPlies,
  waitForReady,
} from './support';

const BUILDS = ['threads-simd', 'single-simd', 'single-nosimd'] as const;

// Level 2 is "轻松 · 1 层 / 180 ms": enough to force a real search, short enough
// to keep the suite quick.
async function useFastLevel(page: import('@playwright/test').Page): Promise<void> {
  await page.selectOption('#difficulty', '2');
}

for (const build of BUILDS) {
  test(`@smoke 构建 ${build} 可以加载并完成一次搜索`, async ({ page }) => {
    await page.goto(`/?build=${build}`);
    const ready = await waitForReady(page);
    expect(ready.build).toBe(build);
    expect(ready.engineInfo?.build).toBe(build);
    expect(ready.engineInfo?.netBytes).toBeGreaterThan(40_000_000);
    expect(ready.playerColor).toBe('w');
    await expect(page.locator('#loadingOverlay')).toBeHidden();
    await expect(page.locator('#errorBanner')).toBeHidden();

    await useFastLevel(page);
    await playCannonPage(page);
    await waitForPlies(page, 1);
    await waitForIdle(page);
    await waitForPlies(page, 2);

    const state = await screen(page);
    expect(state?.history[0]).toBe('b2e2');
    // The engine answered, so the human is on move again.
    expect(state?.turn).toBe('w');
  });
}

test('@smoke 加载后不会自行走棋', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await page.waitForTimeout(3000);
  expect((await screen(page))?.history).toEqual([]);
});

test('键盘：方向键移动焦点，回车选子与落子，Esc 取消', async ({ page }) => {
  await page.goto('/?build=single-simd');
  await waitForReady(page);
  await useFastLevel(page);

  // Roving tabindex: exactly one square is tabbable and the arrows move it.
  await expect(page.locator('#board .square[tabindex="0"]')).toHaveCount(1);
  await page.locator('#board .square[tabindex="0"]').focus();
  const before = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.file);
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.file);
  expect(Number(after)).toBe(Number(before) + 1);
  expect((await screen(page))?.boardFocused).toBe(true);

  // Enter activates a focused square, exactly like a click.
  await page.locator(square(1, 2)).focus();
  await page.keyboard.press('Enter');
  expect((await screen(page))?.selected).toEqual({ file: 1, rank: 2 });

  await page.keyboard.press('Escape');
  expect((await screen(page))?.selected).toBeNull();

  await page.locator(square(1, 2)).focus();
  await page.keyboard.press('Enter');
  await page.locator(square(4, 2)).focus();
  await page.keyboard.press('Enter');
  await waitForPlies(page, 1);
  expect((await screen(page))?.history[0]).toBe('b2e2');
});

test('悔棋回到玩家回合', async ({ page }) => {
  await page.goto('/');
  await waitForReady(page);
  await useFastLevel(page);
  await playCannonPage(page);
  await waitForPlies(page, 2);
  await waitForIdle(page);

  await page.click('#undoButton');
  await expect.poll(() => plies(page)).toBe(0);
  expect((await screen(page))?.turn).toBe('w');
});

test('提示画出建议着法', async ({ page }) => {
  await page.goto('/?build=single-simd');
  await waitForReady(page);

  await page.click('#hintButton');
  await expect.poll(async () => Boolean((await screen(page))?.hint), { timeout: 60_000 }).toBe(true);

  const hint = (await screen(page))?.hint;
  expect(hint).toBeTruthy();
  expect(hint?.from).not.toEqual(hint?.to);
  await expect(page.locator('#board .hint-arrow')).toHaveCount(1);
  await expect(page.locator('#srStatus')).toContainText('提示');
});

test('翻转棋盘只影响显示', async ({ page }) => {
  await page.goto('/?build=single-simd');
  const ready = await waitForReady(page);
  const leftBefore = await page.locator(square(0, 9)).evaluate(el => (el as HTMLElement).style.left);

  await page.click('#flipButton');
  const leftAfter = await page.locator(square(0, 9)).evaluate(el => (el as HTMLElement).style.left);

  expect(leftAfter).not.toBe(leftBefore);
  expect((await screen(page))?.fen).toBe(ready.fen);
});

test('切换执黑后引擎先行', async ({ page }) => {
  await page.goto('/?build=single-simd');
  await waitForReady(page);

  await page.click('#sideToggle [data-side="b"]');
  await expect.poll(async () => (await screen(page))?.playerColor).toBe('b');
  await waitForPlies(page, 1);

  const state = await screen(page);
  // Red moved (the engine), and it is now the human's turn as Black.
  expect(state?.turn).toBe('b');
});

test('分析面板给出候选着法', async ({ page }) => {
  await page.goto('/?build=single-simd');
  await waitForReady(page);

  // The checkbox itself is visually hidden; a user clicks the switch track.
  await expect(page.locator('#analysisToggle')).toHaveAccessibleName('实时分析');
  await page.click('.switch-track');
  await expect(page.locator('#analysisToggle')).toBeChecked();
  await expect
    .poll(async () => page.locator('#pvList .pv-row').count(), { timeout: 90_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('#evalValue')).not.toBeEmpty();
});

test('生产构建带严格 CSP 且无违规', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', message => {
    if (/Content Security Policy|Refused to (load|execute|create|apply)/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/');
  const state = await waitForReady(page);
  expect(state.ready).toBe(true);

  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(policy).toContain("worker-src 'self' blob:");
  expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");

  // Exercise the worker and a search: that is where a too-strict policy breaks.
  await useFastLevel(page);
  await playCannonPage(page);
  await waitForPlies(page, 2);
  expect(violations).toEqual([]);
});

test('可访问性：状态有 live region，按钮有 aria-pressed', async ({ page }) => {
  await page.goto('/?build=single-simd');
  await waitForReady(page);

  await expect(page.locator('#srStatus')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#srStatus')).toContainText('引擎就绪');
  await expect(page.locator('#board')).toHaveAttribute('role', 'group');
  await expect(page.locator('#board')).toHaveAttribute('aria-describedby', 'boardHelp');
  await expect(page.locator('#sideToggle [data-side="w"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sideToggle [data-side="b"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#boardHelp')).toHaveCount(1);
});
