/**
 * The REAL `FyRenderBlock`, in real Chromium, at both required viewports.
 *
 * WHY THIS FILE EXISTS. Every other piece of `fy-render` evidence stops short of
 * the component. `fy-render-sandbox.security.test.ts` drives a hand-built
 * `/parent` page with no React in it, because its subject is what a browser
 * refuses. `harness/fy-render-safari/` says so about itself — its parent bridge is
 * a faithful replica of `FyRenderSandbox`, not the component. `harness/main.tsx`
 * and `harness/screenshot.ts` have the two viewports and no `fy-render` entry at
 * all. So no capture and no assertion touched the shipped component at 390×844 or
 * 1440×900, and every layout claim in `docs/fy-render.md` was unmeasured.
 *
 * The unit tier cannot close that. It renders to a plain object tree or to
 * happy-dom, and the open items are precisely the ones neither can see: whether a
 * stylesheet rule actually takes effect, whether a control row wraps instead of
 * overflowing, whether a touch target clears 44px, and where focus really goes
 * when a control is removed from under the reader.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT. Real: the shipped `FyRenderBlock` and
 * `FyRenderSandbox`, the generated shell and its hash-pinned CSP built by the real
 * builder, the two real library bundles, and the app's whole stylesheet graph
 * bundled from `src/styles/index.css` — which is exactly what `main.tsx` imports.
 * Not real: the app shell. There is no daemon, no transcript and no routing,
 * because none of them change what this component does.
 *
 * THE STYLESHEET IS BUILT, NEVER READ FROM `dist/`. A test whose fidelity depends
 * on whether somebody happened to run `bun run build` first is not evidence. Bun
 * bundles the same `@import` graph Vite does; Vite's output additionally carries
 * xterm's vendor CSS, which nothing in this component reads. `should serve the
 * app's own stylesheet with the fy-render rules intact` pins that, including that
 * the dynamic viewport units survive bundling — a bundler that lowered `dvh` to
 * `vh` would silently invalidate the one finding that repair answers.
 *
 * IT IS ALSO THE EVIDENCE DRIVER. Set `FY_RENDER_EVIDENCE_DIR` and every scene
 * writes a PNG and a `manifest.json` there. Nothing is written into the
 * repository: the scene source is tracked so the capture is reproducible, and the
 * artifacts belong outside it.
 *
 * CHROMIUM ONLY, AND THAT IS A STATED LIMIT. Playwright's bundled WebKit is not
 * Safari; the real macOS `safaridriver` proof is a separate release gate.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT CAPTURE, said out loud rather than left
 * for a reader to assume:
 *
 *   1. A Lottie `lifetime` stop. It is 120 seconds of wall-clock by design, and
 *      the block takes no deadline seam. Its presentation — neutral tone, no fold,
 *      no source panel — is proven in `tests/unit/fy-render-sandbox.test.tsx`
 *      against the exact value the watchdog is measured to emit.
 *   2. An `%%{init}%%` directive being REFUSED by the parent gate. Measured
 *      against the shipped config, it is not refused: the `init-directive` scene
 *      below asserts the directive compiles to a normal diagram, which is what
 *      actually happens and is why `docs/fy-render.md` now calls the
 *      `<foreignObject>` refusal a fail-closed guard rather than a fallback path.
 *      The reachable Mermaid failure is a parse error, and `mermaid-failure`
 *      captures that one.
 */
import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import should from 'should';
import { buildFyRenderShell, FY_RENDER_SHELL_ARTIFACTS } from '../../scripts/build-fy-render-libs.ts';

const pkgRoot = resolve(import.meta.dir, '../..');

/** Set to capture PNGs. Never inside the repository — the artifacts are not source. */
const evidenceDir = process.env.FY_RENDER_EVIDENCE_DIR ?? null;

/** The two viewports `docs/fy-render.md` makes layout claims about. */
const VIEWPORTS = [
  { height: 844, name: '390x844', width: 390 },
  { height: 900, name: '1440x900', width: 1_440 },
] as const;

/**
 * A real animation with a real eased keyframe, because that is what Slice A's
 * grammar used to refuse: it rejected any `"x"` key, and Lottie overloads that key
 * onto bezier easing handles. A fixture without one would pass a grammar that
 * cannot render most real Lottie.
 */
