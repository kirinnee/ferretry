/**
 * The REAL `FyRenderBlock`, in real Chromium, at both required viewports.
 *
 * WHY THIS FILE EXISTS. The unit tier renders to a plain object tree or to
 * happy-dom, so it cannot see whether a stylesheet rule takes effect, whether the
 * hidden corner tools really are hidden and really appear, whether a touch target
 * clears 44px, or where focus goes. Those are exactly the claims the inline
 * presentation makes, so they are measured here.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT. Real: the shipped `FyRenderBlock` and
 * `FyRenderSandbox`, the generated shell and its hash-pinned CSP built by the real
 * builder, the two real library bundles, and the app's whole stylesheet graph
 * bundled from `src/styles/index.css`. The block sits inside an `.md` column, as it
 * does in a transcript, so the fallback code block wears the ordinary fence's
 * styling. Not real: the app shell — no daemon, no routing.
 *
 * THE STYLESHEET IS BUILT, NEVER READ FROM `dist/`. A test whose fidelity depends
 * on whether somebody ran `bun run build` first is not evidence.
 *
 * IT IS ALSO THE EVIDENCE DRIVER. Set `FY_RENDER_EVIDENCE_DIR` and every scene
 * writes a PNG and a `manifest.json` there, outside the repository.
 *
 * CHROMIUM ONLY, AND THAT IS A STATED LIMIT. Playwright's bundled WebKit is not
 * Safari; the real macOS `safaridriver` proof is a separate release gate.
 *
 * NOT CAPTURED HERE: a Lottie or `html` `lifetime` stop (minutes of wall-clock by
 * design; the presentation is unit-proven against the value the watchdog emits),
 * and an `%%{init}%%` directive being refused — measured, it is not refused, and
 * the `init-directive` scene asserts it compiles.
 */
import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import should from 'should';
import { fakeTilePng } from '../support/fake-tile.ts';
import { FY_RENDER_VISUAL_CASES } from './fixtures/fy-render-visual-cases.ts';
import { THEME_FAMILIES } from '../../src/lib/theme-preferences.ts';
import { sharedChromium } from './support/chromium.ts';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

/** Set to capture PNGs. Never inside the repository — the artifacts are not source. */
const evidenceDir = process.env.FY_RENDER_EVIDENCE_DIR ?? null;

/** The two viewports `docs/fy-render.md` makes layout claims about. */
const VIEWPORTS = [
  { height: 844, name: '390x844', width: 390 },
  { height: 900, name: '1440x900', width: 1_440 },
] as const;

/**
 * THE FIXTURES LIVE APART FROM THIS FILE, in `fixtures/fy-render-visual-cases.ts`,
 * because the browser scene needs the same strings and a fixture that differs
 * between the driver and the page is evidence of nothing. That module imports no
 * React and no DOM, so reading it here pulls no component graph into the test
 * runner — which is exactly what the fixture boundary below exists to prevent.
 *
 * Reading them here is not decoration: `openScene` checks the name it is given
 * against this map, so a renamed or mistyped fixture fails in the driver with a
 * sentence rather than as a blank page whose `throw` happened inside the scene.
 */
const caseNames = new Set(Object.keys(FY_RENDER_VISUAL_CASES));

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

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
/** Every scene's recorded facts, written next to the PNGs. */
const manifest: Record<string, unknown>[] = [];

let appCss = '';

beforeAll(async () => {
  /**
   * EVERY INPUT COMES FROM A CHILD PROCESS, and this file compiles nothing.
   *
   * It used to call `Bun.build` three times here — the shell generator, the app
   * stylesheet, and a scene entry it first WROTE into `.artifacts/`. That last one
   * traverses the real component graph, and two reviewers independently pinned it
   * as the operation that never returned when this file runs together with
   * `fy-render-sandbox.security.test.ts` — which is how `scripts/ci/test.sh int`
   * runs them, one Bun process for every integration file. It did not fail; it
   * wedged, asleep with no Chromium alive, consuming the job timeout.
   *
   * The loader spawns the builder instead. Everything below is read from a private
   * `mkdtemp` directory that was freshly built for this run: no `public/`, no
   * `dist/`, no repository scratch write, and nothing in this process that a
   * compiler can hang.
   */
  // THE BROWSER FIRST — see `support/chromium.ts` and the sibling file's identical
  // ordering. One memoised launch, reached the same way from both files.
  browser = await sharedChromium();

  const fixture = await fyRenderIntegrationFixture();
  const shell = fixture.shell;
  const mermaidBundle = fixture.mermaid;
  const lottieBundle = fixture.lottie;
  appCss = fixture.appCss;
  const app = fixture.appJs;

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
        return answer();
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
html[data-theme$="light"] body { background: #fafafa; color: #15171c; }
</style>
</head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  });
});

/**
 * THE SERVER'S KNOBS GO BACK, UNCONDITIONALLY, and a scene-local `finally` is not
 * enough to promise that.
 *
 * Every test that withholds the bundle assigns the flag and THEN awaits
 * `openScene`, so a rejection while launching a browser context skips the `finally`
 * that would have restored it — and the next scene silently gets a 404 renderer it
 * never asked for, failing for a reason that has nothing to do with its subject.
 * This line costs nothing and makes that class of contamination impossible.
 * The scene-local reset stays, because it restores the state mid-test rather than
 * only between tests.
 */
afterEach(() => {
  lottieLibraryServable = true;
});

/**
 * THIS FILE'S SERVER GOES; THE BROWSER DOES NOT — see `support/chromium.ts`. It
 * belongs to the process, and closing it here would restore the relaunch that
 * wedges the combined run. Every scene closes its own context, which is where
 * isolation lives.
 */
