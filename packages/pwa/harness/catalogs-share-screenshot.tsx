/**
 * Sharing a catalog with people (docs/design/catalogs.md §5.2 and §5.5): the Share sheet for a new person,
 * the Share sheet for someone already in (with its warning), the link shown once with its QR, and People and
 * codes with two browsers and the revoke confirm. On a phone and a desktop, light and dark.
 *
 *   bun harness/catalogs-share-screenshot.tsx      # writes harness/out/catalogs-share-*.png
 *
 * Scenes: share-new, share-existing, share-link, share-link-relayed (a loopback-only machine on its relay),
 * share-unreachable (no address and no relay), members, members-revoke, plus the way IN for a member: paste-link
 * (Settings › Sharing › Catalogs with a share link pasted), paste-link-other (a link that is not a share link) and
 * skills-entry (the same field and the More menu where the Skills tab shows them).
 *
 * It renders the REAL `ShareSheet` and `CatalogMembersPanel` against invented machines. THE SHARE CODE IN THE
 * PICTURES IS A FIXED FAKE and the link is built on an example host: a committed PNG of a real code would be a
 * real leak. It fails if any frame scrolls sideways.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HIDDEN_CHARACTER_SOURCE } from '@ferretry/protocol';
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
import { FyHttpError } from '@ferretry/protocol/client';
import { CatalogMembersPanel } from '../../src/features/catalogs/catalog-members.tsx';
import { AddCatalogEntry } from '../../src/features/catalogs/catalog-row-tools.tsx';
import { CatalogsSurface } from '../../src/features/catalogs/catalogs-surface.tsx';
import { ShareSheet } from '../../src/features/catalogs/share-sheet.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const AT = '2026-10-31T09:00:00.000Z';
const NOW = Date.parse(AT);
const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: 'studio-mac' });
const CATALOG = 'cat_' + 'c'.repeat(22);
const OTHER = 'cat_' + 'r'.repeat(22);
const MEMBER_A = 'mbr_' + 'a'.repeat(22);
const MEMBER_B = 'mbr_' + 'b'.repeat(22);
const SHARE_1 = 'shr_' + 's'.repeat(22);
const SHARE_2 = 'shr_' + 't'.repeat(22);
const FAKE_CODE = 'fy_share_FAKEFAKEFAKEFAKEFAKEFA';
const FAKE_LINK = 'https://app.example.test/join#v1;url=https%3A%2F%2Fstudio.example.test;fp=fy_daemon_' + 'q'.repeat(43) + ';share=' + FAKE_CODE;
// The same fake share minted by a machine that answers only on loopback and is reached through its relay.
const FAKE_RELAYED_LINK = 'https://app.example.test/join#v1;url=http%3A%2F%2F127.0.0.1%3A7077;fp=fy_daemon_' + 'q'.repeat(43) + ';share=' + FAKE_CODE;

const owned = (id, name) => ({
  id, name, description: '', publisherName: 'studio-mac', visibility: 'members', revision: 4,
  issuedAt: AT, createdAt: AT, items: [],
});
const CATALOGS = [owned(CATALOG, 'Team skills'), owned(OTHER, 'Reading list')];

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
    shareId: SHARE_1, memberId: MEMBER_B, memberLabel: 'Bob', catalogIds: [CATALOG], createdAt: '2026-10-31T08:30:00.000Z',
    expiresAt: '2026-10-31T09:30:00.000Z', uses: { kind: 'single' }, state: 'live', usedBy: [],
  },
  {
    shareId: SHARE_2, memberId: MEMBER_A, memberLabel: 'Alice', catalogIds: [CATALOG], createdAt: '2026-10-29T09:00:00.000Z',
    expiresAt: '2026-10-29T10:00:00.000Z', uses: { kind: 'single' }, state: 'spent',
    usedBy: [{ clientName: 'Firefox on a Mac', keyId: 'mk_' + '1'.repeat(22), at: '2026-10-29T09:05:00.000Z' }],
  },
];
const MINTED = {
  share: {
    shareId: SHARE_1, memberId: MEMBER_B, memberLabel: 'Carol', catalogIds: [CATALOG], createdAt: AT,
    expiresAt: '2026-10-31T09:14:52.000Z', uses: { kind: 'single' }, state: 'live', usedBy: [],
  },
  code: FAKE_CODE,
  link: FAKE_LINK,
};

const client = {
  request: async (path, _schema, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.startsWith('/v1/catalogs')) return { catalogs: CATALOGS };
    if (method === 'GET' && path === '/v1/catalog-members') return { members: MEMBERS };
    if (method === 'GET' && path === '/v1/catalog-shares') return { shares: SHARES };
    if (method === 'POST' && path === '/v1/catalog-shares') {
      if (view === 'share-unreachable')
        throw new FyHttpError('no carrier', 503, 'share_link_unavailable');
      return view === 'share-link-relayed' ? { ...MINTED, link: FAKE_RELAYED_LINK } : MINTED;
    }
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const createClient = async () => client;

const view = new URLSearchParams(location.search).get('view');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const mountPage = element => createRoot(root).render(<main data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>{element}</main>);

if (view === 'paste-link' || view === 'paste-link-other') {
  mountPage(<CatalogsSurface connection={CONNECTION} createClient={createClient} />);
} else if (view === 'skills-entry') {
  mountPage(
    <section data-skills-frame="" aria-label="Skills" className="flex max-w-[360px] flex-col gap-sm rounded border border-line p-panel">
      <p className="m-0 text-meta text-muted">Claude skills this machine sees</p>
      <AddCatalogEntry host={{ connection: CONNECTION, createClient }} />
    </section>,
  );
} else if (view === 'members' || view === 'members-revoke') {
  mountPage(
    <CatalogMembersPanel
      connection={CONNECTION}
      createClient={createClient}
      catalogs={CATALOGS}
      onBack={() => undefined}
      now={() => NOW}
      timeZone="UTC"
      initialConfirm={view === 'members-revoke' ? { kind: 'revoke', memberId: MEMBER_A } : null}
    />,
  );
} else {
  mountPage(
    <ShareSheet
      connection={CONNECTION}
      createClient={createClient}
      catalog={CATALOGS[0]}
      onClose={() => undefined}
      now={() => NOW}
      copyText={async () => undefined}
    />,
  );
}
window.__ready = true;
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/catalogs-share.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/catalogs-share-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'catalogs-share-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'catalogs-share-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'catalogs-share.css'),
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
    // The stylesheet names its fonts as `../assets/fonts/…`: serve them from src, so the pictures are drawn in the
    // app's own typefaces and not a fallback.
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
  phone: { viewport: { width: 390, height: 2600 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1440, height: 2000 } },
} as const;

const HIDDEN_ANYWHERE = new RegExp(`[${HIDDEN_CHARACTER_SOURCE}]`, 'u');

const shot = async (page: Page, name: string, theme: string, vp: string, crop?: string): Promise<void> => {
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = getComputedStyle(document.body).fontFamily;
    return { family, loaded: [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family) };
  });
  if (!faces.loaded.some(face => faces.family.includes(face.replaceAll('"', ''))))
    fail(`${name} ${theme} ${vp} is drawn in a fallback font (${faces.family}; loaded: ${faces.loaded.join(', ')})`);
  const text = await page.evaluate(() => document.body.textContent ?? '');
  if (HIDDEN_ANYWHERE.test(text)) fail(`${name} ${theme} ${vp} shows a hidden character instead of its marker`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  const file = `catalogs-share-${name}-${theme}-${vp}.png`;
  await page.waitForTimeout(500);
  const frame = page.locator(crop ?? '[role="dialog"]').first();
  const box = (await frame.count()) === 0 ? null : await frame.boundingBox();
  await page.screenshot({
    path: join(outDir, file),
    ...(box === null
      ? { fullPage: true }
      : {
          clip: {
            x: Math.max(0, box.x - 8),
            y: Math.max(0, box.y - 12),
            width: box.width + 16,
            height: box.height + 24,
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
  await open(page, theme, 'share-new');
  await page.locator('[data-share-name]').fill('Carol');
  await shot(page, 'share-new', theme, vp);

  await open(page, theme, 'share-existing');
  await page.locator('[data-share-who-existing]').check();
  await page.locator('[data-share-existing-warning]').waitFor({ state: 'visible' });
  await shot(page, 'share-existing', theme, vp);

  await open(page, theme, 'share-link');
  await page.locator('[data-share-name]').fill('Carol');
  await page.locator('[data-share-confirm]').click();
  await page.locator('[data-share-qr]').waitFor({ state: 'visible' });
  await shot(page, 'share-link', theme, vp);

  // A machine on 127.0.0.1 reached through the hosted relay: the link is made, and the relay is named beside it.
  await open(page, theme, 'share-link-relayed');
  await page.locator('[data-share-name]').fill('Carol');
  await page.locator('[data-share-confirm]').click();
  await page.locator('[data-share-relayed]').waitFor({ state: 'visible' });
  await shot(page, 'share-link-relayed', theme, vp);

  // No address and no relay: nothing is made, and the sentence says what to set.
  await open(page, theme, 'share-unreachable');
  await page.locator('[data-share-name]').fill('Carol');
  await page.locator('[data-share-confirm]').click();
  await page.locator('[data-catalog-failure]').waitFor({ state: 'visible' });
  await shot(page, 'share-unreachable', theme, vp);

  await open(page, theme, 'paste-link');
  await page
    .locator('[data-catalog-link-input]')
    .fill(
      'https://app.example.test/join#v1;url=https%3A%2F%2Fstudio.example.test;fp=fy_daemon_' +
        'q'.repeat(43) +
        ';share=fy_share_FAKEFAKEFAKEFAKEFAKEFA',
    );
  await shot(page, 'paste-link', theme, vp, '[data-catalogs-surface]');

  await open(page, theme, 'paste-link-other');
  await page.locator('[data-catalog-link-input]').fill('https://example.com/skills');
  await page.locator('[data-catalog-link-add]').click();
  await page
    .locator('[data-catalog-link-form] [role="alert"], [data-catalog-link-form] [data-catalog-failure]')
    .first()
    .waitFor({ state: 'visible' });
  await shot(page, 'paste-link-other', theme, vp, '[data-catalogs-surface]');

  await open(page, theme, 'skills-entry');
  await shot(page, 'skills-entry', theme, vp, '[data-skills-frame]');

  await open(page, theme, 'members');
  await page.locator('[data-members-person="Alice"]').waitFor({ state: 'visible' });
  await shot(page, 'members', theme, vp, '[data-catalog-members]');

  await open(page, theme, 'members-revoke');
  await page.locator('[data-members-confirm]').waitFor({ state: 'visible' });
  await shot(page, 'members-revoke', theme, vp, '[data-catalog-members]');
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
  process.stdout.write('✅ Sharing screens do not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
