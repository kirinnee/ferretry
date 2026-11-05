/**
 * B164: opens Fullscreen on a hypermedia block inside the agenda swipe-deck card and checks the overlay really
 * covers the screen and sits above the app header.
 *
 *   bun harness/fy-render-expand-screenshot.ts [outDir]   # default /tmp/claude-1000/shots/B164
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'fy-render-expand-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/B164');
mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) process.exit(1);
};
run('bun', ['build', join(harnessDir, 'fy-render-expand-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const page = (theme: string) => `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><link rel="stylesheet" href="/app.css" /></head>
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/fy-render-expand-page.js"></script></body></html>`;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(page(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return (await built.exists()) ? new Response(built) : new Response('', { status: 404 });
  },
});

const executablePath = Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser');
if (executablePath === null) throw new Error('no Chrome or Chromium');
const browser = await chromium.launch({ executablePath, headless: true });
const forms = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1280, height: 800 } },
} as const;
let failed = false;
for (const [form, options] of Object.entries(forms))
  for (const [mode, theme] of [
    ['light', 'studio-light'],
    ['dark', 'studio-dark'],
  ] as const) {
    const context = await browser.newContext(options);
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${server.port}/?theme=${theme}`);
    await tab.locator('figure[data-fy-render-type="svg"]').waitFor();
    await tab.screenshot({ path: join(outDir, `${form}-${mode}-inline.png`) });
    await tab.getByRole('button', { name: 'Fullscreen' }).click();
    await tab.waitForTimeout(300);
    const host = tab.getByRole('dialog');
    const box = await host.boundingBox();
    const view = tab.viewportSize();
    const covers = box !== null && view !== null && box.width >= view.width - 1 && box.height >= view.height - 1;
    const top = await tab.evaluate(() => document.elementFromPoint(20, 10)?.closest('[role="dialog"]') !== null);
    await tab.screenshot({ path: join(outDir, `${form}-${mode}-fullscreen.png`) });
    process.stdout.write(`${form}/${mode}: covers=${covers} aboveHeader=${top} box=${JSON.stringify(box)}\n`);
    if (!covers || !top) failed = true;
    await context.close();
  }
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
