/**
 * New machine setup, five pages (six with another machine to copy): every step at 390 and 1440, light and
 * dark, from the real `MachineOnboarding` in the shell harness (`?machine-setup=<daemon>`) with no real
 * daemon. Walks it the way a person does — Back · Skip · ONE primary — and fails if a page shows a second
 * primary, scrolls sideways at 390px, or the footer's primary does not move the page on. Start from… is
 * walked with another machine paired (the two cards) and without one (the rail opens on Claude Code).
 *
 *   bun harness/machine-setup-simple-screenshot.tsx [outDir]
 *
 * Writes `machine-<step>-<light|dark>-<phone|desktop>.png` (a `-bottom` file too when a page scrolls).
 * Pairing codes in the harness are always fake.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/simpler-onboarding-pr2-fewer-steps/after');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, [...args], { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', 'harness/main.tsx', '--outdir', 'harness/out', '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  'harness/out/app.css',
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/')
      return new Response(Bun.file(join(harnessDir, 'index.html')), { headers: { 'content-type': 'text/html' } });
    if (path === '/pre-paint.js') return new Response(Bun.file(join(packageDir, 'public/pre-paint.js')));
    const file = Bun.file(path.startsWith('/assets/fonts/') ? join(packageDir, 'src', path) : join(buildDir, path));
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const SCREEN = '#harness-machine-setup [data-machine-onboarding]';

try {
  for (const theme of ['light', 'dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === 'phone' ? 2 : 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
        locale: 'en-US',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`⚠ page error: ${error.message}\n`));
        const screen = page.locator(SCREEN);
        const open = async (machine: string, step?: string, alone = false): Promise<void> => {
          const url = new URL(server.url);
          url.searchParams.set('machine-setup', machine);
          if (step !== undefined) url.searchParams.set('setup-step', step);
          if (alone) url.searchParams.set('setup-sources', 'none');
          await page.goto(url.toString());
          await screen.waitFor({ state: 'visible' });
        };
        const stepBody = async (id: string): Promise<void> =>
          screen.locator(`[data-onboarding-step-body="${id}"]`).waitFor({ state: 'visible' });
        const primary = screen.locator(
          '[data-onboarding-foot] [data-onboarding-primary], [data-onboarding-foot] [data-onboarding-finish]',
        );
        const shot = async (name: string): Promise<void> => {
          await page.waitForTimeout(500);
          await page.evaluate(() => document.fonts.ready);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (vp === 'phone' && overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
          const primaries = await screen.locator('button[data-variant="primary"]:visible').allInnerTexts();
          if (primaries.length > 1)
            fail(`${name} ${theme} ${vp} shows ${primaries.length} primaries: ${primaries.join(' / ')}`);
          const inner = screen.locator('.scroll-thin.overflow-y-auto:has([data-onboarding-step-body])').first();
          const base = `machine-${name}-${theme}-${vp}`;
          await inner.evaluate(el => {
            el.scrollTop = 0;
          });
          await page.screenshot({ path: join(outDir, `${base}.png`) });
          const tall = await inner.evaluate(el => el.scrollHeight > el.clientHeight + 4);
          if (tall) {
            await inner.evaluate(el => {
              el.scrollTop = el.scrollHeight;
            });
            await page.waitForTimeout(200);
            await page.screenshot({ path: join(outDir, `${base}-bottom.png`) });
          }
          process.stdout.write(`📸 ${join(outDir, `${base}.png`)}\n`);
        };

        // Start from… (another machine is paired): two cards are the actions, there is no footer primary.
        await open('checking-daemon');
        await stepBody('start');
        if ((await primary.count()) > 0) fail('Start from… shows a footer primary; its two cards are the actions');
        await shot('start');
        await screen.locator('[data-start-card="clone"]').click();
        await screen
          .locator('[data-onboarding-step-body="start"] [data-machine-stepper]')
          .waitFor({ state: 'visible' });
        await shot('start-copy');
        await screen.locator('[data-onboarding-back]').click();
        await screen.locator('[data-start-card="fresh"]').click();
        // Then Claude Code: the step's own Import in the footer, the name as text, conversations.
        await screen.locator('[data-harness-runtime-line]').waitFor({ state: 'visible' });
        await screen.locator('[data-harness-runtime-line]').waitFor({ state: 'visible' });
        await page.waitForTimeout(400);
        await shot('claude');
        // A provider's key form is open: its own Add owns the page, and the footer's Import goes quiet.
        await screen.locator('[data-harness-provider-toggle]').click();
        await screen.locator('[data-provider-tile="deepseek"]').click();
        await screen.locator('[data-env-login="form"]').waitFor({ state: 'visible' });
        await shot('claude-provider-form');
        await screen.locator('[data-harness-provider-toggle]').click();
        await screen.locator('[data-env-login="form"]').waitFor({ state: 'detached' });
        await screen.locator('[data-setup-disclosure="found-details"] summary').click();
        await shot('claude-details');
        await screen.locator('[data-harness-conversations]').check();
        await screen.locator('[data-harness-name-change]').click();
        await shot('claude-name-conversations');
        // Import moves on by itself, carrying what it did to the next page.
        await primary.click();
        await screen.locator('[data-setup-note="import-carry"]').waitFor({ state: 'visible' });
        await stepBody('codex');
        await shot('codex');
        // A key form is open, then Sign in first is opened too: the form that came first keeps the one
        // primary, the sign-in's button goes quiet, and nothing typed is lost.
        await screen.locator('[data-harness-provider-toggle]').click();
        await screen.locator('[data-provider-tile="deepseek"]').click();
        await screen.locator('[data-env-secret-input="DEEPSEEK_API_KEY"]').fill('sk-demo-not-a-real-key');
        await screen.locator('[data-harness-sign-in]').click();
        await screen.locator('[data-first-run-sign-in="codex"]').waitFor({ state: 'visible' });
        await shot('codex-sign-in-and-key');
        const kept = await screen.locator('[data-env-secret-input="DEEPSEEK_API_KEY"]').inputValue();
        if (kept !== 'sk-demo-not-a-real-key') fail('the typed key was lost when Sign in first opened');
        await screen.locator('[data-first-run-sign-in-close]').click();
        await screen.locator('[data-harness-provider-toggle]').click();
        await screen.locator('[data-env-login="form"]').waitFor({ state: 'detached' });
        // Back to Claude Code: already imported, so the one primary is Continue.
        await screen.locator('[data-onboarding-back]').click();
        await stepBody('claude');
        await screen.locator('[data-harness-imported], [data-harness-has]').first().waitFor({ state: 'visible' });
        await shot('claude-imported');
        await primary.click();
        await stepBody('codex');
        await primary.click();
        await stepBody('speedups');
        await shot('speedups');
        await screen.locator('[data-speedup-field="jev"] input').fill('jev-demo-key-not-real-0123456789');
        await shot('speedups-typed');
        await primary.click();
        await screen
          .locator('[data-onboarding-step-body="defaults"], [data-speedups-problem]')
          .first()
          .waitFor({ state: 'visible' });
        const stuck = await screen.locator('[data-speedups-problem]').allInnerTexts();
        if (stuck.length > 0) fail(`Save keys did not move on: ${stuck.join(' ')}`);
        // Defaults: already set, so the page opens ready to keep; one change is saved on Use these.
        await stepBody('defaults');
        await screen.locator('[data-default-row="voice"]').waitFor({ state: 'visible' });
        await shot('defaults');
        await screen.locator('input[aria-label="Learn from my corrections"]').uncheck();
        await shot('defaults-changed');
        await primary.click();
        await stepBody('done');
        await shot('done');
        if ((await screen.locator('[data-onboarding-restart]').count()) > 0) fail('Done still offers Start again');

        // No other machine paired: Start from… is not on the rail, the setup opens on Claude Code.
        await open('checking-daemon', undefined, true);
        await stepBody('claude');
        if ((await screen.locator('[data-onboarding-go="start"]').count()) > 0)
          fail('Start from… is on the rail alone');
        await screen.locator('[data-harness-runtime-line]').waitFor({ state: 'visible' });
        await shot('no-start');

        // A machine without Codex: the one primary is the install.
        await open('harness-daemon', 'codex');
        await screen.locator('[data-onboarding-foot] [data-onboarding-primary]').waitFor({ state: 'visible' });
        await shot('missing');
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write(`✅ every setup step shows one primary and does not scroll sideways at 390px -> ${outDir}\n`);
} finally {
  await browser.close();
  server.stop();
}
