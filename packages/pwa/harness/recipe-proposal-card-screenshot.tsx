/**
 * The recipe card on the agenda (&F640): a ferret's proposed sign-in recipe, answered in chat with Approve and Decline.
 * Six states — ready, standing rule, stale (Decline only), refused (both buttons off), network failure (both on), and approved — on a phone and a desktop, light and dark.
 *
 *   bun harness/recipe-proposal-card-screenshot.tsx [outDir]   # writes recipe-card-<theme>-<viewport>.png
 *
 * It renders the REAL `RecipeProposalCard` with invented data (an example host and account, no value), in the app's own
 * fonts. It fails if a frame scrolls sideways or is drawn in a fallback font.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const workDir = join(harnessDir, 'out');
const shotDir = process.argv[2] ?? workDir;

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
import { RecipeProposalCard } from '../../src/features/input-request/recipe-proposal-card.tsx';
import { RECIPE_APPROVED_WORDS, RECIPE_REFUSED_WHERE } from '../../src/lib/recipe-proposal-card.ts';

const AT = '2026-11-05T10:00:00.000Z';
const account = { id: 'DEMO_GIT', label: 'Example Git', username: 'demo-user', fields: { password: true, totp: false }, factors: [], signIns: ['si_00000000000000a1'], createdAt: AT, updatedAt: AT };
const base = 'Open git.example.com\\nClick Sign in\\nType the username and password from [[DEMO_GIT]]';
const proposal = { id: 'rp_00000000000000b1', base, recipe: 'Open git.example.com\\nClick Continue with SSO\\nPick [[DEMO_SSO]] and wait for the dashboard', why: 'The Sign in button moved behind Continue with SSO, and the password form is gone.', sessionId: 's1', proposedAt: AT };
const signIn = (recipe) => ({ id: 'si_00000000000000a1', account: 'DEMO_GIT', place: { kind: 'site', domains: ['git.example.com'], match: [] }, method: { kind: 'password' }, recipe, recipeVersion: 3, proposals: [proposal], createdAt: AT, updatedAt: AT });
const ready = { kind: 'ready', account, signIn: signIn(base), proposal };
const stale = { kind: 'stale', account, signIn: signIn('Edited by the owner'), proposal };
const noop = () => undefined;
const rule = {
  id: 'sr_' + 'a'.repeat(24), revision: 1, signIn: 'si_00000000000000a1', account: { id: 'DEMO_GIT', label: 'Example Git' },
  username: 'demo-user', place: { kind: 'site', domains: ['git.example.com'], match: [] }, fields: ['username', 'password'], totp: false,
  scope: { kind: 'any' }, createdAt: '2026-10-30T09:00:00.000Z', expiresAt: '2026-11-29T09:00:00.000Z', status: 'active',
  usage: { count: 0 }, flags: [], approvedWith: { deviceId: 'fy_device_id_AAAAAAAAAAAAAAAAAAAAAA', device: 'Demo phone' },
};
const withRule = { askPasskey: undefined, client: { request: async (_path, schema) => schema.parse({ health: 'ok', rules: [rule], stages: [] }) } };
const states = [
  ['Ready', { kind: 'open', view: ready }],
  ['Standing rule on this sign-in', { kind: 'open', view: ready }, withRule],
  ['Recipe changed since', { kind: 'open', view: stale }],
  ['Refused by the machine', { kind: 'failed', view: ready, refused: true, words: 'This device may not change accounts. ' + RECIPE_REFUSED_WHERE }],
  ['Network failed, try again', { kind: 'failed', view: ready, refused: false, words: 'Failed to fetch' }],
  ['Approved', { kind: 'done', ok: true, words: RECIPE_APPROVED_WORDS }],
];

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
    {states.map(([label, phase, rules]) => (
      <section key={label} className="rounded-control border border-border bg-surface p-3" data-shot-state={label}>
        <p className="m-0 mb-2 text-meta text-faint">Recipe change on git.example.com · {label}</p>
        <RecipeProposalCard phase={phase} rules={rules} onApprove={noop} onDecline={noop} settings={{ href: '/d/demo/settings#accounts', onOpen: noop }} />
      </section>
    ))}
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/recipe-card-entry.js"></script></body>
</html>`;

mkdirSync(workDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });
await Bun.write(join(workDir, 'recipe-card-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(workDir, 'recipe-card-entry.jsx'), '--outdir', workDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(workDir, 'app.css'),
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
    return new Response(Bun.file(join(workDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

const shot = async (page: Page, theme: string, vp: string): Promise<void> => {
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = getComputedStyle(document.body).fontFamily;
    return { family, loaded: [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family) };
  });
  if (!faces.loaded.some(face => faces.family.includes(face.replaceAll('"', ''))))
    fail(`${theme} ${vp} is drawn in a fallback font (${faces.family}; loaded: ${faces.loaded.join(', ')})`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${theme} ${vp} scrolls sideways by ${overflow}px`);
  const file = join(shotDir, `recipe-card-${theme}-${vp}.png`);
  await page.screenshot({ path: file, fullPage: true });
  process.stdout.write(`📸 ${file}\n`);
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
        await page.goto(`${server.url}?theme=${theme}`);
        await page.locator('[data-recipe-card]').first().waitFor({ state: 'visible' });
        await page.locator('[data-rule-edit-warning]').first().waitFor({ state: 'visible' });
        await shot(page, theme, vp);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ The recipe card does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