afterAll(async () => {
  if (evidenceDir !== null) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(resolve(evidenceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  await server?.stop(true);
});

interface Scene {
  readonly page: Page;
  readonly close: () => Promise<void>;
  /** Every request the page made to an origin other than this test's own server, in order. */
  readonly outside: string[];
  /** Captures a PNG when `FY_RENDER_EVIDENCE_DIR` is set, and records the facts. */
  readonly shot: (name: string, facts?: Record<string, unknown>) => Promise<void>;
}

const openScene = async (
  which: string,
  viewport: (typeof VIEWPORTS)[number],
  options: { reducedMotion?: 'reduce'; theme?: 'light' | 'dark'; themeName?: string } = {},
): Promise<Scene> => {
  if (!caseNames.has(which)) throw new Error(`no such fy-render fixture: ${which}`);
  const context = await browser.newContext({
    colorScheme: options.theme ?? 'dark',
    deviceScaleFactor: 2,
    reducedMotion: options.reducedMotion ?? 'no-preference',
    /**
     * A REAL PHONE CONTEXT AT THE PHONE VIEWPORT, which the first version of this
     * file did not have. Without `isMobile`/`hasTouch`, `(pointer: coarse)` is
     * false, `--target-floor` stays `0px`, and every action button measured 24px
     * high — so a test titled "thumb-sized at 390x844" asserted only that the
     * height was above zero. `harness/screenshot.ts` already defines this shape for
     * the same reason. At 1440x900 the fine-pointer context is the correct one.
     *
     * The user agent travels WITH `isMobile`, matching `harness/screenshot.ts`
     * exactly: `isMobile` alone leaves a desktop UA in place, and this repository
     * has already been bitten by phone captures that rendered the desktop journey.
     */
    ...(viewport.width <= 480
      ? {
          hasTouch: true,
          isMobile: true,
          userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        }
      : {}),
    viewport: { height: viewport.height, width: viewport.width },
  });
  const page = await context.newPage();
  // A map's tiles are the one remote load a block makes. They are answered here, never fetched: a test that
  // reached a real tile server would depend on the network and on that provider's goodwill.
  const outside: string[] = [];
  page.on('request', request => {
    if (!request.url().startsWith(server.url.origin) && !request.url().startsWith('data:')) outside.push(request.url());
  });
  await page.route('https://tile.openstreetmap.org/**', route =>
    route.fulfill({ body: Buffer.from(fakeTilePng()), contentType: 'image/png' }),
  );
  const theme =
    options.themeName !== undefined
      ? `&theme=${options.themeName}`
      : options.theme === 'light'
        ? '&theme=studio-light'
        : '';
  await page.goto(`${server.url.origin}/?case=${which}${theme}`);
  await page.waitForSelector('[data-fy-render-type]');
  return {
    close: async () => await context.close(),
    outside,
    page,
    shot: async (name, facts = {}) => {
      manifest.push({ case: which, scene: name, viewport: viewport.name, ...facts });
      if (evidenceDir === null) return;
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: resolve(evidenceDir, `${viewport.name}-${name}.png`) });
    },
  };
};

/** Horizontal overflow of the document, which no viewport may have. */
const overflow = async (page: Page): Promise<number> =>
  await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The corner tools' computed opacity — `0` until hover, focus or a long press. */
const toolsOpacity = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    const tools = document.querySelector('.fy-render-tools');
    return tools === null ? -1 : Number(getComputedStyle(tools).opacity);
  });

/** Lets the tools' 120 ms fade settle before a reading or a capture. */
const settleFade = async (page: Page): Promise<void> => {
  await page.waitForTimeout(250);
};

const waitForMermaidDiagram = async (page: Page): Promise<void> => {
  const terminal = await page.waitForFunction(
    () => {
      if (document.querySelector('img[data-fy-render-diagram="true"]') !== null) return { kind: 'diagram' };
      const failed = document.querySelector('[data-fy-render-failure]');
      return failed === null ? null : { kind: 'failed', why: failed.getAttribute('data-fy-render-failure') };
    },
    { timeout: 40_000 },
  );
  const outcome = (await terminal.jsonValue()) as { readonly kind: string; readonly why?: string };
  if (outcome.kind === 'failed') throw new Error(`Mermaid fell back instead of drawing: ${outcome.why}`);
};

describe('fy-render component evidence — the served stylesheet', () => {
  test('should serve the app’s own stylesheet with the fy-render rules intact', () => {
    // Assert — the graph really is the app's, and the dynamic units survived bundling.
    should(appCss).containEql('.fy-render-tools');
    should(appCss).containEql('--target-floor');
    should(appCss).containEql('60dvh');
    should(appCss).not.containEql('max-height:60vh');
    should(appCss).not.containEql('max-height: 60vh');

    // Scoped to the rule: the library frame takes no pointer, so focus can never
    // rest in a separate document and swallow Escape.
    const frameRule = /\.fy-render-frame\s*\{[^}]*\}/u.exec(appCss)?.[0] ?? '';
    should(frameRule.replaceAll(' ', '')).containEql('pointer-events:none');
    // And the tools start invisible.
    const toolsRule = /\.fy-render-tools\s*\{[^}]*\}/u.exec(appCss)?.[0] ?? '';
    should(toolsRule.replaceAll(' ', '')).containEql('opacity:0');
  });
});

