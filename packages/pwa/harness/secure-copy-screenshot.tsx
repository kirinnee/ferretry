/**
 * Screenshots of secure copy's three owner screens (docs/secure-copy.md), at a 390px phone and a 1440px desktop,
 * in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/secure-copy-screenshot.tsx [out-dir] [states]   # writes secure-copy-{paste,page,store,plan,rules}-*.png
 *
 * `states` is a comma list (paste,page,store,plan,rules) when only some are wanted.
 *
 * Fake fixtures only: no real account, no real daemon, no value (a paste card never holds one). "paste" is the
 * input card a paste raises: a token sealed from `vercel tokens create`, going into the `vercel` program reading
 * %terminal:dev, with the daemon's risk flag. "store" is the same copy saved as the secret VERCEL_TOKEN, which
 * already holds a value, so the card warns it replaces it. "page" is a copy from the vercel found in
 * ~/.bun/bin going into a password field on vercel.com. "plan" is the card a ferret raises before it starts, two planned
 * pastes with one ticked off. "rules" is Settings › Secure copy › Pastes approved in advance, with programs in the
 * owner's own profile allowed, the gh → vercel rule marked as one into the profile, and the add form open on a rule
 * into bash, which it warns runs whatever it reads.
 * Every width asserts no sideways scroll and the touch floor on every button of the phone.
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
import { InputCard } from '../../src/features/input-request/input-card.tsx';
import { CopyPlanCard } from '../../src/features/secure-copy/copy-plan-card.tsx';
import { CopyRulesCard } from '../../src/features/secure-copy/copy-rules-card.tsx';
import { fieldsOf } from '../../src/lib/input-card.ts';
import { NOW, browserField, field, request as fakeRequest } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view');
const client = { request: async () => { throw new Error('the harness has no daemon'); } } as never;
const quiet = async () => true;

// The daemon's own sentence for a recognised-program terminal secret (service.ts riskOf).
const GREEN = { level: 'green', reason: 'Typing is hidden and the program is one known to ask for a password.' } as const;
const paste = fakeRequest({
  prompt: 'The new deploy token for the production env',
  sensitivity: 'secret',
  target: { kind: 'terminal', key: 'dev' },
  fields: [field('secret', { label: 'Token', risk: GREEN })],
  risk: GREEN,
  source: { kind: 'sealed', name: 'vercel_token', from: { kind: 'command', program: 'vercel' } },
  observed: {
    kind: 'terminal',
    paneProof: { paneId: '%4', pid: 5100 },
    foreground: { pid: 5120, pgid: 5120, comm: 'vercel', argv: 'vercel env add TOKEN production' },
    echo: 'off',
    cursorRow: 9,
    promptLine: '? What’s the value of TOKEN?',
    promptLineDigest: 'a'.repeat(64),
    program: 'vercel',
    recognisedConsumer: true,
  },
});

// The daemon's own sentence for a paste replacing a secret (service.ts riskOf).
const REPLACES = { level: 'amber', reason: 'This replaces the value the secret holds now; the old value is gone for good.' } as const;
const store = fakeRequest({
  prompt: 'The new deploy token, kept for the deploy script',
  sensitivity: 'secret',
  target: { kind: 'secret', key: 'VERCEL_TOKEN' as never },
  fields: [field('secret', { label: 'Token', risk: REPLACES })],
  risk: REPLACES,
  source: { kind: 'sealed', name: 'vercel_token', from: { kind: 'command', program: 'vercel' } },
  observed: { kind: 'secret', name: 'VERCEL_TOKEN', exists: true },
} as Parameters<typeof fakeRequest>[0]);

// The daemon's own sentence for a password field on a secure page (service.ts pageRiskOf).
const PASSWORD = { level: 'green', reason: 'A password field on a secure page, as the browser reported it.' } as const;
const intoPage = fakeRequest({
  prompt: 'The deploy token for the project settings page',
  sensitivity: 'secret',
  target: { kind: 'browser', key: 'app' },
  fields: [field('secret', { id: 'value', risk: PASSWORD })],
  risk: PASSWORD,
  source: {
    kind: 'sealed',
    name: 'vercel_token',
    from: { kind: 'command', program: 'vercel', path: '/home/kirin/.bun/bin/vercel' },
  },
  observed: {
    kind: 'browser',
    pageId: 'page-1',
    origin: 'https://vercel.com',
    secure: true,
    navigationId: 'nav-1',
    fields: [browserField('value', { frameOrigin: 'https://vercel.com', field: { tag: 'input', type: 'password' } })],
  },
} as Parameters<typeof fakeRequest>[0]);

const plan = {
  id: 'b'.repeat(32),
  sessionId: 'sess-1',
  agendaItemId: 'A8',
  items: [
    { from: { kind: 'command', program: 'vercel' }, to: { kind: 'terminal', program: 'vercel' }, why: 'the production deploy token' },
    { from: { kind: 'browser', origin: 'https://github.com' }, to: { kind: 'browser', origin: 'https://vercel.com' }, why: 'the GitHub token Vercel builds with' },
  ],
  state: 'pending',
  raisedAt: '2026-08-05T09:58:00.000Z',
  expiresAt: '2026-08-05T11:58:00.000Z',
} as never;

const rules = [
  { id: '1'.repeat(32), from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' }, remaining: 3, used: 1, createdAt: '2026-08-05T09:00:00.000Z', createdBy: { kind: 'host' }, expiresAt: '2026-08-06T09:00:00.000Z' },
  { id: '2'.repeat(32), from: { kind: 'clipboard', origin: 'https://github.com' }, to: { kind: 'browser', origin: 'https://vercel.com' }, used: 0, createdAt: '2026-08-05T09:10:00.000Z', createdBy: { kind: 'device', deviceId: 'phone-1' } },
  { id: '3'.repeat(32), from: { kind: 'command', program: 'vercel' }, to: { kind: 'terminal', program: 'vercel' }, sessionId: 'sess-1', remaining: 1, used: 0, createdAt: '2026-08-05T09:58:30.000Z', createdBy: { kind: 'host' }, expiresAt: '2026-08-05T11:58:00.000Z', plan: 'b'.repeat(32) },
] as never;

const pasteItem = {
  id: 'A7', source: 'question', sourceRef: paste.id, sourceSeq: 1, kind: 'input',
  title: 'Wants to paste a secure copy',
  subject: 'Allow pasting sealed:vercel_token (64 characters from vercel) into the terminal. You type nothing.',
  why: 'Allow pasting sealed:vercel_token (64 characters from vercel) into the terminal. You type nothing.',
  context: 'The agent says: The new deploy token for the production env',
  howToResolve: 'Open the card and allow the paste. Nothing is typed until you press Allow paste.',
  input: { requestId: paste.id }, neededBy: paste.expiresAt, blockingNow: true, waitingSince: paste.raisedAt,
  raisedBy: 'agent', raisedBySession: paste.sessionId, raisedByName: 'Hadi',
} as never;

const storeItem = {
  ...(pasteItem as object),
  sourceRef: store.id,
  subject: 'Allow pasting sealed:vercel_token (64 characters from vercel) into the secret VERCEL_TOKEN, replacing its value. You type nothing.',
  why: 'Allow pasting sealed:vercel_token (64 characters from vercel) into the secret VERCEL_TOKEN, replacing its value. You type nothing.',
  context: 'The agent says: The new deploy token, kept for the deploy script',
  input: { requestId: store.id },
} as never;

const pageItem = {
  ...(pasteItem as object),
  sourceRef: intoPage.id,
  subject: 'Allow pasting sealed:vercel_token (64 characters from vercel) into a field on vercel.com. You type nothing.',
  why: 'Allow pasting sealed:vercel_token (64 characters from vercel) into a field on vercel.com. You type nothing.',
  context: 'The agent says: The deploy token for the project settings page',
  input: { requestId: intoPage.id },
} as never;

const planItem = {
  id: 'A8', source: 'question', sourceRef: plan.id, sourceSeq: 2, kind: 'permission', copyPlan: { planId: plan.id },
  title: 'Asks to approve pastes in advance',
  subject: 'Allow these 2 pastes once each, without asking, until 2026-08-05 11:58 UTC?',
  why: 'Allow these 2 pastes once each, without asking, until 2026-08-05 11:58 UTC?',
  context: '1. what vercel prints → vercel in a terminal. The agent says: the production deploy token\\n2. text from https://github.com → a field on https://vercel.com. The agent says: the GitHub token Vercel builds with',
  neededBy: plan.expiresAt, waitingSince: plan.raisedAt, raisedBy: 'daemon', raisedBySession: 'sess-1',
} as never;

const itemView = (item: never, extra: object) => (
  <div style={{ height: '100vh', display: 'grid' }}>
    <AgendaItemView busy={false} error={null} ferret="Hadi" history={[]} item={item} now={NOW} onAct={() => undefined}
      onClose={() => undefined} position={{ index: 0, total: 3 }} renderProse={text => <Markdown text={text} />} swipeable={false} {...extra} />
  </div>
);

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]">
      {view === 'rules' ? (
        <CopyRulesCard
          rules={rules}
          settings={{ allowProfileTargets: true }}
          profileRules={['1'.repeat(32)]}
          onAdd={quiet}
          onRemove={quiet}
          onSettings={quiet}
        />
      ) : view === 'plan' ? (
        itemView(planItem, { planForm: <CopyPlanCard agentName="Hadi" onAnswer={async () => 'Allowed 1 of 2, each once.'} plan={plan} /> })
      ) : view === 'page' ? (
        itemView(pageItem, {
          inputForm: <InputCard agentName="Hadi" client={client} embedded fields={fieldsOf(intoPage)} now={NOW} onDone={() => undefined} request={intoPage} />,
        })
      ) : view === 'store' ? (
        itemView(storeItem, {
          inputForm: <InputCard agentName="Hadi" client={client} embedded fields={fieldsOf(store)} now={NOW} onDone={() => undefined} request={store} />,
        })
      ) : (
        itemView(pasteItem, {
          inputForm: <InputCard agentName="Hadi" client={client} embedded fields={fieldsOf(paste)} now={NOW} onDone={() => undefined} request={paste} />,
        })
      )}
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
  <body><div id="root"></div><script type="module" src="/secure-copy-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'secure-copy-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'secure-copy-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const wanted = process.argv[3]?.split(',');
const STATES = (['paste', 'page', 'store', 'plan', 'rules'] as const).filter(
  state => wanted === undefined || wanted.includes(state),
);

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
  { name: 'phone', width: 390, height: 844, shot: 1_320, touch: true },
  { name: 'desktop', width: 1_440, height: 900, shot: 1_060, touch: false },
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
          const surface =
            state === 'rules'
              ? page.locator('[data-testid="copy-rules-card"]')
              : state === 'plan'
                ? page.locator('[data-copy-plan]')
                : page.locator('[data-input-paste]');
          await surface.waitFor({ state: 'visible' });
          if (state === 'plan') await page.locator('[data-copy-plan-tick="1"]').uncheck();
          if (state === 'rules') {
            await page.locator('[data-copy-rule-add-open]').click();
            await page.locator('[data-copy-rule-from]').fill('gh');
            await page.locator('[data-copy-rule-to]').fill('bash');
          }
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            // The touch floor is asked of this feature's own controls; the agenda's chrome has its own harness.
            for (const height of await surface
              .locator('button')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
          }
          const target = join(outDir, `secure-copy-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: state === 'rules' });
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
