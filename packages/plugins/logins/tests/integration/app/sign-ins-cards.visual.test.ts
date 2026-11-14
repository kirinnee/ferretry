/**
 * THE LOGINS LIST, CARD BY CARD, in a real browser over fake data (`fixtures/sign-ins-cards-scene.tsx`): each card keeps
 * v4's on/off switch beside its name and a Remove button under it, on a phone (390) and a desktop (1280), light and dark.
 * Pressing Remove shows the daemon's consequences under the card before anything is removed.
 *
 * Set `FY_LOGIN_CARDS_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LOGIN_CARDS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-login-cards-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/sign-ins-cards-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the login cards scene did not build (${code}):\n${stderr}\n${stdout}`);
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

describe('the Logins list: each card has its switch and its Remove', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`shows them, inside the card and clear of the text (${viewport.name}, ${theme})`, async () => {
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
          await tab.goto(`${origin}/?theme=${theme}`);
          await tab.locator('[data-login-card-wrap]').first().waitFor({ state: 'visible' });
          await tab.waitForTimeout(200);
          const cards = await tab.locator('[data-login-card-wrap]').count();
          expect(cards).toBe(3);
          expect(await tab.locator('[data-login-switch]').count()).toBe(3);
          expect(await tab.locator('[data-login-card-remove]').count()).toBe(3);
          const states = await tab
            .locator('[data-login-switch]')
            .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-login-switch-state')));
          expect(states).toEqual(['on', 'off', 'on']);
          // Switch and Remove sit inside their card, and the page does not scroll sideways.
          const inside = await tab.evaluate(() =>
            Array.from(document.querySelectorAll('[data-login-card-wrap]')).map(card => {
              const box = card.getBoundingClientRect();
              return ['[data-login-switch] button', '[data-login-card-remove]'].every(selector => {
                const part = card.querySelector(selector)?.getBoundingClientRect();
                return part !== undefined && part.left >= box.left && part.right <= box.right + 1;
              });
            }),
          );
          expect(inside).toEqual([true, true, true]);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-list.png`) });

          await tab.locator('[data-login-card-remove="claude-personal"]').click();
          await tab.locator('[data-login-remove]').waitFor({ state: 'visible' });
          await tab.waitForTimeout(200);
          expect(await tab.locator('[data-login-remove]').textContent()).toContain('saved sign-in stays');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-remove.png`) });
        } finally {
          await context.close();
        }
      });
    }
  }
});
