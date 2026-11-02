/**
 * Screenshots for the one Inbox count and the "Updating" that ends: the shell's real inbox over an owner-like fleet
 * with one machine down (`inbox-count-page.tsx`). Phone 390 and desktop 1440, light and dark. Each shot is taken
 * once the reads settle, and the run fails if any surface's count differs or "Updating" is still showing.
 *
 *   bun harness/inbox-count-screenshot.ts [outDir]     # writes <outDir>/inbox-count-<phone|desktop>-<theme>.png
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'inbox-count-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/inbox-count');
const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'inbox-count-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-count-page.js"></script></body></html>`;
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
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark').split(',');
const problems: string[] = [];

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
    const page = await context.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}?theme=${theme}`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    // The laptop's reads give up after 400ms here; its line replaces any spinner once they do.
    await page.locator('[data-agenda-unreadable]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(300);
    const where = `${form} ${theme}`;
    if (errors.length > 0) problems.push(`${where}: ${errors.join('; ')}`);
    const unreadable = (await page.locator('[data-agenda-unreadable]').textContent()) ?? '';
    if (!unreadable.includes(' — the machine hit an error. Trying again.'))
      problems.push(`${where}: the unreadable line does not say why: ${unreadable}`);
    if ((await page.locator('[data-agenda-updating], [data-agenda-reading]').count()) > 0)
      problems.push(`${where}: still says Updating after every read settled`);
    const counts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-unread-badge]')]
        .filter(badge => (badge as HTMLElement).offsetParent !== null)
        .map(
          badge =>
            `${badge.closest('[data-sbar-agenda], h1, nav, header')?.tagName ?? '?'}=${badge.getAttribute('data-count')}`,
        ),
    );
    const numbers = new Set(counts.map(entry => entry.split('=')[1]));
    if (counts.length < 2 || numbers.size !== 1)
      problems.push(`${where}: counts disagree or are missing: ${counts.join(', ')}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 0) problems.push(`${where}: scrolls sideways by ${wide}px`);
    const path = join(outDir, `inbox-count-${form}-${theme}.png`);
    await page.screenshot({ path });
    process.stdout.write(`📸 ${path}  (${counts.join(', ')})\n`);
    await context.close();
  }
}
await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
