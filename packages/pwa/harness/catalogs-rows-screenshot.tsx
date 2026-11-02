/**
 * The side panel's ACTIVE skills and MCP servers (docs/catalogs.md "The skill and MCP rows", &B131 A1): the Skills list
 * with its "N active in this session" header (a project skill, one already published with its version, one installed
 * from someone, one not active because another wins), the ⋯ menu open on a published skill and on an installed one,
 * and Publish in a catalog… from the ⋯ on a skill in no catalog. The MCP list has a ⋯ on every row, with Show details
 * opened on two of them. No row has Share or Add, and neither list has "Add from a link…". On a phone and a desktop,
 * light and dark.
 *
 *   bun harness/catalogs-rows-screenshot.tsx      # writes harness/out/catalogs-rows-*.png
 *
 * It renders the REAL `ContextRailBody` (the rail the Skills and MCP lists live in) against an invented machine.
 * It fails if any frame scrolls sideways or a button on the row is shorter than 44px on the phone.
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
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const AT = '2026-10-31T09:00:00.000Z';
const NOW = Date.parse(AT);
const MACHINE = 'studio-mac';
const CONNECTION = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: MACHINE });
const CATALOG = 'cat_' + 'c'.repeat(22);
const DIGEST = 'sha256:' + 'ab'.repeat(32);
const FLOOP_PATH = '/fy/home/.claude/skills/floop/SKILL.md';

const view = new URLSearchParams(location.search).get('view');
const tab = view.startsWith('mcp') ? 'mcp' : 'skills';
let added = view !== 'skills-add';

const owned = (items) => ({
  id: CATALOG, name: 'Team skills', description: '', publisherName: MACHINE, visibility: 'members', revision: 4,
  issuedAt: AT, createdAt: AT, items,
});
const item = (itemId, kind, name, source, versions) => ({
  itemId, kind, name, summary: '', source,
  versions: versions.map(version => ({ version, digest: DIGEST, size: 100, publishedAt: AT })),
});
const FLOOP_ITEM = item('itm_' + 'f'.repeat(22), 'skill', 'floop', { kind: 'skill', path: FLOOP_PATH }, [1, 2, 3]);
const LINEAR_ITEM = item('itm_' + 'l'.repeat(22), 'mcp', 'linear', { kind: 'mcp', id: 'id-linear', name: 'linear' }, [1, 2]);
const PDF_ITEM = item('itm_' + 'p'.repeat(22), 'skill', 'pdf-tools', { kind: 'skill', path: '/fy/home/.claude/skills/pdf-tools/SKILL.md' }, [1]);
const catalogs = () => [owned(added ? [FLOOP_ITEM, LINEAR_ITEM, PDF_ITEM] : [FLOOP_ITEM, LINEAR_ITEM])];

const installRecord = (kind, name, version) => ({
  installId: 'cin_' + (kind === 'skill' ? 'i' : 'j').repeat(22),
  installedAt: AT,
  provenance: {
    publisher: 'fy_daemon_' + 'q3Xk'.repeat(10) + 'Xkq', publisherName: 'Ines', catalogId: 'cat_' + 'x'.repeat(22),
    catalogName: 'Ines’s skills', itemId: 'itm_' + 'x'.repeat(22), kind, name, version, digest: DIGEST,
  },
  target: { scope: 'runtime', runtime: 'claude-work', profile: 'default' },
  destination: 'runtime claude-work, profile default',
  secretBindings: {},
});

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
    skill('floop', 'Review, fix and re-review until the diff is clean', { path: FLOOP_PATH }),
    skill('pdf-tools', 'Split, merge and OCR PDFs'),
    skill('review-pr', 'Walk a pull request the way the team does'),
    skill('summary', 'An older summary of a session', { shadowedBy: 'project' }),
  ],
};
const server = (name, extra = {}) => ({
  id: 'id-' + name, name, scope: 'user', harness: 'claude', transport: 'stdio', target: 'npx',
  runtimes: [{ runtime: 'claude-work' }], ...extra,
});
const MCP = {
  problems: [],
  servers: [
    server('github', { transport: 'http', target: 'https://github.example/mcp' }),
    server('linear', { transport: 'http', target: 'https://linear.example/mcp' }),
    server('notion', { scope: 'project', transport: 'http', target: 'https://notion.example/mcp', project: { root: '/work/app', name: 'app' }, source: '/work/app/.mcp.json', runtimes: [{ runtime: 'claude-work', approval: 'approved' }] }),
    server('scratch', { scope: 'local', project: { root: '/work/app' } }),
  ],
};

const PREVIEW = {
  catalogId: CATALOG, kind: 'skill', name: 'pdf-tools', summary: 'Split, merge and OCR PDFs',
  location: '/fy/home/.claude/skills/pdf-tools/SKILL.md', version: 1, digest: DIGEST, size: 100,
  review: [{ label: 'Skill file SKILL.md', text: '# pdf tools\\n', document: true }], warnings: [], problems: [], secrets: [],
};

const client = {
  request: async (path, _schema, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/v1/catalog-installs')
      return { installs: [installRecord('skill', 'review-pr', 2), installRecord('mcp', 'github', 3)] };
    if (method === 'GET' && path === '/v1/catalogs') return { catalogs: catalogs() };
    if (method === 'POST' && path.endsWith('/items/preview')) return PREVIEW;
    if (method === 'POST' && path.endsWith('/items')) {
      added = true;
      return { itemId: PDF_ITEM.itemId, kind: 'skill', name: 'pdf-tools', itemVersion: 1, digest: DIGEST };
    }
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
};
const createClient = async () => client;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
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
        tab={tab}
        label="Context sections"
        now={() => NOW}
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
    <link rel="stylesheet" href="/catalogs-rows.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/catalogs-rows-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'catalogs-rows-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'catalogs-rows-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'catalogs-rows.css'),
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
  phone: { viewport: { width: 390, height: 1400 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1280, height: 1100 } },
} as const;

const HIDDEN_ANYWHERE = new RegExp(`[${HIDDEN_CHARACTER_SOURCE}]`, 'u');

/** Crops to the list frame, grown to take in whatever floats over it (the ⋯ menu, a sheet). */
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
  const file = `catalogs-rows-${name}-${theme}-${vp}.png`;
  const x = Math.max(0, left - 8);
  const y = Math.max(0, top - 8);
  await page.screenshot({
    path: join(outDir, file),
    fullPage: true,
    clip: { x, y, width: right - x + 8, height: bottom - y + 8 },
  });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

