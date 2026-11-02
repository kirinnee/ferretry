/**
 * One-tap Publish from a row's ⋯, its Undo toast, the default catalog and "Publish in another catalog…"
 * (docs/catalogs.md, "The app (catalogs 3c-4)"): the row, the toast after Publish with Undo, after Undo, the review
 * sheet a tap falls back to, "Already in …", the default badge in My catalogs, the ⋯ with Make default, and the
 * frozen review that Publish in another catalog… shows. On a phone and a desktop, light and dark.
 *
 *   bun harness/catalogs-quickadd-screenshot.tsx      # writes harness/out/catalogs-quickadd-*.png
 *
 * It renders the REAL `ContextRailBody` and `CatalogsSurface` against an invented machine that advertises
 * `catalogs.items.1` and `catalogs.quick-add.1`. Fake data only. It fails if any frame scrolls sideways, a hidden
 * character shows instead of its marker, a row button or the Undo button is shorter than 44px on the phone, or the
 * phone toast does not clear the 52px bottom tab bar.
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
import { ContextRailBody } from '../../src/features/context-rail/context-rail-body.tsx';
import { CatalogsSurface } from '../../src/features/catalogs/catalogs-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { crypto } from '../../tests/support/catalog-files.ts';

const AT = '2026-10-31T09:00:00.000Z';
const NOW = Date.parse(AT);
const MACHINE = 'studio-mac';
const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: MACHINE });
const TEAM = 'cat_' + 't'.repeat(22);
const DEFAULT = 'cat_' + 'd'.repeat(22);
const READING = 'cat_' + 'r'.repeat(22);
const DIGEST = 'sha256:' + 'ab'.repeat(32);
const PUBLISHER = 'fy_daemon_' + 'q3Xk'.repeat(10) + 'Xkq';
const FLOOP_PATH = '/fy/home/.claude/skills/floop/SKILL.md';
const PDF_PATH = '/fy/home/.claude/skills/pdf-tools/SKILL.md';
const NOTES_PATH = '/fy/home/.claude/skills/notes-helper/SKILL.md';
const UNDO_TOKEN = 'cqu_' + 'u'.repeat(22);

const view = new URLSearchParams(location.search).get('view');

let defaultId = DEFAULT;
let pdfListed = false;

const item = (itemId, name, path) => ({
  itemId, kind: 'skill', name, summary: '', source: { kind: 'skill', path },
  versions: [{ version: 1, digest: DIGEST, size: 100, publishedAt: AT }],
});
const FLOOP = item('itm_' + 'f'.repeat(22), 'floop', FLOOP_PATH);
const PDF = item('itm_' + 'p'.repeat(22), 'pdf-tools', PDF_PATH);
const NOTES = item('itm_' + 'n'.repeat(22), 'notes-helper', NOTES_PATH);
const catalog = (id, name, items, revision) => ({
  id, name, description: '', publisherName: MACHINE, visibility: 'members', revision,
  issuedAt: AT, createdAt: AT, items, ...(id === defaultId ? { role: 'default' } : {}),
});
const catalogs = () => [
  catalog(TEAM, 'Team skills', [FLOOP], 4),
  catalog(DEFAULT, 'studio-mac’s skills', pdfListed ? [NOTES, PDF] : [NOTES], pdfListed ? 3 : 2),
  catalog(READING, 'Reading list', [], 1),
].map(entry => (entry.id === defaultId ? { ...entry, role: 'default' } : { ...entry, role: undefined }));

const skill = (name, description, extra = {}) => ({
  name, description, harness: 'claude', scope: 'user',
  path: '/fy/home/.claude/skills/' + name + '/SKILL.md', runtimes: ['claude-work'], ...extra,
});
const SKILLS = {
  sessionId: 'harness-session', harness: 'claude', runtime: 'claude-work', truncated: false,
  skills: [
    skill('floop', 'Review, fix and re-review until the diff is clean', { path: FLOOP_PATH }),
    skill('pdf-tools', 'Split, merge and OCR PDFs', { path: PDF_PATH }),
    skill('summary', 'Summarise this session for the human', {
      scope: 'project', path: '/work/app/.claude/skills/summary/SKILL.md', project: { root: '/work/app' },
    }),
  ],
};
const MCP = { problems: [], servers: [] };

const SUMMARY_PREVIEW = {
  kind: 'skill', name: 'summary', summary: 'Summarise this session for the human',
  location: '/work/app/.claude/skills/summary/SKILL.md', version: 1, digest: DIGEST, size: 900,
  review: [
    { label: 'Skill file SKILL.md', text: '---\\nname: summary\\ndescription: Summarise this session for the human\\n---\\n# summary\\n\\nRun scripts/collect.sh to gather the session.\\n', document: true },
    { label: 'Skill file scripts/collect.sh', text: '#!/bin/sh\\nset -eu\\ngit log --oneline -20\\n', document: true },
  ],
  warnings: [{ code: 'carries-scripts', text: 'This skill carries a script, scripts/collect.sh. A ferret may run it.' }], problems: [], secrets: [],
};
const FLOOP_PREVIEW = {
  catalogId: DEFAULT, kind: 'skill', name: 'floop', summary: 'Review, fix and re-review until the diff is clean',
  location: FLOOP_PATH, version: 3, digest: DIGEST, size: 1400,
  review: [{ label: 'Skill file SKILL.md', text: '---\\nname: floop\\ndescription: Review, fix and re-review until the diff is clean\\n---\\n# floop\\n\\nReview the diff, fix what you find, review again.\\n', document: true }],
  warnings: [], problems: [], secrets: [],
};

const client = {
  request: async (path, _schema, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'GET' && path === '/v1/health') return { features: ['catalogs.items.1', 'catalogs.quick-add.1'] };
    if (method === 'GET' && path === '/v1/catalog-installs') return { installs: [] };
    if (method === 'GET' && path.startsWith('/v1/catalogs'))
      return { publisher: PUBLISHER, defaultCatalogId: defaultId, catalogs: catalogs() };
    if (method === 'GET' && path === '/v1/catalog-items')
      return {
        publisher: PUBLISHER, defaultCatalogId: defaultId,
        items: [{
          itemId: FLOOP.itemId, kind: 'skill', name: 'floop', summary: 'Review, fix and re-review until the diff is clean',
          source: FLOOP.source, current: 3, createdAt: AT, catalogs: [{ catalogId: TEAM, state: 'live' }],
          versions: [1, 2, 3].map(version => ({ version, digest: DIGEST, size: 1400, publishedAt: AT })),
        }],
      };
    if (method === 'POST' && path === '/v1/catalog-items/quick-add') {
      const at = body.source?.skill ?? '';
      if (at.includes('pdf-tools')) {
        pdfListed = true;
        return {
          outcome: 'added', catalog: { catalogId: DEFAULT, name: 'studio-mac’s skills', revision: 3, created: false },
          itemId: PDF.itemId, itemVersion: 1, digest: DIGEST, newItem: true, sourceChanged: false,
          undo: { token: UNDO_TOKEN, expiresAt: '2026-10-31T09:01:00.000Z' },
        };
      }
      if (at.includes('floop')) return { outcome: 'already', catalogId: TEAM, itemId: FLOOP.itemId, itemVersion: 3 };
      return { outcome: 'review', reasons: ['warnings'], preview: SUMMARY_PREVIEW };
    }
    if (method === 'POST' && path === '/v1/catalog-items/quick-add/undo') {
      pdfListed = false;
      return { catalogId: DEFAULT, itemId: PDF.itemId, mode: 'retracted', revision: 4, itemRemoved: true };
    }
    if (method === 'PATCH' && path.startsWith('/v1/catalogs/')) {
      defaultId = decodeURIComponent(path.slice('/v1/catalogs/'.length));
      return catalogs().find(entry => entry.id === defaultId);
    }
    if (method === 'POST' && path.endsWith('/items/preview')) return body.itemId === undefined ? SUMMARY_PREVIEW : FLOOP_PREVIEW;
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const createClient = async () => client;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  view === 'catalogs' ? (
    <main style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
      <section data-frame="" className="flex flex-col overflow-hidden rounded border border-border-soft bg-surface p-sm">
        <CatalogsSurface connection={CONNECTION} createClient={createClient} installHost={{ createClient, crypto, projects: [{ name: 'app', path: '/work/app' }] }} />
      </section>
    </main>
  ) : (
    <main style={{ margin: '0 auto', maxWidth: 440, padding: '12px 0' }}>
      <section data-frame="" className="flex flex-col overflow-hidden rounded border border-border-soft bg-surface">
        <ContextRailBody
          sessionId="harness-session"
          machineName={MACHINE}
          loadMcp={async () => MCP}
          loadSkills={async () => SKILLS}
          loadSkillFile={async path => ({ path, content: '# Skill\\n\\nWhat it does.' })}
          loadDocs={async () => []}
          onInsertSkill={() => undefined}
          onOpenFile={() => undefined}
          mcpSignIn={{ connection: CONNECTION, createClient, machineName: MACHINE }}
          catalogs={{ connection: CONNECTION, createClient }}
          tabs={['skills', 'mcp']}
          tab="skills"
          label="Context sections"
          now={() => NOW}
        />
      </section>
    </main>
  ),
);
window.__ready = true;
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/catalogs-quickadd.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/catalogs-quickadd-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'catalogs-quickadd-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'catalogs-quickadd-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'catalogs-quickadd.css'),
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
  phone: { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1280, height: 900 } },
} as const;
const TALL = { phone: 1400, desktop: 1100 } as const;
const SHORT = { phone: 800, desktop: 900 } as const;
const WIDTH = { phone: 390, desktop: 1280 } as const;
const TAB_BAR = 52;

const HIDDEN_ANYWHERE = new RegExp(`[${HIDDEN_CHARACTER_SOURCE}]`, 'u');

const checks = async (page: Page, name: string, theme: string, vp: string): Promise<void> => {
  const text = await page.evaluate(() => document.body.textContent ?? '');
  if (HIDDEN_ANYWHERE.test(text)) fail(`${name} ${theme} ${vp} shows a hidden character instead of its marker`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  await page.evaluate(async () => document.fonts.ready);
  await page.waitForTimeout(400);
};

/** Crops to the frame, grown to take in whatever floats over it (the ⋯ menu, a sheet). */
const shot = async (
  page: Page,
  name: string,
  theme: string,
  vp: keyof typeof TALL,
  around: readonly string[],
): Promise<void> => {
  await page.setViewportSize({ width: WIDTH[vp], height: TALL[vp] });
  await checks(page, name, theme, vp);
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
  const file = `catalogs-quickadd-${name}-${theme}-${vp}.png`;
  const x = Math.max(0, left - 8);
  const y = Math.max(0, top - 8);
  await page.screenshot({ path: join(outDir, file), clip: { x, y, width: right - x + 8, height: bottom - y + 8 } });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

/** The toast floats, so it is shot as the viewport shows it: the whole screen, tab bar space and all. */
const shotScreen = async (page: Page, name: string, theme: string, vp: keyof typeof SHORT): Promise<void> => {
  await page.setViewportSize({ width: WIDTH[vp], height: SHORT[vp] });
  await checks(page, name, theme, vp);
  const toast = await page.locator('[data-catalog-toast]').boundingBox();
  if (toast === null) fail(`${name} ${theme} ${vp} has no toast`);
  else {
    if (vp === 'phone' && toast.y + toast.height > SHORT.phone - TAB_BAR - 8)
      fail(
        `${name} ${theme} ${vp}: the toast bottom is ${SHORT.phone - toast.y - toast.height}px above the screen edge; it must clear the ${TAB_BAR}px tab bar`,
      );
    if (toast.x < 0 || toast.x + toast.width > WIDTH[vp])
      fail(`${name} ${theme} ${vp}: the toast leaves the screen sideways`);
  }
  const undo = page.locator('[data-catalog-toast-undo]');
  if ((await undo.count()) > 0) {
    const box = await undo.boundingBox();
    if (box !== null && box.height < 44) fail(`${name} ${theme} ${vp}: Undo is ${box.height}px tall`);
  }
  const file = `catalogs-quickadd-${name}-${theme}-${vp}.png`;
  await page.screenshot({ path: join(outDir, file) });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

const open = async (page: Page, theme: string, view: 'rail' | 'catalogs', vp: keyof typeof TALL): Promise<void> => {
  await page.setViewportSize({ width: WIDTH[vp], height: SHORT[vp] });
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  if (view === 'catalogs') {
    await page.locator('[data-catalogs-list]').waitFor({ state: 'visible' });
  } else {
    await page.locator('[data-row-use]').first().waitFor({ state: 'visible' });
  }
  await page.waitForTimeout(300);
};

const FRAME = ['[data-frame]'];
const SHEET = ['[role="dialog"]'];

const row = (name: string) => `[data-catalog-item-row="${name}"]`;

/** Opens a row's ⋯ and picks the one-tap Publish item, once the machine has said it can (the item then names a catalog). */
const publish = async (page: Page, name: string): Promise<void> => {
  await page.locator(`${row(name)} [data-row-more]`).click();
  const item = page.locator('[data-menu-key="publish"]').filter({ hasNotText: 'Publish in a catalog…' });
  await item.waitFor({ state: 'visible' });
  await item.click();
};

const walk = async (page: Page, theme: string, vp: keyof typeof TALL): Promise<void> => {
  await open(page, theme, 'rail', vp);
  if (vp === 'phone') {
    for (const button of await page.locator('[data-row-controls] button').all()) {
      const box = await button.boundingBox();
      if (box !== null && box.height < 44) fail(`a row button is ${box.height}px tall on the phone`);
    }
  }
  await shot(page, '1-row', theme, vp, FRAME);

  await page.setViewportSize({ width: WIDTH[vp], height: SHORT[vp] });
  await publish(page, 'pdf-tools');
  await page.locator('[data-catalog-toast-undo]').waitFor({ state: 'visible' });
  await shotScreen(page, '2-toast', theme, vp);

  await page.locator('[data-catalog-toast-undo]').click();
  await page.locator('[data-catalog-toast]:not(:has([data-catalog-toast-undo]))').waitFor({ state: 'visible' });
  await shotScreen(page, '3-undone', theme, vp);

  await open(page, theme, 'rail', vp);
  await publish(page, 'summary');
  await page.locator('[data-catalog-sheet="add"] [data-catalog-preview-block]').waitFor({ state: 'visible' });
  await shot(page, '4-review', theme, vp, SHEET);

  await open(page, theme, 'rail', vp);
  await publish(page, 'floop');
  await page.locator('[data-catalog-toast]').waitFor({ state: 'visible' });
  await shotScreen(page, '5-already', theme, vp);

  await open(page, theme, 'catalogs', vp);
  await shot(page, '6-default-badge', theme, vp, ['[data-catalogs-list]']);

  await page.locator('[data-catalog-open="Reading list"]').click();
  await page.locator('[data-catalog-detail]').waitFor({ state: 'visible' });
  await page.locator('[data-catalog-more-menu]').click();
  await page.getByRole('menu').waitFor({ state: 'visible' });
  await shot(page, '7-make-default-menu', theme, vp, ['[data-catalog-detail]', '[role="menu"]']);

  await open(page, theme, 'rail', vp);
  await page.locator(`${row('floop')} [data-row-more]`).click();
  await page.getByRole('menuitem', { name: 'Publish in another catalog…' }).click();
  await page.locator('[data-catalog-sheet="add"]').waitFor({ state: 'visible' });
  await page.locator('[data-catalog-preview-block]').waitFor({ state: 'visible' });
  await shot(page, '8-add-another', theme, vp, SHEET);
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
        await walk(page, theme, vp as keyof typeof TALL);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write(
    '✅ One-tap Add frames do not scroll sideways, the phone toast clears the tab bar, and Undo is 44px tall\n',
  );
} finally {
  await browser.close();
  server.stop();
}
