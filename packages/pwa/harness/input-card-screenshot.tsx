/**
 * Screenshots of the input card and of Settings › Accounts, at a 390px phone and a 1440px
 * desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/input-card-screenshot.tsx [out-dir] [states]   # writes input-card-*.png, input-p2-*.png, saved-logins-*.png
 *
 * `states` is a comma list (first,next,google,chain,codeterm,signin,unverified,logins) when only some are wanted.
 *
 * Fake fixtures only (`tests/support/input-fixtures.ts`): no real account, no real daemon, and the typed value
 * is a made-up phrase. Two card states are captured. "first" is the first time a password is asked for: a
 * value typed, "Save as" ticked with the daemon's suggested label and handle. "next" is the next time: a
 * saved login the daemon matched, one tap, with another login folded away. "google" is a browser login of two
 * fields (Email plain, Password secret) with the email typed, each plain field flagged red; "chain" is the second
 * step of that login, a one-time `code` typed and visible; "codeterm" is a one-time code at a terminal. Settings is shown with a 2FA seed form open on one row, so the warning and
 * its tick are on screen. "unverified" is a secret
 * card whose reader the kernel did not prove (a shell that calls itself sudo): amber, "unverified", the full lock. Every width asserts no sideways scroll and the touch floor on every button of the phone.
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
import { LoginsCard } from '../../src/features/secrets/logins-card.tsx';
import { fieldsOf } from '../../src/lib/input-card.ts';
import { NOW, browserField, field, offer, request as fakeRequest, saved, savedSignIn, signInLogins, withSaved } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view');
const refuse = async () => {
  throw new Error('the harness has no daemon');
};
const client = { request: refuse } as never;
const quiet = async () => true;

const first = withSaved(
  saved({ offers: [offer({ id: 'GITHUB_KIRINNEE', label: 'GitHub (kirinnee)', matched: false, username: 'kirinnee' })] }),
);
const next = withSaved(
  saved({
    offers: [
      offer({ username: 'kirin' }),
      offer({ id: 'GITHUB_KIRINNEE', label: 'GitHub (kirinnee)', matched: false, username: 'kirinnee' }),
      offer({ id: 'DEPLOY_KEY', label: 'deploy key', matched: false, hinted: true }),
    ],
  }),
);
const page = (fields, origin = 'https://accounts.google.com') => ({
  kind: 'browser',
  pageId: 'page-1',
  origin,
  secure: true,
  navigationId: 'nav-1',
  fields,
});
// The daemon's own sentences for a page (service.ts pageRiskOf), so the shots show what an owner reads.
const CODE_RISK = { level: 'neutral', reason: 'One-time code: the ferret can see it.' };
const google = fakeRequest({
  target: { kind: 'browser', key: 'app' },
  prompt: 'Sign in to Google',
  sensitivity: 'secret',
  fields: [
    field('plain', { id: 'email', label: 'Email' }),
    field('secret', {
      id: 'password',
      label: 'Password',
      risk: { level: 'green', reason: 'A password field on a secure page, as the browser reported it.' },
    }),
  ],
  risk: { level: 'red', reason: 'Not secret: the ferret can see this value.' },
  lock: { seconds: 10, reason: 'probed-field' },
  observed: page([
    browserField('email', { field: { tag: 'input', type: 'email' } }),
    browserField('password', { backendNodeId: 8, field: { tag: 'input', type: 'password' } }),
  ]),
});
const chain = fakeRequest({
  agendaItemId: 'A9',
  target: { kind: 'browser', key: 'app' },
  prompt: 'Google wants the 2FA code',
  sensitivity: 'code',
  fields: [field('code', { id: 'code', label: '2FA code', risk: CODE_RISK })],
  risk: CODE_RISK,
  chain: 'A7',
  step: 2,
  observed: page([browserField('code', { field: { tag: 'input', type: 'text', autocomplete: 'one-time-code' } })]),
});
// A one-time code at a terminal: ssh asking for the code its 2FA module sent. Not secret, so no lock line.
const codeterm = fakeRequest({
  agendaItemId: 'A8',
  prompt: 'The bastion wants the code from the authenticator',
  sensitivity: 'code',
  fields: [field('code', { label: 'Verification code', risk: CODE_RISK })],
  risk: CODE_RISK,
  observed: {
    kind: 'terminal',
    paneProof: { paneId: '%1', pid: 4242 },
    foreground: { pid: 4310, pgid: 4310, comm: 'ssh', argv: 'ssh bastion.example.test' },
    echo: 'on',
    cursorRow: 12,
    promptLine: 'Verification code:',
    promptLineDigest: 'a'.repeat(64),
    program: 'ssh',
    recognisedConsumer: true,
  },
});
// The ferret asked for a password on Vercel's own page, but Vercel signs in with Google: the card says so, and the
// Google login is not offered here at all: it is typed only on accounts.google.com, where it is the one tap.
const signin = fakeRequest({
  target: { kind: 'browser', key: 'app' },
  prompt: 'Sign in to Vercel',
  sensitivity: 'secret',
  fields: [
    field('secret', {
      id: 'password',
      label: 'Password',
      risk: { level: 'green', reason: 'A password field on a secure page, as the browser reported it.' },
    }),
  ],
  risk: { level: 'green', reason: 'A password field on a secure page, as the browser reported it.' },
  observed: page(
    [browserField('password', { frameOrigin: 'https://app.vercel.com', field: { tag: 'input', type: 'password' } })],
    'https://app.vercel.com',
  ),
  saved: savedSignIn({
    match: 'app.vercel.com',
    offers: [],
  }),
});
// A ferret's shell that wrote sudo into its own name: ps says sudo, the kernel proves nothing (no program fact). The
// daemon's own sentence (service.ts UNVERIFIED_FLAG) and the full lock (lock.ts, not-proven).
const UNVERIFIED_RISK = {
  level: 'amber',
  reason:
    'Unverified: Ferretry could not prove which program is reading the terminal, so the name it shows may be a disguise and the value may land somewhere unexpected.',
};
const unverified = fakeRequest({
  fields: [field('secret', { risk: UNVERIFIED_RISK })],
  risk: UNVERIFIED_RISK,
  lock: { seconds: 120, reason: 'not-proven' },
  observed: {
    kind: 'terminal',
    paneProof: { paneId: '%1', pid: 4242 },
    foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -k apt update' },
    echo: 'off',
    cursorRow: 12,
    promptLine: '[sudo] password for kirin:',
    promptLineDigest: 'a'.repeat(64),
    recognisedConsumer: false,
    canonical: true,
  },
});
const request = { first, next, google, chain, codeterm, signin, unverified }[view] ?? first;
const subject =
  view === 'google' || view === 'chain'
    ? 'Sign in to Google'
    : view === 'signin'
      ? 'Sign in to Vercel'
      : view === 'codeterm'
        ? 'Type it into ssh'
        : view === 'unverified'
          ? 'Type it into the terminal'
          : 'Type it into sudo';

// The agenda item the daemon raises for the request (lib/input-requests/agenda-adapter.ts), drawn by the REAL v5
// item view with the card as its form: the type badge, the header and the paging are the item view's own.
const item = {
  id: 'A7',
  source: 'question',
  sourceRef: request.id,
  sourceSeq: 1,
  kind: 'input',
  title: view === 'google' ? 'Needs a login' : view === 'chain' || view === 'codeterm' ? 'Needs a code' : 'Needs a secret',
  subject,
  why: subject,
  context: 'The rebuild you asked for in &F131',
  howToResolve: 'Open the card and type the value in its form. Nothing is sent until you press Send.',
  input: { requestId: request.id },
  neededBy: request.expiresAt,
  blockingNow: true,
  waitingSince: request.raisedAt,
  raisedBy: 'agent',
  raisedBySession: request.sessionId,
  raisedByName: 'Hadi',
} as never;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]">
      {view === 'logins' ? (
        <LoginsCard list={signInLogins()} onPut={quiet} onRename={quiet} onRemove={quiet} onDecide={quiet} />
      ) : (
        <div style={{ height: '100vh', display: 'grid' }}>
          <AgendaItemView
            busy={false}
            error={null}
            ferret="Hadi"
            history={[]}
            inputForm={
              <InputCard
                agentName="Hadi"
                client={client}
                embedded
                fields={fieldsOf(request)}
                now={NOW}
                onDone={() => undefined}
                request={request}
              />
            }
            item={item}
            now={NOW}
            onAct={() => undefined}
            onClose={() => undefined}
            position={{ index: 0, total: 3 }}
            renderProse={text => <Markdown text={text} />}
            swipeable={false}
          />
        </div>
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
  <body><div id="root"></div><script type="module" src="/input-card-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'input-card-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'input-card-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const wanted = process.argv[3]?.split(',');
const STATES = (['first', 'next', 'google', 'chain', 'codeterm', 'signin', 'unverified', 'logins'] as const).filter(
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
    // The stylesheet names its self-hosted fonts under /assets/fonts; they live in src/assets.
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
        for (const state of STATES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${state}`);
          const surface =
            state === 'logins' ? page.locator('[data-testid="logins-card"]') : page.locator('[data-input-request]');
          await surface.waitFor({ state: 'visible' });
          if (state === 'first') {
            await page.locator('[data-input-value]').fill('correct-horse-battery');
            await page.locator('[data-input-save-tick]').check();
          }
          if (state === 'google')
            await page.locator('[data-input-field="email"] [data-input-value]').fill('kirin@example.test');
          // A made-up code, typed so the shot shows it is visible as it is typed.
          if (state === 'chain' || state === 'codeterm') await page.locator('[data-input-value]').fill('481516');
          if (state === 'logins') {
            await page.locator('[aria-label="Edit Vercel"]').evaluate(el => (el as HTMLElement).click());
            await page
              .locator('[aria-label="Add 2FA seed to GitHub (kirinnee)"]')
              .evaluate(el => (el as HTMLElement).click());
            await page.locator('[data-login-totp-ack]').evaluate(el => (el as HTMLElement).click());
            await page.locator('[data-login-add-open]').evaluate(el => (el as HTMLElement).click());
            await page.locator('[data-login-new-method]').selectOption('sso');
            await page.locator('[data-login-new-label]').fill('Acme');
            await page.locator('[data-login-new-sso-name]').fill('Okta');
          }
          if (state === 'logins') await page.setViewportSize({ width: viewport.width, height: 2_400 });
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            for (const height of await page
              .locator('button')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
          }
          const name =
            state === 'logins'
              ? 'saved-logins'
              : state === 'google' || state === 'chain'
                ? `input-p2-${state}`
                : state === 'codeterm'
                  ? 'input-code-terminal'
                  : `input-card-${state}`;
          const target = join(outDir, `${name}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: state === 'logins' });
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
