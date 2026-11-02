/**
 * Screenshots of a sign-in card when the page is signing in a second person on one site (&B137): no one-tap of the
 * saved account, the title naming whose sign-in it is, and "Save to Accounts" in each of its states — a new account,
 * its name in the terminal under More, Update of the same person (never offered for another), and a password
 * too short to save — at a 390px phone and a 1440px desktop, in the light and dark studio themes. Review evidence;
 * nothing compares the PNGs.
 *
 *   bun harness/save-as-screenshot.tsx [out-dir] [views]   # writes save-as-<view>-<viewport>-<scheme>.png
 *
 * Fake fixtures only: no real account, no daemon. The typed password is a made-up string.
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
import { AccountListSchema } from '@ferretry/protocol';
import { InputCard } from '../../src/features/input-request/input-card.tsx';
import { fieldsOf } from '../../src/lib/input-card.ts';
import { NOW, browserField, fakeClient, offer, requestOf, saved } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view') ?? 'different';
const AT = '2026-11-02T03:14:00.000Z';
const SIGN_IN = 'si_0123456789abcdef';
const KIRIN = { id: 'ACCOUNTS_GOOGLE_COM', label: 'accounts.google.com', username: 'kirinnee97@gmail.com' };
const accounts = AccountListSchema.parse({
  v: 1,
  health: 'ready',
  accounts: [{ ...KIRIN, fields: { password: true, totp: false }, factors: [], signIns: [SIGN_IN], createdAt: AT, updatedAt: AT }],
  signIns: [{ id: SIGN_IN, account: KIRIN.id, place: { kind: 'site', domains: ['accounts.google.com'], match: [] }, method: { kind: 'password' }, createdAt: AT, updatedAt: AT }],
});
const same = view === 'update' || view === 'one-tap';
const who = same ? KIRIN.username : 'ernest@atomi.tech';
const request = requestOf('secret', {
  risk: { level: 'green', reason: 'A password field on a secure page, as the browser reported it.' },
  agendaItemId: 'A251',
  expiresAt: '2026-08-05T10:04:00.000Z',
  prompt: 'Google wants the password',
  target: { kind: 'browser', key: 'gper2' },
  observed: {
    kind: 'browser',
    pageId: 'page-2',
    origin: 'https://accounts.google.com',
    secure: true,
    navigationId: 'nav-1',
    fields: [browserField('secret', { frameOrigin: 'https://accounts.google.com', field: { tag: 'input', type: 'password', name: 'Passwd' } })],
  },
  saved: saved({
    match: 'accounts.google.com',
    suggest: same ? { id: KIRIN.id, label: KIRIN.label } : { id: 'GOOGLE_ERNEST', label: 'Google · ernest@atomi.tech' },
    ...(same ? { update: KIRIN } : {}),
    newAccount: same ? { id: 'GOOGLE_KIRINNEE97', label: 'Google · kirinnee97@gmail.com' } : { id: 'GOOGLE_ERNEST', label: 'Google · ernest@atomi.tech' },
    typedUsername: who,
    ...(same ? {} : { differentFrom: KIRIN }),
    offers: [offer({ ...KIRIN, matched: true, signIn: SIGN_IN, ...(same ? { primary: true, why: 'only' } : {}) })],
  }),
});
const machine = fakeClient(() => ({}));
createRoot(document.getElementById('root')).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]" data-harness-surface="">
      <InputCard accounts={accounts} agentName="Hadi" client={machine.client} fields={fieldsOf(request)} now={NOW} onDone={() => undefined} request={request} />
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
  <body><div id="root"></div><script type="module" src="/save-as-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'save-as-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'save-as-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const wanted = process.argv[3]?.split(',');
const VIEWS = ['different', 'save-new', 'save-more', 'update', 'too-short', 'one-tap'].filter(
  each => wanted === undefined || wanted.includes(each),
);

const PASSWORD = 'made-up-PASSWORD-1';

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
          if (state !== 'one-tap') {
            if (state === 'update') await page.locator('[data-input-type-instead]').first().click();
            // `different` is the card exactly as it opens: the password box is empty (the app never holds a saved value).
            // Every other state has the owner typing a made-up password first.
            if (state !== 'different')
              await page.locator('[data-input-value]').fill(state === 'too-short' ? 'abc' : PASSWORD);
            if (state !== 'different') await page.locator('[data-input-save-tick]').check();
            if (state === 'save-more') await page.locator('[data-input-save-more] summary').click();
            if (state === 'update') await page.locator('[data-input-save-update]').check();
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
          const target = join(outDir, `save-as-${state}-${viewport.name}-${scheme}.png`);
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
