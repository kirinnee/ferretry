/**
 * THE PRS & CI SCREEN in a real browser over fake data (`fixtures/pulls-list-scene.tsx`), at 1280 and 390 wide, light
 * and dark: it draws, never scrolls sideways (even with one unbroken 100-character title), and stays calm.
 *
 * Set `FY_PULLS_LIST_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PULLS_LIST_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pulls-list-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pulls-list-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the PRs screen scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

const WAIT_FOR: Record<string, string> = {
  empty: '[data-pulls-needs-account]',
  mixed: '[data-pull-row]',
  running: '[data-pull-ci="running"]',
  paused: '[data-pulls-paused]',
  long: '[data-pull-row]',
};

describe('PRs & CI screen', () => {
  for (const kind of ['empty', 'mixed', 'running', 'paused', 'long'] as const) {
    for (const variant of VARIANTS) {
      it(`${kind} at ${variant.name}: draws, never scrolls sideways, no stray errors`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
          colorScheme: variant.scheme,
        });
        const tab = await context.newPage();
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}&case=${kind}`);
        await tab.waitForSelector(WAIT_FOR[kind] as string);
        if (kind === 'mixed' || kind === 'long') await tab.locator('[data-pulls-filter="all"]').click();
        const sideways = await tab.evaluate(() => {
          const main = document.querySelector('[data-pulls-list]');
          return Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            main === null ? 0 : main.scrollWidth - main.clientWidth,
          );
        });
        expect(sideways).toBeLessThanOrEqual(0);
        if (kind === 'long') {
          // 24 routine PRs and two odd ones are folded to a page, and the rest is one press away.
          expect(await tab.locator('[data-pull-row]').count()).toBe(20);
        }
        if (shotsDir !== '') {
          await tab.setViewportSize({ width: variant.width, height: variant.phone ? 2600 : 1600 });
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-${kind}.png`) });
          if (kind === 'mixed') {
            // The notify choices, open: the one part of the screen a closed disclosure hides.
            await tab.locator('[data-pulls-notify] summary').first().click();
            await tab.screenshot({ path: join(shotsDir, `${variant.name}-${kind}-notify.png`) });
          }
        }
        expect(problems).toEqual([]);
        await context.close();
      });
    }
  }
});

/**
 * r11 S7, the owner's line: "I don't understand 'Watch this project's pull requests'. If a GitHub account is linked,
 * watch by default and show the PRs; the checkbox becomes a quiet 'Stop watching'". Computed geometry and DOM, in real
 * Chromium, over a client that decides like the daemon (see the scene). The measured numbers go in the PR body.
 */
