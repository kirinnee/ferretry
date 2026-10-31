/**
 * THE WARDEN PAGE NAMES AND FILTERS BY DAEMON, in a real browser (owner: "warden page doesnt show or allow
 * filter by different daemons").
 *
 * The scene (`tests/integration/fixtures/warden-daemons-scene.tsx`) is the real `WardenPage` over two fake
 * daemons. Under All every daemon is its own named section, a picked daemon is the only one shown, the choice
 * survives a reload on this device, and nothing scrolls sideways on a phone.
 *
 * Set `FY_WARDEN_DAEMONS_SHOTS_DIR` to keep All and one picked daemon at 390 and 1440 wide, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_WARDEN_DAEMONS_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-warden-daemons-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/warden-daemons-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the warden-daemons scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, mode: 'light' | 'dark', query = ''): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${mode}${query}`);
  await tab.waitForSelector('[data-warden-page]');
  return tab;
};

const sections = (tab: Page): Promise<string[]> =>
  tab.locator('[data-daemon]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-daemon') ?? ''));

const shoot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

describe('the Warden page across paired daemons', () => {
  for (const viewport of VIEWPORTS) {
    for (const mode of ['light', 'dark'] as const) {
      it(`names every daemon under All and narrows to one picked daemon (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        try {
          const tab = await open(context, mode);
          const select = tab.getByLabel('Daemon');
          expect(await select.inputValue()).toBe('');
          expect(await select.locator('option').allTextContents()).toEqual([
            'All daemons',
            'Liftoff EC2',
            'Liftoff MBP',
          ]);
          expect(await sections(tab)).toEqual(['daemon-ec2', 'daemon-mbp']);
          expect(await tab.getByRole('region', { name: 'Warden on Liftoff EC2' }).count()).toBe(1);
          expect(await tab.getByRole('region', { name: 'Warden on Liftoff MBP' }).count()).toBe(1);
          const heads = await tab.locator('h2').allTextContents();
          expect(heads.filter(text => text.startsWith('Warden'))).toEqual([
            'Warden · Liftoff EC2',
            'Warden · Liftoff MBP',
          ]);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect(await select.boundingBox().then(box => box?.height ?? 0)).toBeGreaterThanOrEqual(
            viewport.phone ? 44 : 30,
          );
          await shoot(tab, `warden-daemons-all-${viewport.name}-${mode}`);

          await select.selectOption('daemon-mbp');
          expect(await sections(tab)).toEqual(['daemon-mbp']);
          expect(await tab.getByRole('region', { name: 'Warden on Liftoff EC2' }).count()).toBe(0);
          await shoot(tab, `warden-daemons-mbp-${viewport.name}-${mode}`);

          await tab.reload();
          await tab.waitForSelector('[data-warden-page]');
          expect(await tab.getByLabel('Daemon').inputValue()).toBe('daemon-mbp');
          expect(await sections(tab)).toEqual(['daemon-mbp']);

          await tab.getByLabel('Daemon').selectOption('');
          expect(await sections(tab)).toEqual(['daemon-ec2', 'daemon-mbp']);
        } finally {
          await context.close();
        }
      }, 60_000);
    }
  }

  it('offers no filter and no daemon name for a single paired daemon', async () => {
    const context = await newContext(VIEWPORTS[0], 'light');
    try {
      const tab = await open(context, 'light', '&daemons=1');
      expect(await tab.getByLabel('Daemon').count()).toBe(0);
      expect(await tab.locator('[data-warden-machine]').count()).toBe(0);
      expect(await sections(tab)).toEqual(['daemon-ec2']);
    } finally {
      await context.close();
    }
  }, 60_000);
});
