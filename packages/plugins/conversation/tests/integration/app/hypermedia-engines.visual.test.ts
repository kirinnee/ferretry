/**
 * WHAT A MESSAGE FETCHES, in real Chromium, on the build a page is given (r12 H8 fix). The scene is built by the app shell's own
 * Vite with the Durian plugin (`tests/support/vite-scene.ts`), served under the app's real `Content-Security-Policy`, and one
 * assistant message is drawn at a time. The request ledger is the claim:
 *
 *   a plain message       fetches no animation engine, no 3D stage, no Chart.js;
 *   a held ```chart fence  is shown as code (its source on the page, no canvas) and fetches no Chart.js: the evaluator and the
 *                          chart library are not in the build at all, so there is nothing to fetch;
 *   an ```animation fence  fetches the 2D engine chunk (and not the 3D stage), draws the stage, and the page has 0 policy
 *                          violations, 0 uncaught errors.
 *
 * Set `FY_HYPERMEDIA_SHOTS_DIR` to keep `engines-<viewport>-<scheme>.png` of a message with the 2D animation and a part: the pictures
 * the fix is judged on (390 and 1280 wide, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from '@ferretry/app/testing/browser';
import { buildViteScene, type ViteScene } from '../../support/vite-scene.ts';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_HYPERMEDIA_SHOTS_DIR ?? '';
const FENCE = '`'.repeat(3);
const fence = (info: string, ...body: readonly string[]): string => [`${FENCE}${info}`, ...body, FENCE].join('\n');

const PLAIN = 'A plain assistant message, with `code` and a [link](https://example.com).';
const CHART = fence(
  'chart',
  'kind: line',
  'x: { label: step, values: [1, 2, 3] }',
  'series:',
  '  - name: calls',
  '    data: [1, 2, 3]',
);
const ANIMATION = fence(
  'animation',
  'array a: 5 2 8 1',
  'pointer i "i" at a.0',
  '@step Bubble sort compares neighbours. 5 and 2 are out of order.',
  'highlight a.0 a.1',
  '@step So they swap: 2 now comes first.',
  'swap a.0 a.1',
);
/** The picture's message: the 2D animation beside parts that read the YAML-free parsers (a terminal, a tier list, tabs). */
const SHOWCASE = [
  'Here is the sort, and the commands I ran.',
  ANIMATION,
  fence('terminal', '$ bun test', '12 pass, 0 fail'),
  fence('tierlist', 'S: [parser, scene]', 'A: [chart held]'),
  [':::tabs', '#### Node', 'npm i', '#### Python', 'pip install', ':::'].join('\n'),
].join('\n\n');

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

let browser: Browser;
let scene: ViteScene;
let server: ReturnType<typeof Bun.serve> | undefined;
let origin = '';
const ledger: string[] = [];
/** The built files that hold the 2D engine, the 3D stage and Chart.js, found by what they contain, not by their names. */
let engineFile = '';
let threeFile = '';
const chartFiles: string[] = [];

const text = (file: string | Blob | undefined): string => (typeof file === 'string' ? file : '');