const open = async (page: Page, theme: string, view: string): Promise<void> => {
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.locator('[data-row-use], [data-context-mcp]').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
};

const FRAME = ['[data-frame]'];
const SHEET = ['[role="dialog"]'];

const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  await open(page, theme, 'skills');
  await page.locator('[data-row-from]').first().waitFor({ state: 'visible' });
  if (vp === 'phone') {
    for (const button of await page.locator('[data-row-controls] button').all()) {
      const box = await button.boundingBox();
      if (box !== null && box.height < 44) fail(`a row button is ${box.height}px tall on the phone`);
    }
  }
  await shot(page, 'skills', theme, vp, FRAME);

  await page.locator('[data-catalog-item-row="floop"] [data-row-more]').click();
  await page.getByRole('menu').waitFor({ state: 'visible' });
  await shot(page, 'skills-menu', theme, vp, ['[data-frame]', '[role="menu"]']);

  await open(page, theme, 'skills');
  await page.locator('[data-catalog-item-row="review-pr"] [data-row-more]').click();
  await page.getByRole('menu').waitFor({ state: 'visible' });
  await shot(page, 'skills-menu-installed', theme, vp, ['[data-frame]', '[role="menu"]']);

  await open(page, theme, 'skills-add');
  await page.locator('[data-catalog-item-row="pdf-tools"] [data-row-more]').click();
  await page.getByRole('menu').waitFor({ state: 'visible' });
  await shot(page, 'skills-menu-unpublished', theme, vp, ['[data-frame]', '[role="menu"]']);
  await page.getByRole('menuitem', { name: 'Publish in a catalog…' }).click();
  await page.locator('[data-catalog-sheet="add"]').waitFor({ state: 'visible' });
  await page.locator('[data-catalog-preview]').click();
  await page.locator('[data-catalog-add]').click();
  await page.locator('[data-catalog-landed]').waitFor({ state: 'visible' });
  await shot(page, 'publish', theme, vp, SHEET);

  await open(page, theme, 'mcp');
  await page.locator('[data-row-from]').first().waitFor({ state: 'visible' });
  await shot(page, 'mcp', theme, vp, FRAME);

  await page.locator('[data-context-mcp="scratch"] [data-row-more]').click();
  await page.getByRole('menu').waitFor({ state: 'visible' });
  await shot(page, 'mcp-menu-scratch', theme, vp, ['[data-frame]', '[role="menu"]']);
  await page.getByRole('menuitem', { name: 'Show details' }).click();
  await page.locator('[data-context-mcp="notion"] [data-row-more]').click();
  await page.getByRole('menuitem', { name: 'Show details' }).click();
  await page.locator('[data-mcp-details="notion"]').waitFor({ state: 'visible' });
  await shot(page, 'mcp-details', theme, vp, FRAME);
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
  process.stdout.write('✅ Skill and MCP rows do not scroll sideways, and their buttons are 44px tall on a phone\n');
} finally {
  await browser.close();
  server.stop();
}
