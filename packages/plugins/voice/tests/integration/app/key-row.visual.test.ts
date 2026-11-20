/**
 * VOICE'S KEY ROW in a real browser (r11 O7; `fixtures/key-row-scene.tsx`): the row a first-run page mounts through the
 * `speedup-key` panel. Proof, on the DOM and computed geometry: the key field is a password input that fits its column
 * (no sideways scroll at 390 or 1280, 44 px controls); Save sends the key to the vault route once, after which the key's
 * text is in no DOM, storage or console line and the field is gone; Test is one call and the person's own press.
 * Set `FY_KEY_ROW_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_KEY_ROW_SHOTS_DIR ?? '';
const FAKE_KEY = 'jev-fake-key-0123456789abcdef';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-key-row-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/key-row-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the key row scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 800, phone: true },
] as const;

describe('Voice key row', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      it(`field, Save, Test, and no key left behind (${viewport.name}, ${theme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        const logs: string[] = [];
        tab.on('console', message => logs.push(message.text()));
        try {
          await tab.goto(`${origin}/?theme=${theme}`);
          const field = tab.locator('input[type=password]');
          await field.waitFor({ state: 'visible' });
          const box = await tab.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const row = rect(document.querySelector('[data-speedup-key-row]') as Element);
            return {
              controls: [
                ...document.querySelectorAll('[data-speedup-key-row] input, [data-speedup-key-row] button'),
              ].map(el => ({ h: rect(el).height, right: rect(el).right })),
              rowRight: row.right,
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          expect(box.scrollX).toBeLessThanOrEqual(0);
          for (const control of box.controls) {
            expect(control.h).toBeGreaterThanOrEqual(43.5);
            expect(control.right).toBeLessThanOrEqual(box.rowRight + 1);
          }
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-empty.png`) });

          await field.fill(FAKE_KEY);
          await tab.getByRole('button', { name: 'Save' }).click();
          await tab.locator('[data-speedup-set]').waitFor({ state: 'visible' });
          const fake = await tab.evaluate(() => (window as unknown as { __fake: unknown }).__fake);
          expect(fake).toEqual({ puts: [{ name: 'JEV_API_KEY', length: FAKE_KEY.length }], tests: 0 });
          const where = await tab.evaluate(key => {
            const stores = [localStorage, sessionStorage].map(store => JSON.stringify({ ...store }));
            return {
              html: document.documentElement.outerHTML.includes(key),
              text: document.body.innerText.includes(key),
              stores: stores.some(store => store.includes(key)),
              fields: document.querySelectorAll('input[type=password]').length,
            };
          }, FAKE_KEY);
          expect(where).toEqual({ html: false, text: false, stores: false, fields: 0 });
          expect(logs.some(line => line.includes(FAKE_KEY))).toBe(false);

          // A Test is the person's press, and one call.
          await tab.getByRole('button', { name: 'Test the Jev key' }).click();
          await tab.locator('[data-speedup-last-test]').waitFor({ state: 'visible' });
          expect(
            (
              (await tab.evaluate(() => (window as unknown as { __fake: { tests: number } }).__fake)) as {
                tests: number;
              }
            ).tests,
          ).toBe(1);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-tested.png`) });
        } finally {
          await context.close();
        }
      });
    }
  }
});
