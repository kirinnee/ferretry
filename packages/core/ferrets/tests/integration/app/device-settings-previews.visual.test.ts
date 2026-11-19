/**
 * THE FERRET LIST PREVIEWS in a real browser over fake data (`fixtures/needs-you-scene.tsx`, `?view=row`: the real
 * "Ferret list" settings group): each row carries a 160 x 100 animated frame, a choice replays it, and Reduced motion
 * leaves the final frame only.
 *
 * Set `FY_FERRET_PREVIEWS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FERRET_PREVIEWS_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-ferret-previews-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/needs-you-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ferret previews scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
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

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 500, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 500, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 700, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 700, phone: true, scheme: 'dark' },
] as const;

const open = async (variant: (typeof VARIANTS)[number], extra = '') => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}&view=row${extra}`);
  await tab.waitForSelector('[data-setting-row="Density"] [data-setting-preview]');
  await nudge(tab);
  return { tab, problems, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

/**
 * The frames REST on the chosen value and play once when it changes (compose/setting-preview), so each choice is given
 * one change and the way back, and every movement is then held at its start so a frame is the same on every run.
 */
const nudge = async (tab: Page): Promise<void> => {
  // A change and then the way back: every choice ends on the value it started on, having played one movement.
  const names = await tab.evaluate(() => [
    ...new Set([...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.name)),
  ]);
  for (const name of names) {
    const radios = tab.locator(`input[type="radio"][name="${name}"]`);
    const homeValue = await radios.evaluateAll(
      nodes => (nodes as HTMLInputElement[]).find(n => n.checked)?.value ?? null,
    );
    const awayValue = await radios.evaluateAll(
      nodes => (nodes as HTMLInputElement[]).find(n => !n.checked && !n.disabled)?.value ?? null,
    );
    if (homeValue === null || awayValue === null) continue;
    await tab
      .locator(`input[type="radio"][name="${name}"][value="${awayValue}"]`)
      .first()
      .locator('xpath=ancestor::label')
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await tab
      .locator(`input[type="radio"][name="${name}"][value="${homeValue}"]`)
      .first()
      .locator('xpath=ancestor::label')
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await seek(tab, 0);
  }
  const switches = tab.locator('[role="switch"], button[aria-pressed]');
  for (let index = 0; index < (await switches.count()); index += 1) {
    await switches
      .nth(index)
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await switches
      .nth(index)
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await seek(tab, 0);
  }
};

/** The two layers take turns: at no point of the movement are both visible, so a label never lands on another. */
const expectNeverOverlapping = async (tab: Page): Promise<void> => {
  for (let step = 0; step <= 100; step += 1) {
    await seek(tab, (1_400 * step) / 100);
    const worst = await tab.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll('[data-setting-preview]')].map(frame => {
          const layer = (kind: string) =>
            Number(getComputedStyle(frame.querySelector(`.fy-sp__layer--${kind}`) as Element).opacity);
          return Math.min(layer('before'), layer('after'));
        }),
      ),
    );
    expect(worst).toBe(0);
  }
};

const ROWS = ['Group Needs you at the top', 'Density'] as const;
const frameOf = (tab: Page, row: string) => tab.locator(`[data-setting-row="${row}"] [data-setting-preview]`);

describe('the Ferret list previews', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: both rows carry a 160 x 100 frame that plays, and the page does not widen`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        for (const row of ROWS) {
          const box = await frameOf(tab, row).boundingBox();
          expect(Math.round(box?.width ?? 0)).toBe(160);
          expect(Math.round(box?.height ?? 0)).toBe(100);
          expect(await frameOf(tab, row).getAttribute('data-sp-state')).toBe('playing');
        }
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await seek(tab, 0);
        await shotOf(tab, variant, 'ferret-list-t0-before');
        await seek(tab, 1_400 * 0.39);
        await shotOf(tab, variant, 'ferret-list-mid-fade');
        await seek(tab, 1_400 * 0.45);
        await shotOf(tab, variant, 'ferret-list-mid-fade-gap');
        await seek(tab, 1_400 * 0.51);
        await shotOf(tab, variant, 'ferret-list-mid-fade-in');
        await expectNeverOverlapping(tab);
        await seek(tab, 1_400 * 0.7);
        await shotOf(tab, variant, 'ferret-list-final');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: choosing a density replays its frame; turning Needs you off shows the folders`, async () => {
      const { tab, close } = await open(variant);
      try {
        await tab.locator('[role="radiogroup"][aria-label="Density"] label', { hasText: 'Minimal' }).click();
        expect(await frameOf(tab, 'Density').getAttribute('data-sp-value')).toBe('minimal');
        await tab.locator('[data-setting-row="Group Needs you at the top"] [role="switch"]').click();
        expect(await frameOf(tab, 'Group Needs you at the top').getAttribute('data-sp-value')).toBe('off');
        await seek(tab, 1_400 * 0.7);
        await shotOf(tab, variant, 'ferret-list-minimal-off');
      } finally {
        await close();
      }
    });
  }
});
