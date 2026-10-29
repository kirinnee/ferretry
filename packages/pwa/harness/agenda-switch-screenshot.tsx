/**
 * Screenshots of the three per-ferret switches — Hypermedia, Pack mode and Agenda mode — as the app
 * draws them: the Actions menu with all three toggles (`menu`), and the switch marks in the session
 * header and in the sessions list (`marks`), at a 390px phone and a 1440px desktop, in the light and dark
 * studio themes. Review evidence for the Agenda switch; nothing compares the PNGs.
 *
 *   bun harness/agenda-switch-screenshot.tsx          # writes harness/out/agenda-switch-*.png
 *
 * It renders the REAL `SessionTopBar`, `ActionsMenu` (over the three real session-action hooks) and
 * `SessionsBar`, so the toggles and marks are the shipped ones; the daemon behind them is answered inside
 * the page and changes nothing. Like `pack-mode-screenshot.tsx` it drives the system Chrome through
 * playwright-core and aborts every request off the loopback origin.
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
import { SessionTopBar } from '../../src/components/session-top-bar.tsx';
import { useAgendaSessionActions } from '../../src/features/agenda/agenda-session-actions.tsx';
import { useHypermediaSessionActions } from '../../src/features/hypermedia/hypermedia-session-actions.tsx';
import { usePackSessionActions } from '../../src/features/pack/pack-session-actions.tsx';
import { ActionsMenu } from '../../src/features/session-actions/actions-menu.tsx';
import { sessionActionSections } from '../../src/features/session-actions/registry.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../tests/support/sessions.ts';

const connection = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'd' });
const fetcher = async () => new Response('{}', { status: 500 });
const NOW = '2026-01-01T00:00:00.000Z';
const view = sessionView('hadi', {
  config: { teammate: 'hadi', label: 'Fix the stuck sign-in', mode: 'interactive', hypermedia: true, pack: true, agenda: true, cwd: '/work/ferretry' },
  state: { lastActivityAt: NOW },
});
const others = [
  sessionView('maryah', { config: { teammate: 'maryah', label: 'Wire the relay bundle', mode: 'interactive', hypermedia: false, pack: false, agenda: true, cwd: '/work/ferretry' }, state: { lastActivityAt: NOW } }),
  sessionView('ora', { config: { teammate: 'ora', label: 'Plain chores', mode: 'interactive', hypermedia: false, pack: false, cwd: '/work/ferretry' }, state: { lastActivityAt: NOW } }),
];
const which = new URLSearchParams(location.search).get('state');
const compact = window.innerWidth < 640;

function Menu() {
  const hypermedia = useHypermediaSessionActions({ connection, fetcher });
  const pack = usePackSessionActions({ connection, fetcher });
  const agenda = useAgendaSessionActions({ connection, fetcher });
  const context = { view, canControl: true };
  const sections = sessionActionSections(
    [...hypermedia.contributions, ...pack.contributions, ...agenda.contributions],
    context,
  );
  return <ActionsMenu sections={sections} compact={compact} name="Hadi" form={null} onFormChange={() => {}} />;
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="flex flex-col bg-bg text-fg" style={{ minHeight: 420 }} data-shot="">
    <SessionTopBar
      actions={null}
      compact={false}
      menu={<Menu />}
      project="ferretry"
      session={view}
      switches={{ learning: true, hypermedia: true, pack: true, agenda: true }}
    />
    {which === 'marks' ? (
      <div style={{ width: compact ? 340 : 320, margin: '16px' }}>
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
          presentation="column"
          projects={[]}
          sessions={[view, ...others]}
        />
      </div>
    ) : null}
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/agenda-switch-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'agenda-switch-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'agenda-switch-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'agenda-switch-entry.tsx'));
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
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const SCENES = ['menu', 'marks'] as const;

const shotsDir = process.env.AGENDA_SWITCH_SHOTS ?? outDir;
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
        for (const scene of SCENES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${scene}`);
          await page.locator('[data-shot]').waitFor({ state: 'visible' });
          if (scene === 'menu') {
            await page.locator('[data-session-actions-trigger]').click();
            await page.locator('[data-session-action-item="agenda"]').waitFor({ state: 'visible' });
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `agenda-switch-${scene}-${viewport.name}-${scheme}.png`);
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