describe('fy-render component evidence — Mermaid', () => {
  for (const viewport of VIEWPORTS) {
    test(`should draw a diagram by itself, inline, with no chrome at ${viewport.name}`, async () => {
      // Arrange
      const scene = await openScene('mermaid', viewport);
      const { page, shot } = scene;

      try {
        // Assert — nothing to press: it renders, and the frame that compiled it is gone.
        should(await page.getByRole('button', { name: /Render/ }).count()).equal(0);
        await waitForMermaidDiagram(page);
        await page.waitForTimeout(300);
        const diagram = await page.locator('img[data-fy-render-diagram="true"]').boundingBox();
        await shot('mermaid-01-inline', { diagramBox: diagram, overflow: await overflow(page) });
        should(await page.locator('iframe').count()).equal(0);
        should(await page.locator('figcaption').count()).equal(0);
        should(await page.locator('[role="status"]').count()).equal(0);
        should(await page.locator('img[data-fy-render-diagram="true"]').getAttribute('alt')).equal(
          'How an fy-render block reaches the reader',
        );
        should(await overflow(page)).equal(0);
        should(diagram?.width ?? 0).be.above(0);
        // The picture may be wider than the column (it pans in its own box); the BOX never is.
        const scrollBox = await page.locator('.fy-render-diagram').boundingBox();
        should(scrollBox?.width ?? 0).be.belowOrEqual(viewport.width);
        // No surface, no border: the figure paints nothing of its own.
        const figure = await page.evaluate(() => {
          const element = document.querySelector('figure.fy-render');
          return element === null
            ? null
            : {
                background: getComputedStyle(element).backgroundColor,
                border: getComputedStyle(element).borderTopWidth,
              };
        });
        should(figure).eql({ background: 'rgba(0, 0, 0, 0)', border: '0px' });

        // Assert — the tools are there but invisible until asked for.
        should(await toolsOpacity(page)).equal(0);
        if (viewport.width > 480) {
          await page.locator('figure.fy-render').hover();
        } else {
          // A long press on touch: a press held still.
          await page.locator('figure.fy-render').dispatchEvent('pointerdown', { pointerType: 'touch' });
          await page.waitForTimeout(600);
        }
        await settleFade(page);
        should(await toolsOpacity(page)).equal(1);
        await shot('mermaid-02-tools', { tools: await page.locator('.fy-render-tool').count() });

        // Act / Assert — Source, then Fullscreen and Exit.
        await page.getByRole('button', { name: 'Mermaid source' }).click();
        await page.waitForSelector('[data-fy-render-source="true"]');
        await shot('mermaid-03-source', { overflow: await overflow(page) });
        should(await overflow(page)).equal(0);
        await page.getByRole('button', { name: 'Mermaid source' }).click();
        await page.getByRole('button', { name: 'Fullscreen' }).click();
        await page.waitForSelector('[role="dialog"]');
        await page.waitForTimeout(200);
        await shot('mermaid-04-fullscreen', { overflow: await overflow(page) });
        should(await overflow(page)).equal(0);
        await page.getByRole('button', { name: 'Exit fullscreen' }).click();
        should(await page.locator('[role="dialog"]').count()).equal(0);
      } finally {
        await scene.close();
      }
    }, 120_000);
  }

  test('should fall back to the ordinary code block, quietly, when Mermaid refuses the source', async () => {
    // Arrange
    const scene = await openScene('mermaid-failure', VIEWPORTS[0]);
    const { page, shot } = scene;

    try {
      // Act
      await page.waitForSelector('[data-fy-render-failure="render"]', { timeout: 40_000 });
      await page.waitForTimeout(200);

      // Assert — the source as a fence, no sentence in the app's voice, the parse
      // dump kept as a title for whoever is debugging.
      should(await page.locator('[data-fy-render-error="true"] pre').count()).equal(1);
      should(await page.locator('[role="status"]').count()).equal(0);
      should(await page.locator('[data-fy-render-error="true"]').getAttribute('title')).containEql('Parse error');
      // Bytes Mermaid refused would only be refused again, so there is no retry.
      should(await page.getByRole('button', { name: /Try rendering again/ }).count()).equal(0);
      await shot('mermaid-05-fallback', { overflow: await overflow(page) });
      should(await overflow(page)).equal(0);
    } finally {
      await scene.close();
    }
  }, 120_000);

  test('should compile an init-directive diagram rather than refuse it', async () => {
    // Arrange — measured against the shipped config, the directive does not defeat
    // `htmlLabels: false`, so the parent's `<foreignObject>` refusal is a fail-closed
    // guard against a future Mermaid release and no reader sees it.
    const scene = await openScene('init-directive', VIEWPORTS[1]);
    const { page } = scene;

    try {
      // Act
      await waitForMermaidDiagram(page);

      // Assert
      const src = await page.locator('img[data-fy-render-diagram="true"]').getAttribute('src');
      should(decodeURIComponent((src ?? '').replace('data:image/svg+xml,', ''))).not.containEql('foreignObject');
    } finally {
      await scene.close();
    }
  }, 120_000);
});

