/**
 * Screenshots of the "Outdated" mark and the one "Restart outdated (N)" button, as the app draws them: the
 * sessions bar (a column on a desktop, the drawer on a phone) with outdated ferrets marked and the button at
 * the head of the list, before a press (`list`) and after it, showing what restarted now and what is queued
 * (`result`), under the REAL session header. Light and dark studio themes. Review evidence for
 * `docs/launch-settings.md`; nothing compares the PNGs.
 *
 *   bun harness/restart-outdated-screenshot.tsx [--out <dir>]    # writes restart-outdated-*.png
 *
 * The daemon behind the button is answered inside the page and changes nothing. Like the other harnesses it
 * drives the system Chrome through playwright-core and aborts every request off the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const outFlag = process.argv.indexOf('--out');
const shotsDir = outFlag === -1 ? outDir : resolve(process.argv[outFlag + 1] ?? outDir);

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
import { SessionTopBar } from '../../src/components/session-top-bar.tsx';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../tests/support/sessions.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const make = (id, label, sections) => ({
  ...sessionView(id, {
    config: { teammate: id, label, mode: 'interactive', cwd: '/work/ferretry' },
    state: { lastActivityAt: NOW },
  }),
  ...(sections === undefined ? {} : { outdated: { sections } }),
});
const open = make('hadi', 'Fix the stuck sign-in', ['pack', 'notify']);
const sessions = [
  open,
  make('maryah', 'Wire the relay bundle', ['tools']),
  make('ora', 'Plain chores'),
  make('wren', 'Review the grants docs', ['agenda']),
];
const compact = window.innerWidth < 640;
const restart = async () => ({
  restarted: [{ id: 'ora', name: 'Ora' }],
  queued: [
    { id: 'hadi', name: 'Hadi', reason: 'own-session' },
    { id: 'wren', name: 'Wren', reason: 'mid-turn' },
  ],
  skipped: [],
  failed: [],
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="flex flex-col bg-bg text-fg" style={{ minHeight: 560 }} data-shot="">
    <SessionTopBar
      actions={null}
      compact={compact}
      project="ferretry"
      session={open}
      onOpenSessions={compact ? () => {} : undefined}
    />
    <div style={{ display: 'flex' }}>
      <SessionsBar
        active={null}
        activeSessionId="hadi"
        daemonId={'harness'}
        machineName="studio"
        machines={[]}
        onAddMachine={() => {}}
        onClose={() => {}}
        onCollapse={() => {}}
        onNavigate={() => {}}
        onOpenPalette={() => {}}
        onRestartOutdated={restart}
        presentation={compact ? 'drawer' : 'column'}
        projects={[]}
        sessions={sessions}
      />
    </div>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg"><div id="root"></div><script type="module" src="/restart-outdated-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(outDir, 'restart-outdated-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'restart-outdated-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'restart-outdated-entry.tsx'));
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
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

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
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-restart-outdated-button]').waitFor({ state: 'visible' });
        const shoot = async (scene: string): Promise<void> => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `restart-outdated-${scene}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        };
        await shoot('list');
        await page.locator('[data-restart-outdated-button]').click();
        await page.locator('[data-restart-outdated-result]').waitFor({ state: 'visible' });
        await shoot('result');
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
