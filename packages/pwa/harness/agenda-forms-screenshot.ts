/**
 * Screenshots and checks for an AGENDA FORM card in the Inbox: radios, checkboxes, a Yes/No and a text field on the
 * card, the ferret's composer under it, and ONE Send. Phone 390 and desktop 1440, light and dark, in four states:
 * empty (the recommendations picked), ask (Send with a required field empty: asked once), filled, sent (the undo toast).
 *
 *   bun harness/agenda-forms-screenshot.ts [outDir]   # writes <outDir>/form-<state>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (`?view=form`: the real `AgendaInboxPage`, `AgendaFormFields` and `Composer`, invented
 * data) and FAILS (after writing every picture) when: a page scrolls sideways; the fields are not drawn as radios,
 * checkboxes and Yes/No; the recommendation is not picked; the answer row offers buttons; Send does not ask once; or
 * the sent answer is not the structured one (read after the undo window runs out).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-forms-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/agenda-forms');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'inbox-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome or Chromium');
const browser = await chromium.launch({ executablePath, headless: true });

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const TYPED = 'Use the green cluster, and tell me when it is up.';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const shoot = async (page: Page, state: string, form: string, theme: string): Promise<void> => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${state} ${form} ${theme}: scrolls sideways by ${wide}px`);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  const path = join(outDir, `form-${state}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.name} ${scheme}`;
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.name === 'phone',
      hasTouch: viewport.name === 'phone',
      deviceScaleFactor: 2,
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: scheme,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', error => fail(`page error in ${label}: ${error.message}`));
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=studio-${scheme}&view=form`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    const form = page.locator('.fy-attn-deck__top [data-agenda-form]');
    await form.waitFor({ state: 'visible' });
    await page.locator('[data-inbox-composer] [data-live-editor]').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);

    // empty: the recommendations are picked, nothing else, and nothing offers a button.
    check((await form.locator('[data-agenda-form-field]').count()) === 4, `${label}: not four fields`);
    check((await form.locator('input[type="radio"]').count()) === 3, `${label}: not three radios`);
    check((await form.locator('input[type="checkbox"]').count()) === 3, `${label}: not three checkboxes`);
    check((await form.locator('[data-agenda-form-yesno] button').count()) === 2, `${label}: no Yes/No`);
    check(await form.locator('input[type="radio"][value="EU"]').isChecked(), `${label}: EU is not picked`);
    check(
      (await form.locator('[data-agenda-form-yesno] button[aria-pressed="true"]').innerText()).startsWith('Yes'),
      `${label}: Yes is not picked`,
    );
    check(
      (await page.locator('.fy-attn-deck__top [data-agenda-quick-replies] button').count()) === 0,
      `${label}: the form offers answer buttons`,
    );
    check((await page.locator('.fy-attn-deck__top [data-agenda-dismiss]').count()) === 1, `${label}: no Not needed`);
    await shoot(page, 'empty', viewport.name, scheme);

    // ask: Send with the alerts empty asks once, and sends nothing.
    await page.locator('[data-composer-send]').click();
    const asked = page.locator('.fy-composer-error');
    await asked.waitFor({ state: 'visible' });
    check((await asked.innerText()).includes('Not answered yet: 2. Alerts'), `${label}: the ask names the alerts`);
    check(
      (await page.evaluate(() => (window as unknown as { __committed: unknown[] }).__committed.length)) === 0,
      `${label}: the first Send went out`,
    );
    await shoot(page, 'ask', viewport.name, scheme);

    // filled: another region, two alerts, words in the composer.
    await form.locator('input[type="radio"][value="Asia"]').check();
    await form.locator('input[type="checkbox"][value="Relay down"]').check();
    await form.locator('input[type="checkbox"][value="High latency"]').check();
    await page.locator('[data-inbox-composer] [data-live-editor]').click();
    await page.keyboard.type(TYPED);
    await page.waitForTimeout(150);
    check(
      (await page.locator('.fy-composer-error').count()) === 0,
      `${label}: the ask line stays after the alerts are ticked`,
    );
    check(
      (await page.locator('.fy-attn-deck__top').innerText()).split('Four things I need').length === 2,
      `${label}: the card says its ask more than once`,
    );
    await shoot(page, 'filled', viewport.name, scheme);

    // sent: one Send, the form leaves into the undo window.
    await page.locator('[data-composer-send]').click();
    await page.locator('[data-agenda-undo]').waitFor({ state: 'visible' });
    check((await form.count()) === 0, `${label}: the form is still on the deck after Send`);
    await shoot(page, 'sent', viewport.name, scheme);

    // the daemon gets the structured answer once the undo window runs out.
    await page.waitForFunction(() => (window as unknown as { __committed: unknown[] }).__committed.length > 0, null, {
      timeout: 9_000,
    });
    const action = (await page.evaluate(() => (window as unknown as { __committed: unknown[] }).__committed[0])) as {
      response?: { kind: string; answers: { id: string; picked: unknown }[] };
    };
    check(
      JSON.stringify(action.response) ===
        JSON.stringify({
          kind: 'form',
          answers: [
            { id: '1', picked: 'Asia' },
            { id: '2', picked: ['Relay down', 'High latency'] },
            { id: '3', picked: 'Yes' },
            { id: '4', picked: TYPED },
          ],
        }),
      `${label}: the sent answer is ${JSON.stringify(action.response)}`,
    );
    await context.close();
  }
}

await browser.close();
server.stop(true);
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