describe('fy-render component evidence — Lottie', () => {
  test('should play by itself in an unreachable frame, and pause from its tool without a remount', async () => {
    // Arrange
    const scene = await openScene('lottie', VIEWPORTS[1]);
    const { page, shot } = scene;

    try {
      await page.waitForSelector('[data-fy-render-playing="true"]', { state: 'attached', timeout: 40_000 });
      await page.waitForTimeout(900);
      const frame = await page.locator('iframe[data-fy-render-frame="lottie"]').boundingBox();
      await shot('lottie-01-playing', { frameBox: frame, overflow: await overflow(page) });
      should(await overflow(page)).equal(0);
      should(frame?.height ?? 0).be.above(0);
      should(frame?.height ?? 0).be.belowOrEqual(Math.min(900 * 0.6, 720) + 1);

      // Assert — THE FRAME IS UNREACHABLE: a click on it does not put focus in it.
      should(await page.locator('iframe[data-fy-render-frame="lottie"]').getAttribute('tabindex')).equal('-1');
      await page.mouse.click((frame?.x ?? 0) + (frame?.width ?? 0) / 2, (frame?.y ?? 0) + (frame?.height ?? 0) / 2);
      should(await page.evaluate(() => document.activeElement?.tagName)).not.equal('IFRAME');

      // Act — pause from the corner tool.
      const before = await page.locator('iframe[data-fy-render-frame="lottie"]').getAttribute('src');
      await page.locator('figure.fy-render').hover();
      await page.getByRole('button', { name: 'Pause animation' }).click();
      await page.waitForTimeout(300);

      // Assert — a port command, never a remount; and the tools stay up while paused.
      should(await page.locator('[data-fy-render-playing="false"]').count()).equal(1);
      should(await page.locator('iframe[data-fy-render-frame="lottie"]').getAttribute('src')).equal(before);
      await page.mouse.move(0, 0);
      await settleFade(page);
      should(await toolsOpacity(page)).equal(1);
      await shot('lottie-02-paused', { playing: 'false' });
    } finally {
      await scene.close();
    }
  }, 120_000);

  test('should start paused under a reduce preference, with Play visible', async () => {
    // Arrange
    const scene = await openScene('lottie', VIEWPORTS[0], { reducedMotion: 'reduce' });
    const { page, shot } = scene;

    try {
      // Act
      await page.waitForSelector('[data-fy-render-playing]', { state: 'attached', timeout: 40_000 });
      await settleFade(page);

      // Assert — Play is not behind a hover the reader may not have.
      should(await page.locator('[data-fy-render-playing="false"]').count()).equal(1);
      should(await page.getByRole('button', { name: 'Play animation' }).count()).equal(1);
      should(await toolsOpacity(page)).equal(1);
      await shot('lottie-03-reduced-motion', { reducedMotion: 'reduce' });
    } finally {
      await scene.close();
    }
  }, 120_000);

  test('should fall back to a code block that scrolls inside itself when the renderer is missing', async () => {
    // Arrange — the `library` class: the parent's own fetch fails.
    lottieLibraryServable = false;
    const scene = await openScene('lottie', VIEWPORTS[0]);
    const { page, shot } = scene;

    try {
      // Act
      await page.waitForSelector('[data-fy-render-failure="library"]', { timeout: 40_000 });

      // Assert — a Lottie source is one enormous line, and it must be reachable
      // rather than clipped: the fence is its own scrollport and the page never
      // scrolls sideways.
      should(await page.locator('iframe').count()).equal(0);
      const pre = await page.evaluate(() => {
        const element = document.querySelector('[data-fy-render-error="true"] pre');
        return element === null
          ? null
          : {
              clientWidth: element.clientWidth,
              overflowX: getComputedStyle(element).overflowX,
              scrollWidth: element.scrollWidth,
            };
      });
      should(pre?.overflowX).equal('auto');
      should(pre?.scrollWidth ?? 0).be.above(pre?.clientWidth ?? 0);
      await shot('lottie-04-fallback', { overflow: await overflow(page), pre });
      should(await overflow(page)).equal(0);

      // Act — the renderer comes back, and the reader retries.
      lottieLibraryServable = true;
      await page.getByRole('button', { name: /Try rendering again/ }).click();

      // Assert
      await page.waitForSelector('iframe[data-fy-render-frame="lottie"]', { timeout: 40_000 });
      should(await page.locator('[data-fy-render-error="true"]').count()).equal(0);
    } finally {
      lottieLibraryServable = true;
      await scene.close();
    }
  }, 120_000);
});

