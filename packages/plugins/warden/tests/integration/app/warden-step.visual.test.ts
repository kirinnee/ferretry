/**
 * THE WARDEN'S FIRST-RUN PAGE in a real browser over fake data (`fixtures/warden-step-scene.tsx`): nothing chosen, the free
 * answer, the LLM answer with no Jev key (the note and its link), and a stored key the Warden is not told to use; on a
 * phone (390) and a desktop (1280), light and dark. Also proves the page does not scroll sideways and its buttons are
 * not full width.
 *
 * Set `FY_WARDEN_STEP_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_WARDEN_STEP_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-warden-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/warden-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Warden step scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
const STATES = [
  { name: 'nothing-chosen', pick: undefined, key: 'missing', note: undefined },
  { name: 'rules-only', pick: 'rules', key: 'missing', note: undefined },
  { name: 'llm-no-key', pick: 'llm', key: 'missing', note: 'missing' },
  { name: 'jev-key-not-named', pick: 'jev', key: 'not_named', note: 'not_named' },
] as const;

describe('the Warden first-run page', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const state of STATES) {
        it(`${state.name} (${viewport.name}, ${theme})`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          try {
            await tab.goto(`${origin}/?theme=${theme}&key=${state.key}`);
            await tab.locator('[data-choice-cards]').waitFor({ state: 'visible' });
            expect(await tab.locator('[data-choice]').count()).toBe(3);
            if (state.pick !== undefined) {
              await tab.locator(`[data-choice="${state.pick}"]`).click();
              await tab.locator(`[data-warden-demo="${state.pick}"]`).waitFor({ state: 'visible' });
              // The demo plays once (1.5 s) and rests on its last frame.
              await tab.waitForTimeout(1_800);
            }
            if (state.note !== undefined)
              await tab.locator(`[data-warden-jev="${state.note}"]`).waitFor({ state: 'visible' });
            // No sideways scroll, and no button fills the page.
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            const widths = await tab.evaluate(() => {
              const page = (document.querySelector('main') as HTMLElement).getBoundingClientRect().width;
              return [...document.querySelectorAll('button')].map(b => b.getBoundingClientRect().width / page);
            });
            for (const share of widths) expect(share).toBeLessThan(0.6);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${state.name}.png`) });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
