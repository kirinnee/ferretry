/**
 * Screenshots of the credential cards (&F291 R2-5): a code card, "Set up automatic codes" in each of its states,
 * and the approve-on-phone card, at a 390px phone and a 1440px desktop, in the light and dark studio themes.
 * Review evidence; nothing compares the PNGs.
 *
 *   bun harness/cred-cards-screenshot.tsx [out-dir] [views]   # writes cred-<view>-<viewport>-<scheme>.png
 *
 * `views` is a comma list when only some are wanted. Fake fixtures only: no real account, no daemon, and the key
 * typed into the setup panel is a made-up base32 string that is cleared as soon as Save is pressed.
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
import { AccountListSchema, PhoneApprovalSchema } from '@ferretry/protocol';
import { InputCard } from '../../src/features/input-request/input-card.tsx';
import { PhoneApprovalCard } from '../../src/features/input-request/phone-approval-card.tsx';
import { fieldsOf } from '../../src/lib/input-card.ts';
import { NOW, browserField, fakeClient, offer, requestOf, saved } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view') ?? 'code-sms';
const AT = '2026-10-31T14:02:00.000Z';
const SIGN_IN = 'si_0123456789abcdef';
const STAGE = 'st_' + 'a'.repeat(24);
const PARAMS = { algorithm: 'SHA1', digits: 6, period: 30 };
const sms = { id: 'tf_000000000001', kind: 'sms', label: 'Phone', endsWith: '42', addedAt: AT, addedBy: 'owner', automatic: false };
const totp = (id, label) => ({ id, kind: 'totp', label, params: PARAMS, addedAt: AT, addedBy: 'owner', automatic: true });
const accountList = factors =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      {
        id: 'GITHUB',
        label: 'GitHub',
        username: 'kirinnee',
        fields: { password: true, totp: factors.some(each => each.automatic) },
        factors,
        signIns: [SIGN_IN],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    signIns: [
      {
        id: SIGN_IN,
        account: 'GITHUB',
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  });

const codeCard = codes =>
  requestOf('code', {
    expiresAt: '2026-08-05T10:04:00.000Z',
    prompt: 'GitHub wants the code',
    target: { kind: 'browser', key: 'app' },
    observed: {
      kind: 'browser',
      pageId: 'page-1',
      origin: 'https://github.com',
      secure: true,
      navigationId: 'nav-1',
      fields: [browserField('code', { frameOrigin: 'https://github.com', field: { tag: 'input', type: 'text', autocomplete: 'one-time-code' } })],
    },
    saved: saved({
      match: 'github.com',
      offers: [
        offer({
          id: 'GITHUB',
          label: 'GitHub (kirinnee)',
          username: 'kirinnee',
          fills: 'totp',
          matched: true,
          primary: true,
          why: 'only',
          signIn: SIGN_IN,
          ...(codes === undefined ? {} : { codes }),
        }),
      ],
    }),
  });

const answers = call => {
  if (view === 'setup-failed' && call.path.endsWith('/commit')) throw new Error('the daemon went away');
  if (call.path.endsWith('/commit')) return { account: 'GITHUB', factor: totp('tf_000000000002', 'Authenticator app'), mismatch: false };
  if (call.method === 'DELETE') return { stage: STAGE, dropped: true };
  if (call.path.endsWith('/factors/seed'))
    return { stage: STAGE, account: 'GITHUB', label: 'Authenticator app', expiresAt: AT, parsed: { params: PARAMS, issuer: 'GitHub', accountName: 'kirinnee' } };
  return {};
};

const BASE = {
  id: 'pa_' + '0'.repeat(23) + '1',
  sessionId: 'mvwxxxhv-11b529cb',
  agentName: 'lizzette',
  surface: 'browser',
  origin: 'https://company.okta.com',
  signIn: SIGN_IN,
  account: { id: 'CLICKUP', label: 'ClickUp' },
  username: 'a@gmail.com',
  via: { id: 'OKTA', label: 'Okta' },
  raisedAt: AT,
  expiresAt: '2026-10-31T14:04:00.000Z',
  state: 'waiting',
};
const approval = over => PhoneApprovalSchema.parse({ ...BASE, ...over });
const APPROVALS = {
  'approve-tap': approval({ number: { value: '42', from: 'okta', direction: 'tap-on-phone', readAt: AT } }),
  'approve-duo': approval({
    origin: 'https://sso.duosecurity.test',
    via: { id: 'DUO', label: 'Duo' },
    number: { value: '123', from: 'duo', direction: 'type-on-phone', readAt: AT },
  }),
  'approve-none': approval({ numberMissing: 'none-found' }),
  'approve-steered': approval({ numberMissing: 'steered' }),
  'approve-terminal': approval({ surface: 'terminal', origin: undefined, via: undefined, account: undefined, signIn: undefined, username: undefined, numberMissing: 'terminal' }),
};

const root = document.getElementById('root');
const never = () => new Promise(() => undefined);
const shell = child => (
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]">{child}</div>
  </div>
);
if (view in APPROVALS) {
  createRoot(root).render(
    shell(
      <div className="kt-card flex flex-col gap-3 rounded-control border border-border bg-surface p-4" data-harness-surface="">
        <PhoneApprovalCard approval={APPROVALS[view]} onRefuse={async () => undefined} onViewPage={() => undefined} />
      </div>,
    ),
  );
} else {
  const totpOffer = view === 'code-totp';
  const factors = totpOffer ? [sms, totp('tf_000000000002', 'Authenticator app')] : [sms];
  const request = codeCard(
    totpOffer
      ? [
          { factor: 'tf_000000000002', label: 'Authenticator app', checked: 'worked' },
          { factor: 'tf_000000000003', label: 'Work phone' },
        ]
      : undefined,
  );
  const machine = fakeClient(answers);
  const addKey = view === 'setup-passkey' ? never : async () => true;
  createRoot(root).render(
    shell(
      <div data-harness-surface="">
        <InputCard
          accounts={accountList(factors)}
          addKey={addKey}
          client={machine.client}
          fields={fieldsOf(request)}
          now={NOW}
          onDone={() => undefined}
          request={request}
        />
      </div>,
    ),
  );
}
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/cred-cards-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'cred-cards-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'cred-cards-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const wanted = process.argv[3]?.split(',');
const VIEWS = [
  'code-sms',
  'code-totp',
  'setup-empty',
  'setup-parsed',
  'setup-mismatch',
  'setup-passkey',
  'setup-saved',
  'setup-failed',
  'approve-tap',
  'approve-duo',
  'approve-none',
  'approve-steered',
  'approve-terminal',
].filter(each => wanted === undefined || wanted.includes(each));

const KEY = 'JBSWY3DPEHPK3PXP';
const OTHER_KEY = 'otpauth://totp/Slack:someone@else.test?secret=JBSWY3DPEHPK3PXP&issuer=Slack';

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
  { name: 'phone', width: 390, height: 844, shot: 1_100, touch: true },
  { name: 'desktop', width: 1_440, height: 900, shot: 900, touch: false },
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
        for (const state of VIEWS) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${state}`);
          await page.locator('[data-harness-surface]').waitFor({ state: 'visible' });
          if (state.startsWith('setup-')) {
            await page.locator('[data-codes-panel] summary').click();
            if (state !== 'setup-empty') {
              await page.locator('[data-codes-seed]').fill(state === 'setup-mismatch' ? OTHER_KEY : KEY);
              await page.locator('[data-codes-warning-tick]').check();
            }
            if (state === 'setup-mismatch') await page.locator('[data-codes-mismatch-tick]').check();
            if (['setup-passkey', 'setup-saved', 'setup-failed'].includes(state)) {
              await page.locator('[data-codes-save]').click();
              await page
                .locator(
                  state === 'setup-passkey'
                    ? '[data-codes-passkey]'
                    : state === 'setup-saved'
                      ? '[data-codes-saved]'
                      : '[data-codes-failed]',
                )
                .waitFor({ state: 'visible' });
            }
          }
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            for (const height of await page
              .locator('button:visible')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
          }
          const target = join(outDir, `cred-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
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
