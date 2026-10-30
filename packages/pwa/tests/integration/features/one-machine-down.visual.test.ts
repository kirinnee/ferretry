/**
 * ONE MACHINE ASLEEP MUST NOT TAKE THE APP WITH IT, in a real browser.
 *
 * The owner's report: two machines paired, Liftoff MBP asleep, Liftoff EC2 fine, the Sessions page open
 * on the MBP. A card pinned over the header and "+ New", a red page-level "could not reach fyd at
 * http://127.0.0.1:7431 (…)", and an "Updating…" pill waiting on the down machine. The scene
 * (`tests/integration/fixtures/one-machine-down-scene.tsx`) is that state, through the real components.
 *
 * What is proved, on a phone (390) and a desktop (1440), light and dark:
 *   - the healthy machine's sessions are on screen and live, with no page-level error or "Updating…";
 *   - the asleep machine is said IN PLACE: its section's status line ("Asleep · retrying · as of 23:05",
 *     Retry now, Details) above its greyed, read-only rows;
 *   - the raw transport text and the loopback address appear nowhere outside Details;
 *   - the top indicator is one small pill that covers NO control and moves nothing;
 *   - "+ New" defaults to the reachable machine and marks the asleep one unavailable;
 *   - no sideways scroll; every control meets the touch floor on the phone.
 * With the list set to "This machine", the MBP's own page says its outage as a status row, not red text.
 *
 * Set `FY_MACHINE_DOWN_SHOTS_DIR` to keep the captures for review; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';
import { boundedContext, overlapped } from '../support/overlap.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_MACHINE_DOWN_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

let browser: Browser;
const overlap = overlapped();
const bounded = boundedContext(() => browser, 3);
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-one-machine-down-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/one-machine-down-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the one-machine-down scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

type Scene = 'phone' | 'desktop' | 'single';

const open = async (
  scene: Scene,
  mode: 'light' | 'dark',
): Promise<{ readonly context: BrowserContext; readonly tab: Page }> => {
  const phone = scene !== 'desktop';
  const context = await bounded({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    // "as of 23:05" is the reader's own clock; pin it so the capture says what the owner's phone said.
    timezoneId: 'UTC',
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?scene=${scene}&theme=studio-${mode}`);
  await tab.waitForSelector(scene === 'single' ? '[data-machine-status-row]' : '[data-machine-status]');
  return { context, tab };
};

const shoot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await writeFile(join(shotsDir, `${name}.png`), await tab.screenshot({ animations: 'disabled' }));
};

describe('one machine asleep, the other fine', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    const { css, js } = await build();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
        if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
        return new Response('not here', { status: 404 });
      },
    });
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  beforeAll(overlap.start);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  for (const scene of ['phone', 'desktop'] as const)
    for (const mode of ['light', 'dark'] as const)
      overlap.it(
        `keeps the healthy machine usable and says the asleep one in place — ${scene}, ${mode}`,
        async () => {
          const { context, tab } = await open(scene, mode);
          try {
            const page = await tab.evaluate(() => {
              const main = document.querySelector('main');
              const text = main?.innerText ?? '';
              const status = document.querySelector('[data-machine-section] [data-machine-status]');
              const ec2 = document.querySelector('[data-machine-section][data-machine-reach="online"]');
              return {
                wide: document.documentElement.scrollWidth - innerWidth,
                alerts: document.querySelectorAll('[role="alert"], [data-machine-status-row], [data-cache-updating]')
                  .length,
                raw: document.body.innerText.includes('127.0.0.1') || text.includes('could not reach fyd'),
                status: status === null ? '' : (status as HTMLElement).innerText.replace(/\s+/gu, ' '),
                ec2Rows: ec2?.querySelectorAll('a[href*="/session/"]').length ?? 0,
                readOnly:
                  document.querySelector(
                    '[data-machine-section][data-machine-reach="offline"] [data-machine-read-only]',
                  ) !== null,
              };
            });
            expect(page.wide).toBeLessThanOrEqual(0);
            expect(page.alerts).toBe(0);
            expect(page.raw).toBe(false);
            expect(page.status).toContain('Asleep · retrying');
            expect(page.status).toContain('as of 23:05');
            expect(page.ec2Rows).toBeGreaterThan(0);
            expect(page.readOnly).toBe(true);

            // The top indicator: one small pill naming the machine, covering no control anywhere.
            const pill = await tab.$eval('[data-connection-pill]', node => (node as HTMLElement).innerText.trim());
            expect(pill).toBe('Liftoff MBP offline');
            const covered = await tab.evaluate(() => {
              const notice = document.querySelector('[data-connection-health]');
              const own = notice === null ? [] : [...notice.querySelectorAll('button')];
              const boxes = own.map(node => node.getBoundingClientRect());
              const controls = [...document.querySelectorAll('button, a[href], input, [role="tab"]')].filter(
                node => !own.includes(node as HTMLButtonElement) && (node as HTMLElement).offsetParent !== null,
              );
              const hit = (a: DOMRect, b: DOMRect): boolean =>
                a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
              return controls
                .filter(node => boxes.some(box => hit(box, node.getBoundingClientRect())))
                .map(node => node.getAttribute('aria-label') ?? (node as HTMLElement).innerText);
            });
            expect(covered).toEqual([]);
            if (scene === 'phone') {
              const heights = await tab.$$eval(
                '[data-connection-pill], [data-connection-dismiss], [data-machine-retry], [data-machine-details]',
                nodes => nodes.map(node => node.getBoundingClientRect().height),
              );
              expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
            }
            await shoot(tab, `one-machine-down-${scene}-${mode}`);

            // "+ New" defaults to the reachable machine; the asleep one is listed, unavailable, saying why.
            await tab.click('main [data-new-session-menu]');
            const menu = '[role="menu"][aria-label="New session on"]';
            await tab.waitForSelector(menu, { state: 'visible' });
            const items = await tab.$$eval(`${menu} [role="menuitem"]`, nodes =>
              nodes.map(node => node.textContent ?? ''),
            );
            const disabled = await tab.$$eval(`${menu} [role="menuitem"]`, nodes =>
              nodes.map(node => node.hasAttribute('disabled')),
            );
            expect(items[0]).toContain('Liftoff EC2');
            expect(items[1]).toContain('Liftoff MBP isn’t reachable right now');
            expect(disabled).toEqual([false, true]);
            if (mode === 'light') await shoot(tab, `one-machine-down-${scene}-new-menu`);
            await tab.keyboard.press('Escape');

            // Details is the only place the raw text appears.
            if (mode === 'light') {
              await tab.click('[data-machine-section] [data-machine-details]');
              const sheet = await tab.waitForSelector('[data-machine-outage-sheet]', { state: 'visible' });
              expect(await sheet.innerText()).toContain('could not reach fyd at http://127.0.0.1:7431');
              await shoot(tab, `one-machine-down-${scene}-details`);
            }
          } finally {
            await context.close();
          }
        },
        120_000,
      );

  overlap.it(
    'says the outage as the machine’s own status row when the list shows this machine only',
    async () => {
      for (const mode of ['light', 'dark'] as const) {
        const { context, tab } = await open('single', mode);
        try {
          const row = await tab.$eval('[data-machine-status-row]', node => (node as HTMLElement).innerText);
          expect(row).toContain('Liftoff MBP isn’t reachable right now');
          expect(row).toContain('as of 23:05');
          const page = await tab.evaluate(() => ({
            wide: document.documentElement.scrollWidth - innerWidth,
            alerts: document.querySelectorAll('[role="alert"], [data-cache-updating]').length,
            raw: document.body.innerText.includes('127.0.0.1'),
            rows: document.querySelectorAll('[data-session-row]').length,
          }));
          expect(page).toMatchObject({ alerts: 0, raw: false });
          expect(page.wide).toBeLessThanOrEqual(0);
          expect(page.rows).toBeGreaterThan(0);
          await shoot(tab, `one-machine-down-single-phone-${mode}`);
        } finally {
          await context.close();
        }
      }
    },
    120_000,
  );

  overlap.it(
    'hides the pill on × and leaves the page exactly where it was',
    async () => {
      const { context, tab } = await open('phone', 'light');
      try {
        const before = await tab.$eval('main', node => JSON.stringify(node.getBoundingClientRect()));
        await tab.click('[data-connection-dismiss]');
        expect(await tab.$$eval('[data-connection-pill]', nodes => nodes.length)).toBe(0);
        expect(await tab.$eval('main', node => JSON.stringify(node.getBoundingClientRect()))).toBe(before);
      } finally {
        await context.close();
      }
    },
    120_000,
  );
});
