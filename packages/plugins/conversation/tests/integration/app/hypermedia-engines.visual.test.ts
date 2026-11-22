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
  await page.goto(`${origin}/?theme=${options.theme ?? 'studio-light'}&text=${encodeURIComponent(body)}`);
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

  it('an animation fetches the 2D engine (not the 3D stage) and draws, with 0 violations', async () => {
    const { context, found, state, requested } = await show(ANIMATION);
    await context.close();
    expect(fetched(requested, engineFile)).toBe(true);
    expect(fetched(requested, threeFile)).toBe(false);
    expect(state.stages).toBeGreaterThan(0);
    expect(found).toEqual({ csp: [], errors: [] });
  }, 90_000);
});

describe('the pictures: the 2D animation and parts', () => {
  for (const [width, height, label] of [
    [390, 844, '390'],
    [1_280, 900, '1280'],
  ] as const)
    for (const theme of ['light', 'dark'] as const)
      it(`${label} ${theme}: draws the animation and the parts beside it`, async () => {
        const { context, page, found, state } = await show(SHOWCASE, { width, height, theme: `studio-${theme}` });
        if (shotsDir !== '') {
          await mkdir(shotsDir, { recursive: true });
          await page.screenshot({ path: join(shotsDir, `engines-${label}-${theme}.png`), fullPage: false });
        }
        await context.close();
        expect(state.stages).toBeGreaterThan(0);
        expect(found).toEqual({ csp: [], errors: [] });
      }, 90_000);
});
