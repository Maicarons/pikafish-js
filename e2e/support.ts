import { expect, type Page } from '@playwright/test';

export const PLAIN_ORIGIN = `http://127.0.0.1:${process.env.E2E_PLAIN_PORT ?? 4312}`;

/** The read-only state hook the demo exposes for tests (`window.__pikafish`). */
export type DemoScreen = {
  ready: boolean;
  build: string | null;
  buildChoice: string;
  variant: string;
  fen: string;
  turn: 'w' | 'b';
  thinking: boolean;
  playerColor: 'w' | 'b';
  difficulty: number;
  history: string[];
  selected: { file: number; rank: number } | null;
  hint: { from: { file: number; rank: number }; to: { file: number; rank: number } } | null;
  status: { over: boolean; result: string | null; reason: string | null; inCheck: boolean };
  engineInfo: {
    build: string;
    threads: number;
    hashMB: number;
    netBytes: number;
    netCached: boolean;
  } | null;
  boardFocused: boolean;
};

export function screen(page: Page): Promise<DemoScreen | null> {
  return page.evaluate(() => (window as unknown as { __pikafish?: DemoScreen }).__pikafish ?? null);
}

export async function waitForReady(page: Page, timeout = 120_000): Promise<DemoScreen> {
  await page.waitForFunction(
    () => (window as unknown as { __pikafish?: { ready: boolean } }).__pikafish?.ready === true,
    undefined,
    { timeout },
  );
  const state = await screen(page);
  if (!state) throw new Error('the demo state hook is missing');
  return state;
}

/**
 * The GitHub Pages path reloads itself once, when the service worker takes
 * control, so a plain `waitForFunction` can be destroyed mid-navigation.
 */
export async function waitForReadyAcrossReloads(page: Page, timeout = 180_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => {
        const hook = (window as unknown as { __pikafish?: { ready: boolean } }).__pikafish;
        const banner = document.querySelector<HTMLElement>('#errorBanner');
        return {
          ready: Boolean(hook?.ready),
          error:
            banner && !banner.hidden
              ? (document.querySelector('#errorText')?.textContent ?? '')
              : '',
        };
      });
      if (state.ready) return;
      if (state.error) throw new Error(`demo reported: ${state.error}`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (lastError.startsWith('demo reported:')) throw error;
      // Otherwise the document is being replaced; try again.
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`the engine never became ready (${lastError})`);
}

export const square = (file: number, rank: number) =>
  `#board .square[data-file="${file}"][data-rank="${rank}"]`;

/** 炮二平五 — the red cannon on file 2 steps to the middle file. */
export async function playCannonPage(page: Page): Promise<void> {
  await page.click(square(1, 2));
  await page.click(square(4, 2));
}

export async function plies(page: Page): Promise<number> {
  return (await screen(page))?.history.length ?? -1;
}

export async function waitForPlies(page: Page, minimum: number, timeout = 90_000): Promise<void> {
  await expect.poll(() => plies(page), { timeout }).toBeGreaterThanOrEqual(minimum);
}

export async function waitForIdle(page: Page, timeout = 90_000): Promise<void> {
  await expect.poll(async () => (await screen(page))?.thinking, { timeout }).toBe(false);
}
