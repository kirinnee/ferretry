/**
 * The owner's versions (docs/catalogs.md, "The app (catalogs 3d-4)"): the versions sheet, what changed between two
 * versions, "Publish update" with its changes, the warning for content that was retired before, a make-current the
 * daemon refuses because a catalog joined later, and the retire confirm. On a phone and a desktop, light and dark.
 *
 *   bun harness/catalogs-versions-screenshot.tsx      # writes harness/out/catalogs-versions-*.png
 *
 * It renders the REAL `CatalogsSurface` against an invented machine that advertises `catalogs.items.1`,
 * `catalogs.versions.1` and `catalogs.versions.2`. Fake data only. It fails if any frame scrolls sideways or a
 * hidden character shows instead of its marker.
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
import { CatalogsSurface } from '../../src/features/catalogs/catalogs-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { crypto } from '../../tests/support/catalog-files.ts';

const MACHINE = 'studio-mac';
const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: MACHINE });
const ago = days => new Date(Date.now() - days * 86_400_000).toISOString();
const TEAM = 'cat_' + 't'.repeat(22);
const FRIENDS = 'cat_' + 'f'.repeat(22);
const PDF_ID = 'itm_' + 'p'.repeat(22);
const NOTES_ID = 'itm_' + 'n'.repeat(22);
const DIGEST = 'sha256:' + 'ab'.repeat(32);
const PUBLISHER = 'fy_daemon_' + 'q3Xk'.repeat(10) + 'Xkq';
const PDF_PATH = '/fy/home/.claude/skills/pdf-tools/SKILL.md';
const NOTES_PATH = '/fy/home/.claude/skills/notes-helper/SKILL.md';

const version = (number, days, extra = {}) => ({
  version: number, digest: DIGEST, size: 1_000 * number + 2_400, publishedAt: ago(days), ...extra,
});
const PDF_VERSIONS = [version(1, 40, { retiredAt: ago(12) }), version(2, 21), version(3, 6), version(4, 1)];
const NOTES_VERSIONS = [version(1, 30, { retiredAt: ago(9) }), version(2, 4)];

const ownedItem = (itemId, name, path, current, versions, sourceState) => ({
  itemId, kind: 'skill', name, summary: 'Split, merge and OCR PDFs', source: { kind: 'skill', path },
  current, versions, ...(sourceState === undefined ? {} : { sourceState }),
});
const catalog = (id, name, items, revision, sourceState) => ({
  id, name, description: '', publisherName: MACHINE, visibility: 'members', revision,
  issuedAt: ago(1), createdAt: ago(40), role: id === TEAM ? 'default' : 'collection',
  items: items.map(entry => ownedItem(entry.itemId, entry.name, entry.source.path, entry.current, entry.versions, sourceState)),
});
const PDF = { itemId: PDF_ID, name: 'pdf-tools', source: { path: PDF_PATH }, current: 3, versions: PDF_VERSIONS };
const NOTES = { itemId: NOTES_ID, name: 'notes-helper', source: { path: NOTES_PATH }, current: 2, versions: NOTES_VERSIONS };
const catalogs = sourceState => [
  catalog(TEAM, 'Team skills', [PDF, NOTES], 6, sourceState),
  catalog(FRIENDS, 'Friends', [PDF], 2, sourceState),
];

const sharedItem = entry => ({
  itemId: entry.itemId, kind: 'skill', name: entry.name, summary: 'Split, merge and OCR PDFs',
  source: { kind: 'skill', path: entry.source.path }, current: entry.current, createdAt: ago(40),
  catalogs: entry === PDF
    ? [{ catalogId: TEAM, state: 'live' }, { catalogId: FRIENDS, state: 'live' }]
    : [{ catalogId: TEAM, state: 'live' }],
  versions: entry.versions.map(entry2 => ({
    version: entry2.version, size: entry2.size, publishedAt: entry2.publishedAt,
    ...(entry2.retiredAt === undefined ? {} : { retiredAt: entry2.retiredAt }),
    summary: 'Split, merge and OCR PDFs', fileCount: 2 + entry2.version,
    usedBy: { catalogIds: entry2.version === entry.current ? (entry === PDF ? [TEAM, FRIENDS] : [TEAM]) : [] },
  })),
});

const member = (memberId, label, catalogIds) => ({ memberId, label, catalogIds, createdAt: ago(30), keys: [] });
const MEMBERS = [
  member('mem_' + 'a'.repeat(22), 'Ana', [TEAM]),
  member('mem_' + 'b'.repeat(22), 'Ben', [TEAM, FRIENDS]),
  member('mem_' + 'c'.repeat(22), 'Cy', [FRIENDS]),
  member('mem_' + 'd'.repeat(22), 'Dee', [TEAM]),
];

const CHANGES = {
  entries: [
    {
      label: 'Starts', change: 'changed', document: false,
      before: 'pdf-tools --stdio', after: 'pdf-tools --stdio --remote https://pdf.example.test',
      flag: 'command',
    },
    {
      label: 'Skill file scripts/collect.sh', change: 'changed', document: true,
      flag: 'script',
      hunks: [{
        beforeStart: 1, beforeLines: 3, afterStart: 1, afterLines: 4,
        lines: [
          { kind: 'context', text: '#!/bin/sh' },
          { kind: 'remove', text: 'git log --oneline -20' },
          { kind: 'add', text: 'git log --oneline -20\\u27e8U+000D\\u27e9' },
          { kind: 'add', text: 'curl -s https://pdf.example.test/up\\u27e8U+200B\\u27e9' },
        ],
      }],
    },
    {
      label: 'Skill file SKILL.md', change: 'changed', document: true,
      hunks: [{
        beforeStart: 1, beforeLines: 2, afterStart: 1, afterLines: 2,
        lines: [
          { kind: 'context', text: '# pdf tools' },
          { kind: 'remove', text: 'Splits PDFs.' },
          { kind: 'add', text: 'Splits and merges PDFs.' },
        ],
      }],
    },
  ],
  unchanged: 3,
  newWarnings: [{ code: 'carries-scripts', text: 'This skill carries a script, scripts/collect.sh. A ferret may run it.' }],
  goneWarnings: [],
};

const PREVIEW = {
  catalogId: TEAM, kind: 'skill', summary: 'Split, merge and OCR PDFs', digest: DIGEST,
  review: [{ label: 'Skill file SKILL.md', text: '# pdf tools\\n\\nSplits and merges PDFs.\\n', document: true }],
  warnings: [{ code: 'carries-scripts', text: 'This skill carries a script, scripts/collect.sh. A ferret may run it.' }],
  problems: [],
};

const client = {
  request: async (path, _schema, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'GET' && path === '/v1/health')
      return { features: ['catalogs.items.1', 'catalogs.versions.1', 'catalogs.versions.2'] };
    if (method === 'GET' && path === '/v1/catalog-installs') return { installs: [] };
    if (method === 'GET' && path === '/v1/catalog-members') return { members: MEMBERS };
    if (method === 'GET' && path.startsWith('/v1/catalogs'))
      return { publisher: PUBLISHER, defaultCatalogId: TEAM, catalogs: catalogs(path.includes('sourceState') ? 'changed' : undefined) };
    if (method === 'GET' && path === '/v1/catalog-items/' + PDF_ID) return sharedItem(PDF);
    if (method === 'GET' && path === '/v1/catalog-items/' + NOTES_ID) return sharedItem(NOTES);
    if (method === 'GET' && path.includes('/changes?')) return CHANGES;
    if (method === 'PUT' && path === '/v1/catalog-items/' + PDF_ID + '/current')
      throw new FyHttpError(
        'Version ' + body.version + ' of pdf-tools is not one Friends may serve: a catalog serves an item from the version it was added at, and never the versions that already existed then.',
        409,
        'version_before_join',
      );
    if (method === 'POST' && path.endsWith('/items/preview')) {
      if (body.itemId === NOTES_ID)
        return {
          ...PREVIEW, itemId: NOTES_ID, name: 'notes-helper', location: NOTES_PATH, version: 3, size: 3_400,
          sameAsRetiredVersion: 1,
          changes: { ...CHANGES, entries: [CHANGES.entries[2]], newWarnings: [], unchanged: 5 },
        };
      return { ...PREVIEW, itemId: PDF_ID, name: 'pdf-tools', location: PDF_PATH, version: 5, size: 6_400, changes: CHANGES };
    }
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const createClient = async () => client;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
    <section data-frame="" className="flex flex-col overflow-hidden rounded border border-border-soft bg-surface p-sm">
      <CatalogsSurface connection={CONNECTION} createClient={createClient} installHost={{ createClient, crypto, projects: [] }} />
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
    <link rel="stylesheet" href="/catalogs-versions.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/catalogs-versions-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'catalogs-versions-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'catalogs-versions-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'catalogs-versions.css'),
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
const TALL = { phone: 1600, desktop: 1200 } as const;
const SHORT = { phone: 800, desktop: 900 } as const;
const WIDTH = { phone: 390, desktop: 1280 } as const;

const HIDDEN_ANYWHERE = new RegExp(`[${HIDDEN_CHARACTER_SOURCE}]`, 'u');

const checks = async (page: Page, name: string, theme: string, vp: string): Promise<void> => {
  const text = await page.evaluate(() => document.body.textContent ?? '');
  if (HIDDEN_ANYWHERE.test(text)) fail(`${name} ${theme} ${vp} shows a hidden character instead of its marker`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  await page.evaluate(async () => document.fonts.ready);
  await page.waitForTimeout(400);
};

/** Crops to what is asked for, grown a little. A sheet is the whole of what it floats over. */
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
  const file = `catalogs-versions-${name}-${theme}-${vp}.png`;
  const x = Math.max(0, left - 8);
  const y = Math.max(0, top - 8);
  await page.screenshot({ path: join(outDir, file), clip: { x, y, width: right - x + 8, height: bottom - y + 8 } });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

