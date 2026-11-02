/**
 * The Add skills page (docs/catalogs.md "Add skills to this session", &B131): skills grouped under the catalog they
 * are from, a filter chip per catalog, Refresh picking up a skill a catalog added since the page opened, one
 * publisher locked, and the install review opened from a row. On a phone and a desktop, light and dark.
 *
 *   bun harness/add-skills-screenshot.tsx      # writes harness/out/add-skills-*.png
 *
 * It renders the REAL `AddSkillsPage` (and through it `SharedItemSheet`) against fake members, an invented machine
 * and catalogs signed in the page with a throwaway key, so the verification the app runs is the real one. All names,
 * folders and ids are invented. It fails if any frame scrolls sideways or a button on the page is shorter than 44px
 * on the phone.
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
import { AddSkillsPage } from '../../src/features/context-rail/add-skills-page.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { crypto } from '../../tests/support/catalog-files.ts';
import { installPreview, installRecord } from '../../tests/support/catalog-views.ts';
import { sharedItemFixture } from '../../tests/support/shared-screens.ts';

const AT = '2026-10-31T09:00:00.000Z';
const NOW = Date.parse(AT);
const MACHINE = 'studio-mac';
const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: MACHINE });
const KEYS = { publicKey: 'AAAA', boxKey: 'AAAA', signingKey: 'AAAA', boxPrivateKey: 'AAAA' };

const fixture = await sharedItemFixture();
const subscription = (daemonId, ownLabel, daemonName) => ({
  daemonId, daemonName, daemonUrl: 'https://box.example.test', ownLabel,
  keyId: 'mk_' + 'A'.repeat(22), memberId: 'mbr_' + 'A'.repeat(22), memberLabel: 'Alice', status: 'active',
  joinedAt: AT, passkeyWindowEndsAt: AT, unlockDays: 30, carriers: [], ...KEYS,
});
const KIRIN = subscription(fixture.identity.daemonId, 'Kirin’s box', 'kirin-box');
const INES = subscription('fy_daemon_' + 'r'.repeat(43), 'Ines at the studio', 'studio-mac');
const GUILD = subscription('fy_daemon_' + 's'.repeat(43), 'Design guild', 'guild-box');

const skillEntry = fixture.entries.find(entry => entry.kind === 'skill');
const mcpEntry = fixture.entries.find(entry => entry.kind === 'mcp');
const FLOOP_ID = 'itm_' + 'f'.repeat(22);
const entryNamed = (itemId, name, summary, version) => ({ ...skillEntry, itemId, name, summary, version });
const FLOOP = entryNamed(FLOOP_ID, 'floop', 'Review, fix and re-review until the diff is clean', 3);
const withItems = (view, items, change = {}) => ({ ...view, ...change, manifest: { ...view.manifest, ...change, items } });
const view = fixture.view;

const DESIGN = withItems(view, [
  entryNamed('itm_' + 'd'.repeat(22), 'brand-voice', 'Keep copy in the brand voice', 1),
], { catalogId: 'cat_' + 'd'.repeat(22), name: 'Design catalog' });
const STUDIO_ITEMS = [
  entryNamed('itm_' + 'r'.repeat(22), 'review-pr', 'Walk a pull request the way the team does', 2),
  entryNamed('itm_' + 't'.repeat(22), 'commit-style', 'Write commit messages in the house style', 1),
];
window.__publishNew = () => {
  STUDIO_ITEMS.push(entryNamed('itm_' + 'n'.repeat(22), 'release-notes', 'Draft release notes from merged pull requests', 1));
};

const BROWSE = {
  [KIRIN.daemonId]: { kind: 'ok', value: { ...fixture.browse, catalogs: [withItems(view, [skillEntry, FLOOP, mcpEntry]), DESIGN] } },
  [INES.daemonId]: {
    kind: 'ok',
    value: {
      ...fixture.browse,
      catalogs: [
        withItems(view, STUDIO_ITEMS, { catalogId: 'cat_' + 'r'.repeat(22), name: 'Studio skills' }),
      ],
    },
  },
  [GUILD.daemonId]: { kind: 'failed', problem: { kind: 'locked', sentence: 'Locked.' } },
};

const members = {
  list: async () => [KIRIN, INES, GUILD],
  browse: async sub => BROWSE[sub.daemonId],
  unlock: async () => await new Promise(() => undefined),
  openItem: async (_sub, _view, entry) =>
    ({ kind: 'ok', value: { item: fixture.skill, opened: fixture.opened, entry } }),
};

const record = installRecord('skill', 'floop');
const client = {
  request: async (path, schema, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/v1/catalog-installs')
      return { installs: [{ ...record, provenance: { ...record.provenance, publisher: fixture.identity.daemonId, itemId: FLOOP_ID } }] };
    if (method === 'GET' && path === '/v1/fleet/runtimes')
      return { runtimes: [{ id: 'rt-work', wrapper: 'claude-work', profile: 'default' }] };
    if (method === 'GET' && path === '/v1/secrets') return { v: 1, health: 'ready', secrets: [], references: [] };
    if (method === 'GET' && path === '/v1/catalogs') return { catalogs: [] };
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const createClient = async () => client;

const skill = (name, description, extra = {}) => ({
  name, description, harness: 'claude', scope: 'user',
  path: '/fy/home/.claude/skills/' + name + '/SKILL.md', runtimes: ['claude-work'], ...extra,
});
const SKILLS = {
  sessionId: 'harness-session', harness: 'claude', runtime: 'claude-work', truncated: false,
  skills: [
    skill('summary', 'Summarise this session for the human', {
      scope: 'project', path: '/work/app/.claude/skills/summary/SKILL.md', project: { root: '/work/app' },
    }),
    skill('floop', 'Review, fix and re-review until the diff is clean'),
    skill('babysit-pr', 'Drive a pull request to green', { scope: 'ferretry' }),
  ],
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 1100, padding: '8px 0' }}>
    <section data-frame="" className="flex flex-col overflow-hidden rounded border border-border-soft bg-surface" style={{ height: 'min(900px, 100vh)' }}>
      <AddSkillsPage
        connection={CONNECTION}
        machineName={MACHINE}
        sessionId="harness-session"
        cwd="/work/app/src"
        onNavigate={() => undefined}
        install={{ createClient, crypto, projects: [{ name: 'app', path: '/work/app' }] }}
        members={members}
        loadInventory={async () => SKILLS}
      />
    </section>
  </main>,
);
window.__ready = true;
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/add-skills.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/add-skills-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'add-skills-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'add-skills-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'add-skills.css'),
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
  phone: { viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1280, height: 1100 } },
} as const;

const HIDDEN_ANYWHERE = new RegExp(`[${HIDDEN_CHARACTER_SOURCE}]`, 'u');

const shot = async (page: Page, name: string, theme: string, vp: string, around: readonly string[]): Promise<void> => {
  const text = await page.evaluate(() => document.body.textContent ?? '');
  if (HIDDEN_ANYWHERE.test(text)) fail(`${name} ${theme} ${vp} shows a hidden character instead of its marker`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  await page.evaluate(async () => document.fonts.ready);
  await page.waitForTimeout(400);
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = 0;
  let bottom = 0;
  for (const selector of around) {
    const box = await page.locator(selector).first().boundingBox();
    if (box === null) continue;
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  const file = `add-skills-${name}-${theme}-${vp}.png`;
  const x = Math.max(0, left - 8);
  const y = Math.max(0, top - 8);
  await page.screenshot({
    path: join(outDir, file),
    fullPage: true,
    clip: { x, y, width: right - x + 8, height: bottom - y + 8 },
  });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

const open = async (page: Page, theme: string): Promise<void> => {
  await page.goto(`${server.url}?theme=${theme}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.locator('[data-add-skills-installed]').waitFor({ state: 'visible' });
  await page.locator('[data-add-skills-locked]').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
};

const FRAME = ['[data-frame]'];

const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  await open(page, theme);
  if (vp === 'phone') {
    for (const button of await page.locator('[data-frame] button').all()) {
      const box = await button.boundingBox();
      if (box !== null && box.height < 44) fail(`a button on the page is ${box.height}px tall on the phone`);
    }
  }
  await shot(page, 'page', theme, vp, FRAME);

  await page.locator('[data-context-chip]', { hasText: 'Design catalog' }).click();
  await page.waitForTimeout(200);
  await shot(page, 'filtered', theme, vp, FRAME);
  await page.locator('[data-context-chip="all"]').click();

  await page.evaluate(() => (window as unknown as { __publishNew: () => void }).__publishNew());
  await page.locator('[data-add-skills-refresh]').click();
  await page.locator('[data-add-skills-row]', { hasText: 'release-notes' }).waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await shot(page, 'refreshed', theme, vp, FRAME);

  await page.locator('[data-add-skills-row]', { hasText: 'pdf-tools' }).locator('[data-add-skills-install]').click();
  await page.locator('[data-shared-install-button]').click();
  await page.locator('[data-catalog-scope]').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await shot(page, 'target', theme, vp, ['[role="dialog"]']);
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
  process.stdout.write('✅ The Add skills page does not scroll sideways, and its buttons are 44px tall on a phone\n');
} finally {
  await browser.close();
  server.stop();
}
