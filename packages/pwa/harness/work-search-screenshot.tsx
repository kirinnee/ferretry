/**
 * Screenshots of the finder (Cmd/Ctrl+K) and the composer pickers over the daemon work search: a mixed list of
 * cards (open, closed) and agenda items (open, addressed) found by words in their text, the Cards filter, and
 * the `@@@` agenda picker with daemon hits under the local rows. 390px phone and 1440px desktop, light and dark.
 * Review evidence; nothing compares the PNGs and they are never committed.
 *
 *   bun harness/work-search-screenshot.tsx    # writes /tmp/claude-1000/shots/work-search/work-search-*.png
 *
 * It renders the REAL `CommandPalette` and `Composer` with a fixed fake search port injected, so nothing reaches a
 * daemon. Like `task-picker-screenshot.tsx` it drives the system Chrome through playwright-core and aborts every
 * request off the loopback origin. WORK_SEARCH_SHOTS names another directory for the PNGs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
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
import { CommandPalette } from '../../src/shell/command-palette.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { composerSuggestionSwitches } from '../../src/components/composer-autocomplete.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'd' });
const at = '2026-10-30T09:40:00.000Z';
const hits = [
  { kind: 'task', id: 'F412', projectId: 'ferretry', sessionId: 's1', title: 'Harden the relay handshake', state: 'open', standing: 'Doing', updatedAt: at, match: { field: 'brief', line: 'the relay handshake drops when the phone sleeps' }, score: 9 },
  { kind: 'task', id: 'F377', projectId: 'ferretry', sessionId: 's2', title: 'Pick a relay region', state: 'open', standing: 'To do', updatedAt: at, match: { field: 'note', line: 'frankfurt or virginia for the hosted relay' }, score: 7 },
  { kind: 'task', id: 'F301', projectId: 'ferretry', sessionId: 's2', title: 'Relay directory advertisement', state: 'closed', standing: 'Shipped', updatedAt: at, match: { field: 'resolution', line: 'shipped the relay directory behind a flag' }, score: 5 },
  { kind: 'task', id: 'F290', projectId: 'ferretry', sessionId: null, title: 'Self-host the relay on a spare box', state: 'dropped', standing: 'Dropped', updatedAt: at, match: { field: 'body', line: 'dropped: the hosted relay covers this' }, score: 3 },
  { kind: 'agenda', id: 'A3', sessionId: 's1', title: 'Which relay region should we pick?', state: 'open', standing: 'open', updatedAt: at, match: { field: 'body', line: 'frankfurt is closer to most owners than virginia' }, score: 8 },
  { kind: 'agenda', id: 'A8', sessionId: 's1', title: 'Hosted or self-hosted relay for the pilot?', state: 'open', standing: 'snoozed', updatedAt: at, match: { field: 'body', line: 'the pilot owners asked for a relay they run themselves' }, score: 6 },
  { kind: 'agenda', id: 'A7', sessionId: 's2', title: 'Ship the relay behind a flag?', state: 'closed', standing: 'addressed', updatedAt: at, match: { field: 'resolution', line: 'yes, flagged until the daemon side lands' }, score: 4 },
];
const port = {
  search: async (request) => {
    const found = hits.filter(hit => (request.kind === undefined || hit.kind === request.kind) && (request.open !== true || hit.state === 'open'));
    return { hits: found, total: found.length, indexed: hits.length };
  },
};
const params = new URLSearchParams(location.search);
const scene = params.get('scene');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  scene === 'picker' ? (
    <div className="flex min-h-[460px] flex-col justify-end bg-bg p-4 text-fg" style={{ maxWidth: 720, margin: '0 auto' }} data-shot="">
      <Composer
        api={{ send: async () => undefined }}
        autocompleteFetcher={async () => Response.json({}, { status: 500 })}
        autocompleteAgenda={[{ id: 'A3', subject: 'Which relay region should we pick?', source: 'question' }]}
        autocompleteWorkSearch={port}
        compact={params.get('compact') === '1'}
        daemon={daemon}
        sessionId="s1"
        suggestions={composerSuggestionSwitches('ladder', true)}
      />
    </div>
  ) : (
    <CommandPalette open focusSignal={0} onClose={() => {}} daemon={daemon.daemonId} sessions={[]} destinations={[]} onNavigate={() => {}} workSearch={port} />
  ),
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg"><div id="root"></div><script type="module" src="/work-search-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'work-search-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'work-search-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'work-search-entry.tsx'));
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

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, compact: '1' },
  { name: 'desktop', width: 1_440, height: 900, compact: '0' },
] as const;

type Scene = {
  readonly name: string;
  readonly scene: 'palette' | 'picker';
  readonly draft: string;
  readonly chip?: string;
};

const SCENES: readonly Scene[] = [
  { name: 'palette-mixed', scene: 'palette', draft: 'relay' },
  { name: 'palette-cards', scene: 'palette', draft: 'relay', chip: 'Cards' },
  { name: 'palette-agenda', scene: 'palette', draft: 'relay', chip: 'Agenda' },
  { name: 'palette-open', scene: 'palette', draft: 'relay', chip: 'Open' },
  { name: 'picker-agenda', scene: 'picker', draft: '@@@relay' },
];

const shotsDir = process.env.WORK_SEARCH_SHOTS ?? '/tmp/claude-1000/shots/work-search';
mkdirSync(shotsDir, { recursive: true });
const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => fail(`the page threw: ${error.message}`));
        for (const scene of SCENES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&scene=${scene.scene}&compact=${viewport.compact}`);
          if (scene.scene === 'palette') {
            const field = page.locator('#fy-palette-input');
            await field.waitFor({ state: 'visible' });
            await field.fill(scene.draft);
            await page.locator('[data-palette-work-kind], [role=option]').nth(3).waitFor({ state: 'visible' });
            if (scene.chip !== undefined) {
              await page.getByRole('button', { name: scene.chip, exact: true }).click();
              await page.waitForTimeout(400);
            }
          } else {
            const field = page.locator('[data-live-editor]');
            await field.waitFor({ state: 'visible' });
            await field.click();
            await page.keyboard.type(scene.draft);
            await page.locator('[data-kind=attention]').nth(1).waitFor({ state: 'visible' });
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene.name} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `work-search-${scene.name}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
