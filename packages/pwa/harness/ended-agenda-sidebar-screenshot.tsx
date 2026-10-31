/**
 * &B59: a FAILED (red) session that still has an open agenda item stays in the sessions bar's "Needs you"
 * group, with its badge and ask, so the owner can open and dismiss it. Phone 390px and desktop 1440px, light and dark.
 *
 *   bun harness/ended-agenda-sidebar-screenshot.tsx    # writes harness/out/ended-agenda-sidebar-*.png
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
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../tests/support/sessions.ts';

const NOW = '2026-10-30T09:00:00.000Z';
const ended = (id, label, status, open, ask, minutes) =>
  sessionView(id, {
    config: { teammate: id, label, name: 'Home setup', mode: 'interactive', cwd: '/home/kirin/Workspace/personal/ferretry' },
    state: {
      status,
      lastActivityAt: NOW,
      attention: { open, first: 'A' + open, ask, latestAt: new Date(Date.parse(NOW) - minutes * 60_000).toISOString() },
    },
  });
const sessions = [
  ended('home-manager', 'Home manager', 'failed', 1, 'Which lanes should the board have?', 12),
  ended('retired', 'Old audit', 'stopped', 2, 'Ship it, or hold for review?', 90),
  sessionView('ora', { config: { teammate: 'ora', label: 'Plain chores', mode: 'interactive', cwd: '/home/kirin/Workspace/personal/ferretry' }, state: { lastActivityAt: NOW } }),
];
const compact = window.innerWidth < 640;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="bg-bg text-fg" data-shot="" style={{ width: compact ? 390 : 340, minHeight: 760 }}>
    <SessionsBar
      active={null}
      activeSessionId="ora"
      daemonId={'harness'}
      machineName="Liftoff EC2"
      machines={[]}
      onAddMachine={() => {}}
      onClose={() => {}}
      onCollapse={() => {}}
      onNavigate={() => {}}
      onOpenPalette={() => {}}
      presentation="column"
      projects={[]}
      sessions={sessions}
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/ended-agenda-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'ended-agenda-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'ended-agenda-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'ended-agenda-entry.tsx'));
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
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = Bun.file(join(outDir, url.pathname));
    return (await file.exists()) ? new Response(file) : new Response('missing', { status: 404 });
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const shotsDir = process.env.ENDED_AGENDA_SHOTS ?? outDir;
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
        const label = `${viewport.name}/${scheme}`;
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const group = page.locator('[data-sbar-needs-you-group]');
        await group.waitFor({ state: 'visible' });
        const rows = await group.locator('li').count();
        if (rows < 2) fail(`${label}: expected 2 Needs you rows, saw ${rows}`);
        const buttons = await group.locator('button, [data-needs-you-action]').count();
        if (buttons > 0) fail(`${label}: a Needs you row carries ${buttons} control(s)`);
        const words = (await group.textContent()) ?? '';
        if (/asked for you|\bDone\b|\bDismiss\b/u.test(words)) fail(`${label}: the old Done / Dismiss strip is back`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${label}: scrolls sideways by ${overflow}px`);
        const target = join(shotsDir, `ended-agenda-sidebar-${viewport.name}-${scheme}.png`);
        await page.locator('[data-shot]').screenshot({ path: target });
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
