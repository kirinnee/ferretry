/**
 * "WHAT'S NEW" ON A PHONE, in the real shell: it opens from both doors, shows the newest release,
 * scrolls by touch, and closes by every route a thumb has. The scene is the real `AppShell` over a fake
 * daemon (`fixtures/whats-new-scene.tsx`) with the repository's real `Changelog.md` stamped in.
 *
 * Set `FY_WHATS_NEW_SHOTS_DIR` to keep a screenshot of each step.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_WHATS_NEW_SHOTS_DIR;
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const PHONES = [
  { name: '390-dark', width: 390, height: 844, colorScheme: 'dark' },
  { name: '375-light', width: 375, height: 667, colorScheme: 'light' },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let newestVersion = '';

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-whats-new-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/whats-new-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the whats-new scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

const shoot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== undefined) await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

const sheetState = async (tab: Page) =>
  await tab.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-whats-new-body]');
    const sheet = document.querySelector<HTMLElement>('#whats-new');
    const first = document.querySelector('[data-whats-new-release]')?.getAttribute('data-whats-new-release') ?? null;
    const rect = sheet?.getBoundingClientRect();
    return {
      open: body !== null && sheet !== null,
      first,
      scrollTop: body?.scrollTop ?? 0,
      scrollable: body === null ? false : body.scrollHeight > body.clientHeight + 40,
      onScreen:
        rect !== undefined &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight + 1 &&
        rect.right <= window.innerWidth + 1,
    };
  });

const closed = async (tab: Page): Promise<boolean> => {
  await tab.waitForSelector('[data-whats-new-body]', { state: 'detached', timeout: 5000 });
  return true;
};

const touchScroll = async (context: BrowserContext, tab: Page, x: number, from: number, to: number): Promise<void> => {
  const cdp = await context.newCDPSession(tab);
  const point = async (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await point('touchStart', from);
  for (let y = from; y >= to; y -= 20) {
    await point('touchMove', y);
    await tab.waitForTimeout(16);
  }
  await point('touchEnd', to);
  await tab.waitForTimeout(400);
};

describe('whats new, on a phone', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    newestVersion =
      /^## \[([^\]]+)\]/mu.exec(await readFile(resolve(packageRoot, '../../Changelog.md'), 'utf8'))?.[1] ?? '';
    const { css, js } = await build();
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
        if (path.includes('.')) return new Response('not here', { status: 404 });
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      },
    });
    if (shotsDir !== undefined) await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  const phone = async (spec: (typeof PHONES)[number], search = '', motion: 'reduce' | 'no-preference' = 'reduce') => {
    const origin = server?.url.origin ?? '';
    const context = await browser.newContext({
      viewport: { width: spec.width, height: spec.height },
      colorScheme: spec.colorScheme,
      reducedMotion: motion,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: ANDROID_UA,
    });
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    const tab = await context.newPage();
    await tab.goto(`${origin}/${search}`);
    await tab.waitForSelector('a[href$="/session/s-03"]');
    const daemon = await tab.evaluate(
      () => (globalThis as unknown as { __whatsNew: { daemonId: string } }).__whatsNew.daemonId,
    );
    return { context, tab, daemon, settings: `${origin}/d/${encodeURIComponent(daemon)}/settings${search}` };
  };

  const openAboutPanel = async (tab: Page, daemon: string, settings: string): Promise<void> => {
    await tab.goto(settings);
    await tab.click(`[data-settings-machine="${daemon}"]:visible`);
    await tab.click('[data-machine-tab="machine"]');
    await tab.click('[data-daemon-panel="about"]');
  };

  for (const spec of PHONES) {
    describe(spec.name, () => {
      it('opens from Settings › About, shows the newest release, scrolls by touch and closes every way', async () => {
        const { context, tab, daemon, settings } = await phone(spec);
        try {
          await openAboutPanel(tab, daemon, settings);
          await tab.waitForSelector('[data-about-whats-new]');
          await shoot(tab, `${spec.name}-1-about`);
          await tab.tap('[data-about-whats-new]');
          await tab.waitForSelector('[data-whats-new-body]');
          await shoot(tab, `${spec.name}-2-open`);
          const opened = await sheetState(tab);
          expect(opened.open).toBe(true);
          expect(opened.onScreen).toBe(true);
          expect(opened.first).toBe(newestVersion);
          expect(opened.scrollable).toBe(true);

          await touchScroll(context, tab, spec.width / 2, spec.height * 0.7, spec.height * 0.3);
          expect((await sheetState(tab)).scrollTop).toBeGreaterThan(100);
          await shoot(tab, `${spec.name}-3-scrolled`);

          await tab.tap('[data-whats-new-close]');
          expect(await closed(tab)).toBe(true);
          await shoot(tab, `${spec.name}-4-closed`);

          for (const close of [
            async () => await tab.keyboard.press('Escape'),
            async () => await tab.touchscreen.tap(spec.width / 2, 70),
            async () => await tab.tap('[data-sheet-swipe="supported"]'),
          ]) {
            await tab.tap('[data-about-whats-new]');
            await tab.waitForSelector('[data-whats-new-body]');
            await close();
            expect(await closed(tab)).toBe(true);
          }
        } finally {
          await context.close();
        }
      }, 120_000);

      it('opens from the phone More menu', async () => {
        const { context, tab, settings } = await phone(spec);
        try {
          await tab.goto(settings);
          await tab.tap('[data-app-tab="more"]');
          await tab.waitForSelector('[data-app-more-whats-new]');
          await shoot(tab, `${spec.name}-6-more`);
          await tab.tap('[data-app-more-whats-new]');
          await tab.waitForSelector('[data-whats-new-body]');
          const opened = await sheetState(tab);
          expect(opened.first).toBe(newestVersion);
          expect(opened.onScreen).toBe(true);
          await shoot(tab, `${spec.name}-7-from-more`);
          await tab.tap('[data-whats-new-close]');
          expect(await closed(tab)).toBe(true);
        } finally {
          await context.close();
        }
      }, 120_000);

      it('shows that the Settings tab row scrolls, and reaches Machine with the chevron', async () => {
        const { context, tab, daemon, settings } = await phone(spec);
        try {
          await tab.goto(settings);
          await tab.tap(`[data-settings-machine="${daemon}"]:visible`);
          await tab.waitForSelector('[data-machine-tab="machine"]');
          await shoot(tab, `${spec.name}-8-tabs`);
          const rightEdge = async () =>
            await tab.evaluate(() => {
              const machine = document.querySelector<HTMLElement>('[data-machine-tab="machine"]');
              const strip = machine?.closest('ul');
              const end = strip?.getBoundingClientRect().right ?? 0;
              return (machine?.getBoundingClientRect().right ?? 0) - end;
            });
          const chevron = tab.locator('[data-utabs-more="end"]');
          if ((await rightEdge()) > 1) {
            expect(await chevron.isVisible()).toBe(true);
            for (let step = 0; step < 4 && (await rightEdge()) > 1; step += 1) {
              await chevron.tap();
              await tab.waitForTimeout(500);
            }
            await shoot(tab, `${spec.name}-9-tabs-scrolled`);
          }
          expect(await rightEdge()).toBeLessThanOrEqual(1);
        } finally {
          await context.close();
        }
      }, 120_000);

      it('opens from the pull-down finder with a real touch and stays open', async () => {
        const { context, tab, settings } = await phone(spec, '', 'no-preference');
        try {
          await tab.goto(settings);
          const cdp = await context.newCDPSession(tab);
          const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
            await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
          await touch('touchStart', spec.width / 2, 120);
          for (let y = 120; y <= 320; y += 20) {
            await touch('touchMove', spec.width / 2, y);
            await tab.waitForTimeout(16);
          }
          await touch('touchEnd', spec.width / 2, 320);
          await tab.waitForSelector('[placeholder^="Search places"]');
          await tab.tap('[placeholder^="Search places"]');
          await tab.keyboard.type('what');
          await tab.waitForSelector('text=What’s new');
          await shoot(tab, `${spec.name}-6-pull-finder`);
          const box = await tab.locator('text=What’s new').first().boundingBox();
          if (box === null) throw new Error('no What’s new row');
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await tab.evaluate(() => {
            const w = globalThis as unknown as { __seen: boolean[] };
            w.__seen = [];
            const tick = () => {
              w.__seen.push(document.querySelector('[data-whats-new-body]') !== null);
              requestAnimationFrame(tick);
            };
            tick();
          });
          await touch('touchStart', x, y);
          await tab.waitForTimeout(60);
          await touch('touchEnd', x, y);
          // WebKit synthesizes the click from the touch AFTER touchend, hit-testing whatever is under the
          // finger by then. Chromium drops that click when the pressed row has already left the document,
          // so replay it by hand: it must not be able to dismiss the sheet it landed on.
          await tab.evaluate(
            ([px, py]) => {
              document
                .elementFromPoint(px as number, py as number)
                ?.dispatchEvent(
                  new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: px, clientY: py }),
                );
            },
            [x, y],
          );
          await tab.waitForTimeout(1500);
          const seen = await tab.evaluate(() => (globalThis as unknown as { __seen: boolean[] }).__seen);
          const firstOpen = seen.indexOf(true);
          expect(firstOpen).toBeGreaterThanOrEqual(0);
          expect(seen.slice(firstOpen).every(Boolean)).toBe(true);
          const opened = await sheetState(tab);
          expect(opened.first).toBe(newestVersion);
          expect(opened.onScreen).toBe(true);
          await shoot(tab, `${spec.name}-7-pull-open`);
        } finally {
          await context.close();
        }
      }, 120_000);

      it('opens from the finder', async () => {
        const { context, tab, settings } = await phone(spec);
        try {
          await tab.goto(settings);
          await tab.tap('[data-app-tab="find"]');
          await tab.tap('[placeholder^="Search places"]');
          await tab.keyboard.type('what');
          await shoot(tab, `${spec.name}-5-finder`);
          await tab.tap('text=What’s new');
          await tab.waitForSelector('[data-whats-new-body]');
          const opened = await sheetState(tab);
          expect(opened.first).toBe(newestVersion);
          expect(opened.onScreen).toBe(true);
          await tab.tap('[data-whats-new-close]');
          expect(await closed(tab)).toBe(true);
        } finally {
          await context.close();
        }
      }, 120_000);
    });
  }

  it('keeps the door open when the machine did not answer the update read', async () => {
    const { context, tab, daemon, settings } = await phone(PHONES[0], '?about=failed');
    try {
      await openAboutPanel(tab, daemon, settings);
      await tab.waitForSelector('[aria-label="About this machine unavailable"]');
      await shoot(tab, 'failed-1-about');
      await tab.tap('[data-about-whats-new]');
      await tab.waitForSelector('[data-whats-new-body]');
      expect((await sheetState(tab)).first).toBe(newestVersion);
      await shoot(tab, 'failed-2-open');
    } finally {
      await context.close();
    }
  }, 120_000);
});
