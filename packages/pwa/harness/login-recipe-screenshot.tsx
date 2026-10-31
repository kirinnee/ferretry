/**
 * Settings › Saved logins › one login with a recipe, two observed places and one pending proposal, on a phone
 * and a desktop, light and dark.
 *
 *   bun harness/login-recipe-screenshot.tsx [outDir]   # writes login-recipe-<theme>-<viewport>.png
 *
 * It renders the REAL `LoginsCard` with invented data (an example host, no account, no value), in the app's own
 * fonts. It fails if a frame scrolls sideways or is drawn in a fallback font.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const workDir = join(harnessDir, 'out');
const shotDir = process.argv[2] ?? workDir;

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
import { LoginsCard } from '../../src/features/secrets/logins-card.tsx';
import { recipeLogins } from '../../tests/support/login-recipe-fixtures.ts';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
    <LoginsCard list={recipeLogins()} onPut={() => true} onRename={() => true} onRemove={() => true} onDecide={() => true} />
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/login-recipe-entry.js"></script></body>
</html>`;

mkdirSync(workDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });
await Bun.write(join(workDir, 'login-recipe-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(workDir, 'login-recipe-entry.jsx'), '--outdir', workDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(workDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    // The stylesheet names its fonts as `../assets/fonts/…`: serve them from src, so the pictures are drawn in the
    // app's own typefaces and not a fallback.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    return new Response(Bun.file(join(workDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

const shot = async (page: Page, theme: string, vp: string): Promise<void> => {
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = getComputedStyle(document.body).fontFamily;
    return { family, loaded: [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family) };
  });
  if (!faces.loaded.some(face => faces.family.includes(face.replaceAll('"', ''))))
    fail(`${theme} ${vp} is drawn in a fallback font (${faces.family}; loaded: ${faces.loaded.join(', ')})`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${theme} ${vp} scrolls sideways by ${overflow}px`);
  const file = join(shotDir, `login-recipe-${theme}-${vp}.png`);
  await page.screenshot({ path: file, fullPage: true });
  process.stdout.write(`📸 ${file}\n`);
};

try {
  for (const theme of ['studio-light', 'studio-dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === 'phone' ? 2 : 1,
        colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        page.on('pageerror', error => fail(`the page threw: ${error.message}`));
        await page.goto(`${server.url}?theme=${theme}`);
        await page.locator('[data-login-recipe]').first().waitFor({ state: 'visible' });
        await shot(page, theme, vp);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ The login recipe does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
