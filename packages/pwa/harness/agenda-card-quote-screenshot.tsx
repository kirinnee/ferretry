/**
 * Screenshots of quoting from an open agenda card: text selected in the card's premise, the "Quote in composer"
 * menu, and the quote sitting in the composer beneath it. Phone width (390) and desktop (1440), light and dark.
 * Review evidence; nothing compares the PNGs.
 *
 *   bun harness/agenda-card-quote-screenshot.tsx [outDir]   # writes <outDir>/agenda-card-quote-<step>-<scheme>-<viewport>.png
 *
 * Everything drawn is the REAL thing: `AgendaItemView` (with its History as the chat's own `TranscriptRow`s), the
 * real `Composer`, and the quote plumbing between them. Only the data is invented and nothing is sent. The phone
 * frames are a 390px window with a MOUSE right-click: a finger's long-press keeps the browser's own selection
 * menu on purpose (`context-menu-policy.ts`), in the chat as on the card.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? join(buildDir, 'agenda-card-quote'));

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
import { Composer } from '../../src/components/composer.tsx';
import { Markdown } from '../../src/components/markdown.tsx';
import { AgendaItemView } from '../../src/features/agenda/agenda-item-view.tsx';
import type { HistoryEvent } from '../../src/lib/agenda-history.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'harness' });
const scope = daemonSessionScope(connection, 'fr');
const NOW = Date.UTC(2026, 9, 30, 9, 30, 0);
const entries = new Map<string, string>();
const draftStore = new DaemonDraftStore({
  getItem: key => entries.get(key) ?? null,
  setItem: (key, value) => {
    entries.set(key, value);
  },
});

const item = {
  id: 'A47',
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
} as never;

const history: HistoryEvent[] = [
  {
    kind: 'ferret',
    key: 'f1',
    at: NOW - 600_000,
    text: 'I raised !A47 about where finished items live.',
    entry: { id: 'f1', kind: 'assistant', label: 'Zoe', text: 'I raised !A47 about where finished items live.', at: NOW - 600_000 },
  },
  {
    kind: 'owner-text',
    key: 'o1',
    at: NOW - 300_000,
    text: 'Is Postgres overkill here?',
    entry: { id: 'o1', kind: 'user', text: 'Is Postgres overkill here?', at: NOW - 300_000 },
  },
] as never;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px', display: 'grid', gap: 12 }}>
    <div style={{ height: 'min(640px, 70vh)', display: 'grid' }}>
      <AgendaItemView
        busy={false}
        error={null}
        ferret="Zoe"
        history={history}
        item={item}
        now={NOW}
        onAct={() => undefined}
        onClose={() => undefined}
        onProgress={async () => undefined}
        position={{ index: 0, total: 1 }}
        quoteScope={scope}
        renderProse={text => <Markdown text={text} />}
        swipeable={false}
      />
    </div>
    <div data-harness-composer="">
      <Composer api={{ send: async () => ({}) as never }} daemon={connection} draftStore={draftStore} sessionId="fr" />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/agenda-card-quote-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'agenda-card-quote-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'agenda-card-quote-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 900 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
const QUOTED = 'reads are rare';

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
        await page.locator('[data-harness-composer] [data-live-editor]').waitFor({ state: 'visible' });

        await page.evaluate(() => {
          for (const d of document.querySelectorAll('.fy-item-view details')) d.setAttribute('open', '');
        });

        // Select the words inside the premise, as a reader dragging across them would.
        const box = await page.evaluate(text => {
          const walker = document.createTreeWalker(
            document.querySelector('.fy-item-view') as Node,
            NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(text);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + text.length);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
            const rect = range.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.bottom - 2 };
          }
          return null;
        }, QUOTED);
        if (box === null) fail(`${scheme} ${viewport.name}: the premise text to select was not found`);
        const point = box as { x: number; y: number };

        // A mouse right-click on the selection: pointerdown then contextmenu.
        await page.evaluate(({ x, y }) => {
          const target = document.elementFromPoint(x, y) as HTMLElement;
          target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }),
          );
          target.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
          );
        }, point);
        await page.getByRole('menuitem', { name: 'Quote in composer' }).waitFor({ state: 'visible' });
        const menuShot = join(outDir, `agenda-card-quote-menu-${scheme}-${viewport.name}.png`);
        await page.screenshot({ path: menuShot, fullPage: true });
        process.stdout.write(`📸 ${menuShot}\n`);

        await page.getByRole('menuitem', { name: 'Quote in composer' }).click();
        const value = await page.locator('[data-harness-composer] [data-live-editor]').innerText();
        if (!value.includes(QUOTED)) fail(`${scheme} ${viewport.name}: the composer holds ${JSON.stringify(value)}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        const quotedShot = join(outDir, `agenda-card-quote-quoted-${scheme}-${viewport.name}.png`);
        await page.screenshot({ path: quotedShot, fullPage: true });
        process.stdout.write(`📸 ${quotedShot}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
