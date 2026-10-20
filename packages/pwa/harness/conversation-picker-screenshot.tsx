/**
 * "Import conversations" and New session's "Continue a conversation", on a phone and a desktop, in a
 * dark and a light theme: the picker with a few rows kept, one "Start now" on and a row a ferret already
 * keeps; Continue's ONE list under each source chip (All, and Ferretry — what ferrets keep and the
 * stopped ferrets) with the date filter; each row the shared card — a coloured avatar (a ferret's
 * initial and state dot, else the CLI's mark), its name or first real message, and the ferret, CLI and
 * folder badges, a scratch run tagged "scratch"; and an open row showing its last exchanges above the
 * button that continues it.
 *
 *   bun harness/conversation-picker-screenshot.tsx      # writes harness/out/conversation-picker-*.png
 *
 * The page entry is written as `.jsx`: `harness/` is in the typecheck, and an untyped fixture must stay out of it.
 *
 * It renders the REAL `ConversationPicker` and `ContinueConversation` against a fake machine that answers
 * the listing and the preview with invented folders and messages, and invented stopped ferrets — no real
 * conversation is read. It fails if either
 * surface scrolls sideways at 390px.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
import { ContinueConversation } from '../../src/features/fleet/conversations/continue-conversation.tsx';
import { ConversationPicker } from '../../src/features/fleet/conversations/conversation-picker.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const ago = hours => new Date(NOW - hours * 3_600_000).toISOString();
const ROWS = [
  { id: 'c1', harness: 'claude', name: 'Checkout total: coupon plus gift card', project: '/work/shop', preview: 'Fix the checkout total when a coupon and a gift card are both applied', latest: 'Now add a test for the rounding', lastActivityAt: ago(2), turns: 14, model: 'Sonnet 5.5' },
  { id: 'c2', harness: 'claude', name: 'Safari cart badge flicker', project: '/work/shop', preview: 'Why does the cart badge flicker on Safari?', lastActivityAt: ago(30), turns: 6, model: 'Opus 5.5' },
  { id: 'c3', harness: 'claude', name: 'Weekly meeting notes digest', project: '/work/notes', preview: 'Summarise this week of meeting notes into a short list', lastActivityAt: ago(5), turns: 3, model: 'Haiku 5.5', adoptedBy: 'notes-weekly' },
  { id: 'c4', harness: 'claude', project: '/work/notes', preview: 'Tag every note that mentions the launch', lastActivityAt: ago(50), turns: 9 },
  { id: 'c5', harness: 'codex', name: 'Invoice webhook retries', project: '/work/api/services/billing-gateway-with-a-long-folder-name', preview: 'Add retries to the invoice webhook', lastActivityAt: ago(80), turns: 22, model: 'GPT-6' },
  { id: 'c6', harness: 'claude', project: '/work/shop', preview: 'Rename the product grid component', lastActivityAt: ago(24 * 9), turns: 2, model: 'Sonnet 5.5' },
  { id: 'c7', harness: 'claude', project: '/tmp/claude-1000/-work-shop/d711c5af-2c1e-4b7a-9d3e-0f6a1b2c3d4e/scratchpad', preview: 'Fix the checkout total when a coupon is applied', lastActivityAt: ago(3), turns: 4, model: 'Opus 5.5' },
  { id: 'c8', harness: 'codex', project: '/work/api', preview: 'Add retries to the invoice webhook and log each attempt', lastActivityAt: ago(4), turns: 2, model: 'GPT-6', adoptedBy: 'billing-live' },
  { id: 'c9', harness: 'claude', name: 'Ledger move to Postgres', project: '/work/ledger', preview: 'Move the ledger from SQLite to Postgres', latest: 'hi', lastActivityAt: ago(1), turns: 186, turnsAtLeast: true, model: 'Opus 5.5' },
];
const ferret = (id, name, harness, cwd, status, hours) => ({
  config: { id, name, teammate: name, harness, cwd, updatedAt: ago(hours) },
  state: { status, lastActivityAt: ago(hours) },
});
const SESSIONS = [
  ferret('notes-weekly', 'wren', 'claude', '/work/notes', 'stopped', 5),
  ferret('shop-badge', 'otto', 'claude', '/work/shop', 'completed', 30),
  ferret('billing-retries', 'ash', 'codex', '/work/api/services/billing', 'failed', 80),
  ferret('live-one', 'pip', 'claude', '/work/shop', 'running', 1),
  ferret('billing-live', 'juno', 'codex', '/work/api', 'running', 4),
];
ROWS[5].adoptedBy = 'shop-badge';
const PREVIEW = [
  { role: 'user', text: 'Summarise this week of meeting notes into a short list' },
  { role: 'assistant', text: 'Here are the five decisions and three open questions from this week, grouped by team.' },
  { role: 'user', text: 'Add who owns each open question' },
  { role: 'assistant', text: 'Done: Mara owns pricing, Theo the launch date, and the partner list is unowned so far.' },
  { role: 'user', text: 'Turn the unowned one into a task for Monday' },
  { role: 'assistant', text: 'Added "Find an owner for the partner list" to Monday, linked to the notes.' },
];
const RUNTIMES = [
  { name: 'claude-default', wrapper: 'claude-default', harness: 'claude' },
  { name: 'claude-work', wrapper: 'claude-work', harness: 'claude' },
  { name: 'codex-default', wrapper: 'codex-default', harness: 'codex' },
];
const client = {
  request: async (path, schema) => {
    if (path.endsWith('/preview')) {
      const id = path.split('/').at(-2);
      return schema.parse({ id, harness: 'claude', messages: PREVIEW });
    }
    if (path.startsWith('/v1/imports/conversations')) {
      const query = new URL(path, 'https://machine.test').searchParams;
      const harness = query.get('harness');
      const rows = ROWS.filter(row => harness === null || row.harness === harness);
      return schema.parse({ conversations: rows, matched: rows.length, skipped: 0 });
    }
    if (path === '/v1/fleet/runtimes') return schema.parse({ format: 'version-2', runtimes: [] });
    throw new Error('no route ' + path);
  },
};
const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' });
const view = new URLSearchParams(location.search).get('view');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
    <section className="kt-panel p-panel">
      {view !== 'picker' ? (
        <ContinueConversation connection={connection} createClient={async () => client} onNavigate={() => undefined} now={() => NOW} sessions={SESSIONS} resume={async () => undefined} />
      ) : (
        <ConversationPicker connection={connection} createClient={async () => client} harness="claude" runtimes={RUNTIMES} now={() => NOW} />
      )}
    </section>
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/conversation-picker-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'conversation-picker-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'conversation-picker-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Keep two rows, switch Start now on for the first, the way a person would. */
const pickSome = async (page: Page): Promise<void> => {
  await page.locator('[data-conversation-keep="c1"]').check();
  await page.locator('[data-conversation-keep="c2"]').check();
  await page.locator('[data-conversation-keep="c4"]').check();
  await page.locator('[data-conversation-start="c1"]').click();
  await page.locator('[data-segment="claude-work"]').click();
};

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

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
        for (const view of ['picker', 'all', 'ferretry', 'preview'] as const) {
          const page = await context.newPage();
          await page.goto(`${server.url}?theme=${theme}&view=${view}`);
          if (view === 'picker') {
            await page.locator('[data-conversations-found]').waitFor({ state: 'visible' });
            await pickSome(page);
          } else {
            await page.locator('[data-continue-count]').waitFor({ state: 'visible' });
            if (view === 'ferretry') {
              await page.locator('[data-segment="ferretry"]').click();
              await page.locator('[data-continue-row="c3"]').waitFor({ state: 'visible' });
            }
            if (view === 'preview') {
              await page.locator('[data-continue-row="c3"]').click();
              await page.locator('.fy-convo-exchange').first().waitFor({ state: 'visible' });
            }
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${view} ${theme} ${vp} scrolls sideways by ${overflow}px`);
          const name = view === 'picker' ? 'conversation-picker' : `conversation-continue-${view}`;
          const file = `${name}-${theme}-${vp}.png`;
          await page.screenshot({ path: join(outDir, file), fullPage: true });
          process.stdout.write(`📸 ${join(outDir, file)}\n`);
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ neither surface scrolls sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
