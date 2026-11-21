/**
 * THE THREE USAGE SETTINGS TABS in a real browser over fake data, INSIDE THE REAL SETTINGS SHELL
 * (`fixtures/usage-settings-register.tsx` over the app's `settings-shell-scene.tsx`: the real App, its default drawer and Settings nav). Each draws its groups and
 * rows with no card inside a group, every button at least 44px tall, and — measured against the PANEL the shell leaves the
 * tab, not the document (which stays 0 when a panel clips) — every text and control box inside that panel with nothing
 * overlapping, at 768, 1024, 1280 and 390. A 768px window leaves a 212px panel, which is the case a standalone mount hid.
 *
 * Set `FY_USAGE_SETTINGS_SHOTS_DIR` to keep `<viewport>-<case>.png` (768, 1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_USAGE_SETTINGS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-usage-settings-'));
  // The entry is generated, so the plugin reaches the app's scene by a path and never by an import: the register module puts the
  // real pages on the scene's body registry, THEN imports the app's shell scene (which reads it once; a plain side-effect import would
  // be dropped by this package's `sideEffects: false`).
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerUsageSettingsBodies } from ${JSON.stringify(resolve(packageRoot, 'fixtures/usage-settings-register.tsx'))};\nregisterUsageSettingsBodies();\nawait import(${JSON.stringify(resolve(packageRoot, '../../../../../app/tests/integration/fixtures/settings-shell-scene.tsx'))});\n`,
  );
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the usage settings scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
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
  { name: '768-light', width: 768, height: 2_400, phone: false, scheme: 'light' },
  { name: '768-dark', width: 768, height: 2_400, phone: false, scheme: 'dark' },
  { name: '1024-light', width: 1_024, height: 2_400, phone: false, scheme: 'light' },
  { name: '1280-light', width: 1_280, height: 2_400, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 2_400, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 2_400, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 2_400, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const CASES = [
  { name: 'budgets', query: '&tab=budgets', ready: '[data-budget-editor]' },
  { name: 'pricing', query: '&tab=pricing', ready: '[data-pricing-row]' },
  { name: 'pricing-add', query: '&tab=pricing&act=add', ready: '[data-pricing-editor]' },
  { name: 'pricing-feed', query: '&tab=pricing&act=feed', ready: '[data-pricing-change]' },
  { name: 'performance', query: '&tab=performance', ready: '[data-performance]' },
  { name: 'performance-report', query: '&tab=performance&act=record', ready: '[data-performance-report]' },
] as const;

/** Runs in the page: every way the settings panel clips, wraps badly or overlaps, as short sentences. */
const panelProblems = (): string[] => {
  const panel = document.querySelector<HTMLElement>('.fy-settings-page');
  if (panel === null) return ['the real Settings panel (.fy-settings-page) is not on the page'];
  const bounds = panel.getBoundingClientRect();
  const problems: string[] = [];
  const name = (el: Element): string => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
  if (panel.scrollWidth - panel.clientWidth > 0)
    problems.push(`the panel scrolls sideways by ${String(panel.scrollWidth - panel.clientWidth)}px`);
  const shown = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  };
  const leaves = [...panel.querySelectorAll('*')].filter(
    el =>
      shown(el) &&
      (['BUTTON', 'INPUT', 'SELECT'].includes(el.tagName) ||
        (el.children.length === 0 && (el.textContent ?? '').trim() !== '' && el.tagName !== 'svg')),
  );
  for (const el of leaves) {
    const rect = el.getBoundingClientRect();
    if (rect.right > bounds.right + 1 || rect.left < bounds.left - 1)
      problems.push(
        `"${name(el)}" is ${String(Math.round(Math.max(rect.right - bounds.right, bounds.left - rect.left)))}px outside the panel`,
      );
    // A path scrolls in its own box (`PanelPath`) and a one-line hint ends in an ellipsis with its text in a title: both keep their
    // value. Anything else whose text is wider than its box and hidden is clipped.
    const style = getComputedStyle(el);
    if (
      el.scrollWidth > el.clientWidth + 1 &&
      el.clientWidth > 0 &&
      (style.overflowX === 'hidden' || style.overflowX === 'clip') &&
      style.textOverflow !== 'ellipsis'
    )
      problems.push(`"${name(el)}" is clipped inside its own box`);
  }
  for (const row of panel.querySelectorAll('li')) {
    const inRow = leaves.filter(el => row.contains(el) && el.closest('li') === row);
    for (const [i, a] of inRow.entries())
      for (const b of inRow.slice(i + 1)) {
        // A button and the words inside it (a select box's shown value) are one control, not two that overlap.
        if (a.contains(b) || b.contains(a)) continue;
        // Line boxes, not the bounding box: a date that wraps mid-sentence spans two lines but covers nothing between them.
        const touching = [...a.getClientRects()].some(x =>
          [...b.getClientRects()].some(
            y =>
              Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 &&
              Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1,
          ),
        );
        if (touching) problems.push(`"${name(a)}" overlaps "${name(b)}"`);
      }
  }
  return problems;
};

const open = async (variant: Variant, query: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(12_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  const tabId = query.includes('tab=pricing')
    ? 'model-pricing'
    : query.includes('tab=performance')
      ? 'performance'
      : 'budgets';
  await tab.goto(`${origin}/d/ws/settings/usage/${tabId}?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector(ready);
  return { tab, problems, close: async () => await context.close() };
};

describe('the Usage settings tabs', () => {
  for (const variant of VARIANTS) {
    for (const scene of CASES) {
      it(`${variant.name} · ${scene.name}: grouped rows, no card in a group, no sideways scroll, tall buttons`, async () => {
        const { tab, problems, close } = await open(variant, scene.query, scene.ready);
        try {
          if (shotsDir !== '')
            await tab.screenshot({ fullPage: true, path: join(shotsDir, `${variant.name}-${scene.name}.png`) });
          expect(await tab.locator('[data-setting-group]').count(), 'at least one group').toBeGreaterThan(0);
          expect(await tab.locator('.kt-groupcard .kt-panel').count(), 'no card inside a group').toBe(0);
          expect(
            await tab.evaluate(panelProblems),
            'every text and control is inside the panel, nothing overlaps',
          ).toEqual([]);
          const short = await tab.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('.fy-settings-page button:not([disabled])')]
              .filter(button => button.offsetParent !== null && button.getBoundingClientRect().height < 43)
              .map(button => button.textContent?.trim() ?? ''),
          );
          expect(short, 'every visible button is at least 44px tall').toEqual([]);
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }
});
