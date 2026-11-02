/**
 * INBOX FIND LOOKS IN EVERY TAB, in a real browser, on a phone (390) and a desktop (1440).
 *
 * Typing "relay" into Find lists the open, the snoozed, the replied and the resolved item, each with its state chip,
 * and nothing scrolls sideways.
 *
 * Set `FY_INBOX_FIND_SHOTS_DIR` to keep `<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_INBOX_FIND_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-inbox-find-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/inbox-find-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the inbox find scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;

describe('Inbox Find looks in every tab', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`lists the open, snoozed, replied and resolved item with their chips (${viewport.name}, ${scheme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
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
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab.waitForSelector('[data-agenda-find-open]', { timeout: 4_000 });
          await tab.click('[data-agenda-find-open]');
          await tab.fill('[data-agenda-find]', 'relay');
          await tab.waitForSelector('[data-find-row]', { timeout: 4_000 });

          const chips = await tab.$$eval('[data-find-row] [data-find-chip]', nodes =>
            nodes.map(node => node.textContent ?? ''),
          );
          expect(chips).toEqual(['Open', expect.stringMatching(/^Snoozed until /u), 'Replied', 'Resolved']);
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}.png`) });
        } finally {
          await context.close();
        }
      }, 60_000);
});