const LOTTIE = JSON.stringify({
  assets: [],
  ddd: 0,
  fr: 30,
  h: 240,
  ip: 0,
  layers: [
    {
      ao: 0,
      bm: 0,
      ddd: 0,
      ind: 1,
      ip: 0,
      ks: {
        a: { a: 0, k: [0, 0, 0] },
        o: { a: 0, k: 100 },
        p: {
          a: 1,
          k: [
            { i: { x: [0.833], y: [0.833] }, o: { x: [0.167], y: [0.167] }, s: [70, 120, 0], t: 0 },
            { s: [250, 120, 0], t: 45 },
          ],
        },
        r: {
          a: 1,
          k: [
            { i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] }, s: [0], t: 0 },
            { s: [360], t: 45 },
          ],
        },
        s: { a: 0, k: [100, 100, 100] },
      },
      nm: 'dot',
      op: 45,
      shapes: [
        {
          it: [
            { p: { a: 0, k: [0, 0] }, s: { a: 0, k: [90, 90] }, ty: 'el' },
            { c: { a: 0, k: [0.36, 0.72, 0.94, 1] }, o: { a: 0, k: 100 }, ty: 'fl' },
            {
              a: { a: 0, k: [0, 0] },
              o: { a: 0, k: 100 },
              p: { a: 0, k: [0, 0] },
              r: { a: 0, k: 0 },
              s: { a: 0, k: [100, 100] },
              ty: 'tr',
            },
          ],
          ty: 'gr',
        },
      ],
      sr: 1,
      st: 0,
      ty: 4,
    },
  ],
  nm: 'eased',
  op: 45,
  v: '5.7.4',
  w: 320,
});

/**
 * WHETHER THE LOTTIE BUNDLE IS SERVABLE, flipped per test.
 *
 * A `library`-class failure is provoked by withholding the bundle rather than by
 * a malformed animation, and that is a deliberate choice: a payload the grammar
 * admits and the player merely dislikes may fail by never announcing itself, in
 * which case the block sits in `preparing` until the 120-second watchdog and a
 * test waiting on the outcome would hang rather than fail. Withholding the bundle
 * exercises the real parent fetch, the real class and the real teardown, and it
 * resolves in milliseconds every time.
 */
let lottieLibraryServable = true;

/**
 * HOW LONG A LIBRARY RESPONSE TAKES, and it is load-bearing rather than padding.
 *
 * Two things need it. A 404 from a local server resolves in about a millisecond,
 * so the block passed through `preparing` faster than a test could reach the
 * control it needs to watch disappear. And a warm Mermaid bundle compiles in about
 * a second, so a screenshot taken right after asserting `preparing` came back
 * showing the finished diagram — a PNG named `02-preparing` that pictured the ready
 * state, which is worse than no capture at all.
 *
 * Stalling the response makes the pending state last long enough to photograph,
 * and it is the state a reader on a slow connection genuinely sees: the parent's
 * 5-second readiness deadline bounds the HANDSHAKE, not this fetch, so nothing
 * here is being defeated. Every capture named for the pending state re-checks the
 * phase AFTER the screenshot, so a race can only fail the test, never mislabel an
 * artifact.
 */
let libraryStallMs = 0;

const MERMAID = [
  'graph TD',
  '  A[Reader opens a message] --> B{Is there an fy-render block?}',
  '  B -->|no| C[Ordinary markdown]',
  '  B -->|yes| D[Offer, do not render]',
  '  D --> E[Reader presses Render]',
  '  E --> F[Sandbox frame compiles]',
  '  F --> G[SVG re-admitted, shown as an image]',
].join('\n');

/** A jison parse error: the reachable Mermaid failure, and the ugliest wording. */
const MERMAID_BROKEN = 'graph TD\n  A[Unclosed --> B{{{';

/** On paper this asks for HTML labels. Measured, it compiles like any other. */
const MERMAID_INIT_DIRECTIVE = `%%{init: {"flowchart": {"htmlLabels": true}}}%%\n${MERMAID}`;

const fence = (type: string, alt: string, payload: string): string => `type: ${type}\nalt: ${alt}\n---\n${payload}`;

const CASES: Record<string, string> = {
  'init-directive': fence('mermaid', 'A diagram whose author asked for HTML labels', MERMAID_INIT_DIRECTIVE),
  lottie: fence('lottie', 'A blue dot travelling across the frame', LOTTIE),
  mermaid: fence('mermaid', 'How an fy-render block reaches the reader', MERMAID),
  'mermaid-failure': fence('mermaid', 'A diagram that cannot be drawn', MERMAID_BROKEN),
};

/**
 * The page. It mounts the production component and nothing else, and the module
 * graph is bundled by Bun from the real sources at run time — so a change to
 * `fy-render-block.tsx` is in the next run with no build step to remember.
 */
const scene = `
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FyRenderBlock } from ${JSON.stringify(resolve(pkgRoot, 'src/components/fy-render-block.tsx'))};
import { parseFyRender } from ${JSON.stringify(resolve(pkgRoot, 'src/lib/fy-render.ts'))};

const CASES = ${JSON.stringify(CASES)};
const which = new URLSearchParams(location.search).get('case') ?? 'mermaid';
const parsed = parseFyRender(CASES[which]);
if (!parsed.ok) throw new Error('fixture did not parse: ' + parsed.reason);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div className="scene-pad">
      <FyRenderBlock block={parsed.block} />
    </div>
  </StrictMode>,
);
`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
/** Every scene's recorded facts, written next to the PNGs. */
const manifest: Record<string, unknown>[] = [];

