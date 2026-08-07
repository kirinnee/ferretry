/**
 * Build the REAL bundle, serve `dist/` on an ephemeral loopback port, and
 * screenshot the running app — the brand surfaces at both viewports in both
 * colour schemes, and first-run in every state that actually differs: the
 * chooser, and each step of each of the three routes it leads to.
 *
 * This is the other half of `harness/screenshot.ts`, not a replacement for it.
 * That one bundles `harness/main.tsx`: a stacked gallery of every ported surface,
 * which is the right shape for comparing a component against the original but is
 * not the app. Some claims can only be made against the shipped artifact:
 *
 *   - An ICON REFERENCE only resolves if `public/` really was copied into `dist/`
 *     and the href really is root-absolute. The component harness serves neither
 *     `index.html` nor `public/`, so it cannot tell you whether the tab has an
 *     icon at all. This pass records every request the page makes and fails if
 *     one 404s.
 *   - THE FAVICON AT 16px cannot be screenshotted out of the browser's tab strip
 *     by any automation, so the honest substitute is to make the page itself load
 *     `/icons/favicon.svg` at exactly 16x16 — same origin, same policy, same
 *     rasteriser — and capture that, beside a nearest-neighbour magnification of
 *     the same 16px box so a human can actually see the pixels.
 *   - COLOUR SCHEME. `pre-paint.js` resolves the theme from `prefers-color-scheme`
 *     before first paint, so light mode is a different first frame rather than a
 *     class toggle. It has to be emulated at the context, not the DOM.
 *   - A ROUTE'S REAL STATE. First-run's steps are reached by answering a question
 *     and then clicking, and its pairing step reacts to the software keyboard.
 *     Neither is a prop you can set from outside; both have to be driven.
 *
 * Dev-only, never runs in CI, and nothing it writes is committed —
 * `harness/out/` is gitignored. Every request that leaves the loopback origin is
 * aborted, and the server binds an ephemeral port on 127.0.0.1: a developer's
 * machine has real daemons and real agent sessions on it, and a screenshot pass
 * has no business reaching any of them.
 *
 *   bun harness/app-screenshot.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContextOptions, chromium, type Page } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const distDir = join(packageDir, 'dist');
const outDir = join(harnessDir, 'out');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const SCHEMES = ['light', 'dark'] as const;

const PHONE = { width: 390, height: 844 } as const;

/**
 * WHAT A PHONE SAYS ABOUT ITSELF, which is the only thing `detectDeviceKind` reads.
 *
 * `isMobile` and `hasTouch` change the layout viewport, the pointer media query
 * and the orientation — they do NOT change `navigator.userAgent`. Chromium keeps
 * announcing itself as desktop Linux Chrome, `device-kind.ts` believes it (its
 * unknown-case answer is `desktop`, deliberately), and every `-mobile` capture
 * renders the DESKTOP flow at phone width. That is a screenshot that proves the
 * opposite of what its name claims, and a whole unit's "verified on mobile"
 * would inherit it.
 *
 * A literal string rather than `devices['Pixel 7']`: the registry entry also
 * carries a `deviceScaleFactor` of 3, which would silently triple the pixel size
 * of an already-reviewed capture set for no reason connected to device detection.
 * This is a stock Android Chrome agent, which is what the `android` marker in
 * `device-kind.ts` matches.
 */
const PHONE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/**
 * A phone, emulated rather than merely sized — used for the `-mobile` SETUP
 * captures only.
 *
 * `isMobile` is what makes Chromium report `screen.orientation.type` as
 * `portrait-primary` and `(pointer: coarse)` as true. Both matter here and
 * neither follows from the viewport: a bare 390x844 headless context reports
 * `landscape-primary`, and `use-app-viewport.ts` decides `phoneLike` from the
 * coarse pointer. Setting the width alone produces a narrow desktop, which is a
 * different thing from a phone and is precisely the state the keyboard capture
 * must not be confused with.
 *
 * The user agent is here for the same reason and is not decoration: the setup
 * flow ASKS FEWER QUESTIONS on a phone, so a capture taken without it is a
 * picture of the wrong journey. `expectDevice` below asserts the app agreed.
 *
 * Deliberately NOT applied to the brand captures above. Those are the images that
 * were reviewed and merged; re-emulating them now would silently change an
 * already-approved review set for no reason connected to this change.
 */
const PHONE_CONTEXT = {
  viewport: PHONE,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE_USER_AGENT,
} as const;

/** The keyboard-open visual viewport height, an Android-plausible ~414px of chrome. */
const KEYBOARD_VISUAL_HEIGHT = 430;

/** The favicon magnification factor, matching the `-at-12x` proofs in `docs/brand`. */
const MAGNIFY = 12;

/** The setup screen's root, and the attribute that names what is on the glass. */
const SETUP_ROOT = '[data-onboarding="setup"]';
const setupStep = (step: string): string => `${SETUP_ROOT}[data-onboarding-screen="${step}"]`;
/** The entry question — what the reader has — which every visit starts on. */
const SETUP_ENTRY = setupStep('entry');
/** Which computer runs the daemon. Only reached from an entry this device cannot settle. */
const SETUP_TARGET = setupStep('target');
/** Who installs it, which every daemon journey reaches. */
const SETUP_DOER = setupStep('doer');

