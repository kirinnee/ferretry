/**
 * EVERY Settings screen, for a layout review: the phone's home, each device section (Appearance,
 * Behaviour, This device), each machine tab, and each of the machine's own panels opened on its own,
 * at 390 and 1440, light and dark, from the real Settings page in the shell harness
 * (`?settings-harness=1`) with fake data and no real daemon. Each capture is the whole scrolled page,
 * so the review sees everything a reader would scroll through, not the first screenful.
 *
 * Also prints, per desktop capture, how wide the content column drew — the number a "set width" fix
 * has to change.
 *
 * Run from packages/pwa: `bun harness/settings-audit-screenshot.ts [outDir] [filter]`.
 * `filter` keeps only the captures whose name contains it (e.g. `panel-devices`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/compact-settings/before');
const filter = process.argv[3] ?? '';
/** Extra CSS laid over the page, for trying a layout change before writing it (`SETTINGS_AUDIT_CSS`). */
const extraCss = process.env.SETTINGS_AUDIT_CSS ?? '';

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
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

const SECTIONS = ['appearance', 'behaviour', 'device'] as const;
const TABS = ['runtimes', 'agents', 'sign-ins', 'profiles', 'browser', 'machine'] as const;
/** Every daemon panel, by the tab that opens it (`machine-panels.ts`). */
const PANELS: readonly (readonly [tab: string, panel: string])[] = [
  ['agents', 'warden'],
  ['agents', 'learning'],
  ['agents', 'pack'],
  ['sign-ins', 'accounts'],
  ['sign-ins', 'secrets'],
  ['sign-ins', 'secure-copy'],
  ['machine', 'devices'],
  ['machine', 'grants'],
  ['machine', 'security'],
  ['machine', 'carrier'],
  ['machine', 'security-log'],
  ['machine', 'doctor'],
  ['machine', 'host-checks'],
  ['machine', 'resource-limits'],
  ['machine', 'performance'],
  ['machine', 'agent-clis'],
  ['machine', 'files'],
  ['machine', 'terminal-slots'],
  ['machine', 'speedups'],
  ['machine', 'model-pricing'],
  ['machine', 'about'],
];

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const VIEWPORTS = {
  '390': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  '1440': { viewport: { width: 1440, height: 900 } },
} as const;

const settle = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const animation of document.getAnimations())
      if (animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY) animation.finish();
  });
  await page.waitForTimeout(500);
};

const go = async (page: Page, hash: string): Promise<void> => {
  await page.evaluate(next => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, hash);
  await settle(page);
};

/** The whole scrolled page: the window grows to the scroller's content, then shrinks back. */
const capture = async (page: Page, name: string, vp: string): Promise<void> => {
  const width = page.viewportSize()?.width ?? 390;
  const state = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    font: document.fonts.check('16px Inter'),
    height: document.querySelector('[data-settings-scroller]')?.scrollHeight ?? 900,
    column: Math.round(document.querySelector('#settings-section-panel')?.getBoundingClientRect().width ?? 0),
  }));
  if (!state.font) fail(`the app's font did not load for ${name}`);
  const height = Math.min(8_000, Math.max(vp === '390' ? 844 : 900, state.height + 8));
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  await page.setViewportSize({ width, height: vp === '390' ? 844 : 900 });
  process.stdout.write(
    `📸 ${file}  column=${state.column}px height=${state.height}px${state.overflow > 1 ? ` ⚠ sideways ${state.overflow}px` : ''}\n`,
  );
};

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const theme of ['light', 'dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const wanted = (name: string): boolean => name.includes(filter);
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === '390' ? 2 : 1,
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
        await page.goto(`${server.url}?settings-harness=1`);
        await page.getByLabel('Settings page preview', { exact: true }).waitFor({ state: 'visible' });
        if (extraCss !== '') await page.addStyleTag({ content: extraCss });
        await settle(page);
        const tag = `${vp}-${theme}`;
        if (vp === '390' && wanted(`home-${tag}`)) await capture(page, `home-${tag}`, vp);
        for (const section of SECTIONS) {
          if (!wanted(`section-${section}-${tag}`)) continue;
          await go(page, `#${section}`);
          await capture(page, `section-${section}-${tag}`, vp);
        }
        // The machine's name is whatever the page links it by; read it from the address it opens.
        await go(page, '');
        const settings = page.getByLabel('Settings page preview', { exact: true });
        const navigation = settings.locator(vp === '390' ? '[data-settings-home]' : '[data-settings-sidebar]');
        await navigation.locator('[data-settings-machine="harness-daemon"]').click();
        await settings.locator('[data-machines-surface="harness-daemon"]').waitFor({ state: 'visible' });
        await settle(page);
        const machine = (await page.evaluate(() => window.location.hash)).split('/')[1] ?? fail('no machine hash');
        for (const tab of TABS) {
          if (!wanted(`tab-${tab}-${tag}`)) continue;
          await go(page, `#machines/${machine}/${tab}`);
          await capture(page, `tab-${tab}-${tag}`, vp);
        }
        for (const [tab, panel] of PANELS) {
          if (!wanted(`panel-${panel}-${tag}`)) continue;
          await go(page, `#machines/${machine}/${tab}/${panel}`);
          await page
            .locator(`[data-daemon-panel-open="${panel}"]`)
            .waitFor({ state: 'visible', timeout: 5_000 })
            .catch(() => process.stderr.write(`⚠ panel ${panel} did not open at ${tag}\n`));
          await settle(page);
          await capture(page, `panel-${panel}-${tag}`, vp);
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write(`✅ captures in ${outDir}\n`);
} finally {
  await browser.close();
  server.stop();
}
