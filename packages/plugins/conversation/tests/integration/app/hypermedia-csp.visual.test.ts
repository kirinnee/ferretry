/**
 * EVERY DURIAN PART UNDER THE APP'S REAL POLICY, in real Chromium (r12 H4).
 *
 * The page is served with the exact `Content-Security-Policy` `packages/app/public/_headers` gives the app (Trusted Types
 * included: `require-trusted-types-for 'script'`, three named policies), and holds the REAL `Transcript` over one fake
 * assistant message: each of Durian's 84 fixtures (66 of its format, 18 hostile; the plan said 81 at v0.1.0) in turn. For each, after every stepped
 * part is stepped and the first animation is opened in 3D, it measures:
 *   - 0 `securitypolicyviolation` events and 0 Trusted Types errors (the two are one event family, counted apart);
 *   - 0 uncaught errors and 0 requests to any origin but the scene's own (a `data:` / `blob:` URL is not a request out);
 *   - nothing the author wrote is a live element of the page: no `<script>`, no `<object>`/`<embed>`, no `<foreignObject>`,
 *     no `<iframe>` that is not one of OUR sandbox frames, no `on*` attribute, no `javascript:` / `data:` link;
 *   - every `<svg>` in the message is Durian's own chrome (an animation stage, an icon), never author markup.
 * And then the claims that are about one part: a ```mermaid part is `<img src="data:image/svg+xml…">` made by OUR sandbox
 * frame; Durian's in-page mermaid and its HTML-string sinks are not in the bundle; the 3D stage is a lazy chunk, fetched
 * when a reader opens a 3D view and not before; a context lost or WebGL unavailable falls back to the flat view.
 *
 * Set `FY_HYPERMEDIA_SHOTS_DIR` to keep `parts-<viewport>-<scheme>.png`. Chromium evidence is not Safari evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '@ferretry/app/testing/browser';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';
import { scanForHtmlSinks } from './support/sink-scan.ts';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_HYPERMEDIA_SHOTS_DIR ?? '';
const durianRoot = dirname(
  createRequire(join(packageRoot, '../../../package.json')).resolve('durian-hypermedia/package.json'),
);

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let origin = '';
/** The pathnames the server was asked for, in order: what "fetched" means for the 3D chunk. */
const ledger: string[] = [];
let threeChunk = '';
let bundleInputs: readonly string[] = [];
const FIXTURES: { readonly name: string; readonly file: string }[] = [];

