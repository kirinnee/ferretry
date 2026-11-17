/**
 * THE "SCREENS FERRETRY CLEARS" CARD in a real browser over a FIXED FAKE screen (`fixtures/warden-dialog-rules-scene.tsx`): a
 * proposed rule (the row it would press marked, the owner's yes offered) and a held one (shown, never saved), on a phone (390)
 * and a desktop (1280), light and dark. No real pane, ferret or secret is drawn.
 * Set `FY_WARDEN_DIALOG_RULES_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_WARDEN_DIALOG_RULES_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-warden-dialog-rules-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/warden-dialog-rules-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Warden dialog-rules scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: 'proposal', expects: 'the rule would press this', saves: true },
  { name: 'held', expects: 'it is held', saves: false },
] as const;

describe('the screens Ferretry clears, over a fake screen', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const state of STATES) {
        it(`shows ${state.name} (${viewport.name}, ${theme})`, async () => {
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
            await tab.goto(`${origin}/?theme=${theme}&state=${state.name === 'held' ? 'held' : 'proposal'}`);
            const task = tab.locator('[aria-label="Screens Ferretry clears"]');
            await task.waitFor({ state: 'visible' });
            const text = await task.innerText();
            expect(text).toContain(state.expects);
            expect(text.includes('Save this rule')).toBe(state.saves);
            // No horizontal scroll on a phone: the card fits the width it is given.
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            if (shotsDir !== '')
              await tab.screenshot({
                path: join(shotsDir, `${viewport.name}-${theme}-dialog-rules-${state.name}.png`),
                fullPage: true,
              });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