const bundle = async (entry: string): Promise<string> => {
  const built = await Bun.build({ entrypoints: [entry], minify: false, target: 'browser', throw: false });
  if (!built.success) throw new Error(`${entry} did not build:\n${built.logs.join('\n')}`);
  const output = built.outputs[0];
  if (output === undefined) throw new Error(`${entry} produced no output`);
  return await output.text();
};

let appCss = '';

beforeAll(async () => {
  // The artifacts under test are BUILT, never read from a checkout: `public/` is
  // generated and gitignored, and a stale shell would let this pass against a CSP
  // nobody deploys.
  await buildFyRenderShell();
  const shell = await Bun.file(FY_RENDER_SHELL_ARTIFACTS.shell).text();
  const mermaidBundle = await Bun.file(FY_RENDER_SHELL_ARTIFACTS.mermaid).text();
  const lottieBundle = await Bun.file(FY_RENDER_SHELL_ARTIFACTS.lottie).text();

  appCss = await bundle(resolve(pkgRoot, 'src/styles/index.css'));

  // Written to the scratch dir Bun.build can read, then bundled from there. The
  // SCENE is the string above, which is tracked; this file is its build input.
  const sceneDir = resolve(pkgRoot, '.artifacts/fy-render-visual');
  await mkdir(sceneDir, { recursive: true });
  await writeFile(resolve(sceneDir, 'scene.tsx'), scene, 'utf8');
  const app = await bundle(resolve(sceneDir, 'scene.tsx'));

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const js = { 'content-type': 'text/javascript; charset=utf-8' };
      if (path === '/fy-render-sandbox.html')
        return new Response(shell, {
          headers: {
            // Exactly what `public/_headers` makes Cloudflare Pages send for this
            // path: the CONTENT policy travels in the document, and this header
            // carries only the two things a `<meta>` tag cannot express.
            'content-security-policy': "frame-ancestors 'self'; sandbox allow-scripts",
            'content-type': 'text/html; charset=utf-8',
          },
        });
      // A withheld bundle is a real deployment failure: the parent's `response.ok`
      // check is what turns it into the `library` class.
      const library = (body: string, servable: boolean): Response | Promise<Response> => {
        const answer = (): Response =>
          servable ? new Response(body, { headers: js }) : new Response('', { status: 404 });
        return libraryStallMs === 0 ? answer() : Bun.sleep(libraryStallMs).then(answer);
      };
      if (path === '/fy-render-mermaid.js') return library(mermaidBundle, true);
      if (path === '/fy-render-lottie.js') return library(lottieBundle, lottieLibraryServable);
      if (path === '/app.js') return new Response(app, { headers: js });
      if (path === '/app.css') return new Response(appCss, { headers: { 'content-type': 'text/css; charset=utf-8' } });
      return new Response(
        `<!doctype html><html lang="en" data-theme="studio-dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="/app.css">
<style>
/* The app sets these on its shell root, which this page does not mount. Without
   them every piece of text renders with no colour, and a capture would look like
   a component bug rather than a missing harness. */
body { margin: 0; background: var(--surface-1, #0f1115); color: var(--fg); font-family: var(--font-ui, ui-sans-serif, system-ui, sans-serif); font-size: var(--text-md, 13.5px); }
.scene-pad { padding: 16px; max-width: 900px; margin: 0 auto; }
#before { margin-bottom: 8px; }
</style>
</head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  });

  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) throw new Error('❌ no Chromium binary found; this tier is real-browser evidence or nothing');
  browser = await chromium.launch({ executablePath: chrome, headless: true });
});

/**
 * THE SERVER'S KNOBS GO BACK, UNCONDITIONALLY, and a scene-local `finally` is not
 * enough to promise that.
 *
 * Every test that withholds or stalls the bundle assigns the flag and THEN awaits
 * `openScene`, so a rejection while launching a browser context skips the `finally`
 * that would have restored it — and the next scene silently gets a 404 renderer it
 * never asked for, failing for a reason that has nothing to do with its subject.
 * These two lines cost nothing and make that class of contamination impossible.
 * The scene-local resets stay, because they restore the state mid-test rather than
 * only between tests.
 */
afterEach(() => {
  lottieLibraryServable = true;
  libraryStallMs = 0;
});

/**
 * PER FILE, NOT PER RUN — measured with both fy-render integration files in one
 * Bun process, which is how `scripts/ci/test.sh int` runs them: this hook finishes
 * before the sibling file's `beforeAll` starts, so exactly one browser and one
 * server of this file's are ever alive.
 */
afterAll(async () => {
  if (evidenceDir !== null) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(resolve(evidenceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  await browser?.close();
  await server?.stop(true);
});

interface Scene {
  readonly page: Page;
  readonly close: () => Promise<void>;
  /** Captures a PNG when `FY_RENDER_EVIDENCE_DIR` is set, and records the facts. */
  readonly shot: (name: string, facts?: Record<string, unknown>) => Promise<void>;
}

const openScene = async (
  which: string,
  viewport: (typeof VIEWPORTS)[number],
  options: { reducedMotion?: 'reduce' } = {},
): Promise<Scene> => {
  const context = await browser.newContext({
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    reducedMotion: options.reducedMotion ?? 'no-preference',
    viewport: { height: viewport.height, width: viewport.width },
  });
  const page = await context.newPage();
  await page.goto(`${server.url.origin}/?case=${which}`);
  await page.waitForSelector('[data-fy-render-type]');
  return {
    close: async () => await context.close(),
    page,
    shot: async (name, facts = {}) => {
      manifest.push({ case: which, scene: name, viewport: viewport.name, ...facts });
      if (evidenceDir === null) return;
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: resolve(evidenceDir, `${viewport.name}-${name}.png`) });
    },
  };
};

const press = async (page: Page, name: RegExp): Promise<void> => {
  await page.getByRole('button', { name }).first().click();
};

const statusText = async (page: Page): Promise<string> =>
  (await page.locator('[data-fy-render-sandbox-status]').innerText()).trim();

const phase = async (page: Page): Promise<string | null> =>
  await page.locator('[data-fy-render-sandbox-status]').getAttribute('data-fy-render-sandbox-status');

/** Horizontal overflow of the document, which no viewport may have. */
const overflow = async (page: Page): Promise<number> =>
  await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe('fy-render component evidence — the served stylesheet', () => {
  test('should serve the app’s own stylesheet with the fy-render rules intact', () => {
    // Assert — the graph really is the app's. A missing `@import` would make every
    // layout assertion below a measurement of unstyled HTML.
    should(appCss).containEql('.fy-render-frame');
    should(appCss).containEql('.fy-render-status');
    should(appCss).containEql('--target-floor');
    should(appCss).containEql('.kt-fs-why');

    // Assert — and the DYNAMIC units survived bundling. On iOS Safari `vh`
    // resolves against the LARGE viewport, so a bundler that lowered `min(60dvh,
    // 720px)` to `vh` would silently undo the repair while every pixel here still
    // looked right, because headless Chromium has no browser chrome to hide.
    should(appCss).containEql('60dvh');
    should(appCss).not.containEql('max-height:60vh');
    should(appCss).not.containEql('max-height: 60vh');

    // Assert — the frame is refused the pointer. This is the half of the
    // Escape repair that no object-tree test can see.
    should(appCss.replaceAll(' ', '')).containEql('pointer-events:none');
  });
});

