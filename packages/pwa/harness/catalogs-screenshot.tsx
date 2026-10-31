/**
 * Catalogs (docs/catalogs.md): "Add to catalog…" from a skill row and from an MCP row, Settings › Catalogs
 * (the list and one catalog), installing from a catalog file (a first publisher with secrets to bind, a skill
 * with a hidden character in it) and a file that fails verification. On a phone and a desktop, light and dark.
 *
 *   bun harness/catalogs-screenshot.tsx      # writes harness/out/catalogs-*.png
 *
 * It renders the REAL `AddToCatalogSheet`, `CatalogsSurface` and `InstallFromFileSheet` against invented
 * machines. The catalog file is signed in the page with a throwaway key made there, so the verification the
 * app runs is the real one. No real key, secret or pairing code exists anywhere in it. It fails if any frame
 * scrolls sideways.
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
import { SharedCatalogFileSchema, SharedCatalogItemSchema } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { createRoot } from 'react-dom/client';
import { AddToCatalogSheet } from '../../src/features/catalogs/add-to-catalog-sheet.tsx';
import { CatalogsSurface } from '../../src/features/catalogs/catalogs-surface.tsx';
import { InstallFromFileSheet } from '../../src/features/catalogs/install-from-file-sheet.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { crypto, newIdentity, signedFile } from '../../tests/support/catalog-files.ts';

const AT = '2026-10-31T09:00:00.000Z';
const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: 'studio-mac' });
const CATALOG = 'cat_' + 'c'.repeat(22);
const SKILL_ITEM = 'itm_' + 's'.repeat(22);
const MCP_ITEM = 'itm_' + 'm'.repeat(22);
const DIGEST = 'sha256:' + 'ab'.repeat(32);
const PUBLISHER = 'fy_daemon_' + 'q3Xk'.repeat(10) + 'Xkq';
const RLO = String.fromCodePoint(0x202e);

const version = (n, size) => ({ version: n, digest: DIGEST, size, publishedAt: AT });
const owned = (name, items, change = {}) => ({
  id: CATALOG, name, description: '', publisherName: 'studio-mac', visibility: 'members', revision: 4,
  issuedAt: AT, createdAt: AT, items, ...change,
});
const SKILL_OWNED = {
  itemId: SKILL_ITEM, kind: 'skill', name: 'pdf-tools', summary: 'Split, merge and OCR PDFs',
  source: { kind: 'skill', path: '/home/k/.claude/skills/pdf-tools/SKILL.md' },
  versions: [version(1, 1200), version(2, 1800)], sourceState: 'changed',
};
const MCP_OWNED = {
  itemId: MCP_ITEM, kind: 'mcp', name: 'acme-mcp', summary: 'Talk to Acme',
  source: { kind: 'mcp', id: 'id-acme-user', name: 'acme-mcp' },
  versions: [version(1, 300)], sourceState: 'unchanged',
};
const CATALOGS = [owned('Team skills', [SKILL_OWNED, MCP_OWNED]), { ...owned('Reading list', []), id: 'cat_' + 'r'.repeat(22), revision: 1 }];

const SKILL_PREVIEW = {
  catalogId: CATALOG, kind: 'skill', name: 'pdf-tools', summary: 'Split, merge and OCR PDFs',
  location: '/home/k/.claude/skills/pdf-tools/SKILL.md', version: 3, digest: DIGEST, size: 1800,
  review: [
    { label: 'Skill file SKILL.md', document: true, text: '---\\nname: pdf-tools\\ndescription: Split, merge and OCR PDFs\\n---\\n# pdf tools\\n\\nRun scripts/split.sh to split a file.\\n' },
    { label: 'Skill file scripts/split.sh', document: true, text: '#!/bin/sh\\nset -eu\\nqpdf --split-pages "$1" out-%d.pdf\\n' },
  ],
  warnings: [{ code: 'carries-scripts', text: 'This skill carries a script, scripts/split.sh. A ferret may run it.' }],
  problems: [{ subject: 'notes.psd', reason: 'It is larger than 1 MiB, so it was left out.' }],
};
const MCP_PREVIEW = {
  catalogId: CATALOG, kind: 'mcp', name: 'acme-mcp', summary: 'Talk to Acme',
  location: 'MCP server acme-mcp in /home/k/.claude.json', version: 1, digest: DIGEST, size: 300,
  review: [
    { label: 'Starts', document: false, text: 'npx -y acme-mcp --stdio' },
    { label: 'Environment ACME_TOKEN', document: false, text: '\${secret:ACME_TOKEN}' },
    { label: 'Environment ACME_WEBHOOK_KEY', document: false, text: '\${secret:ACME_WEBHOOK_KEY}' },
    { label: 'Environment ACME_REGION', document: false, text: 'eu' },
  ],
  warnings: [{ code: 'unpinned-package', text: 'npx fetches the newest acme-mcp every time it starts, so this can change without an update.' }],
  problems: [],
};

const INSTALL_BASE = {
  previewId: 'cip_' + 'p'.repeat(22), expiresAt: '2026-10-31T09:10:00.000Z',
  publisher: { daemonId: PUBLISHER, name: 'kirin-box', firstSeen: true },
  target: { scope: 'runtime', runtime: 'box', profile: 'default' },
  destination: 'runtime box, profile default',
};
const provenance = (kind, name, itemId) => ({
  publisher: PUBLISHER, publisherName: 'kirin-box', catalogId: CATALOG, catalogName: "Kirin's catalog",
  itemId, kind, name, version: 1, digest: DIGEST,
});
const INSTALL_MCP = {
  ...INSTALL_BASE, provenance: provenance('mcp', 'acme-mcp', MCP_ITEM),
  review: MCP_PREVIEW.review,
  secrets: [{ placeholder: 'ACME_TOKEN' }, { placeholder: 'ACME_WEBHOOK_KEY' }],
  warnings: [
    { code: 'first-publisher', text: 'This is the first install from kirin-box. Its fingerprint is remembered from now on.' },
    MCP_PREVIEW.warnings[0],
  ],
};
const INSTALL_SKILL = {
  ...INSTALL_BASE, publisher: { ...INSTALL_BASE.publisher, firstSeen: false },
  provenance: provenance('skill', 'pdf-tools', SKILL_ITEM),
  review: [
    { label: 'Skill file SKILL.md', document: true, text: '# pdf tools\\n\\nRun scripts/split.sh ' + RLO + 'gnp.sh to split a file.\\n' },
    SKILL_PREVIEW.review[1],
  ],
  secrets: [],
  warnings: [
    { code: 'older-version', text: 'This is version 1. You have version 2 installed.' },
    { code: 'hidden-characters', text: 'SKILL.md holds a hidden text-direction character. It is shown marked below.' },
    SKILL_PREVIEW.warnings[0],
  ],
  replaces: { installId: 'cin_' + 'i'.repeat(22), version: 2 },
};

const params = new URLSearchParams(location.search);
const view = params.get('view');

const THIS_DEVICE = 'fy_device_id_' + 'Pq3xK9mT2vLw8RnYb5cHdA';
const catalogClient = {
  request: async (path, schema, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (path === '/v1/pair/devices') return { devices: [], hostLocal: false, thisDeviceId: THIS_DEVICE };
    if (view === 'sharing-off' && path.startsWith('/v1/catalogs')) throw new FyHttpError('This device may not use Sharing.', 403, 'grant_device_not_granted');
    if (method === 'GET' && path.startsWith('/v1/catalogs')) return schema.parse({ publisher: PUBLISHER, catalogs: CATALOGS });
    if (method === 'POST' && path.endsWith('/items/preview')) return schema.parse(view === 'add-mcp' ? MCP_PREVIEW : SKILL_PREVIEW);
    if (method === 'GET' && path === '/v1/fleet/runtimes') return { runtimes: [{ id: 'box', profile: 'default' }] };
    if (method === 'GET' && path === '/v1/secrets')
      return schema.parse({ v: 1, health: 'ready', secrets: [{ name: 'ACME_TOKEN', createdAt: AT, updatedAt: AT }, { name: 'GITHUB_TOKEN', createdAt: AT, updatedAt: AT }], references: [] });
    if (method === 'POST' && path.endsWith('/preview')) return schema.parse(agreeing(body.item.itemId === MCP_ITEM ? INSTALL_MCP : INSTALL_SKILL));
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const createClient = async () => catalogClient;
const agreeing = preview => ({
  ...preview,
  publisher: { ...preview.publisher, daemonId: window.__publisher },
  provenance: {
    ...preview.provenance,
    publisher: window.__publisher,
    ...(window.__entries?.[preview.provenance.itemId] ?? {}),
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const mountPage = element => createRoot(root).render(<main data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>{element}</main>);

if (view === 'add-skill' || view === 'add-mcp') {
  mountPage(
    <AddToCatalogSheet
      connection={CONNECTION}
      source={view === 'add-skill' ? { kind: 'skill', skill: SKILL_OWNED.source.path } : { kind: 'mcp', mcp: 'id-acme-user' }}
      label={view === 'add-skill' ? 'pdf-tools' : 'acme-mcp'}
      createClient={createClient}
      onClose={() => undefined}
    />,
  );
} else if (view === 'catalogs' || view === 'sharing-off') {
  mountPage(<CatalogsSurface connection={CONNECTION} createClient={createClient} installHost={{ createClient, crypto, projects: [{ name: 'app', path: '/work/app' }] }} />);
} else {
  const identity = await newIdentity();
  const items = ['skill', 'mcp'].map(kind =>
    SharedCatalogItemSchema.parse(
      kind === 'skill'
        ? { format: 'ferretry-catalog-item', version: 1, publisher: identity.daemonId, catalogId: CATALOG, itemId: SKILL_ITEM, itemVersion: 1, name: 'pdf-tools', summary: 'Split, merge and OCR PDFs', kind, skill: { files: [{ path: 'SKILL.md', content: '# pdf tools\\n' }] } }
        : { format: 'ferretry-catalog-item', version: 1, publisher: identity.daemonId, catalogId: CATALOG, itemId: MCP_ITEM, itemVersion: 1, name: 'acme-mcp', summary: 'Talk to Acme', kind, mcp: { transport: 'command', command: 'npx', args: ['-y', 'acme-mcp', '--stdio'], env: { ACME_TOKEN: '\${secret:ACME_TOKEN}', ACME_WEBHOOK_KEY: '\${secret:ACME_WEBHOOK_KEY}', ACME_REGION: 'eu' } } },
    ),
  );
  const file = await signedFile(identity, items);
  const tampered = SharedCatalogFileSchema.parse({ ...file, items: file.items.map(item => ({ ...item, summary: 'Changed after it was signed' })) });
  window.__publisher = identity.daemonId;
  window.__entries = Object.fromEntries(
    file.signedManifest.manifest.items.map(entry => [entry.itemId, { name: entry.name, version: entry.version, digest: entry.digest }]),
  );
  window.__catalogFile = JSON.stringify(view === 'refused' ? tampered : file);
  mountPage(<InstallFromFileSheet connection={CONNECTION} onClose={() => undefined} host={{ createClient, crypto, projects: [{ name: 'app', path: '/work/app' }] }} />);
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/catalogs-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'catalogs-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'catalogs-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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
  const file = `catalogs-${name}-${theme}-${vp}.png`;
  await page.waitForTimeout(500);
  const sheet = page.locator(crop ?? '[role="dialog"]').first();
  const box = (await sheet.count()) === 0 ? null : await sheet.boundingBox();
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

const give = async (page: Page): Promise<void> => {
  const text = await page.evaluate(() => (window as unknown as { __catalogFile: string }).__catalogFile);
  await page
    .locator('[data-catalog-file-input]')
    .setInputFiles({ name: 'kirin.catalog.json', mimeType: 'application/json', buffer: Buffer.from(text) });
};

const SKILL_ID = `itm_${'s'.repeat(22)}`;
const MCP_ID = `itm_${'m'.repeat(22)}`;

const reviewItem = async (page: Page, itemId: string): Promise<void> => {
  await page.locator('[data-catalog-file-summary]').waitFor({ state: 'visible' });
  await page.locator(`[data-catalog-file-item="${itemId}"] input`).check();
  await page.locator('[data-catalog-scope]').selectOption('runtime');
  await page.locator('[data-catalog-runtime]').selectOption('box');
  await page.locator('[data-catalog-preview]').click();
  await page.locator('[data-catalog-confirm]').waitFor({ state: 'visible' });
};

const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  for (const view of ['add-skill', 'add-mcp'] as const) {
    await open(page, theme, view);
    await page.locator('[data-catalog-preview]').click();
    await page.locator('[data-catalog-preview-block]').waitFor({ state: 'visible' });
    await shot(page, view, theme, vp);
  }

  await open(page, theme, 'catalogs');
  await page.locator('[data-catalogs-list]').waitFor({ state: 'visible' });
  await shot(page, 'list', theme, vp, '[data-catalogs-list]');
  await page.locator('[data-catalog-open]').first().click();
  await page.locator('[data-catalog-detail]').waitFor({ state: 'visible' });
  await shot(page, 'detail', theme, vp, '[data-catalog-detail]');

  await open(page, theme, 'install');
  await give(page);
  await reviewItem(page, MCP_ID);
  await page.locator('[data-catalog-secret="ACME_TOKEN"] select').selectOption('ACME_TOKEN');
  await page.locator('[data-catalog-secret="ACME_WEBHOOK_KEY"] select').selectOption({ label: 'Leave unbound' });
  await shot(page, 'install-mcp', theme, vp);

  await open(page, theme, 'install');
  await give(page);
  await reviewItem(page, SKILL_ID);
  await shot(page, 'install-skill', theme, vp);

  await open(page, theme, 'sharing-off');
  await page.locator('[data-sharing-off]').waitFor({ state: 'visible' });
  await shot(page, 'sharing-off', theme, vp, '[data-sharing-off]');

  await open(page, theme, 'refused');
  await give(page);
  await page.locator('[data-catalog-failure]').waitFor({ state: 'visible' });
  await shot(page, 'refused', theme, vp);
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
  process.stdout.write('✅ Catalogs do not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
