/**
 * SETTINGS › CLAUDE CONNECTOR in a real browser, INSIDE the real settings shell, over fake data: at a phone (390) and a
 * desktop (1440), light and dark, in the default style and in the style with the HIGHEST rounding (Neumorphism: 24 px
 * panels, pill controls).
 *
 * The owner's rule under test: content never meets a rounded corner. For every box with a rounded corner, no text, icon,
 * button or code line of the tab may sit where the corner has been cut away. Nothing scrolls sideways; every control is a
 * 44 px target on a phone; the match code is the largest thing in its card.
 *
 * Set `FY_CONNECTOR_SHOTS_DIR` to keep `<viewport>-<scheme>-<style>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CONNECTOR_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-connector-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/connector-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the connector scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(built.css, 'utf8');
  const js = await readFile(built.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

/** The default style, and the one whose corners are rounded the most (panels 24 px, controls pills). */
const STYLES = ['studio', 'neumorphism'] as const;
const STATES = ['off', 'on', 'tunnel', 'pending', 'apps'] as const;

const open = async (
  viewport: Viewport,
  scheme: 'light' | 'dark',
  style: string,
  state: string,
  query = '',
  drawn = '[data-settings="connector"] [data-setting-group]',
) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    colorScheme: scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(`${origin}/d/ws/settings/connector?theme=studio-${scheme}&state=${state}${query}`);
  try {
    await page.waitForSelector(drawn);
  } catch (error) {
    const seen = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 600);
    throw new Error(`the connector tab did not draw: ${String(error)}\n${problems.join('\n')}\nON SCREEN: ${seen}`);
  }
  // The shell publishes its own look once at mount; the scene then puts the style under test on the root.
  await page.evaluate(value => document.documentElement.setAttribute('data-style', value), style);
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
  });
  await page.waitForTimeout(250);
  return { page, problems, close: async () => await context.close() };
};

const shoot = async (page: Page, viewport: Viewport, scheme: string, style: string, name: string): Promise<void> => {
  if (shotsDir === '') return;
  const content = await page.evaluate(
    () => document.querySelector('[data-settings="connector"]')?.getBoundingClientRect().bottom ?? 0,
  );
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(content) + 80) });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${style}-${name}.png`), fullPage: true });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
};

/**
 * Content that sits where a rounded corner has been cut away. Runs in the page: for every box in `root` with a rounded
 * corner, each text run, icon, button and code line inside it must lie within the shape (the corner's circle, the radius
 * clamped as the browser does). Text and controls are measured, not the boxes that merely fill a card edge to edge.
 */
const cornerViolations = async (page: Page, root: string): Promise<readonly string[]> =>
  await page.evaluate(selector => {
    const scope = selector === '' ? document.body : document.querySelector(selector);
    if (scope === null) return ['no scope'];
    const out: string[] = [];
    const contents = (box: Element): DOMRect[] => {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === '') continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push(rect);
      }
      for (const control of box.querySelectorAll('button, svg, input, img, code, [role="switch"]')) {
        if (control.closest('.sr-only') !== null) continue;
        const rect = control.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) rects.push(rect);
      }
      return rects;
    };
    const outside = (cx: number, cy: number, r: number, x: number, y: number): boolean =>
      Math.hypot(x - cx, y - cy) > r + 0.75;
    for (const box of [scope, ...scope.querySelectorAll('*')]) {
      if (box.closest('.sr-only') !== null) continue;
      const style = getComputedStyle(box);
      const edge = box.getBoundingClientRect();
      if (edge.width === 0 || edge.height === 0) continue;
      const half = Math.min(edge.width, edge.height) / 2;
      const radius = (value: string): number => Math.min(Number.parseFloat(value) || 0, half);
      const tl = radius(style.borderTopLeftRadius);
      const tr = radius(style.borderTopRightRadius);
      const br = radius(style.borderBottomRightRadius);
      const bl = radius(style.borderBottomLeftRadius);
      if (Math.max(tl, tr, br, bl) < 4) continue;
      // A box that clips nothing and is itself only an icon or control does not hold other content.
      const inner = contents(box).filter(rect => {
        // The box's own control rect (a button is its own content) is not content OF the box.
        const same =
          Math.abs(rect.left - edge.left) < 0.5 &&
          Math.abs(rect.right - edge.right) < 0.5 &&
          Math.abs(rect.top - edge.top) < 0.5 &&
          Math.abs(rect.bottom - edge.bottom) < 0.5;
        return !same;
      });
      for (const rect of inner) {
        // Only content that reaches into a corner square can be cut by it.
        const checks: [number, number, number, number][] = [
          [edge.left + tl, edge.top + tl, rect.left, rect.top],
          [edge.right - tr, edge.top + tr, rect.right, rect.top],
          [edge.right - br, edge.bottom - br, rect.right, rect.bottom],
          [edge.left + bl, edge.bottom - bl, rect.left, rect.bottom],
        ];
        const radii = [tl, tr, br, bl];
        const inCorner = [
          rect.left < edge.left + tl && rect.top < edge.top + tl,
          rect.right > edge.right - tr && rect.top < edge.top + tr,
          rect.right > edge.right - br && rect.bottom > edge.bottom - br,
          rect.left < edge.left + bl && rect.bottom > edge.bottom - bl,
        ];
        checks.forEach(([cx, cy, x, y], index) => {
          if (inCorner[index] === true && outside(cx, cy, radii[index] ?? 0, x, y)) {
            const name = `${box.tagName.toLowerCase()}${box.getAttribute('data-setting-group') ? `[${box.getAttribute('data-setting-group')}]` : ''}.${String(box.className).slice(0, 36)}`;
            out.push(
              `${name} corner ${index} r=${Math.round(radii[index] ?? 0)} content ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
            );
          }
        });
      }
    }
    return out.slice(0, 12);
  }, root);