describe('fy-render component evidence — Mermaid', () => {
  for (const viewport of VIEWPORTS) {
    test(`should carry a mermaid block from offer to diagram at ${viewport.name}`, async () => {
      // Arrange
      const scene = await openScene('mermaid', viewport);
      const { page, shot } = scene;

      try {
        // Assert — THE OFFER. Nothing has been fetched and no frame exists.
        await page.waitForSelector('[data-fy-render-consent="true"]');
        await shot('mermaid-01-offer', {
          frames: await page.locator('iframe').count(),
          overflow: await overflow(page),
          statusPhase: await phase(page),
        });
        should(await page.locator('iframe').count()).equal(0);
        // The live region exists already, holding nothing, so its first sentence
        // is a CHANGE rather than an insertion.
        should(await phase(page)).equal('idle');
        should(await statusText(page)).be.empty();
        should(await overflow(page)).equal(0);

        // Act — consent, with the renderer deliberately slow so the pending state
        // is long enough to photograph. See `libraryStallMs`.
        libraryStallMs = 2_500;
        await press(page, /Render illustration/);

        // Assert — THE VISIBLE PENDING STATE. This is the repair: the stage used
        // to be a bordered empty plane for up to fifteen seconds with nothing said
        // to anybody at all.
        await page.waitForSelector('[data-fy-render-sandbox-status="preparing"]', { timeout: 10_000 });
        should(await statusText(page)).equal('Preparing the Mermaid renderer…');
        // A frame IS mounted behind the status — replacing it with the note would
        // mean the acknowledgement that ends this state could never arrive.
        should(await page.locator('iframe[data-fy-render-frame="mermaid"]').count()).equal(1);
        await shot('mermaid-02-preparing', { statusText: await statusText(page) });
        // THE CAPTURE MUST SHOW THE STATE IT IS NAMED FOR. Asserted after the
        // screenshot, because the first version of this file shipped an
        // `02-preparing.png` that pictured the finished diagram.
        should(await phase(page)).equal('preparing');
        libraryStallMs = 0;

        // Assert — THE COMPILED DIAGRAM, back through the measured `<img>` sink.
        await page.waitForSelector('img[data-fy-render-diagram="true"]', { timeout: 40_000 });
        await page.waitForTimeout(300);
        const diagram = await page.locator('img[data-fy-render-diagram="true"]').boundingBox();
        await shot('mermaid-03-diagram', {
          diagramBox: diagram,
          frames: await page.locator('iframe').count(),
          overflow: await overflow(page),
          statusText: await statusText(page),
        });
        // The frame is destroyed the moment it yields a diagram, so no live
        // opaque-origin document is left in the transcript.
        should(await page.locator('iframe').count()).equal(0);
        should(await statusText(page)).equal('The Mermaid illustration is ready.');
        should(await overflow(page)).equal(0);
        should(diagram?.width ?? 0).be.above(0);
        // It fits the reading column rather than escaping it.
        should(diagram?.width ?? 0).be.belowOrEqual(viewport.width);

        // Act / Assert — SOURCE beside the diagram.
        await press(page, /Source/);
        await page.waitForSelector('[data-fy-render-source="true"]');
        await shot('mermaid-04-source', { overflow: await overflow(page) });
        should(await overflow(page)).equal(0);
        await press(page, /Source/);

        // Act / Assert — FULLSCREEN, then Exit.
        await press(page, /Fullscreen/);
        await page.waitForSelector('[role="dialog"]');
        await page.waitForTimeout(200);
        await shot('mermaid-05-fullscreen', { overflow: await overflow(page) });
        should(await overflow(page)).equal(0);
        await press(page, /Exit fullscreen/);
        should(await page.locator('[role="dialog"]').count()).equal(0);

        // Act / Assert — RELOAD returns to a compiled diagram, not to the offer.
        await press(page, /Reload/);
        await page.waitForSelector('img[data-fy-render-diagram="true"]', { timeout: 40_000 });
        await page.waitForTimeout(300);
        await shot('mermaid-06-reloaded', { statusText: await statusText(page) });
        should(await statusText(page)).equal('The Mermaid illustration is ready.');
      } finally {
        await scene.close();
      }
    }, 120_000);

    test(`should show a reader sentence and fold the parse dump at ${viewport.name}`, async () => {
      // Arrange — the REACHABLE Mermaid failure. A jison dump quoting a slice of
      // the author's own source with an ASCII caret rule under it used to be the
      // app's main error sentence.
      const scene = await openScene('mermaid-failure', viewport);
      const { page, shot } = scene;

      try {
        // Act
        await press(page, /Render illustration/);
        await page.waitForSelector('[data-fy-render-sandbox-status="failed"]', { timeout: 40_000 });
        await page.waitForTimeout(200);

        // Assert — the sentence is the app's, and it names no library internals.
        const sentence = await page.locator('[data-fy-render-sandbox-status] [role="status"]').innerText();
        should(sentence.trim()).equal(
          'This Mermaid illustration could not be rendered. The authored source is shown below.',
        );
        should(sentence).not.containEql('Parse error');
        should(sentence).not.containEql('^');

        // Assert — and the dump is kept, folded, with a thumb-sized summary.
        const summary = page.locator('.kt-fs-why > summary');
        should(await summary.count()).equal(1);
        const summaryBox = await summary.boundingBox();
        should(summaryBox?.height ?? 0).be.aboveOrEqual(44);
        await shot('mermaid-07-failure-folded', {
          overflow: await overflow(page),
          sentence: sentence.trim(),
          summaryHeight: summaryBox?.height,
        });
        should(await overflow(page)).equal(0);

        // Act — open the fold. The precise wording is there for whoever needs it.
        await summary.click();
        await page.waitForTimeout(150);
        const detail = await page.locator('.fy-render-why-body').innerText();
        should(detail).containEql('Parse error');
        await shot('mermaid-08-failure-unfolded', { detailFirstLine: detail.split('\n')[0] });
        // Opening a wall of machine text must not push the page sideways.
        should(await overflow(page)).equal(0);

        // Assert — the source panel opened as scaffolding for bad bytes.
        should(await page.locator('[data-fy-render-source="true"]').count()).equal(1);
      } finally {
        await scene.close();
      }
    }, 120_000);
  }

  test('should compile an init-directive diagram rather than refuse it', async () => {
    // Arrange — recorded because it is NOT what the docs used to imply. On paper
    // `flowchart.htmlLabels` is reachable from an in-diagram directive and the
    // parent's `<foreignObject>` refusal is what would catch it. Measured against
    // the shipped config, the directive does not defeat the option, so the refusal
    // is a fail-closed guard against a future Mermaid release and no reader sees
    // it. This scene is the evidence for that sentence.
    const scene = await openScene('init-directive', VIEWPORTS[1]);
    const { page, shot } = scene;

    try {
      // Act
      await press(page, /Render illustration/);
      await page.waitForSelector('img[data-fy-render-diagram="true"]', { timeout: 40_000 });
      await page.waitForTimeout(300);

      // Assert — it compiled, and the gate admitted it.
      should(await statusText(page)).equal('The Mermaid illustration is ready.');
      should(await page.locator('[data-fy-render-sandbox-status="failed"]').count()).equal(0);
      // And what reached the page carries no `<foreignObject>`, which is the
      // property the refusal exists for and which the config is delivering.
      const src = await page.locator('img[data-fy-render-diagram="true"]').getAttribute('src');
      should(decodeURIComponent((src ?? '').replace('data:image/svg+xml,', ''))).not.containEql('foreignObject');
      await shot('mermaid-09-init-directive-compiled', { refused: false });
    } finally {
      await scene.close();
    }
  }, 120_000);
});

