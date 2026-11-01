/**
 * Screenshots of a replied choice item that shows the ferret's answer to the owner's question ABOVE its still-live
 * options: phone (390) and desktop, light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/agenda-question-answer-screenshot.tsx [outDir]   # writes <outDir>/question-answer-<scheme>-<viewport>.png
 *
 * Everything drawn is the REAL `AgendaItemView` with the real `AgendaSettled` line; only the data is invented.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? join(buildDir, 'question-answer'));

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
import { Markdown } from '../../src/components/markdown.tsx';
import { AgendaItemView } from '../../src/features/agenda/agenda-item-view.tsx';
import { AgendaSettled } from '../../src/features/agenda/agenda-settled.tsx';

const NOW = Date.UTC(2026, 9, 30, 9, 30, 0);

const item = {
  id: 'A163',
  source: 'agent-raised',
  sourceRef: null,
  sourceSeq: 1,
  title: 'Database for the board',
  subject: 'Which database should keep the board’s finished items?',
  why: 'The board needs somewhere to keep what is done.',
  waitingSince: '2026-10-30T09:00:00.000Z',
  howToResolve: 'Pick one.',
  raisedBy: 'agent',
  raisedBySession: 'fr',
  raisedByName: 'Zoe',
  ask: { kind: 'multiple-choice', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
  recommendation: { decision: 'SQLite', why: 'No server to run.' },
  premise: 'The board keeps every finished item, and reads are rare. Nothing else needs to query it.',
  context: 'Postgres would mean another service to run and back up.',
  questionAnswer:
    'WAL is the write-ahead log: SQLite appends every change to it before touching the database file, so a crash never leaves half a write. Pick either option below; this does not change them.',
  parked: { reason: 'replied', at: '2026-10-30T09:20:00.000Z' },
} as never;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px', display: 'grid' }}>
    <div style={{ height: 'min(900px, 95vh)', display: 'grid' }}>
      <AgendaItemView
        busy={false}
        error={null}
        ferret="Zoe"
        history={[]}
        item={item}
        now={NOW}
        onAct={() => undefined}
        onClose={() => undefined}
        parkedNote={<AgendaSettled busy={false} error={null} ferret="Zoe" item={item} now={NOW} />}
        position={{ index: 0, total: 1 }}
        renderProse={text => <Markdown text={text} />}
        swipeable={false}
      />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/question-answer-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'question-answer-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'question-answer-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
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
    const file = Bun.file(join(buildDir, url.pathname));
    return file.size > 0 ? new Response(file) : new Response('missing', { status: 404 });
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 900 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        timezoneId: 'Asia/Tokyo',
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => fail(`page error in ${scheme} ${viewport.name}: ${error.message}`));
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('.fy-item-view').waitFor({ state: 'visible' });
        await page.locator('[data-agenda-question-answer]').waitFor({ state: 'visible' });
        const live = await page.locator('[data-agenda-quick-replies] button').allInnerTexts();
        if (!live.some(text => text.includes('SQLite'))) fail(`${scheme} ${viewport.name}: options are not live`);
        if (live.some(text => /got it/i.test(text))) fail(`${scheme} ${viewport.name}: a Got it is drawn`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        const shot = join(outDir, `question-answer-${scheme}-${viewport.name}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        process.stdout.write(`📸 ${shot}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