describe('fy-render component evidence — layout and focus', () => {
  for (const viewport of VIEWPORTS) {
    test(`should keep the tools inside the picture and thumb-sized on touch at ${viewport.name}`, async () => {
      // Arrange
      const scene = await openScene('mermaid', viewport);
      const { page, shot } = scene;

      try {
        await waitForMermaidDiagram(page);
        const coarse = viewport.width <= 480;
        should(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).equal(coarse);

        // Assert — 44px on a coarse pointer, small on a fine one, and inside the stage.
        const stage = await page.locator('.fy-render-stage').boundingBox();
        const buttons = page.locator('.fy-render-tool');
        should(await buttons.count()).equal(2);
        const boxes = [];
        for (let index = 0; index < 2; index += 1) {
          const box = await buttons.nth(index).boundingBox();
          boxes.push(box);
          if (coarse) should(box?.height ?? 0).be.aboveOrEqual(44);
          else should(box?.height ?? 0).be.below(44);
          should((box?.x ?? 0) + (box?.width ?? 0)).be.belowOrEqual((stage?.x ?? 0) + (stage?.width ?? 0) + 1);
          should(box?.y ?? 0).be.aboveOrEqual(stage?.y ?? 0);
        }
        await shot('layout-01-tools', { boxes, coarse, overflow: await overflow(page), stage });
        should(await overflow(page)).equal(0);
      } finally {
        await scene.close();
      }
    }, 120_000);
  }

  test('should show a hidden tool the moment it takes keyboard focus, and return focus to it', async () => {
    // Arrange
    const scene = await openScene('mermaid', VIEWPORTS[1]);
    const { page, shot } = scene;

    try {
      await waitForMermaidDiagram(page);
      const trigger = page.getByRole('button', { name: 'Fullscreen' });

      // Act — the keyboard reaches a tool nobody hovered.
      await trigger.focus();
      await settleFade(page);

      // Assert — visible on focus, not only on hover.
      should(await toolsOpacity(page)).equal(1);

      // Act — open, then Escape.
      await trigger.press('Enter');
      await page.waitForSelector('[role="dialog"]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // Assert — back on the trigger.
      should(await page.locator('[role="dialog"]').count()).equal(0);
      should(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).equal('Fullscreen');
      await shot('focus-01-restored', { overflow: await overflow(page) });
    } finally {
      await scene.close();
    }
  }, 120_000);
});

describe('fy-render component evidence — Map', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`should draw an interactive map with markers and a route, ${theme}, at ${viewport.name}`, async () => {
        // Arrange
        const scene = await openScene('map', viewport, { theme });
        const { outside, page, shot } = scene;

        try {
          // Act — nothing to press: the map is near the viewport, so it draws by itself.
          await page.waitForSelector('[data-fy-render-map="drawn"]', { timeout: 40_000 });
          await page.waitForSelector('img.leaflet-tile-loaded');
          await page.waitForTimeout(500);

          // Assert — pins, one route, loaded tiles, and the reader's mode.
          should(await page.locator('.fy-map-pin').count()).equal(3);
          should(await page.locator('.leaflet-overlay-pane path').count()).equal(1);
          should(await page.locator('[data-fy-render-map]').getAttribute('data-fy-render-map-mode')).equal(theme);
          const filter = await page.evaluate(
            () => getComputedStyle(document.querySelector('.leaflet-tile-pane') as Element).filter,
          );
          should(filter === 'none').equal(theme === 'light');
          const box = await page.locator('.fy-render-map').boundingBox();
          should(box?.height ?? 0).be.above(180);
          should(box?.width ?? 0).be.belowOrEqual(viewport.width);
          should(await overflow(page)).equal(0);
          // The tile host is the only origin the page reached, and only ever for tiles.
          should(outside.length).be.above(0);
          should(outside.every(url => url.startsWith('https://tile.openstreetmap.org/'))).be.true();
          should(await page.locator('iframe').count()).equal(0);
          await shot(`map-01-${theme}`, { overflow: await overflow(page), tiles: outside.length });
        } finally {
          await scene.close();
        }
      }, 120_000);
    }
  }

  test('should open a popup on a tap and zoom from its own buttons', async () => {
    // Arrange
    const scene = await openScene('map', VIEWPORTS[1], { theme: 'light' });
    const { page, shot } = scene;

    try {
      await page.waitForSelector('[data-fy-render-map="drawn"]', { timeout: 40_000 });
      await page.waitForSelector('img.leaflet-tile-loaded');
      const zoomOf = async (): Promise<number> =>
        await page.evaluate(() => {
          const tile = document.querySelector<HTMLImageElement>('img.leaflet-tile');
          return Number(tile?.src.split('/').at(-3));
        });
      const before = await zoomOf();

      // Act — tap a pin that has a popup.
      await page.locator('.fy-map-pin').first().click();
      await page.waitForSelector('.fy-map-popup');
      await page.waitForTimeout(500);
      await shot('map-02-popup');

      // Assert — the popup is text in the page, and Zoom in asks for closer tiles.
      should(await page.locator('.fy-map-popup-title').first().textContent()).equal('Big Ben');
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await page.waitForFunction(
        previous =>
          Number(document.querySelector<HTMLImageElement>('img.leaflet-tile')?.src.split('/').at(-3)) > previous,
        before,
      );
      should(await zoomOf()).be.above(before);

      // Act / Assert — Fullscreen gives the map the whole window and Exit returns it.
      await page.getByRole('button', { name: 'Fullscreen' }).click();
      await page.waitForSelector('[role="dialog"]');
      await page.waitForTimeout(400);
      should(await page.locator('[role="dialog"] .leaflet-container').count()).equal(1);
      should(await overflow(page)).equal(0);
      await shot('map-03-fullscreen');
      await page.getByRole('button', { name: 'Exit fullscreen' }).click();
      should(await page.locator('[role="dialog"]').count()).equal(0);
    } finally {
      await scene.close();
    }
  }, 120_000);
});

/**
 * A theme token as the page resolves it, the way `fy-render-theme.ts` does: painted on one pixel of a
 * canvas and read back, so the test compares against the browser's own answer rather than a copy of
 * `themes.css`.
 */
const resolvedToken = async (page: Page, token: string): Promise<string> =>
  await page.evaluate(name => {
    const raw = getComputedStyle(document.querySelector('figure.fy-render') ?? document.documentElement)
      .getPropertyValue(`--${name}`)
      .trim();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = raw;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
  }, token);

/** How many of the chart canvas's pixels are exactly this colour: proof the theme is what painted it. */
const pixelsOf = async (page: Page, hex: string): Promise<number> =>
  await page.evaluate(colour => {
    const canvas = document.querySelector('.fy-render-chart canvas') as HTMLCanvasElement;
    const data = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;
    const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(colour.slice(at, at + 2), 16));
    let count = 0;
    for (let index = 0; index < data.length; index += 4)
      if (data[index] === r && data[index + 1] === g && data[index + 2] === b && data[index + 3] === 255) count += 1;
    return count;
  }, hex);

const waitForChart = async (page: Page): Promise<void> => {
  await page.waitForSelector('[data-fy-render-chart="drawn"]', { timeout: 40_000 });
  // The draw animation is 420 ms; a capture before it ends shows half-grown bars.
  await page.waitForTimeout(700);
};