describe('fy-render component evidence — Lottie', () => {
  for (const viewport of VIEWPORTS) {
    test(`should play, pause and reload a live animation at ${viewport.name}`, async () => {
      // Arrange
      const scene = await openScene('lottie', viewport);
      const { page, shot } = scene;

      try {
        // Assert — the offer names the renderer download, which the authored bytes
        // say nothing about.
        const offer = await page.locator('[data-fy-render-consent="true"]').innerText();
        should(offer).containEql('Lottie renderer');
        await shot('lottie-01-offer', { frames: await page.locator('iframe').count() });
        should(await page.locator('iframe').count()).equal(0);

        // Act — with the renderer deliberately slow, so the pending state is real
        // and long enough to photograph rather than a race.
        libraryStallMs = 2_500;
        await press(page, /Render illustration/);
        await page.waitForSelector('[data-fy-render-sandbox-status="preparing"]', { timeout: 10_000 });
        should(await statusText(page)).equal('Preparing the Lottie renderer…');
        await shot('lottie-02-preparing', { statusText: await statusText(page) });
        // The capture must show the state it is named for.
        should(await phase(page)).equal('preparing');
        libraryStallMs = 0;

        // Assert — READY is the frame's own acknowledgement over the port, not a
        // timer. It used to be discarded, which is why there was nothing to end
        // the wait with.
        await page.waitForSelector('[data-fy-render-sandbox-status="ready"]', { timeout: 40_000 });
        await page.waitForTimeout(900);
        const frame = await page.locator('iframe[data-fy-render-frame="lottie"]').boundingBox();
        await shot('lottie-03-playing', {
          frameBox: frame,
          overflow: await overflow(page),
          statusText: await statusText(page),
        });
        should(await statusText(page)).equal('The Lottie illustration is ready.');
        should(await overflow(page)).equal(0);
        // The stylesheet sizes the frame; the frame never asks for room.
        should(frame?.height ?? 0).be.above(0);
        should(frame?.height ?? 0).be.belowOrEqual(Math.min(viewport.height * 0.6, 720) + 1);

        // Assert — THE FRAME IS UNREACHABLE. `tabIndex={-1}` keeps it out of the
        // tab order and `pointer-events: none` stops a tap putting focus in it.
        // Focus resting in a separate document is what killed Escape.
        should(await page.locator('iframe[data-fy-render-frame="lottie"]').getAttribute('tabindex')).equal('-1');
        await page.mouse.click((frame?.x ?? 0) + (frame?.width ?? 0) / 2, (frame?.y ?? 0) + (frame?.height ?? 0) / 2);
        should(await page.evaluate(() => document.activeElement?.tagName)).not.equal('IFRAME');

        // Act / Assert — PAUSE is a port command, never a remount.
        const before = await page.locator('iframe[data-fy-render-frame="lottie"]').getAttribute('src');
        await press(page, /Pause/);
        await page.waitForTimeout(300);
        await shot('lottie-04-paused', {
          playing: await page.locator('[data-fy-render-playing]').getAttribute('data-fy-render-playing'),
        });
        should(await page.locator('[data-fy-render-playing="false"]').count()).equal(1);
        should(await page.locator('iframe[data-fy-render-frame="lottie"]').getAttribute('src')).equal(before);

        // Act / Assert — and Play again.
        await press(page, /Play/);
        await page.waitForTimeout(300);
        should(await page.locator('[data-fy-render-playing="true"]').count()).equal(1);
        await shot('lottie-05-resumed', { playing: 'true' });

        // Act / Assert — RELOAD is a fresh frame, so the wait starts over.
        await press(page, /Reload/);
        await page.waitForSelector('[data-fy-render-sandbox-status="ready"]', { timeout: 40_000 });
        await page.waitForTimeout(400);
        await shot('lottie-06-reloaded', { statusText: await statusText(page) });
        should(await statusText(page)).equal('The Lottie illustration is ready.');
      } finally {
        await scene.close();
      }
    }, 150_000);
  }

  test('should start paused under a reduce preference, without removing Play', async () => {
    // Arrange — the preference decides whether an animation STARTS; it never takes
    // the control away, because that would be deciding for the reader rather than
    // defaulting for them.
    const scene = await openScene('lottie', VIEWPORTS[0], { reducedMotion: 'reduce' });
    const { page, shot } = scene;

    try {
      // Act
      await press(page, /Render illustration/);
      await page.waitForSelector('[data-fy-render-sandbox-status="ready"]', { timeout: 40_000 });
      await page.waitForTimeout(400);

      // Assert
      should(await page.locator('[data-fy-render-playing="false"]').count()).equal(1);
      should(await page.getByRole('button', { name: 'Play animation' }).count()).equal(1);
      await shot('lottie-07-reduced-motion-paused', { playing: 'false', reducedMotion: 'reduce' });
    } finally {
      await scene.close();
    }
  }, 120_000);

  test('should tear a missing renderer down to a stated sentence, once', async () => {
    // Arrange — the `library` class, end to end in a browser: the parent's own
    // fetch fails, so no author byte was ever involved and blaming the animation
    // would be wrong. The bundle is withheld rather than the animation malformed —
    // see `lottieLibraryServable` for why that matters to a test's runtime.
    lottieLibraryServable = false;
    const scene = await openScene('lottie', VIEWPORTS[0]);
    const { page, shot } = scene;

    try {
      // Act
      await press(page, /Render illustration/);
      await page.waitForSelector('[data-fy-render-sandbox-status="failed"]', { timeout: 40_000 });
      await page.waitForTimeout(200);

      // Assert — the frame is torn down and the sentence names the renderer, not
      // the illustration.
      should(await page.locator('iframe').count()).equal(0);
      const sentence = await page.locator('[data-fy-render-sandbox-status] [role="status"]').innerText();
      should(sentence.trim()).equal('The Lottie renderer could not be loaded. The authored source is shown below.');
      should(await page.locator('[data-fy-render-source="true"]').count()).equal(1);
      // No fold: the parent generated this class itself, so there is no library
      // wording to keep, and an empty disclosure would be a control that reveals
      // nothing.
      should(await page.locator('.kt-fs-why').count()).equal(0);
      // STATED ONCE. The stage renders nothing for a sandbox failure, so
      // `[data-fy-render-error]` matches only the status region — two panels
      // saying the same thing in different words is the defect this replaced.
      should(await page.locator('[data-fy-render-error="true"]').count()).equal(1);

      // Assert — A LOTTIE SOURCE IS ONE ENORMOUS LINE, and it must be reachable
      // rather than merely clipped. The capture of this scene shows the line cut
      // off at the viewport edge, which is correct only because the panel is its
      // own scrollport: the PAGE never scrolls sideways, and the reader can still
      // reach the rest. Were `overflow-x` ever turned to `hidden`, an author's
      // source would be silently truncated with no way to read it and this scene
      // would look identical.
      const panel = await page.evaluate(() => {
        const element = document.querySelector('[data-fy-render-source="true"]');
        if (element === null) return null;
        return {
          clientWidth: element.clientWidth,
          overflowX: getComputedStyle(element).overflowX,
          scrollWidth: element.scrollWidth,
        };
      });
      should(panel?.overflowX).equal('auto');
      should(panel?.scrollWidth ?? 0).be.above(panel?.clientWidth ?? 0);
      await shot('lottie-08-library-missing', {
        overflow: await overflow(page),
        sentence: sentence.trim(),
        sourcePanel: panel,
      });
      should(await overflow(page)).equal(0);
    } finally {
      lottieLibraryServable = true;
      await scene.close();
    }
  }, 120_000);
});