/** Durian's `build-css.ts`, run the way the app's Vite plugin runs it (the package ships no `dist/`). */
const durianCss = async (): Promise<string> => {
  const { buildCss } = (await import(join(durianRoot, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return buildCss();
};

/**
 * ONE MESSAGE WITH A PART OF EACH KIND, for the pictures: a few of Durian's own fixtures, one after the other, without their
 * front matter (a chat message has none). Chosen by number so a renamed fixture is a loud failure, not a thinner picture.
 */
const SHOWCASE = ['39', '35', '38', '31', '06', '07', '12', '10', '44'];
const showcase = async (): Promise<string> => {
  const bodies = await Promise.all(
    SHOWCASE.map(async number => {
      const found = FIXTURES.find(entry => entry.name.startsWith(`format/${number}-`));
      if (found === undefined) throw new Error(`no Durian fixture numbered ${number}`);
      return (await readFile(found.file, 'utf8')).replace(/^---\n[\s\S]*?\n---\n/u, '').trim();
    }),
  );
  return bodies.join('\n\n');
};

/** The cwd the split build runs in: the metafile it prints names every input relative to it. */
const BUILD_CWD = packageRoot;

const spawnJson = async <T>(args: readonly string[]): Promise<T> => {
  const child = Bun.spawn([process.execPath, ...args], { cwd: BUILD_CWD, stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the split scene did not build (${code}):\n${stderr}\n${stdout}`);
  return JSON.parse(stdout.trim().split('\n').at(-1) as string) as T;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

beforeAll(async () => {
  browser = await sharedChromium();
  const fixture = await fyRenderIntegrationFixture();
  const headers = await readFile(resolve(packageRoot, '../../../../../app/public/_headers'), 'utf8');
  const policy =
    headers
      .split('\n')
      .find(line => line.trim().startsWith('Content-Security-Policy:'))
      ?.trim()
      .slice('Content-Security-Policy:'.length)
      .trim() ?? '';
  if (!policy.includes("require-trusted-types-for 'script'")) throw new Error('the real policy lost Trusted Types');
  directory = await mkdtemp(join(tmpdir(), 'ferretry-hypermedia-parts-'));
  const built = await spawnJson<{ chunks: string[]; inputs: string[] }>([
    resolve(packageRoot, 'fixtures/hypermedia-split-build.ts'),
    '--out',
    directory,
    '--entry',
    resolve(packageRoot, 'fixtures/hypermedia-parts-scene.tsx'),
  ]);
  bundleInputs = built.inputs;
  for (const file of ['scene.js', ...built.chunks]) {
    const text = await readFile(join(directory, file), 'utf8');
    if (file !== 'scene.js' && text.includes('WebGLRenderer')) threeChunk = file;
    if (text.includes('allowsEval')) {
      zodFiles.add(file);
      zodSource.set(file, text.split('\n'));
    }
  }
  if (zodFiles.size === 0)
    throw new Error('the scene bundle holds no zod `allowsEval`: the probe allowance has no home');
  const css = `${fixture.appCss}\n${await durianCss()}\n${SCENE_CSS}`;
  for (const kind of ['format', 'hostile'])
    for (const file of (await readdir(join(durianRoot, 'fixtures', kind))).sort())
      FIXTURES.push({ name: `${kind}/${file}`, file: join(durianRoot, 'fixtures', kind, file) });

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      ledger.push(path);
      const secured = (body: string | Blob, type: string): Response =>
        new Response(body, { headers: { 'content-security-policy': policy, 'content-type': type } });
      if (path === '/') {
        return secured(
          `<!doctype html><html lang="en" data-theme="studio-light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/scene.js"></script></body></html>`,
          'text/html; charset=utf-8',
        );
      }
      if (path === '/app.css') return secured(css, CONTENT_TYPES['.css'] ?? '');
      if (path === '/fy-render-sandbox.html')
        return new Response(fixture.shell, {
          headers: {
            'content-security-policy': "frame-ancestors 'self'; sandbox allow-scripts",
            'content-type': 'text/html; charset=utf-8',
          },
        });
      if (path === '/fy-render-mermaid.js')
        return new Response(fixture.mermaid, { headers: { 'content-type': CONTENT_TYPES['.js'] ?? '' } });
      if (path === '/fy-render-lottie.js')
        return new Response(fixture.lottie, { headers: { 'content-type': CONTENT_TYPES['.js'] ?? '' } });
      if (path === '/fixture/showcase') return secured(await showcase(), 'text/plain; charset=utf-8');
      if (path.startsWith('/fixture/')) {
        const found = FIXTURES.find(entry => `/fixture/${entry.name}` === decodeURIComponent(path));
        return found === undefined
          ? new Response('no fixture', { status: 404 })
          : secured(Bun.file(found.file), 'text/plain; charset=utf-8');
      }
      const name = path.slice(1);
      if (/^[\w.-]+$/u.test(name)) {
        const file = Bun.file(join(directory, name));
        if (await file.exists()) {
          const ext = name.slice(name.lastIndexOf('.'));
          return secured(file, CONTENT_TYPES[ext] ?? 'application/octet-stream');
        }
      }
      return new Response('not here', { status: 404 });
    },
  });
  origin = server.url.origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 300_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/**
 * THE ONE KNOWN, NOT-OURS VIOLATION, named exactly so nothing else can hide behind it. zod 4 decides whether it may compile
 * a schema with `new Function("")` (`allowsEval` in its core, behind a cache), and under `require-trusted-types-for 'script'`
 * that probe throws, is caught, and is reported once per page as a Trusted Types violation of `Function`. It is in the app
 * today with no Durian or hypermedia code on the page (the app never sets zod's `jitless`); fixing it is a one-line zod
 * setting at the app's start, outside this unit. It is the exact sink (`Function`, an empty body) and at most once.
 */
const ZOD_EVAL_PROBE =
  /^require-trusted-types-for trusted-types-sink ([^\s:]+):(\d+):\d+ Function\|\(\n\) \{\n\n\}\)$/u;

/** The built files that hold zod's probe (`allowsEval`): the only files the allowance above may come from. */
const zodFiles = new Set<string>();

/**
 * Is this report the zod probe? The sample AND the place: a violation reported from any file but the one that holds zod's
 * `allowsEval`, or from a line of it that does not say `Function`, is not the probe and is a failure.
 */
const isZodProbe = (entry: string): boolean => {
  const match = ZOD_EVAL_PROBE.exec(entry);
  const file = match?.[1];
  const line = Number(match?.[2]);
  if (file === undefined || !zodFiles.has(file)) return false;
  // zod's probe is `const F = Function; new F("")`: the report names the second line, and `Function` is on the one before.
  return (zodSource.get(file)?.slice(Math.max(0, line - 3), line) ?? []).join('\n').includes('Function');
};
/** The lines of each file in {@link zodFiles}, to check the reported line is zod's `new Function`. */
const zodSource = new Map<string, readonly string[]>();

interface Report {
  /** Every violation but the zod probe above. */
  readonly csp: string[];
  /** How many times the zod probe was reported (once per page, at most). */
  readonly evalProbes: number;
  readonly trustedTypes: string[];
  readonly errors: string[];
  readonly foreign: string[];
}

interface Visit {
  readonly page: Page;
  readonly report: () => Promise<Report>;
  readonly close: () => Promise<void>;
}

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 1_500 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  desktop: { viewport: { width: 1_280, height: 900 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false },
} as const;

/** What the page counts for itself, installed before any of the page's own script. */
const COLLECT = `(() => {
  const s = (window.__h4 = { csp: [], errors: [] });
  document.addEventListener('securitypolicyviolation', e => s.csp.push(e.effectiveDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '').split('/').pop() + ':' + e.lineNumber + ':' + e.columnNumber + ' ' + (e.sample || '').slice(0, 80)));
  window.addEventListener('error', e => s.errors.push(String(e.message).slice(0, 200)));
  window.addEventListener('unhandledrejection', e => s.errors.push('rejection ' + String(e.reason).slice(0, 200)));
})();`;

/** WebGL answers "not available": what a phone with the feature off, or a blocklisted GPU, does. */
const NO_WEBGL = `(() => {
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    return /webgl/i.test(String(type)) ? null : get.call(this, type, ...rest);
  };
})();`;

/**
 * Waits for an expression to be true by asking the page, NOT with `page.waitForFunction`: that compiles its predicate in the
 * page with `new Function`, which the page's Trusted Types policy rightly refuses and counts as a violation of the very
 * thing under test. `evaluate` goes through the debugger protocol and touches nothing the page's policy governs.
 * Resolves `false` on the deadline (the caller's next assertion says what was missing).
 */
const until = async (page: Page, expression: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.evaluate(expression)) === true) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

const open = async (
  query: string,
  options: {
    readonly viewport?: keyof typeof VIEWPORTS;
    readonly scheme?: 'light' | 'dark';
    readonly init?: string;
  } = {},
): Promise<Visit> => {
  const context: BrowserContext = await browser.newContext({
    ...VIEWPORTS[options.viewport ?? 'desktop'],
    colorScheme: options.scheme ?? 'light',
  });
  const foreign: string[] = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin || url.startsWith('data:') || url.startsWith('blob:'))
      return await route.continue();
    foreign.push(url);
    return await route.abort();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error.message).slice(0, 200)));
  await page.addInitScript(COLLECT);
  if (options.init !== undefined) await page.addInitScript(options.init);
  await page.goto(`${origin}/?${query}&theme=studio-${options.scheme ?? 'light'}`);
  await until(page, 'window.fyPartsReady === true', 20_000);
  const collected = async (): Promise<Report> => {
    const seen = await page.evaluate(() => (window as unknown as { __h4: { csp: string[]; errors: string[] } }).__h4);
    const violations = seen.csp.filter(entry => !isZodProbe(entry));
    return {
      csp: violations,
      evalProbes: seen.csp.length - violations.length,
      trustedTypes: violations.filter(
        entry => entry.startsWith('require-trusted-types-for') || entry.startsWith('trusted-types'),
      ),
      errors: [...seen.errors, ...errors],
      foreign,
    };
  };
  // The report is read when asked, after the page has had its say.
  return { page, report: collected, close: async () => await context.close() };
};

/** Steps every stepped part once, opens the first animation in 3D when the page offers it, and lets drawing settle. */
const exercise = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dh-doc .btn-go'))
      if (!button.disabled) button.click();
    for (const box of document.querySelectorAll('.dh-doc [data-dh-mermaid]')) box.scrollIntoView({ block: 'center' });
  });
  const has3d = await page.evaluate(() => document.querySelector('.dh-doc button.scn-mode') !== null);
  if (has3d) {
    await page.evaluate(() => {
      const stage = document.querySelector('.dh-doc .scn');
      if (stage !== null && stage.querySelector('.scn3') === null)
        stage.querySelector<HTMLButtonElement>('button.scn-mode')?.click();
    });
    await until(
      page,
      "document.querySelector('.dh-doc .scn3 canvas') !== null && document.querySelector('.dh-doc .scn3-loading') === null",
      15_000,
    );
  }
  const hasDiagram = await page.evaluate(() => document.querySelector('.dh-doc [data-dh-mermaid]') !== null);
  if (hasDiagram)
    await until(
      page,
      `document.querySelector('.dh-doc [data-dh-mermaid] img[src^="data:image/svg+xml"]') !== null || document.querySelector('.dh-doc [data-fy-render-failure], .dh-doc .fy-render--fallback') !== null`,
      20_000,
    );
  await page.waitForTimeout(hasDiagram || has3d ? 500 : 250);
};

/** Every way an author's text could have become a live part of the page, found in the message's own subtree. */
const DANGER = `(() => {
  const doc = document.querySelector('.dh-doc');
  if (doc === null) return ['no .dh-doc'];
  const found = [];
  for (const el of doc.querySelectorAll('script, object, embed, foreignObject, frame, base, meta, link')) found.push(el.tagName);
  for (const frame of doc.querySelectorAll('iframe')) {
    const sandbox = frame.getAttribute('sandbox') || '';
    if (!frame.hasAttribute('data-fy-render-frame') || !/\\ballow-scripts\\b/.test(sandbox) || /allow-same-origin/.test(sandbox)) found.push('iframe ' + sandbox);
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) found.push(el.tagName + '[' + attr.name + ']');
      if (/^(href|src|action|formaction|xlink:href)$/i.test(attr.name) && /^\\s*(javascript|vbscript|data|file|blob):/i.test(attr.value) && !(el.tagName === 'IMG' && /^data:image\\/(png|gif|jpeg|webp|svg\\+xml)[;,]/i.test(attr.value))) found.push(el.tagName + '[' + attr.name + '=' + attr.value.slice(0, 24) + ']');
    }
  }
  // Durian's own svg (an animation stage, an icon in a callout or a control); anything else is author markup.
  for (const svg of doc.querySelectorAll('svg')) {
    if (!svg.closest('.scn, .callout-icon, .banner-icon, button, .btn, .chart, .tier, .align, .human-chip, .dh-mouse, summary, .dh-spin, .fy-render, [data-fy-render-type]')) found.push('svg in ' + (svg.parentElement ? svg.parentElement.className : '?'));
  }
  return found;
})()`;

const expectClean = async (visit: Visit, label: string): Promise<void> => {
  const report = await visit.report();
  const danger = await visit.page.evaluate(DANGER);
  expect({ label, csp: report.csp }).toEqual({ label, csp: [] });
  expect({ label, trustedTypes: report.trustedTypes }).toEqual({ label, trustedTypes: [] });
  expect({ label, evalProbes: report.evalProbes <= 1 }).toEqual({ label, evalProbes: true });
  expect({ label, errors: report.errors }).toEqual({ label, errors: [] });
  expect({ label, foreign: report.foreign }).toEqual({ label, foreign: [] });
  expect({ label, danger: danger as string[] }).toEqual({ label, danger: [] });
};

describe('Durian’s fixtures inside a transcript, under the real policy', () => {
  it('has the 84 fixtures of the pinned version (66 of the format, 18 hostile; the plan counted 81 at v0.1.0) (a bump that adds or drops one is a review)', () => {
    expect(FIXTURES.filter(f => f.name.startsWith('format/')).length).toBe(66);
    expect(FIXTURES.filter(f => f.name.startsWith('hostile/')).length).toBe(18);
  });

  it('draws every fixture with 0 CSP violations, 0 Trusted Types errors, 0 off-origin requests and no live author node', async () => {
    const failures: string[] = [];
    for (const { name } of FIXTURES) {
      const visit = await open(`fixture=${encodeURIComponent(name)}`);
      try {
        await exercise(visit.page);
        await expectClean(visit, name);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`);
      } finally {
        await visit.close();
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});