describe('fy-render component evidence — Chart', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`should draw a stacked bar chart in the theme’s own colours, ${theme}, at ${viewport.name}`, async () => {
        // Arrange
        const scene = await openScene('chart-bar', viewport, { theme });
        const { outside, page, shot } = scene;

        try {
          // Act — nothing to press: it is near, so it draws by itself.
          await waitForChart(page);

          // Assert — painted by the theme: the first series is the first palette slot, the muted series the
          // muted token, both found as exact pixels on the canvas.
          const first = await resolvedToken(page, 'viz-1');
          const muted = await resolvedToken(page, 'muted');
          should(await pixelsOf(page, first)).be.above(200);
          should(await pixelsOf(page, muted)).be.above(50);
          // In the page, not a frame; nothing fetched from anywhere; no sideways scroll.
          should(await page.locator('iframe').count()).equal(0);
          should(outside).eql([]);
          should(await overflow(page)).equal(0);
          const box = await page.locator('.fy-render-chart-plot').boundingBox();
          should(box?.width ?? 0).be.belowOrEqual(viewport.width);
          should(box?.height ?? 0).be.aboveOrEqual(200);
          // Named for a screen reader, with the numbers behind it.
          should(await page.locator('canvas[role="img"]').getAttribute('aria-label')).equal(
            'Chart: Warden spend per day, by kind of work',
          );
          should(await page.locator('.fy-render-chart-data tbody tr').count()).equal(7);
          // ...and that table is clipped to nothing: a transcript's `.md table` must not paint it over the canvas.
          const table = await page.locator('.fy-render-chart-data').boundingBox();
          should(table?.width ?? 99).be.belowOrEqual(1);
          // Nor give the legend list bullets.
          should(
            await page.evaluate(
              () => getComputedStyle(document.querySelector('.fy-render-chart-legend') as Element).listStyleType,
            ),
          ).equal('none');
          should(await page.locator('.fy-render-chart-title').textContent()).equal('Warden spend');
          await shot(`chart-01-bar-${theme}`, { first, muted, overflow: await overflow(page) });

          // Act — a tooltip, by hover or by tap.
          const plot = (await page.locator('.fy-render-chart-plot canvas').boundingBox()) as {
            x: number;
            y: number;
            width: number;
            height: number;
          };
          const at = { x: plot.x + plot.width * 0.62, y: plot.y + plot.height * 0.6 };
          if (viewport.width <= 480) await page.touchscreen.tap(at.x, at.y);
          else await page.mouse.move(at.x, at.y);
          await page.waitForTimeout(400);
          await shot(`chart-02-tooltip-${theme}`);

          // Act — the legend hides a series, and says so.
          const key = page.getByRole('button', { name: 'Reports' });
          await key.click();
          await page.waitForTimeout(600);

          // Assert
          should(await key.getAttribute('aria-pressed')).equal('false');
          await shot(`chart-03-legend-${theme}`);
        } finally {
          await scene.close();
        }
      }, 120_000);
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`should step through a frames chart with buttons and the keyboard, ${theme}, at ${viewport.name}`, async () => {
        // Arrange
        const scene = await openScene('chart-frames', viewport, { theme });
        const { page, shot } = scene;

        try {
          await waitForChart(page);
          const step = page.locator('output.fy-render-chart-step');
          should(await step.textContent()).equal('1 / 3 One worker');
          should(await page.getByRole('button', { name: 'Previous step' }).isDisabled()).be.true();
          await shot(`chart-04-frames-1-${theme}`, { overflow: await overflow(page) });
          should(await overflow(page)).equal(0);

          // Act — Next.
          await page.getByRole('button', { name: 'Next step' }).click();
          await page.waitForTimeout(700);

          // Assert — the frame's own title and series.
          should(await step.textContent()).equal('2 / 3 Four workers');
          should(await page.locator('.fy-render-chart-title').textContent()).equal('Queue depth, four workers');
          await shot(`chart-05-frames-2-${theme}`);

          // Act — the slider, from the keyboard.
          await page.getByRole('slider', { name: 'Step' }).focus();
          await page.keyboard.press('ArrowRight');
          await page.waitForTimeout(700);

          // Assert
          should(await step.textContent()).equal('3 / 3 Autoscaled');
          should(await page.getByRole('button', { name: 'Next step' }).isDisabled()).be.true();
          should(await page.locator('.fy-render-chart-data caption').textContent()).equal(
            'Data: Queue depth as workers are added — Autoscaled',
          );
          await shot(`chart-06-frames-3-${theme}`);
        } finally {
          await scene.close();
        }
      }, 120_000);
    }
  }

  test('should zoom a line chart with a dragged box on a mouse, and reset it', async () => {
    // Arrange
    const scene = await openScene('chart-frames', VIEWPORTS[1], { theme: 'light' });
    const { page, shot } = scene;

    try {
      await waitForChart(page);
      const plot = (await page.locator('.fy-render-chart-plot canvas').boundingBox()) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };

      // Act — drag a box across the middle of the x axis.
      await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(plot.x + plot.width * 0.65, plot.y + plot.height * 0.5, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(600);

      // Assert — zoomed, with a way back.
      const reset = page.getByRole('button', { name: 'Reset zoom' });
      should(await reset.count()).equal(1);
      await shot('chart-07-zoomed');
      await reset.click();
      await page.waitForTimeout(300);
      should(await reset.count()).equal(0);
    } finally {
      await scene.close();
    }
  }, 120_000);

  test('should leave one finger to the page’s scroll on a phone, inline', async () => {
    // Arrange
    const scene = await openScene('chart-frames', VIEWPORTS[0], { theme: 'dark' });
    const { page } = scene;

    try {
      await waitForChart(page);

      // Assert — nothing bound a gesture to the canvas, so the browser keeps its own touch handling.
      const touchAction = await page.evaluate(
        () => getComputedStyle(document.querySelector('.fy-render-chart canvas') as Element).touchAction,
      );
      should(['auto', 'manipulation']).containEql(touchAction);
    } finally {
      await scene.close();
    }
  }, 120_000);

  for (const theme of ['light', 'dark'] as const) {
    test(`should draw a doughnut, a palette slice per label, ${theme}`, async () => {
      // Arrange
      const scene = await openScene('chart-doughnut', VIEWPORTS[1], { theme });
      const { page, shot } = scene;

      try {
        await waitForChart(page);

        // Assert — every slice is a palette slot, in order, and the legend names the slices.
        for (const slot of ['viz-1', 'viz-2', 'viz-3', 'viz-4'])
          should(await pixelsOf(page, await resolvedToken(page, slot))).be.above(100);
        should(await page.locator('.fy-render-chart-key').allTextContents()).eql([
          'Planning',
          'Implementation',
          'Review',
          'Chores',
        ]);
        await shot(`chart-08-doughnut-${theme}`);
      } finally {
        await scene.close();
      }
    }, 120_000);
  }

  test('should repaint in the new palette when the reader switches theme, on screen', async () => {
    // Arrange
    const scene = await openScene('chart-bar', VIEWPORTS[1], { themeName: 'studio-dark' });
    const { page, shot } = scene;

    try {
      await waitForChart(page);
      const before = await page.locator('[data-fy-render-chart]').getAttribute('data-fy-render-chart-palette');

      // Act — a different family in the same mode: "dark" alone would not notice.
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'mission-dark'));
      await page.waitForFunction(
        previous =>
          document.querySelector('[data-fy-render-chart]')?.getAttribute('data-fy-render-chart-palette') !== previous,
        before,
      );
      await page.waitForTimeout(700);

      // Assert
      should(await pixelsOf(page, await resolvedToken(page, 'viz-1'))).be.above(200);
      await shot('chart-09-repainted-mission-dark');
    } finally {
      await scene.close();
    }
  }, 120_000);

  test('should fall back to its source, quietly, when the author tried to colour it', async () => {
    // Arrange
    const scene = await openScene('chart-painted', VIEWPORTS[0]);
    const { page, shot } = scene;

    try {
      // Act
      await page.waitForSelector('[data-fy-render-failure="render"]', { timeout: 40_000 });

      // Assert — the ordinary fence, the reason kept as a title, no canvas.
      should(await page.locator('[data-fy-render-error="true"] pre').count()).equal(1);
      should(await page.locator('[data-fy-render-error="true"]').getAttribute('title')).containEql('color');
      should(await page.locator('canvas').count()).equal(0);
      await shot('chart-10-fallback', { overflow: await overflow(page) });
    } finally {
      await scene.close();
    }
  }, 120_000);

  test('should keep every theme’s series colours apart, in every family and mode', async () => {
    // Arrange — every theme the reader can pick: each family in each mode, from the app's own list.
    const names = THEME_FAMILIES.flatMap(family => [`${family.id}-light`, `${family.id}-dark`]);
    should(names.length).equal(22);
    const scene = await openScene('chart-bar', VIEWPORTS[1]);
    const { page } = scene;

    try {
      // Act
      const palettes = await page.evaluate(themes => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
        const rgb = (raw: string): number[] => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = raw;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        };
        return themes.map(name => {
          document.documentElement.setAttribute('data-theme', name);
          const style = getComputedStyle(document.documentElement);
          return {
            colors: [1, 2, 3, 4, 5, 6, 7, 8].map(slot => rgb(style.getPropertyValue(`--viz-${slot}`).trim())),
            name,
          };
        });
      }, names);

      // Assert — no two of the first five slots are near-duplicates in any theme (RGB distance at least 60
      // of a possible 441), and no two of all eight closer than 30: what `themes.css` claims for the order.
      const near: string[] = [];
      for (const { name, colors } of palettes)
        for (let a = 0; a < colors.length; a += 1)
          for (let b = a + 1; b < colors.length; b += 1) {
            const distance = Math.hypot(...[0, 1, 2].map(at => (colors[a]?.[at] ?? 0) - (colors[b]?.[at] ?? 0)));
            if (distance < (a < 5 && b < 5 ? 60 : 30))
              near.push(`${name}: viz-${a + 1} ~ viz-${b + 1} (${Math.round(distance)})`);
          }
      manifest.push({ palettes, scene: 'chart-palette-distinctness' });
      should(near).eql([]);
    } finally {
      await scene.close();
    }
  }, 120_000);
});

