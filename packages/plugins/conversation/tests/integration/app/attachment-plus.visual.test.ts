/**
 * A-36: THE PLUS ON AN ATTACHMENT TILE, in a real browser over fake files (`fixtures/attachment-plus-scene.tsx`): at a
 * phone and a desktop width, light and dark, in the default style and the roundest one. The plus is a real 44px
 * target on screen, a press puts `%attachment:<delivered name>` in the stand-in message box through the real Add to
 * chat, and the tiles stay round-safe and never push the page sideways.
 *
 * Set `FY_A36_SHOTS_DIR` to keep `<style>-<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_A36_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-attachment-plus-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/attachment-plus-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the attachment plus scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;
/** The default look, and the one whose controls and panels are the roundest (`neumorphism`). */
const STYLES = ['studio', 'neumorphism'] as const;

for (const style of STYLES)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`puts the reference in the message box: ${style} ${viewport.name} ${scheme}`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        try {
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin || route.request().url().startsWith('blob:')
              ? await route.continue()
              : await route.abort(),
          );
          const page = await context.newPage();
          await page.goto(`${origin}/?theme=studio-${scheme}&draft=Please%20read`);
          await page.evaluate(value => document.documentElement.setAttribute('data-style', value), style);
          await page.waitForSelector('[aria-label="Add screenshot.png to the message"]');
          await page.evaluate(async () => await document.fonts.ready);

          // Every tile has a plus, and each is a 44px target inside the screen.
          const pluses = page.locator('[aria-label^="Add "][aria-label$=" to the message"]');
          expect(await pluses.count()).toBe(4);
          for (let at = 0; at < 4; at += 1) {
            const box = await pluses.nth(at).boundingBox();
            expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
            expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
            expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= viewport.width).toBe(true);
          }

          // On a 16px picture the Expand and the Add buttons are two separate targets: neither covers the other, each is
          // at least 44px, and the centre of each is hit by that very button (not its neighbour).
          const expand = page.locator('[aria-label="Expand tiny.png"]');
          const addTiny = page.locator('[aria-label="Add tiny.png to the message"]');
          const [expandBox, addBox] = [await expand.boundingBox(), await addTiny.boundingBox()];
          if (expandBox === null || addBox === null) throw new Error('the tiny picture has no buttons');
          expect(expandBox.width).toBeGreaterThanOrEqual(43.5);
          expect(expandBox.height).toBeGreaterThanOrEqual(43.5);
          const overlaps =
            expandBox.x < addBox.x + addBox.width &&
            addBox.x < expandBox.x + expandBox.width &&
            expandBox.y < addBox.y + addBox.height &&
            addBox.y < expandBox.y + expandBox.height;
          expect(overlaps, 'Expand and Add on a tiny picture do not overlap').toBe(false);
          for (const [label, box] of [
            ['Expand tiny.png', expandBox],
            ['Add tiny.png to the message', addBox],
          ] as const) {
            const hit = await page.evaluate(
              ([x, y]) =>
                document
                  .elementFromPoint(x as number, y as number)
                  ?.closest('button')
                  ?.getAttribute('aria-label'),
              [box.x + box.width / 2, box.y + box.height / 2],
            );
            expect(hit, `the centre of the ${label} button hits that button`).toBe(label);
          }

          await page.click('[aria-label="Add quarterly report.pdf to the message"]');
          await page.click('[aria-label="Add screenshot.png to the message"]');
          await page.waitForTimeout(300);
          const draft = ((await page.locator('[data-scene-draft]').textContent()) ?? '').trim();
          expect(draft).toBe('Please read %attachment:att-pdf/quarterly-report.pdf %attachment:att-png/screenshot.png');
          expect(await page.locator('[role="status"]').allTextContents()).toEqual(
            expect.arrayContaining([expect.stringContaining('Added %attachment:att-pdf/quarterly-report.pdf')]),
          );

          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `${style}-${viewport.name}-${scheme}.png`), fullPage: true });
          const misses = await roundSafeMisses(page);
          expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
            'the page never scrolls sideways',
          ).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      });
