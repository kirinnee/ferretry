/**
 * Shared with me (docs/catalogs.md, the member's side): a share link opened for the first time, joining, a
 * refused link, the add-a-passkey step with its countdown, Shared with me with two publishers, one item's review,
 * the hand-off to install it on a machine, and the Access refused state. On a phone and a desktop, light and dark.
 *
 *   bun harness/shared-screenshot.tsx      # writes harness/out/shared-*.png
 *
 * It renders the REAL `JoinScreen`, `SharedWithMe` and (through them) `SharedItemSheet` and
 * `InstallFromFileSheet` against fake members ports and an invented machine. The catalog is signed in the page
 * with a throwaway key made there, so the verification the app runs is the real one. The link is the FIXED FAKE
 * one (`fy_share_FAKEFAKEFAKEFAKEFAKEFA`); no real key, secret, pairing code or share code exists in it. The clock
 * is fixed, so the countdown always reads 8:41 and nothing in a picture moves. It fails if any frame uses a
 * fallback font, scrolls sideways or shows a hidden character instead of its marker.
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
import { JoinScreen } from '../../src/features/shared/join-screen.tsx';
import { SharedWithMe } from '../../src/features/shared/shared-with-me.tsx';
import { JOIN_REFUSED_SENTENCE, NOT_SHOWN_SENTENCE } from '../../src/features/shared/shared-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { crypto } from '../../tests/support/catalog-files.ts';
import { installPreview, installRecord } from '../../tests/support/catalog-views.ts';
import { FAKE_FRAGMENT, SEED, sharedItemFixture } from '../../tests/support/shared-screens.ts';

const params = new URLSearchParams(location.search);
const view = params.get('view');

const THEN = '2026-10-31T10:00:00.000Z';
const WINDOW_ENDS = '2026-10-31T10:10:00.000Z';
// 8 minutes 41 seconds before the window ends, and a ticker that never ticks: the picture never moves.
const NOW = new Date('2026-10-31T10:01:19.000Z');
const STILL = () => () => undefined;

const KEYS = { publicKey: 'AAAA', boxKey: 'AAAA', signingKey: 'AAAA', boxPrivateKey: 'AAAA' };
const subscription = (daemonId, change) => ({
  daemonId,
  daemonName: 'kirin-box',
  daemonUrl: 'https://box.example.test',
  ownLabel: 'Kirin’s box',
  keyId: 'mk_' + 'A'.repeat(22),
  memberId: 'mbr_' + 'A'.repeat(22),
  memberLabel: 'Alice',
  status: 'active',
  joinedAt: THEN,
  passkeyWindowEndsAt: WINDOW_ENDS,
  unlockDays: 30,
  carriers: [],
  ...KEYS,
  ...change,
});

const fixture = await sharedItemFixture();
const FIRST = subscription(fixture.identity.daemonId, { ownLabel: 'Kirin’s box' });
const SECOND = subscription('fy_daemon_' + 'r'.repeat(43), {
  ownLabel: 'Ines at the studio',
  daemonName: 'studio-mac',
  memberLabel: 'Alice',
});
const REFUSED = subscription(fixture.identity.daemonId, { ownLabel: 'Kirin’s box', status: 'refused' });

const ok = value => ({ kind: 'ok', value });
const never = new Promise(() => undefined);

const joinMembers = change => ({
  begin: async () => ({ kind: 'new', seed: SEED }),
  join: async () => await never,
  addPasskey: async () => await never,
  unlock: async () => await never,
  redeem: async () => await never,
  forget: async () => undefined,
  ...change,
});

const WITHDRAWN_INSTALLED_ID = 'itm_' + 'w'.repeat(22);
const WITHDRAWN_OTHER_ID = 'itm_' + 'x'.repeat(22);
const withdrawnBrowse = {
  ...fixture.browse,
  catalogs: fixture.browse.catalogs.map(block =>
    block.manifest === undefined
      ? block
      : {
          ...block,
          manifest: {
            ...block.manifest,
            withdrawn: [WITHDRAWN_INSTALLED_ID, WITHDRAWN_OTHER_ID].map(itemId => ({ itemId, at: THEN })),
          },
        },
  ),
};

const sharedMembers = {
  list: async () => [FIRST, SECOND],
  tryAgain: async () => ({ kind: 'refused' }),
  browse: async sub =>
    ok(
      sub.daemonId === FIRST.daemonId
        ? withdrawnBrowse
        : {
            ...fixture.browse,
            catalogs: [{ catalogId: 'cat_' + 'r'.repeat(22), name: 'Reading list', revision: 1, problem: NOT_SHOWN_SENTENCE }],
          },
    ),
  openItem: async (_sub, _view, entry) =>
    ok({
      item: [fixture.skill, fixture.mcp].find(item => item.itemId === entry.itemId),
      opened: fixture.opened,
      entry,
    }),
  unlock: async () => await never,
  leave: async () => await never,
  forget: async () => undefined,
  rename: async () => true,
};

const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: 'studio-mac' });
const MACHINES = [{ connection: CONNECTION, name: 'studio-mac' }];

const skillEntry = fixture.entries.find(entry => entry.kind === 'skill');
const installClient = {
  request: async (path, schema, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/v1/catalog-installs') {
      const record = installRecord('skill', 'pdf-merge');
      return schema.parse({
        installs: [
          { ...record, provenance: { ...record.provenance, publisher: fixture.identity.daemonId, itemId: WITHDRAWN_INSTALLED_ID } },
        ],
      });
    }
    if (method === 'GET' && path === '/v1/fleet/runtimes') return { runtimes: [{ id: 'box', profile: 'default' }] };
    if (method === 'GET' && path === '/v1/secrets') return schema.parse({ v: 1, health: 'ready', secrets: [], references: [] });
    if (method === 'POST' && path.endsWith('/preview'))
      return schema.parse(
        installPreview({
          provenance: {
            publisher: fixture.identity.daemonId,
            publisherName: 'kirin-box',
            catalogId: fixture.view.catalogId,
            catalogName: fixture.view.name,
            itemId: skillEntry.itemId,
            kind: skillEntry.kind,
            name: skillEntry.name,
            version: skillEntry.version,
            digest: skillEntry.digest,
          },
          publisher: { daemonId: fixture.identity.daemonId, name: 'kirin-box', firstSeen: true },
          review: [{ label: 'Skill file SKILL.md', document: true, text: '# pdf tools\\n' }],
          secrets: [],
          warnings: [{ code: 'first-publisher', text: 'This is the first install from kirin-box. Its fingerprint is remembered from now on.' }],
        }),
      );
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const INSTALL_HOST = {
  createClient: async () => installClient,
  crypto,
  projects: [{ name: 'app', path: '/work/app' }],
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const mountPage = element =>
  createRoot(root).render(<main data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>{element}</main>);

const joinScreen = members => (
  <JoinScreen members={members} fragment={FAKE_FRAGMENT} now={() => NOW} ticker={STILL} onShared={() => undefined} onHome={() => undefined} />
);

if (view === 'join-ready' || view === 'join-progress') mountPage(joinScreen(joinMembers({})));
else if (view === 'join-refused')
  mountPage(joinScreen(joinMembers({ join: async () => ({ kind: 'refused', sentence: JOIN_REFUSED_SENTENCE }) })));
else if (view === 'passkey')
  mountPage(joinScreen(joinMembers({ join: async () => ({ kind: 'joined', subscription: FIRST }) })));
else if (view === 'access-refused')
  mountPage(
    joinScreen(
      joinMembers({
        begin: async () => ({ kind: 'known', seed: SEED, subscription: FIRST }),
        redeem: async () => ({ kind: 'refused' }),
        tryAgain: async () => ({ kind: 'refused' }),
      }),
    ),
  );
else mountPage(<SharedWithMe members={sharedMembers} machines={MACHINES} installHost={INSTALL_HOST} onHome={() => undefined} />);
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/shared-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'shared-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'shared-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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

/** A page is cropped to the fixture; a sheet to its dialog, which is never wider than 720px. */
const PAGE = '[data-fixture]';
const SHEET = '[role="dialog"]';

