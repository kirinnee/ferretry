/**
 * Screenshots of a run of agent output naming the agent once, at desktop 1440 and phone 390 in the
 * light and dark studio themes. Review evidence only; nothing compares the PNGs.
 *
 *   bun harness/name-grouping-screenshot.tsx            # writes harness/out/name-grouping-after-*.png
 *   bun harness/name-grouping-screenshot.tsx --before   # the same fixture with no run marks (every text names the agent)
 *
 * It renders the REAL `TranscriptRow` with the marks the REAL `agentRuns` computes.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const BEFORE = process.argv.includes('--before');

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
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { agentRuns, transcriptItems, type TranscriptEntry } from '../../src/lib/session-screens.ts';

const at = (hh: number, mm: number): number => Date.UTC(2026, 9, 20, hh, mm, 0);
const call = (key: string, command: string) => ({ key, use: { name: 'Bash', input: { command } }, result: { text: 'ok' } });
const tools = (id: string, n: number): TranscriptEntry => ({
  id,
  kind: 'tool',
  text: 'ran',
  tools: Array.from({ length: n }, (_, i) => call(id + i, 'git status')),
});

const entries: TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: 'Why is the build red?', at: at(1, 45) },
  { id: 'a1', kind: 'assistant', text: 'Let me look at the CI log first.', at: at(1, 45) },
  tools('t1', 3),
  { id: 'a2', kind: 'assistant', text: 'Two tests time out. I am checking whether the retry flag stabilises them.', at: at(1, 46) },
  tools('t2', 2),
  { id: 'a3', kind: 'assistant', text: 'The retry flag fixes both. I have pushed the change.', at: at(1, 47) },
  { id: 'u2', kind: 'user', text: 'Thanks. Re-run CI tomorrow too.', at: at(1, 48) },
  { id: 'a4', kind: 'assistant', text: 'Will do.', at: at(1, 48) },
  { id: 'a5', kind: 'assistant', text: 'Back after a long gap: CI is green.', at: at(3, 10) },
].map(entry => withAgentName(entry as TranscriptEntry, 'Gasper'));

const items = transcriptItems(entries);
const runs = agentRuns(items);
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="fy-transcript-content" data-marks="">
        {items.map((item, index) => (
          <TranscriptRow entry={item.entry} key={item.entry.id} previous={item.previous} run={${BEFORE ? 'undefined' : 'runs[index]'}} />
        ))}
      </div>
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
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/name-grouping-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'name-grouping-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'name-grouping-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const tag = BEFORE ? 'before' : 'after';
const SIZES = [
  { name: 'desktop', width: 1440, height: 900, phone: false },
  { name: 'phone', width: 390, height: 844, phone: true },
] as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const size of SIZES) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 2,
        isMobile: size.phone,
        hasTouch: size.phone,
        timezoneId: 'Asia/Tokyo',
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-marks]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${size.name} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `name-grouping-${tag}-${size.name}-${scheme}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${target}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
