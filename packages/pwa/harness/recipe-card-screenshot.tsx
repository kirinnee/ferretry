/**
 * Screenshots of a ferret's suggested sign-in recipe, answered on its own card (docs/input-requests.md "A recipe
 * proposal on its card"), at a 390px phone and a 1440px desktop, in the light and dark studio themes. Review evidence;
 * nothing compares the PNGs.
 *
 *   bun harness/recipe-card-screenshot.tsx [out-dir] [states]   # writes recipe-card-<state>-<viewport>-<scheme>.png
 *
 * `states` is a comma list of: card (the steps against the recipe they replace, the ferret's quoted words, what
 * Ferretry itself saw, Decline · Edit · Approve), edit (the textarea prefilled, Approve my version), approved (the
 * words the card closes with), declined, stale (the recipe changed since, nothing saved), failed (a refusal in words, the
 * owner's text kept), fallback (a device that may not read accounts: the plain card as it always was).
 *
 * Fake fixtures only (`tests/support/accounts-fixtures.ts`): no real account, no daemon, no value. A recipe holds no
 * secret. Every width asserts no sideways scroll and the touch floor on every button of the phone.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

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
import { Markdown } from '../../src/components/markdown.tsx';
import { AgendaItemView } from '../../src/features/agenda/agenda-item-view.tsx';
import { RecipeProposalHost } from '../../src/features/secrets/recipe-proposal-host.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { list, PROPOSAL, SI_GITHUB } from '../../tests/support/accounts-fixtures.ts';
import { NOW } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view');
const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const quiet = () => undefined;

const RECIPE = [
  'Open the sign-in page',
  'Fill the username',
  'Press Sign in',
  'Wait for the code prompt',
  'Ask the owner for the code',
].join('\\n');
const PROPOSED = [
  'Open the sign-in page',
  'Fill the username',
  'Press Continue',
  'Fill the password',
  'Press Sign in',
  'Wait for the code prompt',
  'Ask the owner for the code',
].join('\\n');

const accounts = () => {
  const base = list();
  return {
    ...base,
    signIns: base.signIns.map(each =>
      each.id === SI_GITHUB
        ? {
            ...each,
            recipe: RECIPE,
            recipeVersion: 3,
            proposals: [{ ...each.proposals[0], base: RECIPE, recipe: PROPOSED, why: 'GitHub now asks for the username on its own page, then the password.' }],
          }
        : each,
    ),
  };
};

const refused = (message, extra) => Object.assign(new Error(message), extra);
const answerFor = (path, method) => {
  if (method === 'GET') {
    if (view === 'fallback') throw refused('Forbidden', { status: 403, code: 'grant_forbidden' });
    return accounts();
  }
  if (view === 'stale') throw refused('refused', { status: 409, code: 'stale_proposal' });
  if (view === 'failed') throw refused('The secret store is damaged.', { status: 500 });
  return accounts().signIns[0];
};
const client = { request: async (path, schema, init) => schema.parse(answerFor(path, init?.method ?? 'GET')) } as never;

const item = {
  id: 'A12', source: 'question', sourceRef: 'recipe', sourceSeq: 2, kind: 'task',
  title: 'Approve a new way to sign in to github.com',
  subject: 'Approve a new way to sign in to github.com',
  why: 'GitHub changed its sign-in page.',
  ask: { kind: 'choices', options: [{ label: 'Open Settings' }] },
  context: '- 1 step added\\n- 1 step removed\\nOpen Settings › Accounts › github.com to read them.',
  neededBy: '2026-11-01T11:00:00.000Z', waitingSince: '2026-11-01T09:00:00.000Z',
  raisedBy: 'daemon', raisedBySession: 'sess-1',
  recipeProposal: { signIn: SI_GITHUB, id: PROPOSAL },
};

const root = document.getElementById('root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]" style={{ height: '100vh', display: 'grid' }}>
      <AgendaItemView busy={false} error={null} ferret="Hadi" history={[]} item={item} now={NOW} onAct={quiet}
        onClose={quiet} position={{ index: 0, total: 1 }} renderProse={text => <Markdown text={text} />} swipeable={false}
        planForm={<RecipeProposalHost agentName="Hadi" connection={connection} createClient={async () => client} item={item} />} />
    </div>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/recipe-card-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'recipe-card-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'recipe-card-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const ALL_STATES = ['card', 'edit', 'approved', 'declined', 'stale', 'failed', 'fallback'] as const;
const wanted = process.argv[3]?.split(',');
const STATES = ALL_STATES.filter(state => wanted === undefined || wanted.includes(state));

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = url.pathname.startsWith('/assets/fonts/')
      ? Bun.file(join(packageDir, 'src', url.pathname))
      : Bun.file(join(buildDir, url.pathname));
    return new Response(file);
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, shot: 1_500, touch: true },
  { name: 'desktop', width: 1_440, height: 900, shot: 1_100, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.shot },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
        for (const state of STATES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${state}`);
          const where = `${state} at ${viewport.name}/${scheme}`;
          if (state === 'fallback') {
            await page.locator('[data-agenda-need]').first().waitFor({ state: 'visible' });
            if ((await page.locator('[data-recipe-proposal]').count()) > 0) fail(`${where} drew the recipe card`);
          } else {
            await page.locator('[data-recipe-proposal]').first().waitFor({ state: 'visible' });
            if ((await page.locator('[data-agenda-need]').count()) > 0) fail(`${where} drew the generic ask`);
            if ((await page.locator('[data-agenda-dismiss]').count()) > 0) fail(`${where} drew Not needed`);
            if ((await page.locator('[data-agenda-section="context"]').count()) > 0)
              fail(`${where} drew the card context`);
          }
          if (state === 'edit' || state === 'failed') {
            await page.locator('[data-recipe-edit]').click();
            await page.locator('[data-recipe-text]').waitFor({ state: 'visible' });
          }
          if (state === 'failed') {
            await page.locator('[data-recipe-text]').fill('1. Open the sign-in page\n2. Press Sign in, then wait');
            await page.locator('[data-recipe-approve-mine]').click();
            await page.locator('[data-recipe-error]').waitFor({ state: 'visible' });
          }
          if (state === 'approved') {
            await page.locator('[data-recipe-approve]').click();
            await page.locator('[data-recipe-done]').waitFor({ state: 'visible' });
          }
          if (state === 'declined') {
            await page.locator('[data-recipe-decline]').click();
            await page.locator('[data-recipe-done]').waitFor({ state: 'visible' });
          }
          if (state === 'stale') {
            await page.locator('[data-recipe-approve]').click();
            await page.locator('[data-recipe-stale]').waitFor({ state: 'visible' });
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            for (const height of await page
              .locator('[data-recipe-proposal] button')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
          }
          const target = join(outDir, `recipe-card-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