/**
 * The pairing arrival used for the Done capture. A fabricated single-use code
 * against a `.test` host that cannot resolve — the reserved TLD is the point,
 * since nothing here may address a real daemon.
 */
const PAIRING_ARRIVAL = '/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=single-use;fp=daemon-a';

function fail(message: string): never {
  throw new Error(`❌ ${message}`);
}

mkdirSync(outDir, { recursive: true });

/**
 * The relay directory origin this REVIEW bundle is built with.
 *
 * The shipped code only asks for an advertisement when the build supplied an
 * origin, so a bundle built without one can never render the advertising or
 * switched-off frames — it short-circuits, correctly, to "no directory". Building
 * the review copy with an origin is what makes those frames reachable at all, and
 * it exercises the whole chain: build constant, request, parse, readout.
 *
 * `.invalid` because the reserved TLD cannot resolve, and because this harness
 * aborts every off-origin request anyway. Nothing here may address a real
 * service, and the answers themselves come from request interception.
 *
 * THIS ONLY STARTED WORKING WHEN `vite.config.ts` LEARNED TO READ THE VARIABLE.
 * Until then it read no environment at all and hard-defined the production origin,
 * so this override was inert: the review bundle carried Ferretry's real directory
 * and the frames below were reached — when they were reached — against an
 * intercepted request to a live service's address rather than to this one.
 */
const RELAY_DIRECTORY = 'https://relay-directory.example.invalid';

process.stdout.write('📦 building the real bundle…\n');
const build = spawnSync('./node_modules/.bin/vite', ['build'], {
  cwd: packageDir,
  stdio: 'inherit',
  env: { ...process.env, FY_RELAY_DIRECTORY_ORIGIN: RELAY_DIRECTORY },
});
if (build.error) fail(`vite could not be started: ${build.error.message}`);
if (build.status !== 0) fail(`vite build exited ${build.status}`);

/**
 * The SPA rewrite rules, READ FROM `public/_redirects` rather than restated here.
 *
 * This used to hardcode one `/* -> /index.html` fallback, and that was wrong the
 * moment the static landing page landed: `/` is now the landing document and the
 * app document is `/app/index.html`, with `/setup`, `/pair` and `/d/*` rewritten
 * to it. A hardcoded fallback served the LANDING page for `/setup` and produced a
 * perfectly clean screenshot of the wrong document — the exact silent failure
 * this file exists to prevent, committed inside the file itself.
 *
 * So the rules come from the same file Cloudflare Pages reads. They cannot drift,
 * and a future route change is picked up without touching this harness.
 */
const redirectRules = (await Bun.file(join(packageDir, 'public/_redirects')).text())
  .split('\n')
  .map(line => line.trim())
  .filter(line => line !== '' && !line.startsWith('#'))
  .map(line => {
    const [from, to] = line.split(/\s+/);
    return { from: from ?? '', to: to ?? '' };
  });
if (redirectRules.length === 0) fail('public/_redirects declares no rewrite rules');

/** First matching rule wins, exactly as Pages orders them. `*` matches a path suffix. */
const rewrite = (path: string): string => {
  for (const rule of redirectRules) {
    if (rule.from.endsWith('*')) {
      if (path.startsWith(rule.from.slice(0, -1))) return rule.to;
    } else if (path === rule.from) return rule.to;
  }
  return path;
};