const shot = async (page: Page, name: string, theme: string, vp: string, crop: string): Promise<void> => {
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
  const file = `shared-${name}-${theme}-${vp}.png`;
  await page.waitForTimeout(500);
  const target = page.locator(crop).first();
  const box = (await target.count()) === 0 ? null : await target.boundingBox();
  if (crop === SHEET && box !== null && box.width > 720.5)
    fail(`${name} ${theme} ${vp} has a sheet wider than 720px (${box.width}px)`);
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
  await open(page, theme, 'join-ready');
  await page.locator('[data-join-button]').waitFor({ state: 'visible' });
  await shot(page, 'join-ready', theme, vp, PAGE);

  await open(page, theme, 'join-progress');
  await page.locator('[data-join-button]').click();
  await page.getByText('Joining…').first().waitFor({ state: 'visible' });
  await shot(page, 'join-progress', theme, vp, PAGE);

  await open(page, theme, 'join-refused');
  await page.locator('[data-join-button]').click();
  await page.getByText('This link did not work').first().waitFor({ state: 'visible' });
  await shot(page, 'join-refused', theme, vp, PAGE);

  await open(page, theme, 'passkey');
  await page.locator('[data-join-button]').click();
  await page.locator('[data-passkey-countdown]').waitFor({ state: 'visible' });
  await page.getByText('8:41').first().waitFor({ state: 'visible' });
  await shot(page, 'passkey', theme, vp, PAGE);

  await open(page, theme, 'shared');
  await page.locator('[data-shared-publisher]').first().waitFor({ state: 'visible' });
  await page.locator('[data-shared-item]').first().waitFor({ state: 'visible' });
  if ((await page.locator('[data-shared-publisher]').count()) !== 2)
    fail('Shared with me does not show two publishers');
  await page.locator('[data-shared-withdrawn-installed]').first().waitFor({ state: 'visible' });
  await shot(page, 'list', theme, vp, PAGE);

  await page.locator('[data-shared-item]').first().click();
  await page.locator('[data-catalog-sheet="shared-item"]').waitFor({ state: 'visible' });
  await shot(page, 'item', theme, vp, SHEET);

  await page.locator('[data-shared-install-button]').click();
  await page.locator('[data-catalog-sheet="install"]').waitFor({ state: 'visible' });
  await page.locator('[data-catalog-scope]').selectOption('runtime');
  await page.locator('[data-catalog-runtime]').selectOption('box');
  await page.locator('[data-catalog-preview]').click();
  await page.locator('[data-catalog-confirm]').waitFor({ state: 'visible' });
  await shot(page, 'install', theme, vp, SHEET);

  await open(page, theme, 'access-refused');
  await page.locator('[data-known-redeem]').click();
  await page.locator('[data-access-refused]').waitFor({ state: 'visible' });
  await shot(page, 'access-refused', theme, vp, PAGE);
  await page.locator('[data-refused-try-again]').click();
  await page.getByText('It refused again.').first().waitFor({ state: 'visible' });
  await shot(page, 'access-refused-again', theme, vp, PAGE);
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
  process.stdout.write('✅ Shared with me does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