describe('a mermaid part is drawn by our sandbox renderer', () => {
  it('appears as an <img src="data:image/svg+xml…"> made in OUR frame, with no author svg or script in the page', async () => {
    const mid = ledger.length;
    const visit = await open('fixture=format/10-diagram.dh.md');
    try {
      await exercise(visit.page);
      const m = await visit.page.evaluate(() => {
        const box = document.querySelector('.dh-doc [data-dh-mermaid="host"]') as HTMLElement;
        return {
          images: [...box.querySelectorAll('img')].map(img => img.getAttribute('src')?.slice(0, 22)),
          inPageMermaid: document.querySelectorAll('.dh-doc [data-mermaid], .dh-doc .diagram.is-drawn svg:not(.lucide)')
            .length,
          // The compiled diagram is the image; the frame that made it is gone, and no frame of the author's is left.
          frames: box.querySelectorAll('iframe').length,
        };
      });
      expect(m.images.length).toBe(1);
      expect(m.images[0]).toBe('data:image/svg+xml,%3C');
      expect(m.inPageMermaid).toBe(0);
      expect(m.frames).toBe(0);
      // It was made in OUR frame: the sandbox shell and the pinned library were fetched, from the scene's own origin.
      const asked = ledger.slice(mid);
      expect(asked).toContain('/fy-render-sandbox.html');
      expect(asked).toContain('/fy-render-mermaid.js');
      await expectClean(visit, 'mermaid');
    } finally {
      await visit.close();
    }
  }, 60_000);

  it('is not Durian’s in-page mermaid: its part, mermaid and DOMPurify-for-diagrams are not in the bundle', () => {
    const inputs = bundleInputs.map(path => path.replace(/\\/gu, '/'));
    // The package's own in-page mermaid part, and the library it loads.
    expect(
      inputs.filter(path =>
        /durian-hypermedia[^/]*\/(?:node_modules\/durian-hypermedia\/)?src\/react\/mermaid\.tsx$/u.test(path),
      ),
    ).toEqual([]);
    expect(inputs.filter(path => /\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?mermaid\//u.test(path))).toEqual([]);
    // The host-drawn part, and the containers (`:::tabs`) that draw their body through the one renderer, ARE.
    expect(inputs.some(path => /src\/react\/mermaid-host\.tsx$/u.test(path))).toBe(true);
    expect(inputs.some(path => /src\/react\/containers\.tsx$/u.test(path))).toBe(true);
  });

  it('keeps every Durian source in the bundle free of an HTML-string sink, and reads every one of them', async () => {
    const own = bundleInputs.filter(path =>
      /durian-hypermedia[^/]*\/(?:node_modules\/durian-hypermedia\/)?src\//u.test(path),
    );
    expect(own.length).toBeGreaterThan(10);
    // The metafile's paths are relative to the cwd the build ran in (BUILD_CWD), and a file that cannot be read rejects.
    const scan = await scanForHtmlSinks(own, BUILD_CWD);
    expect({ scanned: scan.scanned, inMetafile: own.length }).toEqual({ scanned: own.length, inMetafile: own.length });
    expect(scan.hits).toEqual([]);
  });
});

describe('an animation: 3D is on, lazy, and falls back to the flat view', () => {
  const ANIMATION_2D = 'fixture=format/44-animation-binary-search-tree-insert.dh.md';
  const ANIMATION_3D = 'fixture=format/59-3d-the-stateless-replay-system-in-layers.dh.md';

  it('fetches no 3D chunk for a page with no 3D block, and fetches it when a reader opens a 3D view', async () => {
    expect(threeChunk).not.toBe('');
    const before = ledger.length;
    const flat = await open('fixture=format/39-terminal.dh.md');
    try {
      await exercise(flat.page);
    } finally {
      await flat.close();
    }
    expect(ledger.slice(before).filter(path => path === `/${threeChunk}`)).toEqual([]);

    const mid = ledger.length;
    const stage = await open(ANIMATION_2D);
    try {
      await stage.page.waitForTimeout(500);
      // A 2D animation keeps the 3D module until the reader asks for it.
      const scene = await stage.page.evaluate(() => ({
        toggle: document.querySelector('.dh-doc button.scn-mode') !== null,
        canvas: document.querySelector('.dh-doc .scn3 canvas') !== null,
      }));
      expect(scene.toggle).toBe(true);
      expect(scene.canvas).toBe(false);
      expect(ledger.slice(mid).filter(path => path === `/${threeChunk}`)).toEqual([]);
      await stage.page.click('.dh-doc button.scn-mode');
      await stage.page.waitForSelector('.dh-doc .scn3 canvas', { timeout: 15_000 });
      expect(ledger.slice(mid).filter(path => path === `/${threeChunk}`).length).toBe(1);
      await expectClean(stage, '3d');
    } finally {
      await stage.close();
    }
  }, 90_000);

  it('opens a 3D scene on its own, and draws it with 0 CSP and Trusted Types violations', async () => {
    const visit = await open(ANIMATION_3D);
    try {
      await visit.page.waitForSelector('.dh-doc .scn3 canvas', { timeout: 20_000 });
      await visit.page.waitForTimeout(500);
      await expectClean(visit, '3d scene');
    } finally {
      await visit.close();
    }
  }, 60_000);

  it('falls back to the flat view when WebGL is unavailable: no toggle, the 2D stage, no 3D chunk', async () => {
    const mid = ledger.length;
    const visit = await open(ANIMATION_3D, { init: NO_WEBGL });
    try {
      await visit.page.waitForSelector('.dh-doc .scn svg.scn-svg', { timeout: 15_000 });
      const m = await visit.page.evaluate(() => ({
        toggle: document.querySelector('.dh-doc button.scn-mode') !== null,
        canvas: document.querySelector('.dh-doc .scn3 canvas') !== null,
        flat: document.querySelectorAll('.dh-doc .scn svg.scn-svg').length,
      }));
      expect(m).toEqual({ toggle: false, canvas: false, flat: 1 });
      expect(ledger.slice(mid).filter(path => path === `/${threeChunk}`)).toEqual([]);
      await expectClean(visit, 'no webgl');
    } finally {
      await visit.close();
    }
  }, 60_000);

  it('falls back to the flat view when the WebGL context is LOST, and says so', async () => {
    const visit = await open(ANIMATION_3D);
    try {
      await visit.page.waitForSelector('.dh-doc .scn3 canvas', { timeout: 20_000 });
      const lost = await visit.page.evaluate(() => {
        const canvas = document.querySelector('.dh-doc .scn3 canvas') as HTMLCanvasElement;
        const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
        const extension = gl?.getExtension('WEBGL_lose_context');
        extension?.loseContext();
        return extension !== null && extension !== undefined;
      });
      expect(lost).toBe(true);
      await visit.page.waitForSelector('.dh-doc .scn svg.scn-svg', { timeout: 10_000 });
      const m = await visit.page.evaluate(() => ({
        canvas: document.querySelector('.dh-doc .scn3') !== null,
        flat: document.querySelectorAll('.dh-doc .scn svg.scn-svg').length,
        note: document.querySelector('.dh-doc [data-fy-webgl-lost]')?.textContent ?? null,
      }));
      expect(m.canvas).toBe(false);
      expect(m.flat).toBe(1);
      expect(m.note).toContain('flat view');
      await expectClean(visit, 'lost context');
    } finally {
      await visit.close();
    }
  }, 60_000);
});

describe('an author’s chart cannot freeze the tab: the reviewer’s two charts are read as code in under 50 ms (S1)', () => {
  const FENCE = '`'.repeat(3);
  const fenced = (...body: readonly string[]): string => [`${FENCE}chart`, ...body, FENCE].join('\n');
  // 417 bytes: user functions calling user functions over a 10,000-item list. 3.7 s of main-thread time on the unguarded pin.
  const functions = ((): string => {
    const defs = ['  a: range(1,10000)', '  h0(x): x+x'];
    for (let level = 1; level <= 14; level++) defs.push(`  h${level}(x): h${level - 1}(x)+h${level - 1}(x)`);
    return fenced('kind: line', 'let:', ...defs, '  b: h14(a)', 'x: a', 'series:', '  - name: s', '    data: b');
  })();
  // 27 million values on the unguarded pin (0.45 s, hundreds of MB); a billion at n = 1000.
  const fill = fenced(
    'kind: line',
    'let:',
    '  big: fill(fill(fill(1,300),300),300)+1',
    'x: [1]',
    'series:',
    '  - name: s',
    '    data: big',
  );
  for (const [name, chart] of [
    ['nested user functions (h14)', functions],
    ['nested fill (300 x 300 x 300)', fill],
  ] as const)
    it(`${name}: is read in under 50 ms and drawn as code, with no canvas`, async () => {
      const visit = await open('text=');
      try {
        const read = await visit.page.evaluate(
          source => (window as unknown as { fyRead: (text: string) => number }).fyRead(source),
          chart,
        );
        expect(read).toBeLessThan(50);
        await visit.page.evaluate(
          source => (window as unknown as { fyStream: (text: string) => void }).fyStream(source),
          chart,
        );
        await visit.page.waitForTimeout(400);
        const m = await visit.page.evaluate(() => ({
          code: [...document.querySelectorAll('.dh-doc .code-block .code-lang')].map(label => label.textContent),
          canvases: document.querySelectorAll('.dh-doc canvas').length,
          error: document.querySelector('.dh-doc .dh-error') !== null,
        }));
        expect(m).toEqual({ code: ['chart'], canvases: 0, error: false });
        await expectClean(visit, name);
      } finally {
        await visit.close();
      }
    }, 60_000);
});

describe('a held part (chart, code walk) is its readable source, with the author’s :::llm text beside it (C7, S1, G1)', () => {
  const FENCE = '`'.repeat(3);
  const cases = {
    chart: [`${FENCE}chart`, 'type: bar', 'x: [a, b]', 'series:', '  - name: s', '    data: [1, 2]', FENCE],
    codewalk: [`${FENCE}codewalk`, '- file: src/api.ts', '  note: the entry', FENCE],
  } as const;
  for (const [name, lines] of Object.entries(cases))
    it(`${name}: a collapsed "LLM-only text", and no author text poured into a fallback box`, async () => {
      const text = [...lines, '', ':::llm', `About the ${name}.`, ':::'].join('\n');
      const visit = await open(`text=${encodeURIComponent(text)}`);
      try {
        await visit.page.waitForTimeout(500);
        const m = await visit.page.evaluate(() => ({
          disclosures: [...document.querySelectorAll('.dh-doc details[data-fy-llm-only]')].map(d => ({
            open: (d as HTMLDetailsElement).open,
            summary: d.querySelector('summary')?.textContent,
            body: d.querySelector('pre')?.textContent,
          })),
          fallback: document.querySelector('.dh-doc pre[data-dh-missing]')?.textContent ?? '',
          charts: document.querySelectorAll('.dh-doc .chart canvas').length,
          code: [...document.querySelectorAll('.dh-doc .code-block')].map(block => ({
            lang: block.querySelector('.code-lang')?.textContent,
            text: block.querySelector('pre')?.textContent,
          })),
        }));
        expect(m.disclosures).toEqual([{ open: false, summary: 'LLM-only text', body: `About the ${name}.` }]);
        expect(m.fallback).not.toContain(`About the ${name}.`);
        // G1: the source (and a code walk's notes) is on the page as code, beside the disclosure, not replaced by it.
        expect(m.code).toEqual([{ lang: name, text: lines.slice(1, -1).join('\n') }]);
        // S1: a chart is never evaluated, so no canvas.
        expect(m.charts).toBe(0);
        await expectClean(visit, name);
      } finally {
        await visit.close();
      }
    }, 60_000);
});

describe('the parts at a phone and a desktop width, light and dark', () => {
  for (const viewport of ['phone', 'desktop'] as const)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws the showcase without sideways scroll (${viewport}, ${scheme})`, async () => {
        const visit = await open('fixture=showcase', { viewport, scheme });
        try {
          await exercise(visit.page);
          // The transcript scrolls inside the page (and rests at its end), so the page is made as tall as the message and
          // one picture shows all of it. Drawing is measured again after the resize: a diagram fits its column.
          // First as tall as a page may be, so nothing scrolls; then as tall as the message ends.
          const width = VIEWPORTS[viewport].viewport.width;
          await visit.page.setViewportSize({ width, height: 12_000 });
          await visit.page.waitForTimeout(800);
          const height = await visit.page.evaluate(() => {
            const log = document.querySelector('.fy-chat-log') as HTMLElement | null;
            if (log !== null) log.scrollTop = 0;
            const bottom = document.querySelector('.dh-doc')?.getBoundingClientRect().bottom ?? 0;
            return Math.ceil(bottom) + 80;
          });
          await visit.page.setViewportSize({ width, height });
          await visit.page.waitForTimeout(600);
          const m = await visit.page.evaluate(() => ({
            wide: document.documentElement.scrollWidth > window.innerWidth + 1,
            log: ((): boolean => {
              const log = document.querySelector('.fy-chat-log') as HTMLElement | null;
              return log !== null && log.scrollWidth > log.clientWidth + 1;
            })(),
            chartCanvases: document.querySelectorAll('.dh-doc .chart canvas').length,
            heldCharts: [...document.querySelectorAll('.dh-doc .code-block .code-lang')].filter(
              label => label.textContent === 'chart',
            ).length,
            parts: [...document.querySelectorAll('.dh-doc [data-dh-part]')].map(part =>
              part.getAttribute('data-dh-part'),
            ),
            images: document.querySelectorAll('.dh-doc [data-dh-mermaid] img[src^="data:image/svg+xml"]').length,
          }));
          expect(m.wide).toBe(false);
          expect(m.log).toBe(false);
          // A chart is held as code (S1): it is on the page as source and draws no canvas.
          expect(m.chartCanvases).toBe(0);
          expect(m.heldCharts).toBeGreaterThan(0);
          expect(m.images).toBe(1);
          for (const part of ['terminal', 'filetree', 'tabs', 'mermaid', 'animation', 'tierlist', 'accordion'])
            expect(m.parts).toContain(part);
          expect(m.parts).not.toContain('chart');
          await expectClean(visit, `showcase ${viewport} ${scheme}`);
          if (shotsDir !== '') await visit.page.screenshot({ path: join(shotsDir, `parts-${viewport}-${scheme}.png`) });
        } finally {
          await visit.close();
        }
      }, 60_000);
});
