/**
 * Screenshots of the sessions bar's "Pinned" group — two pinned ferrets (one live, one finished and dimmed)
 * above "Needs you" and the rest — plus the row menu offering "Pin to top" / "Unpin", at a 390px phone and a
 * 1440px desktop, in the light and dark studio themes.
 *
 *   bun harness/pinned-sidebar-screenshot.tsx      # writes harness/out/pinned-sidebar-*.png
 *
 * It renders the REAL `SessionsBar` with the REAL row-menu registry, and FAILS when a pinned ferret also
 * appears below Pinned, when Pinned is not the first group, when the menu lacks its pin entry, or when the
 * page scrolls sideways. Like `needs-you-sidebar-screenshot.tsx` it drives the system Chrome through
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
import { sessionRowMenuRenderer } from '../../src/features/session-actions/row-actions-host.tsx';
import { useAppViewport } from '../../src/hooks/use-app-viewport.ts';
import { DaemonAccountPickerStore } from '../../src/lib/account-picker-store.ts';
import { DaemonConnectionStore } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { DaemonProjectsStore } from '../../src/lib/projects-store.ts';
import { StoreProvider } from '../../src/lib/store.tsx';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../tests/support/sessions.ts';

const NOW = '2026-10-30T09:00:00.000Z';
const DAEMON_ID = 'fy_daemon_' + 'Cc'.repeat(21) + 'A';
const CONNECTION = daemonConnection({ daemonId: DAEMON_ID, baseUrl: 'https://workstation.example.test', deviceId: 'harness' });
const cwd = '/home/kirin/Workspace/personal/ferretry';
const row = (id, label, state = {}, pinnedAt) =>
  sessionView(id, {
    config: { teammate: id, label, mode: 'interactive', cwd },
    state: { lastActivityAt: NOW, ...state },
    ...(pinnedAt === undefined ? {} : { pinnedAt }),
  });
const sessions = [
  row('lizzette', 'Ferretry', {}, '2026-10-30T08:00:00.000Z'),
  row('maryah', 'Release notes', { status: 'completed' }, '2026-10-30T08:30:00.000Z'),
  row('johnnie', 'Diene Work', {
    attention: { open: 2, first: 'A2', ask: 'Give the 12 strip variants nothing but their own price', latestAt: '2026-10-30T08:50:00.000Z' },
  }),
  row('ottilie', 'Labelling'),
  row('hadi', 'Executive Assistant'),
];

const store = {
  connections: new DaemonConnectionStore({
    connections: [{ ...CONNECTION, pairedAt: 1, lastSelectedAt: 1 }],
    selectedDaemonId: CONNECTION.daemonId,
  }),
  clients: { client: async () => ({ request: async () => ({ capabilities: [], governed: false }) }) },
  fleet: new DaemonFleetStore({ list: async () => sessions, get: async () => sessions[0] }),
  projects: new DaemonProjectsStore({ projects: async () => [] }),
  accountPicker: new DaemonAccountPickerStore({
    catalog: async () => ({ accounts: [] }),
    health: async () => ({ credentials: [] }),
    probe: async () => ({ credentials: [] }),
  }),
  carrier: { fetch: async () => Response.json({ passive: [], sessions: [] }) },
};
const renderMenu = sessionRowMenuRenderer(() => undefined);
const compact = window.innerWidth < 640;

function Harness() {
  useAppViewport();
  return (
    <StoreProvider store={store}>
      <div className="bg-bg text-fg" data-shot="" style={{ width: compact ? 390 : 340, minHeight: 760 }}>
        <SessionsBar
          active={null}
          activeSessionId="lizzette"
          daemonId={CONNECTION.daemonId}
          machineName="Liftoff EC2"
          machines={[]}
          onAddMachine={() => {}}
          onClose={() => {}}
          onCollapse={() => {}}
          onNavigate={() => {}}
          onOpenPalette={() => {}}
          onTogglePin={() => {}}
          presentation="column"
          projects={[]}
          renderSessionMenu={renderMenu}
          sessions={sessions}
        />
      </div>
    </StoreProvider>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Harness />);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg"><div id="root"></div><script type="module" src="/pinned-sidebar-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'pinned-sidebar-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'pinned-sidebar-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'pinned-sidebar-entry.tsx'));
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

const shotsDir = process.env.PINNED_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    const phone = viewport.name === 'phone';
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        ...(phone ? { hasTouch: true, isMobile: true } : {}),
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        const label = `${viewport.name}/${scheme}`;
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const group = page.locator('[data-sbar-pinned-group]');
        await group.waitFor({ state: 'visible' });
        const pinnedRows = await group.locator('li').count();
        if (pinnedRows !== 2) fail(`${label}: expected 2 Pinned rows, saw ${pinnedRows}`);
        for (const id of ['lizzette', 'maryah']) {
          const copies = await page.locator(`[data-sbar-session="${id}"]`).count();
          if (copies !== 1) fail(`${label}: pinned ${id} shows ${copies} times`);
        }
        const groups = await page
          .locator('.fy-sbar__group')
          .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
        if (groups[0] !== 'Pinned') fail(`${label}: Pinned is not the first group: ${groups.join(' | ')}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${label}: scrolls sideways by ${overflow}px`);
        const sidebar = join(shotsDir, `pinned-sidebar-${viewport.name}-${scheme}.png`);
        if (!phone) await page.locator('[data-sbar-session="ottilie"]').hover();
        await page.locator('[data-shot]').screenshot({ path: sidebar });
        process.stdout.write(`📸 ${sidebar}\n`);

        const target = page.locator('[data-sbar-session="ottilie"]');
        if (phone) {
          const box = await target.boundingBox();
          if (box === null) fail(`${label}: no box for the row`);
          const client = await context.newCDPSession(page);
          const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, id: 1 };
          await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
          await page.waitForTimeout(700);
          await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await target.click({ button: 'right' });
        }
        const menu = page.getByRole('menu', { name: /actions$/u });
        await menu.waitFor({ state: 'visible' });
        const labels = (await menu.getByRole('menuitem').allTextContents()).map(text => text.trim());
        if (!labels.some(text => text.startsWith('Pin to top')))
          fail(`${label}: the row menu has no "Pin to top": ${labels.join(' | ')}`);
        const menuShot = join(shotsDir, `pinned-menu-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: menuShot, animations: 'disabled' });
        process.stdout.write(`📸 ${menuShot}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