describe('fy-render component evidence — Mermaid in the theme', () => {
  /** The compiled diagram's SVG text, decoded from the `<img>` it reached. */
  const diagramSvg = async (page: Page): Promise<string> =>
    decodeURIComponent(
      ((await page.locator('img[data-fy-render-diagram="true"]').getAttribute('src')) ?? '').replace(
        'data:image/svg+xml,',
        '',
      ),
    ).toLowerCase();

  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`should paint a diagram from the app’s tokens, not Mermaid’s stock theme, ${theme}, at ${viewport.name}`, async () => {
        // Arrange
        const scene = await openScene('mermaid', viewport, { theme });
        const { page, shot } = scene;

        try {
          // Act
          await waitForMermaidDiagram(page);
          await page.waitForTimeout(300);

          // Assert — the node fill, its border and the text are the theme's own.
          const svg = await diagramSvg(page);
          for (const token of ['accent-soft', 'accent', 'fg', 'muted'])
            should(svg).containEql(await resolvedToken(page, token));
          should(await overflow(page)).equal(0);
          await shot(`mermaid-06-themed-${theme}`);
        } finally {
          await scene.close();
        }
      }, 120_000);
    }
  }

  test('should redraw a diagram on screen when the palette changes within the same mode', async () => {
    // Arrange
    const scene = await openScene('mermaid', VIEWPORTS[1], { themeName: 'studio-dark' });
    const { page, shot } = scene;

    try {
      await waitForMermaidDiagram(page);
      const before = await diagramSvg(page);

      // Act — dark to dark: a cache keyed on light/dark alone would keep the old picture.
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'mission-dark'));
      await page.waitForFunction(
        previous => {
          const src = document.querySelector('img[data-fy-render-diagram="true"]')?.getAttribute('src') ?? '';
          return decodeURIComponent(src.replace('data:image/svg+xml,', '')).toLowerCase() !== previous;
        },
        before,
        { timeout: 40_000 },
      );

      // Assert
      should(await diagramSvg(page)).containEql(await resolvedToken(page, 'accent-soft'));
      await shot('mermaid-07-repainted-mission-dark');
    } finally {
      await scene.close();
    }
  }, 120_000);

  for (const which of ['mermaid-theme-directive', 'mermaid-theme-frontmatter'])
    test(`should keep the app’s palette when a diagram asks for another (${which})`, async () => {
      // Arrange
      const scene = await openScene(which, VIEWPORTS[1], { theme: 'light' });
      const { page } = scene;

      try {
        // Act
        await waitForMermaidDiagram(page);

        // Assert — `theme`, `themeVariables` and `themeCSS` are secure keys: neither a directive nor front
        // matter reaches them.
        const svg = await diagramSvg(page);
        should(svg).not.containEql('#ff0000');
        should(svg).containEql(await resolvedToken(page, 'accent-soft'));
      } finally {
        await scene.close();
      }
    }, 120_000);
});

