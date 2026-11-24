/**
 * "CONFIRM IT'S YOU" SAYS WHAT ONE PASSKEY REALLY COVERS (O12 S4), in a real browser over fake data
 * (`fixtures/stepup-once-scene.tsx`), on a machine whose step-up window is 15 minutes:
 *
 *  - `import`: an import's passkey (`loosen-config`) is spent on that import, so the second import asks again (QA walk 3
 *    finding 1: asked at the Claude and the Codex import, 77 s apart). The prompt says it confirms this one change and
 *    never "covers changes on this machine for 15 minutes";
 *  - `change`: an ordinary change keeps the machine's window sentence.
 *
 * Set `FY_STEPUP_ONCE_SHOTS_DIR` to keep `<state>-<width>-<scheme>.png` (390 and 1440, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_STEPUP_ONCE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-stepup-once-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/stepup-once-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the step-up scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { width: 1_440, height: 900, phone: false, scheme: 'light' },
  { width: 1_440, height: 900, phone: false, scheme: 'dark' },
  { width: 390, height: 844, phone: true, scheme: 'light' },
  { width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

const WINDOW_SENTENCE = 'This covers changes on this machine for 15 minutes';
const ONCE_SENTENCE = 'This confirms this one change. The next change like it asks for your passkey again.';

describe('Confirm it’s you says what one passkey covers', () => {
  for (const state of ['import', 'change'] as const)
    for (const variant of VIEWPORTS) {
      it(`${state} ${variant.width} ${variant.scheme}: the scope line matches what the daemon spends`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
          colorScheme: variant.scheme,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?theme=studio-${variant.scheme}&state=${state}`);
          await tab.waitForSelector('[data-step-up-dialog]');
          const scope = tab.locator('[data-step-up-scope]');
          // The machine's window is read after the first paint: wait until it has had its say.
          if (state === 'change')
            await tab.waitForFunction(text => document.body.innerText.includes(text), WINDOW_SENTENCE);
          else await tab.waitForTimeout(150);
          const text = await scope.innerText();
          const purpose = await tab.locator('[data-step-up-dialog] [id$="-purpose"]').innerText();
          if (state === 'import') {
            expect(purpose).toBe('Confirm with your passkey to put a configuration change into effect on Fake Box.');
            expect(text).toBe(ONCE_SENTENCE);
            expect(text).not.toContain('15 minutes');
          } else {
            expect(text).toContain(WINDOW_SENTENCE);
          }
          // The line is drawn, not just present: visible, inside the dialog, and nothing overflows the page.
          const box = await scope.boundingBox();
          const dialog = await tab.locator('[data-step-up-dialog]').boundingBox();
          expect(box?.height ?? 0).toBeGreaterThan(0);
          expect((box?.x ?? -1) >= (dialog?.x ?? 0)).toBe(true);
          expect((box?.x ?? 0) + (box?.width ?? 0) <= (dialog?.x ?? 0) + (dialog?.width ?? 0) + 0.5).toBe(true);
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          );
          expect(overflow).toBe(false);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${state}-${variant.width}-${variant.scheme}.png`) });
        } finally {
          await context.close();
        }
      });
    }
});
