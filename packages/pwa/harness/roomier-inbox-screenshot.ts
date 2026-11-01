/**
 * Screenshots for the roomier phone Inbox: the top bar with the Inbox count, an agenda card, a card waiting for a try, and the
 * same card with (i) open showing Skip / Not needed. Phone 390 and desktop 1440, three theme families, light and dark.
 *
 *   bun harness/roomier-inbox-screenshot.ts [outDir]     # writes <outDir>/<name>-<phone|desktop>-<theme>.png
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'roomier-inbox-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/roomier-inbox');
const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

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

const html = (theme: string) => `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><link rel="stylesheet" href="/app.css" /></head>
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome');
const browser = await chromium.launch({ executablePath, headless: true });
const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
} as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 }, hasTouch: true } as const;
const THEMES = (
  process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark,neo-light,neo-dark,mission-light,mission-dark'
).split(',');
const NOW = new Date('2026-10-29T09:00:00.000Z');
const problems: string[] = [];

const open = async (
  context: Awaited<ReturnType<typeof browser.newContext>>,
  theme: string,
  view: string,
): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&view=${view}&bar=1`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('[data-card-head]:visible').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) problems.push(`${view} ${theme}: scrolls sideways by ${wide}px`);
  return page;
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    const [family, mode] = [theme.slice(0, theme.lastIndexOf('-')), theme.slice(theme.lastIndexOf('-') + 1)];
    await context.addInitScript(
      ([f, m]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family: f, mode: m, textScale: 'default' })),
      [family, mode] as const,
    );
    const snap = async (page: Page, name: string): Promise<void> => {
      const path = join(outDir, `${name}-${form}-${theme}.png`);
      await page.waitForTimeout(150);
      await page.screenshot({ path });
      process.stdout.write(`📸 ${path}\n`);
    };

    const agenda = await open(context, theme, 'open');
    await snap(agenda, 'agenda-card');
    await agenda.locator('[data-agenda-info-toggle]:visible').first().click();
    await agenda.waitForTimeout(200);
    await snap(agenda, 'agenda-card-info-open');
    await agenda.close();

    const task = await open(context, theme, 'quick-to-test');
    await snap(task, 'task-card');
    await task.locator('[data-agenda-info-toggle]:visible').first().click();
    await task.waitForTimeout(200);
    await snap(task, 'task-card-info-open');
    if ((await task.locator('[data-to-test-skip]').count()) === 0)
      problems.push(`${form} ${theme}: Skip is not under (i)`);
    await context.close();
  }
}
await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