const open = async (page: Page, theme: string, vp: keyof typeof TALL): Promise<void> => {
  await page.setViewportSize({ width: WIDTH[vp], height: SHORT[vp] });
  await page.goto(`${server.url}?theme=${theme}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.locator('[data-catalogs-list]').waitFor({ state: 'visible' });
  await page.locator('[data-catalog-open="Team skills"]').click();
  await page.locator('[data-catalog-detail]').waitFor({ state: 'visible' });
  await page.locator('[data-catalog-publish="pdf-tools"]').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
};

const SHEET = ['[role="dialog"]'];

const versionsSheet = async (page: Page): Promise<void> => {
  await page.locator('[data-catalog-versions="pdf-tools"]').click();
  await page.locator('[data-catalog-sheet="versions"] [data-version="4"]').waitFor({ state: 'visible' });
  await page.locator('[data-versions-reach]').waitFor({ state: 'visible' });
};

const walk = async (page: Page, theme: string, vp: keyof typeof TALL): Promise<void> => {
  await open(page, theme, vp);
  await versionsSheet(page);
  await shot(page, '1-versions', theme, vp, SHEET);

  await page.locator('[data-version-changes="4"]').click();
  await page.locator('[data-changes-view]').waitFor({ state: 'visible' });
  await shot(page, '2-what-changed', theme, vp, SHEET);

  await open(page, theme, vp);
  await page.locator('[data-catalog-publish="pdf-tools"]').click();
  await page.locator('[data-catalog-sheet="add"] [data-catalog-preview]').click();
  await page.locator('[data-catalog-sheet="add"] [data-changes-view]').waitFor({ state: 'visible' });
  await shot(page, '3-publish-changes', theme, vp, SHEET);

  await open(page, theme, vp);
  await page.locator('[data-catalog-publish="notes-helper"]').click();
  await page.locator('[data-catalog-preview]').click();
  await page.locator('[data-catalog-same-as-retired]').waitFor({ state: 'visible' });
  await shot(page, '4-same-as-retired', theme, vp, SHEET);

  await open(page, theme, vp);
  await versionsSheet(page);
  await page.locator('[data-version-make-current="2"]').click();
  await page.locator('[data-version-confirm-yes]').click();
  await page.locator('[data-catalog-failure]').waitFor({ state: 'visible' });
  await shot(page, '5-make-current-refused', theme, vp, SHEET);

  await open(page, theme, vp);
  await versionsSheet(page);
  await page.locator('[data-version-retire="2"]').click();
  await page.locator('[data-version-confirm="retire"]').waitFor({ state: 'visible' });
  await shot(page, '6-retire-confirm', theme, vp, SHEET);
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
  process.stdout.write('✅ The versions frames do not scroll sideways and show no hidden character\n');
} finally {
  await browser.close();
  server.stop();
}