describe('r11 S7: PRs are watched by default when an account is linked', () => {
  for (const variant of VARIANTS) {
    it(`project with a linked account at ${variant.name}: PRs show, only a quiet Stop watching, one PATCH to stop, ticks keep the watch`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        deviceScaleFactor: variant.phone ? 2 : 1,
        hasTouch: variant.phone,
        isMobile: variant.phone,
        colorScheme: variant.scheme,
      });
      const tab = await context.newPage();
      const problems: string[] = [];
      tab.on('pageerror', error => problems.push(error.message));
      await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}&case=default&project=A`);
      await tab.waitForSelector('[data-pull-row]');

      // (a) PR rows with no setup; no watch checkbox; a quiet button, not a full row.
      const measured = await tab.evaluate(() => {
        const labelOf = (input: Element): string => (input.closest('label')?.textContent ?? '').trim();
        const watchBoxes = [...document.querySelectorAll('input[type="checkbox"]')].filter(box =>
          /watch/i.test(labelOf(box)),
        );
        const stops = [...document.querySelectorAll('button')].filter(button =>
          /^Stop watching/.test(button.textContent ?? ''),
        );
        const card = document.querySelector('[data-pulls-project]') as HTMLElement;
        const stop = stops[0] as HTMLElement | undefined;
        return {
          rows: document.querySelectorAll('[data-pull-row]').length,
          watchBoxes: watchBoxes.length,
          stops: stops.length,
          cardWidth: card.getBoundingClientRect().width,
          stopWidth: stop?.getBoundingClientRect().width ?? 0,
          stopHeight: stop?.getBoundingClientRect().height ?? 0,
          stopTop: stop?.getBoundingClientRect().top ?? 0,
          lastRowBottom: Math.max(
            ...[...document.querySelectorAll('[data-pull-row]')].map(row => row.getBoundingClientRect().bottom),
          ),
          text: document.body.innerText.includes('Watch this project'),
          sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      console.log(`S7 measured ${variant.name}: ${JSON.stringify(measured)}`);
      expect(measured.rows).toBeGreaterThanOrEqual(1);
      expect(measured.watchBoxes).toBe(0);
      expect(measured.text).toBe(false);
      expect(measured.stops).toBe(1);
      expect(measured.stopWidth).toBeLessThan(measured.cardWidth * 0.5);
      expect(measured.stopHeight).toBeGreaterThanOrEqual(44);
      // The PRs come first; the control sits after them.
      expect(measured.stopTop).toBeGreaterThan(measured.lastRowBottom);
      expect(measured.sideways).toBeLessThanOrEqual(0);

      // (d) ticking one event sends notify only, and the read after it still has the watch on.
      await tab.locator('[data-pulls-notify] summary').click();
      expect(await tab.locator('[data-pulls-notify-hint]').innerText()).toBe('Pick what should notify your phone.');
      const unticked = await tab
        .locator('[data-pulls-notify-event]')
        .evaluateAll(boxes => boxes.filter(box => (box as HTMLInputElement).checked).length);
      expect(unticked).toBe(0);
      await tab.locator('[data-pulls-notify-event="ciPassed"]').click();
      await tab.waitForFunction(() => (window as unknown as { __patches: unknown[] }).__patches.length === 1);
      await tab.waitForFunction(
        () =>
          (document.querySelector('[data-pulls-notify-event="ciPassed"]') as HTMLInputElement | null)?.checked === true,
      );
      expect(await tab.evaluate(() => (window as unknown as { __patches: unknown[] }).__patches)).toEqual([
        { notify: { ciPassed: true } },
      ]);
      expect(await tab.locator('[data-pulls-stop]').count()).toBe(1);
      expect(await tab.locator('[data-pull-row]').count()).toBeGreaterThanOrEqual(1);

      if (shotsDir !== '') {
        await tab.setViewportSize({ width: variant.width, height: variant.phone ? 2000 : 1100 });
        await tab.screenshot({ path: join(shotsDir, `${variant.name}-default-watched.png`) });
      }

      // (b) Stop: exactly one more PATCH {watch:false}; the rows go; "Watch again" shows.
      await tab.locator('[data-pulls-stop]').click();
      await tab.waitForSelector('[data-pulls-watch-again]');
      expect(await tab.evaluate(() => (window as unknown as { __patches: unknown[] }).__patches)).toEqual([
        { notify: { ciPassed: true } },
        { watch: false },
      ]);
      expect(await tab.locator('[data-pull-row]').count()).toBe(0);
      expect(await tab.locator('[data-pulls-watch-again]').innerText()).toBe('Watch again');
      expect(await tab.locator('[data-pulls-empty="watch-off"]').innerText()).toContain(
        'You stopped watching this project.',
      );
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-default-stopped.png`) });
      expect(problems).toEqual([]);
      await context.close();
    });

    it(`project with NO account at ${variant.name}: no GitHub look at all, and it says to link one`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        deviceScaleFactor: variant.phone ? 2 : 1,
        colorScheme: variant.scheme,
      });
      const tab = await context.newPage();
      await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}&case=default&project=B`);
      await tab.waitForSelector('[data-pulls-empty="no-reader"]');
      expect(await tab.locator('[data-pulls-empty="no-reader"]').innerText()).toContain('Link a GitHub account');
      expect(await tab.locator('[data-pull-row]').count()).toBe(0);
      expect(await tab.locator('[data-pulls-stop]').count()).toBe(0);
      expect(await tab.evaluate(() => (window as unknown as { __reads: Record<string, number> }).__reads)).toEqual({
        '11111111-1111-4111-8111-111111111111': expect.any(Number),
        '22222222-2222-4222-8222-222222222222': 0,
      });
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-default-no-account.png`) });
      await context.close();
    });
  }
});
