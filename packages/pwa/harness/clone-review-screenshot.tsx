/**
 * Copy from another machine, the Update review (docs/design/account-model.md §4.7; smart re-copy design §6):
 * every state of the sheet, each at a 390px phone and a 1440px desktop, in the light and the dark studio
 * theme. Review evidence for the owner; nothing compares the PNGs.
 *
 *   bun harness/clone-review-screenshot.tsx [out-dir]   # writes <out-dir>/<scheme>/<state>-<viewport>.png
 *
 * `out-dir` defaults to harness/out/clone-review. The states:
 *
 *   first-copy         a source never copied before: the preview, as it has always been
 *   existing-step      the three-choice step: Update (default), Add alongside, Start over (Replace)
 *   update-all-groups  every group populated, the both-changed items chosen, Apply ready
 *   both-unchosen      the same, nothing chosen for the both-changed items: Apply off, and said so
 *   both-chosen        both-changed items chosen, their changes opened
 *   nothing-to-copy    nothing differs: one note and Done
 *   identical-legacy   an identical old copy matched by name: the note, what finishing links, and its button
 *   two-conflicts      two both-changed items with this machine's value beside the source's, one chosen
 *   kept-with-settings only kept items, a settings file ticked: the button counts it, not "Nothing to copy"
 *   logins-ask         a sign-in several logins here fit, a matched one, an empty slot, an API-key login
 *   relocated          an item that lands elsewhere, and why
 *   stale-review       the apply refused because the review moved, with Review again
 *   done-held          Done: what changed per group, and a held setting with Confirm
 *
 * It renders the REAL `CloneMachine` against two invented machines; the review is the invented one in
 * `tests/unit/features/fleet/setup/clone-review-support.ts`. No credential, token or real name exists in it.
 * It fails if any frame scrolls sideways.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? join(buildDir, 'clone-review'));

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
import { CLONE_REVIEW_STALE } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { CloneMachine } from '../../src/features/fleet/setup/clone.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { machineSetupAnswer } from '../machine-setup-fixture.ts';
import {
  FIRST_REVIEW,
  FULL_REVIEW,
  HERE_GUARD_SCRIPT,
  ITEMS,
  NOTHING_REVIEW,
  review,
  UPDATE_BUNDLE,
} from '../../tests/unit/features/fleet/setup/clone-review-support.ts';
import {
  APPLY_PATH,
  bundle,
  credentials,
  credentialView,
  machineAnswer,
  machineView,
  STAGED,
} from '../../tests/unit/features/fleet/setup/setup-support.ts';

const state = new URLSearchParams(location.search).get('state') ?? 'update-all-groups';

const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const WORK = daemonConnection({ daemonId: 'work', baseUrl: 'https://work.example.test', deviceId: 'd-work' });
const WORK_RECORD = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };

// The review each state is about.
const MORE_LOGINS = review({
  items: [],
  logins: [
    { sourceId: 'claude-work', outcome: 'matched', target: 'claude-work' },
    { sourceId: 'codex-work', outcome: 'ask', candidates: ['codex-main', 'codex-spare'] },
    { sourceId: 'claude-lab', outcome: 'slot' },
    {
      sourceId: 'glm-env',
      outcome: 'slot',
      runnable: {
        entries: [
          { label: 'Harness', text: 'Claude Code', document: false },
          { label: 'ANTHROPIC_BASE_URL', text: 'https://api.example.test/anthropic', document: false },
          { label: 'ANTHROPIC_AUTH_TOKEN', text: '\${secret:GLM_API_KEY}', document: false },
        ],
      },
    },
  ],
  same: { count: 4, probable: 1 },
});
const REVIEWS = {
  'first-copy': FIRST_REVIEW,
  'existing-step': FULL_REVIEW,
  'update-all-groups': FULL_REVIEW,
  'both-unchosen': FULL_REVIEW,
  'both-chosen': review({ items: [ITEMS.bothSettings, ITEMS.bothHooks, ITEMS.newMcp], same: { count: 9, probable: 0 } }),
  'nothing-to-copy': review({ same: { count: 12, probable: 0 } }),
  'identical-legacy': NOTHING_REVIEW,
  'two-conflicts': review({ items: [ITEMS.bothSettings, ITEMS.bothProfile], same: { count: 8, probable: 0 } }),
  'kept-with-settings': review({ items: [ITEMS.mineInstructions, ITEMS.goneRuntime], same: { count: 8, probable: 0 } }),
  'logins-ask': MORE_LOGINS,
  relocated: review({ items: [ITEMS.relocated, ITEMS.theirsHooks], same: { count: 9, probable: 1 } }),
  'stale-review': FULL_REVIEW,
  'done-held': review({ items: [ITEMS.newMcp, ITEMS.theirsHooks], same: { count: 8, probable: 0 } }),
};

const MORE_BUNDLE = bundle({
  ...UPDATE_BUNDLE,
  credentials: [
    ...UPDATE_BUNDLE.credentials,
    { id: 'claude-lab', harness: 'claude', label: 'Lab' },
    { id: 'glm-env', harness: 'claude', label: 'GLM', store: 'environment', preset: 'zai-glm',
      env: { ANTHROPIC_BASE_URL: 'https://api.example.test/anthropic', ANTHROPIC_AUTH_TOKEN: '\${secret:GLM_API_KEY}' } },
  ],
});

// This machine's own export: its guard script differs, its launch flags are fewer, and its default profile has a layer more.
const HERE_BUNDLE = bundle({
  files: [{ path: 'components/hooks/guard/send.sh', content: HERE_GUARD_SCRIPT }],
  components: {
    hooks: { guard: { directory: 'components/hooks/guard' } },
    settings: { shared: { flags: ['--verbose'] } },
  },
  profiles: { default: { layers: ['instructions/default', 'mcp/other'] } },
  runtimes: {},
  credentials: [],
});

// Signed-in logins here, so a source sign-in that matches one is not asked for again.
const signedIn = overrides => credentialView(overrides.id, {
  ...overrides.rest,
  status: { ...credentialView('x').status, word: 'ready', label: 'Ready' },
});
const HERE_LOGINS = credentials([
  signedIn({ id: 'claude-work', rest: { email: 'me@work.example' } }),
  signedIn({ id: 'codex-main', rest: { harness: 'codex', email: undefined, label: 'Main' } }),
  signedIn({ id: 'codex-spare', rest: { harness: 'codex', email: undefined, label: 'Spare' } }),
]);

const STACKS = { format: 'version-2', profiles: [
  { name: 'default', layers: ['instructions/default'], usedBy: [], baseFor: [], wouldIncludeItself: [],
    scope: { kind: 'scoped', scope: 'generic' }, harnesses: [], remove: { available: true } } ] };

let applied = false;

const answerFor = machine => (path, init) => {
  const method = init?.method ?? 'GET';
  const isWork = machine === 'work';
  const fixture = machineSetupAnswer(isWork ? 'work-linux' : 'studio-mac', isWork, path, init);
  if (fixture !== undefined) return fixture;
  if (isWork) {
    if (path === '/v1/fleet/machine') return machineView({ name: 'work-linux', runtimeCount: 3 });
    if (path === '/v1/fleet/export') return state === 'logins-ask' ? MORE_BUNDLE : UPDATE_BUNDLE;
  } else {
    if (path === '/v1/fleet/machine') return machineView({ runtimeCount: 2 });
    if (path === '/v1/fleet/profiles') return STACKS;
    if (path === '/v1/fleet/clone/review') return REVIEWS[state];
    if (path === '/v1/fleet/export') return HERE_BUNDLE;
    if (path === '/v1/fleet/credentials') return HERE_LOGINS;
    if (path === '/v1/fleet/proposals' && method === 'POST') {
      if (state === 'stale-review') throw new FyHttpError(CLONE_REVIEW_STALE, 409, 'fleet_change_refused');
      return STAGED;
    }
    if (path === APPLY_PATH) {
      applied = true;
      return { outcome: 'executed', executor: 'clone', summary: 'Updated studio-mac from work-linux: 2 items updated, 1 item added, 0 items removed.' };
    }
  }
  throw new Error('the harness has no answer for ' + method + ' ' + path);
};

const createClient = async connection => {
  const answer = answerFor(connection.daemonId);
  return { request: async (path, schema, init) => schema.parse(answer(path, init)) };
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 1200, padding: '12px 16px' }}>
    <CloneMachine
      sources={[WORK_RECORD]}
      connection={STUDIO}
      machineName="studio-mac"
      machine={machineView({ runtimeCount: 2 })}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={createClient}
      onDone={() => undefined}
      onLeave={() => undefined}
    />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/clone-review-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
await Bun.write(join(buildDir, 'clone-review-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'clone-review-entry.jsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
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
    return new Response(
      url.pathname.startsWith('/assets/fonts/')
        ? Bun.file(join(packageDir, 'src', url.pathname))
        : Bun.file(join(buildDir, url.pathname)),
    );
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

const SCHEMES = { light: 'studio-light', dark: 'studio-dark' } as const;

/** The whole stepper, top to bottom, so one frame shows the story. Fails on any sideways scroll. */
const shot = async (page: Page, state: string, scheme: string, vp: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${state} ${scheme} ${vp} scrolls sideways by ${overflow}px`);
  const wide = await page.evaluate(() => {
    const limit = window.innerWidth;
    return [...document.querySelectorAll('[data-fixture] *')]
      .filter(element => element.getBoundingClientRect().right > limit + 1)
      .map(element => element.tagName.toLowerCase() + '.' + String(element.className).slice(0, 40))
      .slice(0, 3);
  });
  if (wide.length > 0) fail(`${state} ${scheme} ${vp} has content past the right edge: ${wide.join(', ')}`);
  const box = await page.evaluate(() => {
    const frame = document.querySelector('[data-machine-stepper]') as HTMLElement;
    const rect = frame.getBoundingClientRect();
    return { y: rect.top + window.scrollY - 8, height: rect.height + 16, width: window.innerWidth };
  });
  mkdirSync(join(outDir, scheme), { recursive: true });
  const file = join(outDir, scheme, `${state}-${vp}.png`);
  await page.screenshot({
    path: file,
    fullPage: true,
    clip: { x: 0, y: Math.max(0, box.y), width: box.width, height: box.height },
  });
  process.stdout.write(`📸 ${file}\n`);
};

const click = async (page: Page, selector: string): Promise<void> => {
  await page.locator(selector).first().click();
};

const toExisting = async (page: Page): Promise<void> => {
  await page.locator('[data-setup-choice="work"]').waitFor({ state: 'visible' });
  await click(page, '[data-setup-choice="work"]');
  await click(page, '[data-step-next]');
};

const toChanges = async (page: Page): Promise<void> => {
  await toExisting(page);
  await page.locator('[data-clone-step="existing"]').waitFor({ state: 'visible' });
  await click(page, '[data-step-next]');
  await page.locator('[data-clone-step="preview"]').waitFor({ state: 'visible' });
};

const openAll = async (page: Page): Promise<void> => {
  await page.locator('details').evaluateAll(elements => {
    for (const element of elements) (element as HTMLDetailsElement).open = true;
  });
};

const settle = async (page: Page): Promise<void> => {
  await page.waitForTimeout(150);
};

const walk = async (page: Page, state: string, scheme: string, vp: string): Promise<void> => {
  await page.goto(`${server.url}?theme=${SCHEMES[scheme as keyof typeof SCHEMES]}&state=${state}`, {
    timeout: 120_000,
  });
  switch (state) {
    case 'first-copy':
      await toExisting(page);
      await page.locator('[data-clone-step="preview"]').waitFor({ state: 'visible' });
      break;
    case 'existing-step':
      await toExisting(page);
      await page.locator('[data-clone-step="existing"]').waitFor({ state: 'visible' });
      break;
    case 'update-all-groups':
      await toChanges(page);
      await click(page, '[data-review-pick="settings/shared:take"]');
      break;
    case 'both-unchosen':
      await toChanges(page);
      await page.locator('[data-review-hold]').waitFor({ state: 'visible' });
      break;
    case 'both-chosen':
      await toChanges(page);
      await click(page, '[data-review-pick="settings/shared:keep"]');
      await click(page, '[data-review-pick="hooks/lint:take"]');
      await openAll(page);
      break;
    case 'nothing-to-copy':
      await toChanges(page);
      await page.locator('[data-setup-note="nothing-to-copy"]').waitFor({ state: 'visible' });
      break;
    case 'identical-legacy':
      await toChanges(page);
      await page.locator('[data-setup-note="link-by-name"]').waitFor({ state: 'visible' });
      break;
    case 'two-conflicts':
      await toChanges(page);
      await click(page, '[data-review-pick="settings/shared:keep"]');
      await page.locator('[data-review-hold]').waitFor({ state: 'visible' });
      break;
    case 'kept-with-settings':
      await toChanges(page);
      await click(page, '[data-setup-choice="warden"]');
      break;
    case 'logins-ask':
      await toChanges(page);
      await click(page, '[data-review-login-pick="codex-work:codex-main"]');
      break;
    case 'relocated':
      await toChanges(page);
      await openAll(page);
      break;
    case 'stale-review':
      await toChanges(page);
      await click(page, '[data-review-pick="settings/shared:keep"]');
      await click(page, '[data-change-submit]');
      await page.locator('[data-setup-note="stale-review"]').waitFor({ state: 'visible' });
      break;
    case 'done-held':
      await toChanges(page);
      await click(page, '[data-setup-choice="warden"]');
      await click(page, '[data-change-submit]');
      await page.locator('[data-clone-confirm]').waitFor({ state: 'visible' });
      break;
    default:
      fail(`unknown state ${state}`);
  }
  await settle(page);
  await shot(page, state, scheme, vp);
};

const STATES = [
  'first-copy',
  'existing-step',
  'update-all-groups',
  'both-unchosen',
  'both-chosen',
  'nothing-to-copy',
  'identical-legacy',
  'two-conflicts',
  'kept-with-settings',
  'logins-ask',
  'relocated',
  'stale-review',
  'done-held',
] as const;

try {
  for (const scheme of Object.keys(SCHEMES)) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      for (const state of STATES) {
        const context = await browser.newContext({
          ...options,
          deviceScaleFactor: vp === 'phone' ? 2 : 1,
          colorScheme: scheme === 'dark' ? 'dark' : 'light',
        });
        try {
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
          );
          const page = await context.newPage();
          page.setDefaultTimeout(120_000);
          page.on('pageerror', error => fail(`the page threw: ${error.message}`));
          await walk(page, state, scheme, vp);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  }
  process.stdout.write(`✅ The update review does not scroll sideways at 390px or 1440px: ${outDir}\n`);
} finally {
  await browser.close();
  server.stop();
}