beforeAll(async () => {
  browser = await sharedChromium();
  const headers = await readFile(resolve(packageRoot, '../../../../../app/public/_headers'), 'utf8');
  const policy =
    headers
      .split('\n')
      .find(line => line.trim().startsWith('Content-Security-Policy:'))
      ?.trim()
      .slice('Content-Security-Policy:'.length)
      .trim() ?? '';
  if (!policy.includes("require-trusted-types-for 'script'")) throw new Error('the real policy lost Trusted Types');
  scene = await buildViteScene();
  const fixture = await fyRenderIntegrationFixture();
  const css = `${fixture.appCss}\n${SCENE_CSS}`;
  for (const [name, file] of scene.files) {
    if (!name.endsWith('.js')) continue;
    const code = text(file);
    if (code.includes('WebGLRenderer')) threeFile = name;
    else if (/scn-mode/u.test(code) && name !== 'scene.js' && name !== 'first.js') engineFile = name;
    if (code.includes('Chart.js v')) chartFiles.push(name);
  }
  const sheets = scene.styles.map(name => `<link rel="stylesheet" href="/${name}">`).join('');
  const page = `<!doctype html><html lang="en" data-theme="studio-light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css">${sheets}</head><body class="bg-bg text-fg"><div id="root"></div>${scene.scripts.map(name => `<script type="module" src="/${name}"></script>`).join('')}</body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      ledger.push(path);
      const secured = (body: string | Blob, type: string): Response =>
        new Response(body, { headers: { 'content-security-policy': policy, 'content-type': type } });
      if (path === '/') return secured(page, 'text/html; charset=utf-8');
      if (path === '/app.css') return secured(css, TYPES['.css'] ?? '');
      const built = scene.files.get(path.slice(1));
      return built === undefined
        ? new Response('not here', { status: 404 })
        : secured(built, TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream');
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 280_000);

afterAll(async () => {
  await server?.stop(true);
});

/** Opens the scene on one message and lets it settle; returns what the page reports. */
const show = async (
  body: string,
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly theme?: string;
    readonly palette?: string;
    readonly page?: (page: Page) => Promise<void>;
  } = {},
) => {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: options.width ?? 1_280, height: options.height ?? 900 },
  });
  await context.addInitScript(() => {
    const found = { csp: [] as string[], errors: [] as string[] };
    Object.assign(window, { fyFound: found });
    document.addEventListener('securitypolicyviolation', event =>
      found.csp.push(`${event.effectiveDirective} ${event.sourceFile}:${event.lineNumber}`),
    );
    window.addEventListener('error', event => found.errors.push(event.message));
  });
  const page = await context.newPage();
  ledger.length = 0;
  await page.goto(
    `${origin}/?theme=${options.theme ?? 'studio-light'}&palette=${options.palette ?? 'studio'}&text=${encodeURIComponent(body)}`,
  );
  await page.waitForFunction(() => (window as unknown as { fyPartsReady?: boolean }).fyPartsReady === true, undefined, {
    timeout: 30_000,
  });
  await page.waitForTimeout(1_500);
  await options.page?.(page);
  const found = await page.evaluate(
    () => (window as unknown as { fyFound: { csp: string[]; errors: string[] } }).fyFound,
  );
  const state = await page.evaluate(() => ({
    stages: document.querySelectorAll('.dh-doc .scn').length,
    canvases: document.querySelectorAll('canvas').length,
    shown: [...document.querySelectorAll('.dh-doc pre, .dh-doc code')]
      .map(element => element.textContent ?? '')
      .join('\n'),
  }));
  const requested = [...ledger];
  return { page, context, found, state, requested };
};

const fetched = (requested: readonly string[], file: string): boolean => requested.includes(`/${file}`);

describe('what a message fetches', () => {
  it('finds the engine, the 3D stage and (nowhere) Chart.js in the build', () => {
    expect(engineFile).not.toBe('');
    expect(threeFile).not.toBe('');
    expect(engineFile).not.toBe(threeFile);
    // The evaluator and the chart library are not shipped: there is no chart file to fetch.
    expect(chartFiles).toEqual([]);
  });

  it('a plain message fetches no animation engine, no 3D stage', async () => {
    const { context, found, requested } = await show(PLAIN);
    await context.close();
    expect(fetched(requested, engineFile)).toBe(false);
    expect(fetched(requested, threeFile)).toBe(false);
    expect(found).toEqual({ csp: [], errors: [] });
  }, 90_000);

  it('a held chart is its source as code, with no chart drawn and nothing chart-shaped fetched', async () => {
    const { context, found, state, requested } = await show(CHART);
    await context.close();
    expect(state.shown).toContain('kind: line');
    expect(state.canvases).toBe(0);
    expect(fetched(requested, engineFile)).toBe(false);
    expect(fetched(requested, threeFile)).toBe(false);
    expect(found).toEqual({ csp: [], errors: [] });
  }, 90_000);

  // r12 H11a: an animation is held as code until the parser runs off the main thread (`ANIMATION_DRAWS`), so it fetches
  // no engine. The test that it fetches the 2D engine and draws returns with the flag.
  it('an animation is its source as code (r12 H11a): no engine, no 3D stage, no stage drawn, with 0 violations', async () => {
    const { context, found, state, requested } = await show(ANIMATION);
    await context.close();
    expect(state.shown).toContain('array a: 5 2 8 1');
    expect(fetched(requested, engineFile)).toBe(false);
    expect(fetched(requested, threeFile)).toBe(false);
    expect(state.stages).toBe(0);
    expect(state.canvases).toBe(0);
    expect(found).toEqual({ csp: [], errors: [] });
  }, 90_000);
});

/** A scene that OPENS in 3D: boxes on three layers, a toned one and a muted one among them, so the stage draws its edges. */
const THREE_D = fence(
  'animation 3d',
  'layer app "application"',
  'layer tcp "TCP"',
  'layer link "link"',
  'box a1 "browser" layer=app',
  'box b1 "web server" layer=app tone=acc',
  'box a2 "segments" layer=tcp',
  'box b2 "segments" layer=tcp tone=good',
  'box a3 "Wi-Fi" layer=link tone=muted',
  'box b3 "Ethernet" layer=link tone=warn',
  'a1 -> a2 -> a3',
  'b3 -> b2 -> b1',
  '@step Each machine has the same layers; a request goes down one stack and up the other.',
  'split layers',
  '@step TCP talks only to TCP on the other machine.',
  'highlight a2 b2',
);

// r12 H11a: skipped while animations are held as code (`ANIMATION_DRAWS` is false); re-enabled with the flag.
describe.skip('the 3D picture (end-list L145: its edges read in dark as well as light)', () => {
  for (const [width, height, label] of [
    [390, 900, '390'],
    [1_280, 900, '1280'],
  ] as const)
    for (const theme of ['light', 'dark'] as const)
      it(`${label} ${theme}: opens the 3D stage on a WebGL canvas and fetches the 3D chunk only for it`, async () => {
        const { context, page, found, state, requested } = await show(THREE_D, {
          width,
          height,
          theme: `studio-${theme}`,
        });
        await page.waitForTimeout(1_500);
        if (shotsDir !== '') {
          await mkdir(shotsDir, { recursive: true });
          await page.screenshot({ path: join(shotsDir, `edges-3d-${label}-${theme}.png`), fullPage: false });
        }
        const canvases = await page.evaluate(() => document.querySelectorAll('.scn3 canvas').length);
        // THE PIXELS: the stage's own picture with its word labels hidden, read back from a real screenshot of the stage
        // (the WebGL buffer is not readable). An edge is a pixel the stage's ground does not already hold: count those at
        // >= 3:1 against it, the floor for a graphic.
        await page.addStyleTag({ content: '.scn3-labels{display:none !important}' });
        const stage = await page.locator('.scn-stage').first().screenshot();
        const { edgePixels, whitePixels } = await page.evaluate(async (base64: string) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
          g.drawImage(image, 0, 0);
          const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
          const lum = (r: number, gr: number, b: number): number => {
            const f = (v: number): number => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * f(r) + 0.7152 * f(gr) + 0.0722 * f(b);
          };
          // The ground: the stage's most common pixel (a flat colour over most of it).
          const seen = new Map<number, number>();
          for (let at = 0; at < data.length; at += 4) {
            const key = ((data[at] as number) << 16) | ((data[at + 1] as number) << 8) | (data[at + 2] as number);
            seen.set(key, (seen.get(key) ?? 0) + 1);
          }
          const [ground] = [...seen.entries()].sort((a, b) => b[1] - a[1])[0] as [number, number];
          const back = lum((ground >> 16) & 255, (ground >> 8) & 255, ground & 255);
          let count = 0;
          let white = 0;
          for (let at = 0; at < data.length; at += 4) {
            const own = lum(data[at] as number, data[at + 1] as number, data[at + 2] as number);
            if (own > 0.85) white += 1;
            const [hi, lo] = own > back ? [own, back] : [back, own];
            if ((hi + 0.05) / (lo + 0.05) >= 3) count += 1;
          }
          return { edgePixels: count, whitePixels: white };
        }, stage.toString('base64'));
        await context.close();
        expect(canvases).toBe(1);
        // Measured on this build (dark, the owner's case: ~23,000 at 390 and ~39,000 at 1280 after the fix, ~17,000 and
        // ~30,000 before; light ~850 and ~1,250 either way, where the edges were already strong). The floor only says the
        // stage drew shapes the ground does not already hold; the per-pair 3:1 proof is `hypermedia-3d-edges.visual.test.ts`.
        expect(edgePixels).toBeGreaterThan(400);
        // THE WHITE FALLBACK (r2 review): a token three.js cannot parse draws white. On a dark stage nothing is white once the
        // labels are hidden; before the stage colours were resolved to plain rgb, every mixed edge and soft fill was.
        if (theme === 'dark') expect(whitePixels).toBe(0);
        expect(fetched(requested, threeFile)).toBe(true);
        expect(state.stages).toBeGreaterThan(0);
        expect(found).toEqual({ csp: [], errors: [] });
      }, 90_000);
});

/** A 3D scene with all eight families, so every `--c1`..`--c8` edge is on the stage (the 5th and 7th are the palettes' palest). */
const FAMILIES = ['fam1', 'fam2', 'fam3', 'fam4', 'fam5', 'fam6', 'fam7', 'fam8'] as const;
const THREE_D_FAMILIES = fence(
  'animation 3d',
  ...FAMILIES.map(name => `family ${name} "${name}"`),
  ...FAMILIES.map((name, at) => `box ${name[0]}${at} "${name}" is=${name}`),
  '@step Eight families, one colour each.',
);

// r12 H11a: skipped while animations are held as code (`ANIMATION_DRAWS` is false); re-enabled with the flag.
describe.skip('the family colours on the 3D stage (r2 review: every family edge >= 3:1 on its tint, light and dark)', () => {
  for (const palette of ['briefing', 'vintage'] as const)
    for (const [width, height, label] of [
      [390, 900, '390'],
      [1_280, 900, '1280'],
    ] as const)
      for (const theme of ['light', 'dark'] as const)
        it(`${palette} ${label} ${theme}: the eight family boxes draw on a WebGL canvas`, async () => {
          const { context, page, found, state } = await show(THREE_D_FAMILIES, {
            width,
            height,
            theme: `studio-${theme}`,
            palette,
          });
          await page.waitForTimeout(1_500);
          if (shotsDir !== '') {
            await mkdir(shotsDir, { recursive: true });
            await page.screenshot({
              path: join(shotsDir, `families-3d-${palette}-${label}-${theme}.png`),
              fullPage: false,
            });
          }
          const canvases = await page.evaluate(() => document.querySelectorAll('.scn3 canvas').length);
          await context.close();
          expect(canvases).toBe(1);
          expect(state.stages).toBeGreaterThan(0);
          expect(found).toEqual({ csp: [], errors: [] });
        }, 90_000);
});

describe('the pictures: the held animation and tabs beside the parts that draw', () => {
  for (const [width, height, label] of [
    // Tall enough for the whole message (the log opens scrolled to its end, so the first lines would be cut off).
    [390, 1_900, '390'],
    [1_280, 1_300, '1280'],
  ] as const)
    for (const theme of ['light', 'dark'] as const)
      it(`${label} ${theme}: shows the animation and the tabs as code, and draws the parts beside them`, async () => {
        const { context, page, found, state } = await show(SHOWCASE, { width, height, theme: `studio-${theme}` });
        if (shotsDir !== '') {
          await mkdir(shotsDir, { recursive: true });
          await page.screenshot({ path: join(shotsDir, `engines-${label}-${theme}.png`), fullPage: false });
        }
        await context.close();
        expect(state.stages).toBe(0);
        expect(state.shown).toContain(':::tabs');
        expect(state.shown).toContain('array a: 5 2 8 1');
        expect(found).toEqual({ csp: [], errors: [] });
      }, 90_000);
});

/** A message over a pre-parse limit (fake data: a reading list of 60 links, all one paragraph). */
const LIMITED = [
  'A reading list, as one paragraph:',
  Array.from({ length: 60 }, (_, at) => `[item ${at + 1}](https://example.com/${at + 1})`).join(' '),
].join('\n');

describe('the plain-text fallback of a message over a pre-parse limit (r12 H11a)', () => {
  for (const [width, height, label] of [
    // Tall enough for the whole message (the log opens scrolled to its end, so the note would be cut off).
    [390, 1_900, '390'],
    [1_280, 900, '1280'],
  ] as const)
    for (const theme of ['light', 'dark'] as const)
      it(`${label} ${theme}: shows the message as text under its note, draws nothing, with 0 violations`, async () => {
        const { context, page, found } = await show(LIMITED, { width, height, theme: `studio-${theme}` });
        if (shotsDir !== '') {
          await mkdir(shotsDir, { recursive: true });
          await page.screenshot({ path: join(shotsDir, `plain-${label}-${theme}.png`), fullPage: false });
        }
        const drawn = await page.evaluate(() => ({
          note: document.querySelector('[data-fy-plain-note]')?.textContent ?? null,
          text: document.querySelector('pre.fy-hm-plain')?.textContent ?? '',
          links: document.querySelectorAll('.fy-hm a').length,
          docs: document.querySelectorAll('.dh-doc').length,
          wide: document.documentElement.scrollWidth > window.innerWidth + 1,
        }));
        await context.close();
        expect(drawn.note).toBe('shown as plain text');
        expect(drawn.text).toBe(LIMITED);
        expect(drawn.links).toBe(0);
        expect(drawn.docs).toBe(0);
        expect(drawn.wide).toBe(false);
        expect(found).toEqual({ csp: [], errors: [] });
      }, 90_000);
});
