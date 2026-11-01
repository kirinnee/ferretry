/**
 * Mock screenshots of the machine home page — the five-number overview and the top interactive ferrets —
 * rendered from the REAL `MachineHome`, `StatusMark` and `UnreadBadge` with fake data, at a 390px phone and
 * a 1440px desktop in the light and dark studio themes.
 *
 *   MACHINE_HOME_SHOTS=/tmp/shots bun harness/machine-home-screenshot.tsx
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
import { MachineHome } from '../../src/components/machine-home.tsx';
import { sessionView } from '../../tests/support/sessions.ts';

const NOW = Date.parse('2026-10-31T09:00:00.000Z');
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString();
const ferret = (id, teammate, label, cwd, minutes, state = {}) =>
  sessionView(id, {
    config: { teammate, label, name: label, mode: 'interactive', cwd },
    state: { lastActivityAt: ago(minutes), ...state },
  });
const asking = (open, ask, minutes) => ({
  attention: { open, first: 'A' + open, ask, latestAt: ago(minutes) },
});
const home = '/home/kirin/Workspace';
const sessions = [
  ferret('lizzette', 'lizzette', 'Ferretry', home + '/personal/ferretry', 1,
    asking(1, "Should saved-password auto-fill work only for ferrets that provably can't read Ferretry's master key?", 1)),
  ferret('hadi', 'hadi', 'Executive Assistant', home + '/hq', 6, asking(2, 'Approve this week, or tell me what to change', 6)),
  ferret('durian', 'durian', 'Durian Lead', home + '/atomi', 3),
  ferret('johnnie', 'johnnie', 'Diene Work', home + '/atomi/diene', 8),
  ferret('ottilie', 'ottilie', 'Build Test Report', home + '/atomi/diene', 14, { status: 'awaiting_user' }),
  ferret('ora', 'ora', 'Nitroso Project', home + '/atomi/nitroso', 31),
  ferret('primo', 'primo', 'Primordial Lead', home + '/atomi/primordial', 55),
  ferret('cyan', 'cyan', 'CyanPrint', home + '/atomi/sulfone-lite', 190),
  ferret('hm', 'hm', 'try to run fy secret', home + '/home-manager', 400),
  sessionView('bot1', { config: { teammate: 'bot1', label: 'Sweep', name: 'Sweep', mode: 'auto', cwd: home + '/personal/ferretry' } }),
  sessionView('bot2', { config: { teammate: 'bot2', label: 'Sweep 2', name: 'Sweep 2', mode: 'auto', cwd: home + '/personal/ferretry' } }),
];
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'busy';
const quiet = scenario === 'quiet';
const view = quiet
  ? sessions.filter(s => s.config.mode === 'interactive').map(s => ({ ...s, state: { ...s.state, attention: undefined } }))
  : sessions;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="bg-bg text-fg" data-shot="" style={{ minHeight: 640, padding: window.innerWidth < 640 ? '8px 0' : '16px 24px' }}>
    <MachineHome
      daemonId={'harness'}
      health={quiet ? { tone: 'ok', word: 'Healthy', detail: 'checks swept now' } : { tone: 'warn', word: '2 to look at', detail: 'card orphaned' }}
      machineName="Liftoff EC2"
      now={NOW}
      onNavigate={() => {}}
      sessions={view}
      spendTodayUsd={quiet ? 0 : 184.2}
      toTest={quiet ? 0 : 3}
    />
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/machine-home-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'machine-home-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'machine-home-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'machine-home-entry.tsx'));
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
    if (url.pathname.startsWith('/assets/fonts/')) {
      return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    }
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const shotsDir = process.env.MACHINE_HOME_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const scenario of ['busy', 'quiet'] as const) {
        if (scenario === 'quiet' && scheme === 'dark' && viewport.name === 'desktop') continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          reducedMotion: 'reduce',
          ...(viewport.name === 'phone' ? { isMobile: true, hasTouch: true } : {}),
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
            return await route.continue();
          });
          const page = await context.newPage();
          const label = `${viewport.name}/${scheme}/${scenario}`;
          page.on('pageerror', error => fail(`${label}: ${error.message}`));
          await page.goto(`${server.url}?theme=studio-${scheme}&scenario=${scenario}`);
          await page.locator('[data-home-tile]').first().waitFor({ state: 'visible' });
          const tiles = await page.locator('[data-home-tile]').count();
          if (tiles !== 5) fail(`${label}: expected 5 overview tiles, saw ${tiles}`);
          const rows = await page.locator('[data-home-ferret]').count();
          if (rows > 6) fail(`${label}: ${rows} ferret rows, expected at most 6`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${label}: scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `home-${viewport.name}-${scheme}${scenario === 'quiet' ? '-quiet' : ''}.png`);
          await page.locator('[data-shot]').screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
