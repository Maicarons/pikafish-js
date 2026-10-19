// Repeatable benchmark for the three engine builds, run in a real browser.
//
// A browser is the only place the pthread wasm modules can run, so the numbers in
// docs/plan/architecture.md are produced here rather than by a Node script.
// Query parameters: ?movetime=3000 (ms per search) and ?fen=<UCCI FEN>.
import { createEngine, PikafishError, type AnalysisInfo, type BuildName } from 'pikafish-js';
import workerUrl from 'pikafish-js/engine.worker.js?url';

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

const params = new URLSearchParams(location.search);
const movetime = Math.max(200, Number(params.get('movetime')) || 3000);
const fen = params.get('fen') || START_FEN;

const CONFIGS: Array<{ build: BuildName; threads: number }> = [
  { build: 'threads-simd', threads: 4 },
  { build: 'threads-simd', threads: 1 },
  { build: 'single-simd', threads: 1 },
  { build: 'single-nosimd', threads: 1 },
];

interface Row {
  build: BuildName;
  requestedThreads: number;
  appliedThreads: number;
  hashMB: number;
  initMs: number;
  depth: number;
  nodes: number;
  nps: number;
  bestmove: string;
  ok: boolean;
  error?: string;
}

interface Manifest {
  version: string;
  upstreamCommit: string;
  net: { url: string; sha256: string };
  builds: Record<string, { js: string; wasm: string }>;
}

const statusEl = document.querySelector<HTMLElement>('#status')!;
const reportEl = document.querySelector<HTMLElement>('#report')!;
const markdownEl = document.querySelector<HTMLPreElement>('#markdown')!;

function setStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.className = error ? 'error' : '';
}

function describeEnvironment(): string {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return [
    `用户代理：${navigator.userAgent}`,
    `硬件并发：${navigator.hardwareConcurrency ?? '未知'} · 设备内存：${nav.deviceMemory ?? '未知'} GB`,
    `跨源隔离：${crossOriginIsolated ? '是' : '否'} · SharedArrayBuffer：${
      typeof SharedArrayBuffer === 'undefined' ? '无' : '有'
    }`,
  ].join('\n');
}

async function boot(): Promise<void> {
  setStatus('正在读取引擎清单…');
  const response = await fetch(new URL('engine/engine.json', document.baseURI));
  if (!response.ok) throw new Error(`引擎清单加载失败：HTTP ${response.status}`);
  const manifest = (await response.json()) as Manifest;
  const netUrl = new URL(manifest.net.url, document.baseURI).href;

  const rows: Row[] = [];
  for (const config of CONFIGS) {
    setStatus(`正在测试 ${config.build}（${config.threads} 线程）…`);
    const started = performance.now();
    let engine: Awaited<ReturnType<typeof createEngine>> | null = null;
    try {
      engine = await createEngine({
        builds: manifest.builds,
        build: config.build,
        threads: config.threads,
        netUrl,
        netSha256: manifest.net.sha256,
        workerFactory: () => new Worker(workerUrl, { type: 'classic', name: 'pikafish-bench' }),
      });
      const initMs = Math.round(performance.now() - started);

      const handle = await engine.analyze({ fen, movetime });
      let last: AnalysisInfo | null = null;
      for await (const info of handle.updates) {
        if (!info.multipv || info.multipv === 1) last = info;
      }
      const { bestmove } = await handle.result;

      rows.push({
        build: config.build,
        requestedThreads: config.threads,
        appliedThreads: engine.info?.threads ?? -1,
        hashMB: engine.info?.hashMB ?? -1,
        initMs,
        depth: last?.depth ?? -1,
        nodes: last?.nodes ?? -1,
        nps: last?.nps ?? -1,
        bestmove: bestmove || '—',
        ok: true,
      });
    } catch (error) {
      rows.push({
        build: config.build,
        requestedThreads: config.threads,
        appliedThreads: -1,
        hashMB: -1,
        initMs: Math.round(performance.now() - started),
        depth: -1,
        nodes: -1,
        nps: -1,
        bestmove: '—',
        ok: false,
        error: error instanceof PikafishError ? `${error.code}: ${error.message}` : String(error),
      });
    } finally {
      engine?.dispose();
    }
    render(rows, manifest);
  }

  setStatus('完成。数字只反映本机，可用于判断该设备适合哪套构建。');
}

const HEADERS = ['构建', '线程', 'Hash', '初始化', '深度', '节点数', 'NPS', '结果'];

function render(rows: Row[], manifest: Manifest): void {
  const header = HEADERS.map(h => `<th>${h}</th>`).join('');
  const body = rows
    .map(row => {
      const cells = row.ok
        ? [
            row.build,
            `${row.requestedThreads}（实际 ${row.appliedThreads}）`,
            `${row.hashMB} MB`,
            `${row.initMs} ms`,
            String(row.depth),
            row.nodes.toLocaleString('en-US'),
            row.nps.toLocaleString('en-US'),
            row.bestmove,
          ]
        : [row.build, `${row.requestedThreads}`, '—', `${row.initMs} ms`, '—', '—', '—', row.error ?? '失败'];
      return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    })
    .join('');

  reportEl.innerHTML = `
    <table>
      <caption>${describeEnvironment().split('\n').join(' · ')}</caption>
      <thead><tr>${header}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;

  const stamp = new Date().toISOString().slice(0, 10);
  const markdown = [
    `| ${HEADERS.join(' | ')} |`,
    `| ${HEADERS.map(() => '---').join(' | ')} |`,
    ...rows.map(row =>
      row.ok
        ? `| \`${row.build}\` | ${row.appliedThreads} | ${row.hashMB} MB | ${row.initMs} ms | ${row.depth} | ${row.nodes} | ${row.nps} | ${row.bestmove} |`
        : `| \`${row.build}\` | ${row.requestedThreads} | — | ${row.initMs} ms | — | — | — | ${row.error} |`,
    ),
    '',
    `> 采集于 ${stamp}，\`movetime ${movetime}\`，FEN \`${fen}\`，上游 commit \`${manifest.upstreamCommit}\``,
  ].join('\n');
  markdownEl.hidden = rows.length < CONFIGS.length;
  markdownEl.textContent = markdown;
}

void boot().catch(error => {
  setStatus(error instanceof Error ? error.message : String(error), true);
});
