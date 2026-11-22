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
import { buildWorkerChunk } from '../../support/vite-scene.ts';
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
/** The Durian worker as the app builds it, and the test-only one whose parse of a marked message never returns. */
let workerCode = '';
let slowWorkerCode = '';
let slowWorker = false;
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
  workerCode = await buildWorkerChunk(resolve(packageRoot, '../../../app/hypermedia/durian-worker.ts'));
  slowWorkerCode = await buildWorkerChunk(resolve(packageRoot, 'fixtures/slow-durian-worker.ts'));
  directory = await mkdtemp(join(tmpdir(), 'ferretry-hypermedia-parts-'));
  const built = await spawnJson<{ chunks: string[]; inputs: string[] }>([
    resolve(packageRoot, 'fixtures/hypermedia-split-build.ts'),
    '--out',
    directory,
    '--entry',
    resolve(packageRoot, 'fixtures/hypermedia-parts-scene.tsx'),
    // The app's own start-up module, run before the scene's first schema (see the split build's `--first`).
    '--first',
    resolve(packageRoot, '../../../../../app/src/security/zod-jitless.ts'),
  ]);
  bundleInputs = built.inputs;
  for (const file of ['scene.js', ...built.chunks]) {
    const text = await readFile(join(directory, file), 'utf8');
    if (file !== 'scene.js' && text.includes('WebGLRenderer')) threeChunk = file;
  }
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
          `<!doctype html><html lang="en" data-theme="studio-light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/first.js"></script><script type="module" src="/scene.js"></script></body></html>`,
          'text/html; charset=utf-8',
        );
      }
      if (path === '/app.css') return secured(css, CONTENT_TYPES['.css'] ?? '');
      // The Durian worker, built the app's way and served under the page's real policy (a worker script's own response
      // carries the policy it runs under); a test swaps in the one with a slow parse (`slowWorker`).
      if (path === '/assets/durian-worker-test.js')
        return secured(slowWorker ? slowWorkerCode : workerCode, CONTENT_TYPES['.js'] ?? '');
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