describe('fy-render component evidence — Mermaid on a phone', () => {
  /** What the browser really laid out for the diagram: its natural size, shown width, and the scroll box around it. */
  const laidOut = async (page: Page) =>
    await page.evaluate(() => {
      const img = document.querySelector('img[data-fy-render-diagram="true"]') as HTMLImageElement;
      const box = img.parentElement as HTMLElement;
      const src = decodeURIComponent(img.getAttribute('src')?.replace('data:image/svg+xml,', '') ?? '');
      const view = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/u.exec(src);
      const natural = { height: Number(view?.[2] ?? 0), width: Number(view?.[1] ?? 0) };
      const shown = img.getBoundingClientRect().width;
      return {
        bodyPx: Number.parseFloat(getComputedStyle(document.querySelector('figure.fy-render') as Element).fontSize),
        boxClient: box.clientWidth,
        boxScroll: box.scrollWidth,
        natural,
        scrolls: box.getAttribute('data-fy-render-scrolls') === 'true',
        shown,
        textPx: natural.width > 0 ? (shown / natural.width) * 16 : 0,
      };
    });

  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      test(`should draw a left-to-right flowchart readably, ${theme}, at ${viewport.name}`, async () => {
        // Arrange
        const scene = await openScene('mermaid-lr', viewport, { theme });
        const { page, shot } = scene;

        try {
          // Act
          await waitForMermaidDiagram(page);
          await page.waitForTimeout(300);
          const actual = await laidOut(page);
          await shot(`mermaid-08-left-to-right-${theme}`, { laidOut: actual, overflow: await overflow(page) });

          // Assert — the page never scrolls sideways, and the text is never under 12px nor over 1.25× the body.
          should(await overflow(page)).equal(0);
          should(actual.textPx).be.aboveOrEqual(11.9);
          should(actual.textPx).be.belowOrEqual(actual.bodyPx * 1.25 + 0.5);
          if (viewport.width <= 480) {
            // A phone column: declared top-down before it was compiled, so the picture is taller than wide.
            should(actual.natural.height).be.above(actual.natural.width);
            should(actual.shown).be.belowOrEqual(viewport.width);
          } else {
            // A desktop column keeps the author's left-to-right. This one is wider than the column even at the
            // smallest readable size, so it scrolls in its own box (checked below) rather than shrinking to 8px.
            should(actual.natural.width).be.above(actual.natural.height);
            should(actual.scrolls).be.true();
          }
          if (actual.scrolls) should(actual.boxScroll).be.above(actual.boxClient);
        } finally {
          await scene.close();
        }
      }, 120_000);
    }
  }

  test('should draw the other direction when a phone is turned sideways, and back', async () => {
    // Arrange
    const scene = await openScene('mermaid-lr', VIEWPORTS[0], { theme: 'dark' });
    const { page, shot } = scene;
    const drawnAs = async (wanted: 'tall' | 'wide'): Promise<void> => {
      await page.waitForFunction(
        want => {
          const img = document.querySelector('img[data-fy-render-diagram="true"]');
          const src = decodeURIComponent(img?.getAttribute('src')?.replace('data:image/svg+xml,', '') ?? '');
          const view = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/u.exec(src);
          if (view === null) return false;
          return Number(view[2]) > Number(view[1]) === (want === 'tall');
        },
        wanted,
        { timeout: 40_000 },
      );
    };

    try {
      await waitForMermaidDiagram(page);
      await drawnAs('tall');

      // Act — rotated to landscape, across the 520px line.
      await page.setViewportSize({ height: 390, width: 900 });
      await drawnAs('wide');
      await page.waitForTimeout(300);
      await shot('mermaid-09-rotated-landscape', { overflow: await overflow(page) });
      should(await overflow(page)).equal(0);

      // Act — and back upright.
      await page.setViewportSize({ height: 844, width: 390 });
      await drawnAs('tall');

      // Assert — one picture throughout, never an empty frame in between.
      should(await page.locator('img[data-fy-render-diagram="true"]').count()).equal(1);
    } finally {
      await scene.close();
    }
  }, 120_000);
});
