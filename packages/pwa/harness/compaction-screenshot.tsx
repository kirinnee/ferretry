/**
 * The compaction card and its divider, in the real transcript: with the harness's own percentage (49%,
 * 93%), with none reported (Codex, older Claude Code: spinner, clock, usual duration) and done — desktop
 * 1440 and phone 390, light and dark.
 *
 *   bun harness/compaction-screenshot.tsx      # writes harness/out/compaction-<state>-<viewport>-<theme>.png
 *
 * It renders the REAL `Transcript`, `CompactionCard`, `CompactionStrip` and `CompactionChip`, fed the
 * `live` frame the daemon would send. It fails if a state scrolls the page sideways.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { CompactionChip } from '../../src/components/compaction-card.tsx';
import { Transcript } from '../../src/components/transcript.tsx';

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? '49';
const EXPECTED_MS = 60_000;
const now = Date.now();
const rows = [
  { id: 'u1', kind: 'user', text: 'Refactor the cache layer so entries expire per tenant, then run the whole suite.', at: now - 900_000 },
  { id: 'a1', kind: 'assistant', text: 'I moved expiry into the tenant scope and updated the 14 call sites. The suite is green except two snapshot tests, which I will refresh next.', at: now - 600_000 },
  { id: 'u2', kind: 'user', text: 'Great, keep going.', at: now - 420_000 },
];
const running = extra => ({
  phase: 'running',
  startedAt: new Date(now - 434_000).toISOString(),
  tokensBefore: 412_000,
  expectedMs: EXPECTED_MS,
  basis: 'history',
  ...extra,
});
const runningFor = state =>
  state === 'bare' ? running({ startedAt: new Date(now - 26_000).toISOString() }) : running({ percent: Number(state), tokensWritten: 37_400 });
const done = { phase: 'done', trigger: 'auto', startedAt: new Date(now - 41_000).toISOString(), endedAt: new Date(now - 1_000).toISOString(), tokensBefore: 412_000, tokensAfter: 38_000 };
const compaction = state === 'done' ? done : runningFor(state);
const live = { sessionId: 's1', at: new Date(now).toISOString(), compaction };

const root = document.getElementById('root');
createRoot(root).render(
  <main data-fixture="" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
    <header style={{ alignItems: 'center', display: 'flex', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
      <b style={{ fontSize: 14 }}>cache-layer-refactor</b>
      {compaction.phase === 'running' ? <CompactionChip compaction={compaction} /> : null}
    </header>
    <div className="kt-chat-surface" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <Transcript daemonId="d" entries={rows} live={live} sessionId="s1" />
    </div>
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/compaction-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'compaction-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'compaction-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 640, phone: false },
  { name: 'phone', width: 390, height: 560, phone: true },
] as const;

try {
  for (const state of ['49', '93', 'bare', 'done']) {
    for (const viewport of VIEWPORTS) {
      for (const scheme of ['light', 'dark'] as const) {
        const theme = `studio-${scheme}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          isMobile: viewport.phone,
          hasTouch: viewport.phone,
          colorScheme: scheme,
        });
        try {
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
          );
          const page = await context.newPage();
          await page.goto(`${server.url}?theme=${theme}&state=${state}`);
          await page.locator('[data-fixture]').waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${state}/${viewport.name}/${theme} scrolls sideways by ${overflow}px`);
          await page.screenshot({ path: join(outDir, `compaction-${state}-${viewport.name}-${theme}.png`) });
          process.stdout.write(`📸 compaction-${state}-${viewport.name}-${theme}.png\n`);
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}