interface Report {
  /** Every violation, none tolerated: zod's `new Function` probe is off (`@ferretry/app/zod-jitless`, r12 H8). */
  readonly csp: string[];
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
  // The message is read in the Durian worker, so the page has the plain text first: wait until it is a document or says why not.
  await until(page, "document.querySelector('.dh-doc, [data-fy-plain-note]') !== null", 20_000);
  const collected = async (): Promise<Report> => {
    const seen = await page.evaluate(() => (window as unknown as { __h4: { csp: string[]; errors: string[] } }).__h4);
    return {
      csp: seen.csp,
      trustedTypes: seen.csp.filter(
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
  // A message over a pre-parse limit (r12 H11a) is plain text with its note: nothing of it is drawn, so there is nothing to find.
  if (doc === null) return document.querySelector('[data-fy-plain-note] + pre.fy-hm-plain') !== null ? [] : ['no .dh-doc'];
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
  expect({ label, errors: report.errors }).toEqual({ label, errors: [] });
  expect({ label, foreign: report.foreign }).toEqual({ label, foreign: [] });
  expect({ label, danger: danger as string[] }).toEqual({ label, danger: [] });
};

/** The page's own report, for a page that is plain text (no `.dh-doc` to look for live author nodes in). */
const expectNoViolations = async (visit: Visit, label: string): Promise<void> => {
  const report = await visit.report();
  expect({
    label,
    csp: report.csp,
    trustedTypes: report.trustedTypes,
    errors: report.errors,
    foreign: report.foreign,
  }).toEqual({
    label,
    csp: [],
    trustedTypes: [],
    errors: [],
    foreign: [],
  });
};

describe('Durian’s fixtures inside a transcript, under the real policy', () => {
  it('has the 84 fixtures of the pinned version (66 of the format, 18 hostile; the plan counted 81 at v0.1.0) (a bump that adds or drops one is a review)', () => {
    expect(FIXTURES.filter(f => f.name.startsWith('format/')).length).toBe(66);
    expect(FIXTURES.filter(f => f.name.startsWith('hostile/')).length).toBe(18);
  });

  it('draws every fixture with 0 CSP violations, 0 Trusted Types errors, 0 off-origin requests and no live author node', async () => {
    const failures: string[] = [];
    const plain: string[] = [];
    for (const { name } of FIXTURES) {
      const visit = await open(`fixture=${encodeURIComponent(name)}`);
      try {
        await exercise(visit.page);
        await expectClean(visit, name);
        if (await visit.page.evaluate(() => document.querySelector('[data-fy-plain-note]') !== null)) plain.push(name);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`);
      } finally {
        await visit.close();
      }
    }
    expect(failures).toEqual([]);
    // Only a hostile fixture may be over a pre-parse limit: no fixture of the format is shown as plain text.
    expect(plain.filter(name => !name.startsWith('hostile/'))).toEqual([]);
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

describe('held tabs and animation draw as code (r12 H11a)', () => {
  const HELD_FIXTURES: readonly (readonly [string, string])[] = [
    ['tabs', 'fixture=format/06-tabs.dh.md'],
    ['animation', 'fixture=format/44-animation-binary-search-tree-insert.dh.md'],
    ['3d animation', 'fixture=format/59-3d-the-stateless-replay-system-in-layers.dh.md'],
  ];

  for (const [label, query] of HELD_FIXTURES)
    it(`${label}: its source is on the page as code, no tab strip and no stage, with 0 CSP and Trusted Types violations`, async () => {
      const before = ledger.length;
      const visit = await open(query);
      try {
        await exercise(visit.page);
        const drawn = await visit.page.evaluate(() => ({
          code: document.querySelectorAll('.dh-doc .code-block pre').length,
          tabs: document.querySelectorAll('.dh-doc .tabs, .dh-doc [role="tab"]').length,
          stages: document.querySelectorAll('.dh-doc .scn, .dh-doc .scn3, .dh-doc canvas').length,
          parts: [...document.querySelectorAll('.dh-doc [data-dh-part]')].map(part =>
            part.getAttribute('data-dh-part'),
          ),
        }));
        expect(drawn.code).toBeGreaterThan(0);
        expect(drawn.tabs).toBe(0);
        expect(drawn.stages).toBe(0);
        expect(drawn.parts).not.toContain('tabs');
        expect(drawn.parts).not.toContain('animation');
        // Nothing heavy is fetched for source: no 3D chunk.
        expect(threeChunk === '' ? [] : ledger.slice(before).filter(path => path === `/${threeChunk}`)).toEqual([]);
        await expectClean(visit, `held ${label}`);
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
          for (const part of ['terminal', 'filetree', 'mermaid', 'tierlist']) expect(m.parts).toContain(part);
          // r12 H11a: tabs, an accordion and an animation are held as code, like a chart.
          expect(m.parts).not.toContain('chart');
          expect(m.parts).not.toContain('tabs');
          expect(m.parts).not.toContain('accordion');
          expect(m.parts).not.toContain('animation');
          await expectClean(visit, `showcase ${viewport} ${scheme}`);
          if (shotsDir !== '') await visit.page.screenshot({ path: join(shotsDir, `parts-${viewport}-${scheme}.png`) });
        } finally {
          await visit.close();
        }
      }, 60_000);
});

/**
 * r12 H11: A MESSAGE IS READ IN THE DURIAN WORKER, AND A SLOW PARSE CANNOT FREEZE THE PAGE. The worker is the chunk the app's
 * Vite makes of `durian-worker.ts`, started by the product's own `spawnDurianWorker` under the real policy
 * (`worker-src 'self'`, `require-trusted-types-for 'script'`, the `fy-worker` policy that accepts this chunk's name). The "slow
 * parse" is a loop the TEST's own worker runs for a message carrying a marker (`fixtures/slow-durian-worker.ts`): nothing in the
 * product has a hook for it, and nothing here names what makes a real parse slow.
 */
describe('a message is read in the Durian worker, under the real policy', () => {
  /** Records every animation frame and a 10 ms timer on the MAIN thread, from before the page's own script. */
  const PROBE = `(() => {
    const frames = [];
    let last = performance.now();
    const tick = () => { const now = performance.now(); frames.push(now - last); last = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const timers = [];
    setInterval(() => timers.push(performance.now()), 10);
    window.__probe = { frames, timers };
  })();`;

  const SLOW_TEXT = '# Slow\n\nFY-SLOW-PARSE and some words.';

  it('starts the worker through the real spawn with 0 CSP and Trusted Types violations, and draws the document it sends', async () => {
    const before = ledger.length;
    const visit = await open(
      `text=${encodeURIComponent('# Plan\n\nSome **bold** words and `code`.\n\n| a | b |\n| - | - |\n| 1 | 2 |')}`,
    );
    try {
      await until(visit.page, "document.querySelector('.dh-doc h1') !== null", 10_000);
      const m = await visit.page.evaluate(() => ({
        rich: document.querySelector('.dh-doc h1')?.textContent?.includes('Plan') ?? false,
        table: document.querySelectorAll('.dh-doc table').length,
        plain: document.querySelector('pre.fy-hm-plain') !== null,
        note: document.querySelector('[data-fy-plain-note]') !== null,
      }));
      expect(m).toEqual({ rich: true, table: 1, plain: false, note: false });
      expect(ledger.slice(before)).toContain('/assets/durian-worker-test.js');
      await expectClean(visit, 'worker');
    } finally {
      await visit.close();
    }
  }, 60_000);

  it('ends a parse that never returns: the message is plain text with a note within the budget, and the page never stops', async () => {
    slowWorker = true;
    const visit = await open('text=', { init: PROBE });
    try {
      const outcome = await visit.page.evaluate(
        text =>
          new Promise<{ ms: number; reason: string | null; plain: string | null; note: string | null }>(resolve => {
            // What is measured is what happens from here: the page's own start-up is not the parse's.
            const probe = (window as unknown as { __probe: { frames: number[]; timers: number[] } }).__probe;
            probe.frames.length = 0;
            probe.timers.length = 0;
            const started = performance.now();
            (window as unknown as { fyStream: (text: string) => void }).fyStream(text);
            const look = (): void => {
              const note = document.querySelector<HTMLElement>('[data-fy-plain-note]');
              if (note === null) {
                setTimeout(look, 5);
                return;
              }
              resolve({
                ms: performance.now() - started,
                reason: note.getAttribute('data-fy-plain-note'),
                plain: document.querySelector('pre.fy-hm-plain')?.textContent ?? null,
                note: note.textContent,
              });
            };
            look();
          }),
        SLOW_TEXT,
      );
      // The worker starts, says ready, is asked, and is ended at the 500 ms budget: ~500 ms plus the worker's start.
      expect(outcome.ms).toBeLessThan(1000);
      expect(outcome.ms).toBeGreaterThan(450);
      expect(outcome).toMatchObject({ reason: 'slow', plain: SLOW_TEXT, note: 'shown as plain text' });
      // The main thread never stopped: no frame, and no 10 ms timer, waited a long time for the thread.
      const probe = await visit.page.evaluate(() => {
        const { frames, timers } = (window as unknown as { __probe: { frames: number[]; timers: number[] } }).__probe;
        const gaps = timers.slice(1).map((time, index) => time - (timers[index] ?? time));
        return {
          frames: frames.length,
          worstFrame: Math.max(...frames),
          timers: timers.length,
          worstTimer: Math.max(...gaps),
        };
      });
      expect(probe.frames).toBeGreaterThan(5);
      expect(probe.worstFrame).toBeLessThan(250);
      expect(probe.worstTimer).toBeLessThan(250);
      await expectNoViolations(visit, 'slow parse');
    } finally {
      slowWorker = false;
      await visit.close();
    }
  }, 60_000);

  // The one visible new state: a message that was ended is its own text with a quiet line under it. Fake text only.
  const FAKE = [
    '# Release notes for the demo',
    '',
    'FY-SLOW-PARSE This is made-up text for a picture: the build went green, the checklist is done, and nothing here is real.',
    '',
    '- first made-up item with a **bold** word',
    '- second made-up item with `code`',
  ].join('\n');
  for (const viewport of ['phone', 'desktop'] as const)
    for (const scheme of ['light', 'dark'] as const)
      it(`shows an ended message as its text with a note, inside the page (${viewport}, ${scheme})`, async () => {
        slowWorker = true;
        const visit = await open('text=', { viewport, scheme, init: PROBE });
        try {
          await visit.page.evaluate(
            text => (window as unknown as { fyStream: (text: string) => void }).fyStream(text),
            FAKE,
          );
          await until(visit.page, "document.querySelector('[data-fy-plain-note]') !== null", 5_000);
          const m = await visit.page.evaluate(() => {
            const note = document.querySelector<HTMLElement>('[data-fy-plain-note]');
            const box = note?.getBoundingClientRect();
            const style = note === null ? undefined : getComputedStyle(note);
            return {
              text: note?.textContent,
              role: note?.getAttribute('role') ?? null,
              inside: box !== undefined && box.left >= 0 && box.right <= window.innerWidth,
              wide: document.documentElement.scrollWidth > window.innerWidth + 1,
              fontSize: style?.fontSize,
            };
          });
          expect(m).toMatchObject({ text: 'shown as plain text', role: null, inside: true, wide: false });
          if (shotsDir !== '')
            await visit.page.screenshot({ path: join(shotsDir, `plain-note-${viewport}-${scheme}.png`) });
          await expectNoViolations(visit, 'ended message');
        } finally {
          slowWorker = false;
          await visit.close();
        }
      }, 60_000);

  it('does not parse the killed message again, and the next message still reads (a new worker)', async () => {
    slowWorker = true;
    const visit = await open('text=', { init: PROBE });
    try {
      const stream = (text: string): Promise<void> =>
        visit.page.evaluate(
          source => (window as unknown as { fyStream: (text: string) => void }).fyStream(source),
          text,
        );
      await stream(SLOW_TEXT);
      await until(visit.page, "document.querySelector('[data-fy-plain-note]') !== null", 5_000);
      // Another message reads (the killed worker did not take it down)…
      await stream('# Fine\n\nA short one.');
      await until(visit.page, "document.querySelector('.dh-doc h1')?.textContent === 'Fine'", 5_000);
      // …and the killed one is answered from the cache at once, with no second wait for the budget.
      const again = await visit.page.evaluate(
        text =>
          new Promise<number>(resolve => {
            const started = performance.now();
            (window as unknown as { fyStream: (text: string) => void }).fyStream(text);
            const look = (): void => {
              if (document.querySelector('[data-fy-plain-note]') !== null) resolve(performance.now() - started);
              else setTimeout(look, 2);
            };
            look();
          }),
        SLOW_TEXT,
      );
      expect(again).toBeLessThan(100);
      await expectNoViolations(visit, 'slow parse, cached');
    } finally {
      slowWorker = false;
      await visit.close();
    }
  }, 60_000);
});