describe('fy-render component evidence — layout and focus', () => {
  for (const viewport of VIEWPORTS) {
    test(`should keep every control on the plane and thumb-sized at ${viewport.name}`, async () => {
      // Arrange — the four-control row is Slice B's, and 390px is where a row that
      // cannot wrap overflows. `docs/fy-render.md` claimed this fits and nothing
      // had ever measured it.
      const scene = await openScene('lottie', viewport);
      const { page, shot } = scene;

      try {
        await press(page, /Render illustration/);
        await page.waitForSelector('[data-fy-render-sandbox-status="ready"]', { timeout: 40_000 });
        await page.waitForTimeout(400);

        // Assert — four controls, none overflowing, none under the touch floor on
        // a coarse pointer. This context is a fine pointer, so the floor here is
        // the desktop one; the coarse-pointer floor is a media query the same
        // stylesheet carries.
        const buttons = page.locator('.fy-render-actions button');
        should(await buttons.count()).equal(4);
        const row = await page.locator('.fy-render-actions').boundingBox();
        const boxes = [];
        for (let index = 0; index < 4; index += 1) {
          const box = await buttons.nth(index).boundingBox();
          boxes.push(box);
          should(box?.height ?? 0).be.above(0);
          // Inside the row's own box in both axes: a control that has escaped the
          // row is what "wraps rather than overflows" is meant to prevent.
          should((box?.x ?? 0) + (box?.width ?? 0)).be.belowOrEqual((row?.x ?? 0) + (row?.width ?? 0) + 1);
        }
        await shot('layout-01-actions', { actionBoxes: boxes, overflow: await overflow(page), rowBox: row });
        should(await overflow(page)).equal(0);
      } finally {
        await scene.close();
      }
    }, 120_000);
  }

  test('should hand focus back to the overlay when a control vanishes under it', async () => {
    // Arrange — the defect this repair exists for, measured where focus is real.
    // Play/Pause is mounted only while the frame is; a sandbox failure removes it
    // while the overlay stays open, and React does not relocate focus.
    // The bundle answers late AND with a 404, so Pause is genuinely on screen and
    // focusable before the failure removes it. Without the stall this test looked
    // for a control that had already gone and failed as a locator timeout.
    lottieLibraryServable = false;
    libraryStallMs = 1_500;
    const scene = await openScene('lottie', VIEWPORTS[1]);
    const { page, shot } = scene;

    try {
      await press(page, /Render illustration/);
      // Fullscreen is available from the consent press, so the overlay can be
      // opened while the frame is still preparing — which is exactly the window
      // in which the failure lands.
      await press(page, /Fullscreen/);
      await page.waitForSelector('[role="dialog"]');

      // FOCUS THE CONTROL THAT WILL BE TAKEN AWAY. Focusing Source instead would
      // make this test pass without the repair, because Source never leaves — the
      // whole defect is that Play/Pause is mounted only while the frame is.
      const pause = page.getByRole('button', { name: /animation/ }).first();
      await pause.focus();
      should(await page.evaluate(() => document.activeElement?.getAttribute('data-fy-render-playing'))).not.be.null();

      // Act — the failure arrives on its own, with no reader action at all.
      await page.waitForSelector('[data-fy-render-sandbox-status="failed"]', { timeout: 40_000 });
      await page.waitForTimeout(300);
      // The control the reader was on is genuinely gone, which is the precondition
      // this test would otherwise be quietly missing.
      should(await page.locator('[data-fy-render-playing]').count()).equal(0);

      // Assert — focus is still INSIDE the modal, never on `<body>`.
      const inside = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return {
          // `=== true` keeps this a strict boolean: an optional chain over a
          // missing dialog yields `undefined`, and `should(...).be.true()` must
          // fail on "there was no dialog" as loudly as on "focus escaped it".
          contained: dialog?.contains(document.activeElement) === true,
          onBody: document.activeElement === document.body,
          tag: document.activeElement?.tagName ?? null,
        };
      });
      should(inside.onBody).be.false();
      should(inside.contained).be.true();
      await shot('focus-01-recovered', inside);

      // Assert — and Escape still closes, from wherever focus landed. That is the
      // half the trap could not deliver once focus left the container.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      should(await page.locator('[role="dialog"]').count()).equal(0);
      await shot('focus-02-escaped', { dialogs: 0 });
    } finally {
      lottieLibraryServable = true;
      libraryStallMs = 0;
      await scene.close();
    }
  }, 120_000);

  test('should return focus to the control that opened the overlay', async () => {
    // Arrange — the other half of the contract: a dialog you can open from the
    // keyboard and then not get back out of is worse than no dialog.
    const scene = await openScene('mermaid', VIEWPORTS[1]);
    const { page, shot } = scene;

    try {
      await press(page, /Render illustration/);
      await page.waitForSelector('img[data-fy-render-diagram="true"]', { timeout: 40_000 });
      const trigger = page.getByRole('button', { name: /Fullscreen/ }).first();
      await trigger.focus();
      await trigger.press('Enter');
      await page.waitForSelector('[role="dialog"]');

      // Act
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // Assert — back on the trigger, and the page behind it never scrolled.
      should(await page.locator('[role="dialog"]').count()).equal(0);
      should(await page.evaluate(() => document.activeElement?.textContent)).containEql('Fullscreen');
      await shot('focus-03-restored', { overflow: await overflow(page) });
      should(await overflow(page)).equal(0);
    } finally {
      await scene.close();
    }
  }, 120_000);
});