/**
 * `dist/` served the way Cloudflare Pages serves it: a real file wins, and
 * anything else goes through the rewrite rules above, because the app's routes
 * are client-side and `/setup` is not a file on disk.
 */
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const direct = Bun.file(join(distDir, path.endsWith('/') ? `${path}index.html` : path));
    if (await direct.exists()) {
      // Bun has no type for `.webmanifest`, and a manifest served as
      // `application/octet-stream` is ignored outright by Chrome.
      const type = path.endsWith('.webmanifest') ? 'application/manifest+json' : undefined;
      return new Response(direct, type ? { headers: { 'content-type': type } } : undefined);
    }
    const target = Bun.file(join(distDir, rewrite(path)));
    if (!(await target.exists())) return new Response('not found', { status: 404 });
    return new Response(target, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

/**
 * The synthetic `window.visualViewport`, installed before any app code runs.
 *
 * THIS IS THE ONLY HONEST WAY TO SCREENSHOT THE KEYBOARD-OPEN LAYOUT, and the
 * obvious alternatives are all wrong in the same direction. `setViewportSize` and
 * CDP device metrics shrink the LAYOUT viewport — `innerHeight` and
 * `screen.height` shrink with it — which is a short window, not a keyboard.
 * Android with `interactive-widget=resizes-content` and iOS panning both leave the
 * layout viewport alone and move the VISUAL one, and
 * `src/hooks/use-app-viewport.ts` reads exactly that. A driver that only moves the
 * layout viewport renders a different state while looking plausible.
 *
 * It has to be an init script rather than a later `evaluate`, because
 * `browserViewportEnvironment()` captures `window.visualViewport` ONCE when the
 * shell mounts. An object installed after mount is never read.
 *
 * IT WRAPS THE REAL OBJECT AND OVERRIDES ONLY `height`. Replacing it outright
 * with a hand-built stand-in breaks the driver itself: on a mobile context
 * Playwright reads `window.visualViewport` for its own tap coordinate maths, so a
 * stand-in reporting invented `width`/`scale` makes every click time out while the
 * element sits there visible and enabled — which looks like a bad selector and is
 * not one. Everything except `height` therefore delegates to the browser, real
 * `resize`/`scroll` events are forwarded so nothing that listens loses them, and
 * the override stays null until the keyboard is meant to be up (so every click
 * happens while this object is telling the whole truth).
 *
 * `__setVisualViewportHeight` is the seam this file drives.
 */
const VISUAL_VIEWPORT_SCRIPT = `
  (() => {
    const real = window.visualViewport;
    if (!real) return;
    const target = new EventTarget();
    let override = null;
    for (const name of ['width', 'offsetTop', 'offsetLeft', 'pageTop', 'pageLeft', 'scale']) {
      Object.defineProperty(target, name, { get: () => real[name], configurable: true });
    }
    Object.defineProperty(target, 'height', { get: () => override ?? real.height, configurable: true });
    real.addEventListener('resize', () => target.dispatchEvent(new Event('resize')));
    real.addEventListener('scroll', () => target.dispatchEvent(new Event('scroll')));
    Object.defineProperty(window, 'visualViewport', { get: () => target, configurable: true });
    window.__setVisualViewportHeight = next => {
      override = next;
      // The producer listens for 'resize' on the visual viewport and schedules its
      // write on the next frame, so the event is what actually moves the app.
      target.dispatchEvent(new Event('resize'));
    };
  })();
`;

/**
 * Answers `/v1/pair` in the page, without a request leaving it.
 *
 * A page-level `fetch` stub rather than a route fulfilment on purpose: the daemon
 * in the arrival is off-origin, every off-origin request is aborted here, and the
 * honest way to screenshot a SUCCESSFUL pairing is for the exchange never to be
 * attempted rather than to be intercepted and answered. Nothing else is stubbed —
 * the rest of the page runs as shipped.
 */
const PAIR_RESPONSE_SCRIPT = `
  (() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/v1/pair')) {
        return Promise.resolve(
          new Response(JSON.stringify({ daemonId: 'daemon-a', deviceToken: 'screenshot-token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return original(input, init);
    };
  })();
`;

interface KeyboardGeometry {
  readonly innerHeight: number;
  readonly screenHeight: number;
  readonly orientation: string;
  readonly visualHeight: number | undefined;
  readonly appHeight: string;
}

/** Reads the three layout-viewport facts a keyboard must NOT change, plus the one it must. */
const readGeometry = (page: Page): Promise<KeyboardGeometry> =>
  page.evaluate(() => ({
    innerHeight: window.innerHeight,
    screenHeight: window.screen.height,
    orientation: window.screen.orientation.type,
    visualHeight: window.visualViewport?.height,
    appHeight: document.documentElement.style.getPropertyValue('--app-h'),
  }));

try {
  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) fail('no system Chrome or Chromium found');

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const missing: string[] = [];
  /**
   * Behavioural assertions that failed, reported at the END rather than thrown.
   *
   * A thrown assertion would abandon the remaining captures, and the image of a
   * broken state is the most useful thing this pass can hand a human — so the
   * screenshot is taken first and the complaint is queued. The run still exits
   * non-zero, so this defers the failure without softening it.
   */
  const defects: string[] = [];

  /**
   * One fresh context per capture, with the off-origin block and the nested
   * teardown applied BY CONSTRUCTION rather than repeated per call site.
   *
   * Every capture below therefore gets a genuinely fresh browser state — no
   * storage, no carried-over onboarding progress — which is what makes "first
   * run" mean first run. The `finally` chain is why a thrown locator cannot leak
   * a Chromium context or a page for the rest of the run; the browser and the
   * server have the same guarantee one level up.
   */
  const capture = async (options: BrowserContextOptions, body: (page: Page) => Promise<void>): Promise<void> => {
    const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
    try {
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== server.url.origin) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      try {
        // A 404 on an icon or the manifest is the exact failure this pass exists
        // to catch, and it is invisible in a screenshot: the tab just shows the
        // browser's default glyph.
        page.on('response', response => {
          if (response.status() >= 400) missing.push(`${response.status()} ${response.url()}`);
        });
        await body(page);
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  };

  /**
   * `/app/` and not `/`. Since the static landing page landed, `/` is a different
   * document that happens to also say "Ferretry" — so a capture named `app-…`
   * taken at `/` would be a screenshot of marketing copy that looks entirely
   * plausible. The app's own routes (`/setup`, `/pair`, `/d/…`) are passed
   * through unchanged and reach this same document via the rewrite rules.
   */
  const APP_ROOT = '/app/';

  const open = async (page: Page, path = APP_ROOT): Promise<void> => {
    await page.goto(new URL(path, server.url).toString(), { waitUntil: 'load' });
  };

  const shot = async (page: Page, name: string): Promise<void> => {
    const target = join(outDir, `${name}.png`);
    await page.screenshot({ path: target });
    process.stdout.write(`📸 ${name} -> ${target}\n`);
  };

  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        await capture(
          { viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme },
          async page => {
            await open(page);
            await shot(page, `app-${viewport.name}-${scheme}`);

            // The favicon proof, once per scheme — the SVG's ink is
            // scheme-dependent, so one capture would only ever prove half of it.
            // Captured on the phone pass only: it is a fixed 16px box, and the
            // viewport it happens to sit in tells you nothing.
            if (viewport.name === 'mobile') {
              await page.evaluate(
                async ({ magnify }) => {
                  const image = new Image();
                  image.src = '/icons/favicon.svg';
                  await image.decode();

                  // RASTERISE AT 16 FIRST, then magnify that raster. Setting an
                  // <img> to 192px and asking for `image-rendering: pixelated`
                  // does NOT show you 16px: an SVG is rendered at its layout
                  // size, so the browser draws a clean 192px vector and the
                  // "proof" proves nothing about the size that was in question.
                  // The 16x16 canvas is the only way to get the actual pixels a
                  // tab strip receives.
                  const small = document.createElement('canvas');
                  small.width = 16;
                  small.height = 16;
                  small.getContext('2d')?.drawImage(image, 0, 0, 16, 16);

                  const large = document.createElement('canvas');
                  large.width = 16 * magnify;
                  large.height = 16 * magnify;
                  const context = large.getContext('2d');
                  if (context) {
                    context.imageSmoothingEnabled = false;
                    context.drawImage(small, 0, 0, large.width, large.height);
                  }

                  const strip = document.createElement('div');
                  strip.id = 'favicon-proof';
                  strip.style.cssText =
                    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
                    'justify-content:center;gap:24px;background:var(--bg,#fff)';
                  // Left: the untouched 16px <img>, exactly what the tab gets.
                  // Right: that same 16px raster blown up with nearest-neighbour.
                  const actual = document.createElement('img');
                  actual.src = '/icons/favicon.svg';
                  actual.alt = '';
                  actual.width = 16;
                  actual.height = 16;
                  strip.append(actual, large);
                  document.body.appendChild(strip);
                },
                { magnify: MAGNIFY },
              );
              const proofTarget = join(outDir, `favicon-16-${scheme}.png`);
              await page.locator('#favicon-proof').screenshot({ path: proofTarget });
              process.stdout.write(`📸 favicon 16px + ${MAGNIFY}x ${scheme} -> ${proofTarget}\n`);
            }
          },
        );
      }
    }

    // THE HEADER LOCKUP, MAGNIFIED. The mark renders at 20px next to the
    // wordmark, and 20px of grid is too small to judge in a 390px page
    // screenshot — which is exactly the size at which a 3x3 grid's cells start
    // merging into a blob. Captured at deviceScaleFactor 4 so the review is of
    // real rendered pixels enlarged, not of a re-render at a size nothing ships.
    for (const scheme of SCHEMES) {
      await capture({ viewport: PHONE, colorScheme: scheme, deviceScaleFactor: 4 }, async page => {
        await open(page);
        const target = join(outDir, `header-lockup-${scheme}.png`);
        // The lockup is the mark plus the word, so the mark's own size and its
        // optical weight beside the type are both in frame.
        await page.getByText('Ferretry', { exact: true }).first().locator('..').screenshot({ path: target });
        process.stdout.write(`📸 header lockup at 4x ${scheme} -> ${target}\n`);
      });
    }

    /**
     * Is the setup stepper in this bundle at all?
     *
     * Probed once, and the answer decides between capturing all five setup states
     * and skipping all five LOUDLY. The alternative — letting each capture fail on
     * its own locator — cannot tell "this bundle predates the stepper" apart from
     * "a selector is wrong", and those need opposite responses. A silent skip
     * would be worse than either: this file's whole purpose is that a missing
     * surface fails instead of quietly producing nothing.
     */
    let stepperPresent = false;
    await capture(PHONE_CONTEXT, async page => {
      await open(page, '/setup');
      stepperPresent = await page
        .locator(SETUP_ROOT)
        .first()
        .waitFor({ state: 'attached', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
    });

    if (!stepperPresent) {
      process.stdout.write(
        '⏭️  SKIPPED every setup capture: this bundle serves no [data-onboarding="setup"] root at\n' +
          '    /setup. Expected on a branch without the onboarding stepper — but it is NOT a pass.\n' +
          '    setup-<entry|target|doer|install|agents|daemon|connect|reach-*|pair|brief*|agent-pair*|elsewhere|\n' +
          '    scan|done>-\n' +
          '    <mobile|desktop>\n' +
          '    and setup-scan-keyboard-mobile\n' +
          '    were NOT produced.\n',
      );
    } else {
      /*
       * A STEP, REACHED THE WAY A READER REACHES IT.
       *
       * Driving the real control rather than seeding the store is the point: it
       * proves the advances actually land where they claim, which a seeded state
       * would assume. Fresh storage is what makes each of these a first-run
       * frame — the stepper opens on `install` rather than wherever a previous
       * visit left it.
       */
      /*
       * EVERY CAPTURE STARTS AT THE ENTRY QUESTION, because every reader does. A
       * journey names the entry it answers, then the target when this device does
       * not settle that itself, then the doer — so a shot named `install` proves
       * that "first time" plus "I do it myself" really leads to commands, and one
       * named `elsewhere` proves that "another computer" leads to a hand-off
       * instead. A seeded store would prove only that the components render.
       *
       * THE SAME JOURNEY LIST IS WALKED ON BOTH DEVICES, AND THAT IS THE TEST.
       * A phone is never asked which computer runs the daemon, so `target` is
       * declared as what to press IF the question appears and the phone reaches
       * the same doer question without it. A driver that hardcoded the question
       * count would have to be told which device it was on, and then the captures
       * could no longer disagree with the code.
       */
      /*
       * A CONNECTION IS ANSWERED, NOT ADVANCED PAST. The carrier step is a chooser
       * of its own since the pairing/connection split, so a journey that has to
       * get beyond it names the row it presses. Walking it any other way stops on
       * that screen and every later capture times out — which is exactly how this
       * driver reported the split when it landed.
       */
      /*
       * A JOURNEY THAT ONLY A COMPUTER CAN WALK SAYS SO, and is skipped LOUDLY on
       * the phone pass rather than driven until it times out.
       *
       * This is the whole point of the unit rather than a harness convenience: a
       * phone cannot host a daemon, so `install`, `daemon`, `connect`, `local` and
       * the offer to add a phone do not exist on one. Before the phone captures had
       * a phone user agent they all "worked" at 390px, which is exactly the lie
       * those images were telling. Narrow-width readings of those stages are still
       * reviewed — `harness/screenshot.ts` renders the gallery at both viewports —
       * because a 390px WINDOW on a computer is a real thing and a phone is not.
       */
      const JOURNEYS = [
        { name: 'install', on: 'desktop', route: 'first-time', doer: 'self', advances: 0, screen: 'install' },
        /*
         * The step without which everything after it is theatre: Ferretry runs
         * Claude Code and Codex and is neither, so a daemon with both missing
         * starts perfectly and can run nothing.
         */
        { name: 'agents', on: 'desktop', route: 'first-time', doer: 'self', advances: 1, screen: 'agents' },
        { name: 'daemon', on: 'desktop', route: 'first-time', doer: 'self', advances: 2, screen: 'daemon' },
        { name: 'connect', on: 'desktop', route: 'first-time', doer: 'self', advances: 3, screen: 'connect' },
        /*
         * `pair` — run `fy pair` somewhere else — belongs to the pairing entry. It
         * was pointed at first-time with a carrier answer, which since the
         * same-machine collapse lands on `local` and waited thirty seconds for a
         * step that journey does not have.
         */
        { name: 'pair', on: 'both', route: 'add-client', advances: 0, screen: 'pair' },
        {
          name: 'local',
          on: 'desktop',
          route: 'first-time',
          doer: 'self',
          advances: 3,
          screen: 'local',
          connection: 'direct',
        },
        /* An agent on this machine: the prompt, then a pairing that may already be done. */
        { name: 'brief', on: 'desktop', route: 'first-time', doer: 'agent', advances: 0, screen: 'brief' },
        { name: 'agent-pair', on: 'desktop', route: 'first-time', doer: 'agent', advances: 1, screen: 'agent-pair' },
        /*
         * An agent on ANOTHER machine, which is every phone's agent journey and a
         * real one on a computer too. It carries the share affordance, because a
         * clipboard does not reach the machine the agent is on.
         */
        {
          name: 'brief-elsewhere',
          on: 'both',
          route: 'first-time',
          doer: 'agent',
          target: 'other',
          advances: 0,
          screen: 'brief',
        },
        {
          name: 'agent-pair-elsewhere',
          on: 'both',
          route: 'first-time',
          doer: 'agent',
          target: 'other',
          advances: 1,
          screen: 'agent-pair',
        },
        /*
         * THE WHOLE "ANOTHER COMPUTER, BY HAND" BRANCH, which is one screen. On a
         * phone it is where "first time" lands with no question asked; on a
         * computer it is reached by taking the escape from the assumption, which is
         * why this journey presses it and therefore proves it is findable.
         */
        {
          name: 'elsewhere',
          on: 'both',
          route: 'first-time',
          doer: 'self',
          target: 'other',
          advances: 0,
          screen: 'elsewhere',
        },
        /* The scan half: a daemon already exists, so there is nothing to install. */
        { name: 'scan', on: 'both', route: 'add-client', advances: 1, screen: 'scan' },
      ] as const;

      const toEntry = async (page: Page): Promise<void> => {
        await open(page, '/setup');
        await page.locator(SETUP_ENTRY).waitFor({ state: 'visible' });
      };

      const toStep = async (page: Page, journey: (typeof JOURNEYS)[number]): Promise<void> => {
        await toEntry(page);
        await page.locator(`button[data-onboarding-route="${journey.route}"]`).click();
        const doer = 'doer' in journey ? journey.doer : undefined;
        if (doer !== undefined) {
          /* Asked outright only when this device does not answer it by itself. */
          const target = 'target' in journey ? journey.target : 'this';
          if ((await page.locator(SETUP_TARGET).count()) > 0) {
            await page.locator(`button[data-onboarding-target="${target}"]`).click();
          }
          await page.locator(SETUP_DOER).waitFor({ state: 'visible' });
          /*
           * On a computer the target was ASSUMED, so a journey that wants the
           * other machine takes the escape this screen offers — the same control a
           * reader would have to find. A phone is already there and offers none.
           */
          const wayOut = page.locator(`button[data-onboarding-switch-target="${target}"]`);
          if ((await wayOut.count()) > 0) await wayOut.click();
          await page.locator(`button[data-onboarding-doer="${doer}"]`).click();
        }
        for (let advance = 0; advance < journey.advances; advance += 1) {
          await page.locator('[data-onboarding-next]').first().click();
        }
        const connection = 'connection' in journey ? journey.connection : undefined;
        if (connection !== undefined) {
          await page.locator(`[data-onboarding-connection="${connection}"]`).click();
        }
        await page.locator(setupStep(journey.screen)).waitFor({ state: 'visible' });
      };
      const journey = (name: (typeof JOURNEYS)[number]['name']): (typeof JOURNEYS)[number] => {
        const found = JOURNEYS.find(candidate => candidate.name === name);
        if (found === undefined) fail(`no such setup journey: ${name}`);
        return found;
      };

      /**
       * The context for a viewport.
       *
       * Mobile is an EMULATED PHONE rather than a 390px window: touch, the
       * coarse pointer and the device scale all change what the stylesheet
       * resolves, and the reader this screen was rebuilt for is on one.
       */
      const contextFor = (viewport: (typeof VIEWPORTS)[number]): BrowserContextOptions =>
        viewport.name === 'mobile' ? PHONE_CONTEXT : { viewport: { width: viewport.width, height: viewport.height } };

      /**
       * DID THE APP AGREE THAT THIS IS A PHONE?
       *
       * The whole point of the emulation above, checked rather than assumed. The
       * setup root publishes what `detectDeviceKind` decided, so a capture named
       * `-mobile` that rendered the desktop journey is caught here instead of
       * being reviewed as evidence. Queued as a defect rather than thrown, so the
       * wrong-journey image is still on disk for a human to look at.
       */
      const expectDevice = async (page: Page, viewport: (typeof VIEWPORTS)[number], name: string): Promise<void> => {
        const seen = await page.locator(SETUP_ROOT).first().getAttribute('data-onboarding-device');
        if (seen !== viewport.name) {
          defects.push(`setup-${name}-${viewport.name} rendered as data-onboarding-device="${String(seen)}"`);
        }
      };

      /*
       * 1. EVERY QUESTION A READER CAN BE ASKED, AT BOTH VIEWPORTS.
       *
       * THE PHONE IS ASKED ONE FEWER, AND THESE ARE THE FRAMES THAT PROVE IT.
       * `setup-doer-*` on a computer states an assumption with a way out of it;
       * the same capture on a phone states a fact, because the hardware answered.
       * `setup-target-*` exists on a computer only — a phone that was offered
       * "this one" would be offered something it cannot do — so it is skipped
       * loudly there rather than being driven into a question that never comes.
       */
      for (const viewport of VIEWPORTS) {
        await capture(contextFor(viewport), async page => {
          await toEntry(page);
          await expectDevice(page, viewport, 'entry');
          await shot(page, `setup-entry-${viewport.name}`);
          /*
           * THE COMMON PATH FIRST: nothing installed yet. On a computer this is
           * the frame that carries the STATED ASSUMPTION and the way out of it; on
           * a phone it is the same screen carrying the STATED FACT instead, which
           * is the pair a reviewer has to see side by side.
           */
          await page.locator('button[data-onboarding-route="first-time"]').click();
          await page.locator(SETUP_DOER).waitFor({ state: 'visible' });
          await shot(page, `setup-doer-${viewport.name}`);
        });

        /*
         * And the reader who is adding to a fleet, who IS asked which computer and
         * therefore sees a receipt rather than an offer on the next screen. A phone
         * is not asked even here, so that frame is skipped loudly.
         */
        await capture(contextFor(viewport), async page => {
          await toEntry(page);
          await page.locator('button[data-onboarding-route="add-daemon"]').click();
          if ((await page.locator(SETUP_TARGET).count()) === 0) {
            process.stdout.write(
              `⏭️  setup-target-${viewport.name} and setup-doer-chosen-${viewport.name} not captured: this\n` +
                '    device settles which computer runs the daemon without asking, which is the behaviour\n' +
                '    under test rather than a gap.\n',
            );
            return;
          }
          await shot(page, `setup-target-${viewport.name}`);
          await page.locator('button[data-onboarding-target="other"]').click();
          await page.locator(SETUP_DOER).waitFor({ state: 'visible' });
          await shot(page, `setup-doer-chosen-${viewport.name}`);
        });
      }

      // 2. EVERY STEP OF EVERY JOURNEY THE READER CLICKS TO, AT BOTH VIEWPORTS.
      // `done` is not one of them: it is reached by a daemon answering, and is
      // captured below.
      for (const step of JOURNEYS) {
        for (const viewport of VIEWPORTS) {
          if (step.on === 'desktop' && viewport.name !== 'desktop') {
            process.stdout.write(
              `⏭️  setup-${step.name}-${viewport.name} not captured: a phone cannot host a daemon, so this\n` +
                '    stage does not exist on one. Its narrow-width reading is in harness/screenshot.ts.\n',
            );
            continue;
          }
          await capture(contextFor(viewport), async page => {
            await toStep(page, step);
            await expectDevice(page, viewport, step.name);
            await shot(page, `setup-${step.name}-${viewport.name}`);
          });
        }
      }

      /*
       * 2b. THE CARRIER STEP'S THREE ANSWERS.
       *
       * The recommended row reports a runtime fact — whether Ferretry's default
       * relay is advertising itself — so the three frames that matter are the
       * three answers, and they must not look alike. Two are driven by fulfilling
       * the real request the shipped code makes against the build's own directory
       * origin; the third leaves that request UNROUTED, so this harness's
       * off-origin abort makes it fail exactly as an unreachable directory would.
       * Nothing is faked into the component.
       *
       * ON A COMPUTER ONLY, because the question belongs to the machine that is
       * standing the daemon up and no phone ever is one. The narrow reading of this
       * chooser still matters — a 390px window on a computer reaches it — and that
       * is what the gallery in `harness/screenshot.ts` captures.
       */
      const RELAY_ANSWERS = [
        { name: 'available', body: JSON.stringify({ version: 1, relayUrl: 'https://relay.example.invalid' }) },
        { name: 'disabled', body: JSON.stringify({ version: 1, relayUrl: null }) },
        { name: 'undetermined', body: null },
      ] as const;
      for (const answer of RELAY_ANSWERS) {
        for (const viewport of VIEWPORTS.filter(candidate => candidate.name === 'desktop')) {
          await capture(contextFor(viewport), async page => {
            if (answer.body !== null) {
              await page.route('**/v1/default-relay', async route => {
                await route.fulfill({
                  status: 200,
                  contentType: 'application/json; charset=utf-8',
                  headers: { 'Cache-Control': 'no-store' },
                  body: answer.body,
                });
              });
            }
            await toStep(page, journey('connect'));
            // The readout arrives after first paint, so wait for the state the
            // shipped parser resolved rather than for a timeout.
            await page
              .locator(`[data-onboarding-connection-chooser][data-onboarding-fallback="${answer.name}"]`)
              .waitFor({ state: 'visible' });
            await shot(page, `setup-reach-${answer.name}-${viewport.name}`);
          });
        }
      }

      /*
       * The KEYBOARD capture belongs to the scan half, not the `fy pair` half:
       * since the split, the paste field lives on the stage that redeems a code.
       * Pointing this at `pair` waits thirty seconds for a field that stage does
       * not have — which is how the split announced itself here.
       */
      const toPairStep = async (page: Page): Promise<void> => {
        await toStep(page, journey('scan'));
      };

      // 3. THE PAIR STEP WITH THE KEYBOARD UP. See VISUAL_VIEWPORT_SCRIPT for why
      // this is a synthetic visual viewport and not a smaller window.
      await capture(PHONE_CONTEXT, async page => {
        await page.addInitScript(VISUAL_VIEWPORT_SCRIPT);
        await toPairStep(page);

        // The paste form is revealed by that button only when there is a camera to
        // prefer over it (`pasting || scanHost === null` in `pairing-screen.tsx`).
        // Headless Chrome has none, so the form is already rendered and the button
        // does not exist. Both are real states, so the reveal is conditional — but
        // the FIELD is not: it has to be there either way or there is nothing to
        // focus and no keyboard to raise.
        const reveal = page.getByRole('button', { name: 'Paste a link instead' });
        if ((await reveal.count()) > 0) await reveal.click();
        const field = page.locator('#pairing-link');
        await field.waitFor({ state: 'visible' });
        await field.focus();

        // Asserted BEFORE the change, so a driver that silently stopped installing
        // the synthetic viewport cannot pass by starting from the wrong numbers.
        const before = await readGeometry(page);
        if (before.innerHeight !== PHONE.height || before.visualHeight !== PHONE.height) {
          fail(`the synthetic viewport did not start at ${PHONE.height}: ${JSON.stringify(before)}`);
        }

        await page.evaluate(height => {
          (window as unknown as { __setVisualViewportHeight: (next: number) => void }).__setVisualViewportHeight(
            height,
          );
        }, KEYBOARD_VISUAL_HEIGHT);

        // Wait for the PRODUCTION signal, not for a timeout. `use-app-viewport.ts`
        // writes `data-keyboard="open"` on the root and `use-keyboard-open.ts`
        // observes it; if that attribute never arrives, the app did not believe the
        // keyboard and this would be a screenshot of the wrong state.
        await page.locator('html[data-keyboard="open"]').waitFor({ state: 'attached' });

        // And asserted after: the three layout-viewport facts a real keyboard
        // leaves alone must still be untouched, or this is the short-window state
        // wearing the keyboard's name.
        const after = await readGeometry(page);
        if (
          after.innerHeight !== PHONE.height ||
          after.screenHeight !== PHONE.height ||
          after.orientation !== 'portrait-primary' ||
          after.visualHeight !== KEYBOARD_VISUAL_HEIGHT
        ) {
          fail(`the keyboard state moved the wrong viewport: ${JSON.stringify(after)}`);
        }
        process.stdout.write(
          `   keyboard geometry: innerHeight=${after.innerHeight} screen.height=${after.screenHeight} ` +
            `orientation=${after.orientation} visualViewport.height=${String(after.visualHeight)} ` +
            `--app-h=${after.appHeight}\n`,
        );

        // THE POINT OF THIS CAPTURE. A focused text field the keyboard is covering
        // is the bug this state exists to expose, so the field's box is measured
        // against the visible region — NOT scrolled into view. A
        // `scrollIntoViewIfNeeded` here would produce a reassuring screenshot of a
        // state no reader can reach, which is worse than no screenshot.
        //
        // The production response is deliberately one animation frame behind the
        // root attribute: React observes `data-keyboard`, commits its effect, then
        // waits a frame so `scrollIntoView` measures the shortened shell. Waiting
        // for the resulting geometry is therefore required; measuring immediately
        // after the attribute catches a real but transient pre-effect frame.
        //
        // `getBoundingClientRect` is relative to the layout viewport, and
        // `offsetTop` is 0, so the visible band is [0, visualViewport.height].
        const settled = await page
          .waitForFunction(
            () => {
              const field = document.getElementById('pairing-link');
              const box = field?.getBoundingClientRect();
              const visible = window.visualViewport?.height;
              return box !== undefined && visible !== undefined && box.top >= 0 && box.bottom <= visible;
            },
            undefined,
            { timeout: 5_000 },
          )
          .then(
            () => true,
            () => false,
          );
        const fit = await page.evaluate(() => {
          const field = document.getElementById('pairing-link');
          const box = field?.getBoundingClientRect();
          return {
            top: box?.top ?? Number.NaN,
            bottom: box?.bottom ?? Number.NaN,
            visible: window.visualViewport?.height ?? Number.NaN,
            focused: document.activeElement?.id ?? null,
            gate: document.getElementById('fy-portrait-gate') !== null,
          };
        });

        // Screenshot FIRST: if the field is off-screen, this image is the evidence.
        await shot(page, 'setup-scan-keyboard-mobile');

        const inside = settled && fit.top >= 0 && fit.bottom <= fit.visible;
        process.stdout.write(
          `   focused field: top=${fit.top.toFixed(1)} bottom=${fit.bottom.toFixed(1)} ` +
            `visible=${fit.visible.toFixed(1)} -> ${inside ? 'inside' : 'COVERED BY THE KEYBOARD'}; ` +
            `focus=#${String(fit.focused)}; portrait gate mounted=${fit.gate}\n`,
        );
        if (!inside) {
          defects.push(
            `#pairing-link is not inside the visual viewport with the keyboard open: ` +
              `box [${fit.top.toFixed(1)}, ${fit.bottom.toFixed(1)}] against a visible ` +
              `[0, ${fit.visible.toFixed(1)}]. See harness/out/setup-scan-keyboard-mobile.png. ` +
              `This is a production behaviour, not a harness problem — it is deliberately NOT ` +
              `worked around here with a scroll.`,
          );
        }
        if (fit.focused !== 'pairing-link') defects.push('the pairing field lost focus before the keyboard capture');
        if (fit.gate) defects.push('the portrait gate mounted over an upright phone with its keyboard open');
      });

      // 4. A SUCCESSFUL PAIRING, ending on `done`, at both viewports. The arrival
      // seeds the stepper at `pair`, so this is the path a phone's ordinary
      // camera app produces — and the only honest way to reach `done`, which no
      // button on this page may declare.
      for (const viewport of VIEWPORTS) {
        await capture(contextFor(viewport), async page => {
          await page.addInitScript(PAIR_RESPONSE_SCRIPT);
          await open(page, PAIRING_ARRIVAL);
          await page.getByText('Pair this device?').waitFor({ state: 'visible' });
          await page.getByRole('button', { name: 'Pair this device' }).click();
          await page.locator(setupStep('done')).waitFor({ state: 'visible' });
          await shot(page, `setup-done-${viewport.name}`);
        });
      }
    }
  } finally {
    await browser.close();
  }
  // Both reported after the browser is down so a failure cannot leak a Chromium.
  if (missing.length > 0) fail(`the page asked for files the bundle does not serve:\n  ${missing.join('\n  ')}`);
  process.stdout.write('✅ every reference the app requested resolved\n');
  // Non-zero, but only after every capture is on disk: the images of the broken
  // states are the point, and they would be lost by throwing at the assertion.
  if (defects.length > 0) fail(`${defects.length} captured state(s) are wrong:\n  ${defects.join('\n  ')}`);
  process.stdout.write('✅ every captured state holds\n');
} finally {
  server.stop(true);
}