const overflowing = async (page: Page): Promise<readonly string[]> =>
  await page.evaluate(() => {
    const panel = document.querySelector('[data-settings="connector"]');
    if (panel === null) return ['no panel'];
    const edge = panel.getBoundingClientRect();
    const out: string[] = [];
    for (const element of panel.querySelectorAll<HTMLElement>('*')) {
      if (element.closest('.sr-only') !== null) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > edge.right + 1 || box.left < edge.left - 1)
        out.push(
          `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)} ${Math.round(box.left)}..${Math.round(box.right)} vs ${Math.round(edge.left)}..${Math.round(edge.right)}`,
        );
    }
    return out.slice(0, 8);
  });

describe('Settings › Claude connector, in the real settings shell', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const style of STYLES)
        for (const state of STATES)
          it(`${state}: nothing sticks out and no content meets a rounded corner (${viewport.name}, ${scheme}, ${style})`, async () => {
            const { page, problems, close } = await open(viewport, scheme, style, state);
            try {
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
              expect(await overflowing(page), 'nothing sticks out of the panel').toEqual([]);
              expect(
                await cornerViolations(page, '[data-settings="connector"]'),
                'content meets a rounded corner',
              ).toEqual([]);
              expect(problems).toEqual([]);
              // The switch is the first control: its name and the state it is in are said, and it is a 44 px target.
              const control = page.locator('[data-settings="connector"] [role="switch"]');
              expect(await control.getAttribute('aria-checked')).toBe(state === 'off' ? 'false' : 'true');
              const box = await control.boundingBox();
              expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
              expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
              if (state === 'pending') {
                expect(await page.locator('[data-connector-match-code]').innerText()).toBe('K7Q-2MF');
                for (const name of ['approve', 'deny']) {
                  const button = await page.locator(`[data-connector-${name}]`).boundingBox();
                  expect(button?.height ?? 0, `${name} is a 44 px target`).toBeGreaterThanOrEqual(43.5);
                }
              }
              if (state === 'on')
                expect(await page.locator('[data-connector-url]').innerText()).toBe('https://ferretry.example/mcp');
              await shoot(page, viewport, scheme, style, state);
            } finally {
              await close();
            }
          });

  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const style of STYLES)
        it(`the revoke dialog keeps its words off its corners (${viewport.name}, ${scheme}, ${style})`, async () => {
          const { page, problems, close } = await open(viewport, scheme, style, 'apps');
          try {
            await page.click('[data-connector-revoke="cg_abcde23456"]');
            await page.waitForSelector('[role="dialog"]');
            await page.waitForTimeout(300);
            expect(await page.locator('[role="dialog"]').innerText()).toContain('stops working on its very next call');
            expect(await cornerViolations(page, '[role="dialog"]'), 'dialog content meets a rounded corner').toEqual(
              [],
            );
            const panel = await page.locator('[role="dialog"]').boundingBox();
            expect((panel?.x ?? -1) >= 0 && (panel?.x ?? 0) + (panel?.width ?? 0) <= viewport.width).toBe(true);
            expect(problems).toEqual([]);
            if (shotsDir !== '')
              await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${style}-revoke.png`) });
          } finally {
            await close();
          }
        });

  // A daemon built BEFORE the connector existed lists no connector, so the shell's inventory gate blocks the tab before the
  // tab can ask the daemon anything. The shell's own line must then say what is true and what to run.
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const style of STYLES)
        it(`a daemon older than the connector says to update it, with the command (${viewport.name}, ${scheme}, ${style})`, async () => {
          const { page, problems, close } = await open(viewport, scheme, style, 'predates', '', '.fy-shell-line');
          try {
            const line = page.locator('.fy-shell-line').first();
            const said = await line.innerText();
            expect(said).toContain('older than this app');
            expect(said).toContain('fy update');
            expect(said).not.toContain('not available to this device');
            expect(await page.locator('[data-settings="connector"]').count(), 'the gate stays shut').toBe(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            const box = await line.boundingBox();
            expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= viewport.width).toBe(true);
            expect(await cornerViolations(page, '.fy-shell-line'), 'the line meets a rounded corner').toEqual([]);
            expect(problems).toEqual([]);
            if (shotsDir !== '')
              await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${style}-predates.png`) });
          } finally {
            await close();
          }
        });

  it('the corner probe really sees content that meets a rounded corner (so a pass means something)', async () => {
    const { page, close } = await open(VIEWPORTS[1], 'light', 'studio', 'off');
    try {
      await page.evaluate(() => {
        const box = document.createElement('div');
        box.id = 'probe-box';
        box.style.cssText = 'border-radius:24px;border:1px solid red;width:200px;padding:0;margin:8px';
        box.textContent = 'corner text';
        document.body.append(box);
      });
      expect((await cornerViolations(page, '#probe-box')).length).toBeGreaterThan(0);
      await page.evaluate(() => {
        const box = document.getElementById('probe-box') as HTMLElement;
        box.style.padding = '16px 24px';
      });
      expect(await cornerViolations(page, '#probe-box')).toEqual([]);
    } finally {
      await close();
    }
  });

  it('puts the sign-in the waiting page’s link named in view (a link with ?request=)', async () => {
    const { page, close } = await open(VIEWPORTS[0], 'light', 'studio', 'pending', '&request=cr_abcde23456');
    try {
      expect(await page.locator('[data-connector-pending="cr_abcde23456"][data-focused]').count()).toBe(1);
    } finally {
      await close();
    }
  });
});
