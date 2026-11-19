/**
 * THE SHELLS ONBOARDING STEP in a real browser over fake data (r10 O13): the real step body inside the shell's frame (the
 * frame is wrapped in the fixture only), at 1280 and 390 wide, light and dark, for the two things it can say: nix is
 * missing (what ferrets use instead), and the check failed ("Couldn't check", with a retry).
 *
 * Set `FY_SHELLS_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<missing|unreadable>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm as removeTree } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SHELLS_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let built = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), 'ferretry-shells-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', built, '--entry', 'fixtures/shells-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the shells step scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (built !== '') await removeTree(built, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280', width: 1_280, height: 720, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('The Shells onboarding step', () => {
  for (const variant of VARIANTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const outcome of ['missing', 'unreadable'] as const)
        it(`reads clearly inside the shell's frame (${variant.name}, ${scheme}, ${outcome})`, async () => {
          const context = await browser.newContext({
            viewport: { width: variant.width, height: variant.height },
            colorScheme: scheme,
            deviceScaleFactor: variant.phone ? 2 : 1,
            hasTouch: variant.phone,
            isMobile: variant.phone,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const page = await context.newPage();
          try {
            await page.goto(`${origin}/?theme=studio-${scheme}&case=${outcome}`);
            await page.waitForSelector(`[data-testid="shells-step"][data-outcome="${outcome}"]`);
            const text = (await page.textContent('[data-testid="shells-step"]')) ?? '';
            if (outcome === 'unreadable') {
              expect(text).toContain('Couldn’t check');
              expect(await page.$$('[data-shells-step-retry]')).toHaveLength(1);
            } else {
              expect(text).toContain('Nix is not on this machine');
              expect(await page.$$('[data-shells-step-retry]')).toHaveLength(0);
            }
            expect(await page.$$('[data-step-later]'), 'the body draws no Later of its own').toHaveLength(0);
            expect(await page.$$('h1'), 'one title: the frame’s').toHaveLength(1);
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-${outcome}.png`) });
          } finally {
            await context.close();
          }
        }, 60_000);
});
