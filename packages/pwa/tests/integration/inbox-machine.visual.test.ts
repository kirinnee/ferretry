/**
 * THE INBOX'S MACHINE GROUP, in a real browser, on a phone and a desktop.
 *
 *  - The Machine group is the FIRST group, above the ferret's, with the machine's own notices ("3 ferrets could not be
 *    moved", "claude-liftoff hit its hard limit") and no callsign.
 *  - Its header is not a link: the machine agenda has no chat.
 *  - Nothing scrolls sideways.
 *
 * Set `FY_INBOX_MACHINE_SHOTS_DIR` to keep `<viewport>-machine.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_INBOX_MACHINE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-inbox-machine-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/inbox-machine-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the inbox machine scene did not build (${code}):\n${stderr}\n${stdout}`);
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

describe('the Inbox’s Machine group', () => {
  for (const viewport of VIEWPORTS)
    it(`comes first, names no ferret and links nowhere (${viewport.name})`, async () => {
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
        await tab.goto(`${origin}/?theme=studio-light`);
        await tab.waitForSelector('[data-agenda-group]', { timeout: 4_000 });
        const groups = await tab.evaluate(() =>
          [...document.querySelectorAll('[data-agenda-group]')].map(group => ({
            text: group.textContent ?? '',
            link: group.querySelector('[data-agenda-group-link]') !== null,
            machine: group.querySelector('[data-agenda-group-machine]') !== null,
          })),
        );
        expect(groups.length).toBe(2);
        expect(groups[0]?.machine).toBe(true);
        expect(groups[0]?.link).toBe(false);
        expect(groups[0]?.text).toContain('3 ferrets could not be moved');
        expect(groups[0]?.text).toContain('claude-liftoff hit its hard limit');
        expect(groups[1]?.link).toBe(true);
        const overflow = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-machine.png`) });
      } finally {
        await context.close();
      }
    }, 60_000);
});
