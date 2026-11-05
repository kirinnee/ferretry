/**
 * Screenshots of every first-run page, at a 390px phone and a 1440px desktop, light and dark:
 *
 *   bun harness/first-run-screenshot.ts [outDir]   # default /tmp/claude-1000/shots/simpler-onboarding-pr3-first-run/after
 *
 * Files are `device-<screen>-<light|dark>-<phone|desktop>.png` (plus `-bottom` when the page scrolls). It
 * bundles `harness/main.tsx`, serves it on an ephemeral loopback port, aborts anything that leaves it, opens
 * each page by its `#onboarding-<screen>` fragment, and fails when a page scrolls sideways at 390px or draws
 * more than one primary button (the composed pages included: resting, confirming a pasted link, failed) or
 * clips a command block (its inner `pre` must not overflow). Pairing codes are fake: the harness's pairing screen redeems nothing and
 * the hand-off QR carries only a `.invalid` setup link.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'first-run');
const shotsDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/simpler-onboarding-pr3-first-run/after');

/** Gallery screen id → the name the mockups and the before shots use for it. */
const SCREENS = [
  ['entry', 'entry'],
  ['target', 'target'],
  ['doer', 'doer'],
  ['doer-mobile', 'doer-mobile'],
  ['brief', 'agent'],
  ['brief-elsewhere', 'agent-elsewhere'],
  ['brief-confirm', 'agent-confirm'],
  ['brief-failed', 'agent-failed'],
  ['install', 'hand'],
  ['local', 'open'],
  ['local-back', 'open-back'],
  ['handoff', 'phone'],
  ['elsewhere', 'elsewhere'],
  ['elsewhere-mobile', 'elsewhere-mobile'],
  ['elsewhere-confirm', 'elsewhere-confirm'],
  ['elsewhere-failed', 'elsewhere-failed'],
  ['pair', 'pair'],
] as const;

const VIEWPORTS = [
  {
    name: 'phone',
    options: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    },
  },
  { name: 'desktop', options: { viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 } },
] as const;

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', ['build', 'harness/main.tsx', '--outdir', buildDir, '--target', 'browser']);
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
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(Bun.file(join(harnessDir, 'index.html')));
    if (path === '/pre-paint.js') return new Response(Bun.file(join(packageDir, 'public/pre-paint.js')));
    if (path.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', path)));
    const file = Bun.file(join(buildDir, path));
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const defects: string[] = [];

const inspect = async (page: Page, label: string, phone: boolean): Promise<boolean> => {
  const found = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.kt-shell');
    const primaries = [...document.querySelectorAll('[data-onboarding="setup"] button[data-variant="primary"]')].filter(
      button => (button as HTMLElement).offsetParent !== null,
    );
    return {
      sideways:
        (document.scrollingElement?.scrollWidth ?? 0) > window.innerWidth + 1 ||
        (shell !== null && shell.scrollWidth > shell.clientWidth + 1),
      primaries: primaries.map(button => button.textContent?.trim() ?? ''),
      tall: shell !== null && shell.scrollHeight > shell.clientHeight + 4,
      clipped: [...document.querySelectorAll<HTMLElement>('[data-onboarding="setup"] pre')]
        .filter(pre => pre.closest('details:not([open])') === null && pre.scrollWidth > pre.clientWidth + 1)
        .map(pre => (pre.textContent ?? '').slice(0, 40)),
    };
  });
  if (phone && found.sideways) defects.push(`${label} scrolls sideways at 390px`);
  if (found.clipped.length > 0) defects.push(`${label} clips a command block: ${found.clipped.join(' | ')}`);
  if (found.primaries.length > 1) {
    defects.push(`${label} draws ${found.primaries.length} primary buttons: ${found.primaries.join(' | ')}`);
  }
  return found.tall;
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ ...viewport.options, colorScheme: scheme, reducedMotion: 'reduce' });
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== server.url.origin) await route.abort();
        else await route.continue();
      });
      const page = await context.newPage();
      for (const [id, name] of SCREENS) {
        await page.goto(`${server.url}#onboarding-${id}`);
        await page.reload();
        await page.locator(`#harness-onboarding-${id}-page`).waitFor({ state: 'visible' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        const label = `device-${name}-${scheme}-${viewport.name}`;
        const tall = await inspect(page, label, viewport.name === 'phone');
        const shell = page.locator(`#harness-onboarding-${id}-page`);
        await shell.evaluate(el => {
          el.scrollTop = 0;
        });
        await page.screenshot({ path: join(shotsDir, `${label}.png`) });
        if (tall) {
          await shell.evaluate(el => {
            el.scrollTop = el.scrollHeight;
          });
          await page.waitForTimeout(150);
          await page.screenshot({ path: join(shotsDir, `${label}-bottom.png`) });
        }
        process.stdout.write(`📸 ${label}${tall ? ' (+bottom)' : ''}\n`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}
if (defects.length > 0) fail(`${defects.length} defect(s):\n  ${defects.join('\n  ')}`);
process.stdout.write(`✅ ${SCREENS.length * 4} captures in ${shotsDir}\n`);
