/**
 * Screenshots of a sign-in card's "Choose another account" when some saved accounts belong to OTHER sites (&B137 PR B):
 * the first step lists only accounts that sign in at THIS site; accounts saved for another site are behind a second step
 * ("Use an account from another site…") and each says where it signs in ("not linked to a site" when it signs in
 * nowhere). Never a one-tap. Views: the card as it opens (one account here: the one-tap and "Only account here"), the
 * first step open, both steps open, two accounts here ("Pick one", no one-tap, both steps open), and a card whose only
 * saved accounts are other sites'. At a 390px phone and a
 * 1440px desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/other-site-accounts-screenshot.tsx [out-dir] [views]   # writes other-site-<view>-<viewport>-<scheme>.png
 *
 * Fake fixtures only: no real account, no daemon.
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

const view = new URLSearchParams(location.search).get('view') ?? 'closed';
const SIGN_IN = 'si_0123456789abcdef';
const SIGN_IN_B = 'si_0123456789abcdee';
const onlyOther = view === 'only-other';
const pickOne = view === 'pick-one';
const accounts = AccountListSchema.parse({ v: 1, health: 'ready', accounts: [], signIns: [] });
const google = offer({ id: 'GOOGLE_KIRINNEE97', label: 'Google kirinnee97', username: 'kirinnee97@gmail.com', matched: true, signIn: SIGN_IN, ...(pickOne ? {} : { primary: true as const, why: 'only' as const }) });
const googleB = offer({ id: 'GOOGLE_ERNEST', label: 'Google ernest', username: 'ernest@atomi.tech', matched: true, signIn: SIGN_IN_B });
const scratch = offer({ id: 'SCRATCH_LOGIN', label: 'Scratch login', matched: false, elsewhere: [] });
const okta = offer({ id: 'LIFTOFF_OKTA_COM', label: 'Liftoff Okta', username: 'kirin@liftoff.example', matched: false, elsewhere: ['liftoff.okta.com'] });
const github = offer({ id: 'GITHUB_KIRINNEE', label: 'GitHub (kirinnee)', matched: false, elsewhere: ['github.com', 'api.github.com'] });
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
    suggest: { id: 'GOOGLE_KIRINNEE97', label: 'Google kirinnee97' },
    offers: onlyOther ? [okta, github, scratch] : pickOne ? [google, googleB, okta, github, scratch] : [google, okta, github, scratch],
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
  <body><div id="root"></div><script type="module" src="/other-site-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'other-site-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'other-site-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const wanted = process.argv[3]?.split(',');
const VIEWS = ['closed', 'first-step', 'second-step', 'pick-one', 'only-other'].filter(
  each => wanted === undefined || wanted.includes(each),
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
          if (state !== 'closed') {
            await page.locator('[data-input-others] > summary').click();
            if (state !== 'first-step') await page.locator('[data-input-elsewhere] > summary').click();
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
          const target = join(outDir, `other-site-${state}-${viewport.name}-${scheme}.png`);
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
