/**
 * The Sharing page (docs/design/catalogs-sharing.md, slice 3a): its four tabs, and the places that lead to
 * it: the phone's More sheet, the desktop top bar, the sidebar footer and the narrow rail. On a phone and a
 * desktop, light and dark.
 *
 *   bun harness/sharing-screenshot.tsx      # writes harness/out/sharing-*.png
 *
 * It renders the REAL `SharingPage`, `AppBar`, `AppTabBar`, `SessionsBar` and `FleetNavigationRail` against
 * invented machines, catalogs, people and skills. Nothing here is a real key, code or pairing; the member
 * subscription is the throwaway one the unit tests use. It fails if any frame scrolls sideways.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

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
import { SharingPage } from '../../src/features/sharing/sharing-page.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { AppBar, AppTabBar } from '../../src/shell/app-bar.tsx';
import { FleetNavigationRail } from '../../src/shell/fleet-navigation-rail.tsx';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import { ThemeToggle } from '../../src/shell/theme-toggle.tsx';
import { sessionView } from '../../tests/support/sessions.ts';
import { sharedItemFixture } from '../../tests/support/shared-screens.ts';

const AT = '2026-10-31T09:00:00.000Z';
const NOW = Date.parse(AT);
const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: 'studio-mac' });
const CATALOG = 'cat_' + 'c'.repeat(22);
const OTHER = 'cat_' + 'r'.repeat(22);
const MEMBER_A = 'mbr_' + 'a'.repeat(22);
const MEMBER_B = 'mbr_' + 'b'.repeat(22);
const DIGEST = 'sha256:' + 'ab'.repeat(32);
const PUBLISHER = 'fy_daemon_' + 'q3Xk'.repeat(10) + 'Xkq';

const version = (n, size) => ({ version: n, digest: DIGEST, size, publishedAt: AT });
const item = (id, kind, name, summary, source) => ({
  itemId: id, kind, name, summary, source, versions: [version(1, 1200)], sourceState: 'unchanged',
});
const owned = (id, name, items) => ({
  id, name, description: '', publisherName: 'studio-mac', visibility: 'members', revision: 4,
  issuedAt: AT, createdAt: AT, items,
});
const CATALOGS = [
  owned(CATALOG, 'Team skills', [
    item('itm_' + 's'.repeat(22), 'skill', 'pdf-tools', 'Split, merge and OCR PDFs', { kind: 'skill', path: '/home/k/.claude/skills/pdf-tools/SKILL.md' }),
    item('itm_' + 'm'.repeat(22), 'mcp', 'acme-mcp', 'Talk to Acme', { kind: 'mcp', id: 'acme', name: 'acme-mcp' }),
  ]),
  owned(OTHER, 'Reading list', []),
];
const MEMBERS = [
  {
    memberId: MEMBER_A, label: 'Alice', catalogIds: [CATALOG, OTHER], createdAt: '2026-10-29T09:00:00.000Z',
    keys: [
      { keyId: 'mk_' + '1'.repeat(22), clientName: 'Firefox on a Mac', joinedAt: '2026-10-29T09:05:00.000Z', lastSeenAt: '2026-10-31T07:00:00.000Z', passkeys: 1 },
      { keyId: 'mk_' + '2'.repeat(22), clientName: 'Chrome on a phone', joinedAt: '2026-10-30T18:30:00.000Z', passkeys: 0 },
    ],
  },
  {
    memberId: MEMBER_B, label: 'Bob', catalogIds: [CATALOG], createdAt: '2026-10-30T09:00:00.000Z',
    keys: [{ keyId: 'mk_' + '3'.repeat(22), clientName: 'Safari on an iPad', joinedAt: '2026-10-30T09:10:00.000Z', lastSeenAt: '2026-10-30T20:00:00.000Z', passkeys: 1 }],
  },
];
const SHARES = [
  {
    shareId: 'shr_' + 's'.repeat(22), memberId: MEMBER_B, memberLabel: 'Bob', catalogIds: [CATALOG], createdAt: '2026-10-31T08:30:00.000Z',
    expiresAt: '2026-10-31T09:30:00.000Z', uses: { kind: 'single' }, state: 'live', usedBy: [],
  },
];

const client = {
  request: async (path, schema, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.startsWith('/v1/catalogs')) return schema.parse({ publisher: PUBLISHER, catalogs: CATALOGS });
    if (method === 'GET' && path === '/v1/catalog-members') return { members: MEMBERS };
    if (method === 'GET' && path === '/v1/catalog-shares') return { shares: SHARES };
    if (method === 'GET' && path === '/v1/catalog-installs') return schema.parse({ installs: [] });
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const createClient = async () => client;

const fixture = await sharedItemFixture();
const ok = value => ({ kind: 'ok', value });
const never = new Promise(() => undefined);
const SUBSCRIPTION = {
  daemonId: fixture.identity.daemonId, daemonName: 'kirin-box', daemonUrl: 'https://box.example.test', ownLabel: 'Kirin’s box',
  keyId: 'mk_' + 'A'.repeat(22), memberId: 'mbr_' + 'A'.repeat(22), memberLabel: 'Alice', status: 'active',
  joinedAt: AT, passkeyWindowEndsAt: '2026-10-31T10:10:00.000Z', unlockDays: 30, carriers: [],
  publicKey: 'AAAA', boxKey: 'AAAA', signingKey: 'AAAA', boxPrivateKey: 'AAAA',
};
const members = {
  list: async () => [SUBSCRIPTION],
  browse: async () => ok(fixture.browse),
  openItem: async () => await never,
  unlock: async () => await never,
  leave: async () => await never,
  forget: async () => undefined,
  rename: async () => true,
  tryAgain: async () => ({ kind: 'refused' }),
};

const skill = (name, description, scope, origin) => ({ name, description, scope, origin });
const loadSkills = async () => ({
  harness: 'claude',
  skills: [
    skill('floop', 'Review a diff and say what to fix.', 'global', 'claude'),
    skill('kteam', 'Coordinate detached teammates.', 'global', 'both'),
    skill('pdf-tools', 'Split, merge and OCR PDFs.', 'global', 'claude'),
    skill('run', 'Launch the project app.', 'project', 'claude'),
  ],
});

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'catalogs';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const noop = () => undefined;

const page = tab => (
  <div className="kt-shell flex flex-col overflow-hidden" style={{ height: window.innerWidth < 640 ? 760 : 640 }}>
    <SharingPage
      connection={CONNECTION}
      tab={tab}
      onNavigate={noop}
      members={members}
      machines={[{ connection: CONNECTION, name: 'studio-mac' }]}
      createClient={createClient}
      loadSkills={loadSkills}
    />
  </div>
);

const sessions = [
  sessionView('lizzette', { config: { teammate: 'lizzette', label: 'Ferretry', mode: 'interactive', cwd: '/work/ferretry' }, state: { lastActivityAt: AT } }),
  sessionView('ora', { config: { teammate: 'ora', label: 'Plain chores', mode: 'interactive', cwd: '/work/chores' }, state: { lastActivityAt: AT } }),
];

if (['catalogs', 'shared', 'people', 'skills'].includes(view)) {
  createRoot(root).render(page(view));
} else if (view === 'full') {
  createRoot(root).render(
    <div className="kt-shell flex flex-row overflow-hidden" data-shot="" style={{ height: 900, width: window.innerWidth }}>
      <SessionsBar
        active="sharing" activeSessionId={null} daemonId="studio" machineName="studio-mac" machines={[]} onAddMachine={noop} onClose={noop}
        onCollapse={noop} onNavigate={noop} onOpenPalette={noop} presentation="column" projects={[]} sessions={sessions}
      />
      <div data-shell-main="" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppBar crumbs={[{ label: 'Home', href: '/d/studio/sessions' }, { label: 'Sharing' }]} daemon="studio" onOpenPalette={noop} active="sharing" themeToggle={<ThemeToggle />} />
        <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3">
          <SharingPage
            connection={CONNECTION}
            tab="catalogs"
            onNavigate={noop}
            members={members}
            machines={[{ connection: CONNECTION, name: 'studio-mac' }]}
            createClient={createClient}
            loadSkills={loadSkills}
          />
        </div>
      </div>
    </div>,
  );
} else if (view === 'rail') {
  createRoot(root).render(
    <div className="bg-bg text-fg" data-shot="" style={{ width: 52, height: 420 }}>
      <FleetNavigationRail
        daemon="studio" sessionCount={2} mode="all" modeCounts={{ all: 2, auto: 0, interactive: 2 }} rcOnly={false} includeFinished={false}
        onExpand={noop} onSetMode={noop} onSetRcOnly={noop} onSetIncludeFinished={noop} onNavigate={noop}
      />
    </div>,
  );
} else {
  createRoot(root).render(
    <div className="kt-shell flex flex-col overflow-hidden" style={{ height: '100dvh' }}>
      <AppBar crumbs={[{ label: 'Home', href: '/d/studio/sessions' }, { label: 'Sharing' }]} daemon="studio" onOpenPalette={noop} onOpenSidebar={noop} active="sharing" tabBarShown themeToggle={<ThemeToggle touch />} />
      <div className="min-h-0 flex-1" />
      <AppTabBar daemon="studio" active="sharing" onOpenPalette={noop} whatsNew={{ open: noop, unread: true }} />
    </div>,
  );
}
window.__ready = true;
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/sharing-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'sharing-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'sharing-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'sharing-entry.jsx'));
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
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1440, height: 700 } },
} as const;

const shot = async (page: Page, name: string, theme: string, vp: string, crop?: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  const file = `sharing-${name}-${theme}-${vp}.png`;
  await page.waitForTimeout(400);
  const target = page.locator(crop ?? '[data-sharing]').first();
  const box = (await target.count()) === 0 ? null : await target.boundingBox();
  await page.screenshot({
    path: join(outDir, file),
    ...(box === null
      ? { fullPage: true }
      : {
          clip: {
            x: Math.max(0, box.x - 8),
            y: Math.max(0, box.y - 8),
            width: box.width + 16,
            height: box.height + 16,
          },
        }),
  });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

const open = async (page: Page, theme: string, view: string): Promise<void> => {
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
};

const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  await open(page, theme, 'catalogs');
  await page.locator('[data-catalogs-list]').waitFor({ state: 'visible' });
  await shot(page, 'tab-my-catalogs', theme, vp);

  await open(page, theme, 'shared');
  await page.locator('[data-shared-publisher]').first().waitFor({ state: 'visible' });
  await shot(page, 'tab-shared-with-me', theme, vp);

  await open(page, theme, 'people');
  await page.locator('[data-members-person]').first().waitFor({ state: 'visible' });
  await shot(page, 'tab-people', theme, vp);

  await open(page, theme, 'skills');
  await page.getByText('pdf-tools').first().waitFor({ state: 'visible' });
  await shot(page, 'tab-skills', theme, vp);

  if (vp === 'phone') {
    await open(page, theme, 'more');
    await page.locator('[data-app-tab="more"]').click();
    await page.locator('[data-app-more="sharing"]').waitFor({ state: 'visible' });
    await shot(page, 'phone-more-sheet', theme, vp, '[role="dialog"]');
    for (const [label, size] of [
      ['664', { width: 390, height: 664 }],
      ['320x568', { width: 320, height: 568 }],
    ] as const) {
      await page.setViewportSize(size);
      await open(page, theme, 'more');
      await page.locator('[data-app-tab="more"]').click();
      await page.locator('[data-app-more-whats-new]').waitFor({ state: 'attached' });
      await page.waitForTimeout(400);
      const list = page.locator('[data-app-more-list]');
      const scrolls = await list.evaluate(node => node.scrollHeight > node.clientHeight);
      if (!scrolls)
        fail(
          'the More list does not need to scroll at ' +
            label +
            ': ' +
            JSON.stringify(
              await list.evaluate(node => ({
                ch: node.clientHeight,
                sh: node.scrollHeight,
                panel: node.parentElement?.getBoundingClientRect().height,
                max: node.parentElement?.style.maxHeight,
                ih: innerHeight,
              })),
            ),
        );
      await shot(page, 'phone-more-sheet-' + label + '-top', theme, vp, '[role="dialog"]');
      await list.evaluate(node => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForTimeout(200);
      const inView = await page.locator('[data-app-more-whats-new]').evaluate(node => {
        const box = node.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      });
      if (!inView) fail('What’s new is not reachable by scrolling at ' + label);
      await shot(page, 'phone-more-sheet-' + label + '-bottom', theme, vp, '[role="dialog"]');
    }
  } else {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, theme, 'full');
    await page.locator('[data-catalogs-list]').waitFor({ state: 'visible' });
    await shot(page, 'desktop-full-page', theme, vp, '[data-shot]');
    await shot(page, 'desktop-sidebar-footer', theme, vp, '[data-sessions-bar="column"]');
    await open(page, theme, 'rail');
    await shot(page, 'desktop-narrow-rail', theme, vp, '[data-shot]');
  }
};

try {
  for (const theme of ['studio-light', 'studio-dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === 'phone' ? 2 : 1,
        colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        page.on('pageerror', error => fail(`the page threw: ${error.message}`));
        await walk(page, theme, vp);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ Sharing does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
