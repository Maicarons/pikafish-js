// Cross-origin isolation bootstrap.
//
// The engine's three builds all need `SharedArrayBuffer`, which the browser only
// exposes to a cross-origin isolated page. Vercel sends the COOP/COEP headers
// itself; GitHub Pages cannot, so a same-origin service worker adds them and the
// page reloads once the worker takes control.
//
// This lives in the bundle rather than in an inline `<script>` in `index.html`
// so that the production build can ship a strict CSP without `unsafe-inline`
// for scripts. It must therefore run as early as possible: `main.ts` calls it
// before touching the engine.
const RELOAD_FLAG = 'pikafish-coi-reloaded';

export function registerIsolationWorker(): void {
  if (crossOriginIsolated) return;
  // `serviceWorker` can be missing entirely (insecure context, some private
  // modes) or present but unusable; both must not break the engine bootstrap.
  const container = navigator.serviceWorker;
  if (!container) return;

  const workerUrl = new URL('./coi-serviceworker.js', document.baseURI).href;
  try {
    void container
      .register(workerUrl)
      .then((registration) => {
        // An already-active worker from a previous visit may not have claimed
        // this client yet; asking it to claim avoids waiting for a navigation.
        if (registration.active && !container.controller) {
          registration.active.postMessage({ type: 'claim' });
        }
      })
      .catch(() => {
        // Registration can fail (insecure context, SW disabled, private mode).
        // The engine reports a clear isolation error instead of failing quietly.
      });
  } catch {
    // Some environments throw synchronously from `register`.
    return;
  }

  container.addEventListener('controllerchange', () => {
    // Reload exactly once, otherwise a worker that keeps re-claiming would put
    // the page in a reload loop.
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, '1');
    location.reload();
  });
}
