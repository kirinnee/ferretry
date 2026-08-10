/**
 * ONE Chromium for the whole test process, launched exactly once.
 *
 * WHAT WAS MEASURED, and it took three rounds to localize. With both `fy-render`
 * integration files in one Bun process — which is how `scripts/ci/test.sh int` runs
 * every integration file — the run does not fail, it wedges. Instrumented step by
 * step, the surviving stall is precise: `fixture done`, `reads done`,
 * `server done`, `launch start`, and then nothing until the hook budget expires.
 * The same file ALONE reaches `launch done` and passes 12/12 in 9 s.
 *
 * So the defect is not the compile (that was a separate, real wedge, removed by
 * `fy-render-integration-fixture.ts` spawning a child), and it is not launching
 * after a `Bun.spawn`. It is TWO FIRST-TIME LAUNCHES in one process: Bun runs both
 * files' top-level `beforeAll` hooks such that each file's `chromium.launch` begins
 * before the other has finished, and playwright's one-time driver initialisation
 * does not survive that. It also explains a probe that misled an earlier round — two
 * sequential launches, and even two concurrent BROWSERS, are both fine once the
 * driver has initialised once, so only the very first pair races.
 *
 * A second measured failure made the ownership boundary broader: five visual files
 * that each launched and closed an independent browser passed 19 cases, then one
 * file found its Browser disconnected before `newPage()`. Serial isolated files
 * avoided that race, but made Bun 1.3.13 re-initialise Playwright in a fresh global
 * for every file; two complete integration runs then failed inside Playwright module
 * initialisation with `epoll_ctl EEXIST`, and one teardown also consumed its full
 * 120-second hook budget.
 *
 * The durable repair is one module initialisation and one browser for EVERY
 * browser-owning integration file. A memoised promise makes every caller await the
 * same first launch, and no file closes a process-level object a sibling still owns.
 *
 * NO TEST FILE CLOSES THE BROWSER. A per-file `afterAll` would be actively wrong:
 * the first file's teardown would close the browser another file is about to use.
 * `bunfig.int.toml` instead preloads THIS MODULE, which makes the `afterAll` below a
 * global multi-file hook. It closes the one Browser only after every integration
 * file is done. Each file still owns its CONTEXTS and closes them, which is where
 * isolation actually lives — a context has its own cookie jar, storage and
 * permissions — so sharing the browser process weakens no claim. The security
 * file's default-context cookie assertions are unaffected, because every other
 * browser consumer uses `newContext()`.
 *
 * WHO REAPS IT. The global async hook awaits `Browser.close()`. The acceptance
 * proof must observe one stable browser PID for the whole multi-file run and none
 * after the process exits. Playwright's process-exit handling remains a last
 * resort, not the ownership mechanism.
 *
 * A `launchServer()` + `connect()` variant was tried first, for a `BrowserServer`
 * handle this module could `kill` synchronously — `Browser` exposes no public
 * `process()`, and a `process.on('exit')` handler cannot await a `close()`. It was
 * abandoned on measurement: under Bun the FIRST `launchServer` never resolved, where
 * plain `launch()` resolves in about 200 ms. Reaching for a handle we do not need
 * would have traded a fixed wedge for a new one.
 */
import { afterAll } from 'bun:test';
import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';

let shared: Promise<Browser> | null = null;

const launch = async (): Promise<Browser> => {
  const executablePath = Bun.which('google-chrome') ?? Bun.which('chromium');
  // FAIL CLOSED. This tier is real-browser evidence or nothing; skipping would turn
  // a missing engine into a green run that measured no browser at all.
  if (executablePath === null)
    throw new Error('❌ no Chromium binary found; this tier is real-browser evidence or nothing');
  return await chromium.launch({ executablePath, headless: true });
};

/**
 * The test process's browser. Every integration file that needs Chromium reaches
 * this function rather than launching or closing its own Browser.
 *
 * A rejected launch or a later browser disconnect is not remembered, so one
 * transient failure does not poison every later file in the run.
 */
export const sharedChromium = (): Promise<Browser> => {
  if (shared !== null) return shared;
  const started = launch();
  shared = started;
  void started
    .then(
      browser => {
        browser.on('disconnected', () => {
          if (shared === started) shared = null;
        });
      },
      () => {
        if (shared === started) shared = null;
      },
    )
    .catch(() => {});
  return started;
};

/**
 * ONE GLOBAL TEARDOWN, registered because `bunfig.int.toml` preloads this module.
 *
 * The memo is cleared before the await so the `disconnected` listener from an old
 * Browser can never erase a newer promise. A rejected launch already failed its
 * caller and needs nothing closed; a close failure is different and propagates so a
 * leaked browser cannot masquerade as a green tier. This hook is the last Browser
 * owner: a future global hook must not call `sharedChromium()` after teardown starts
 * or it would launch a Browser no hook remains to close.
 */
afterAll(async () => {
  const current = shared;
  shared = null;
  if (current === null) return;

  let browser: Browser;
  try {
    browser = await current;
  } catch {
    return;
  }
  if (browser.isConnected()) await browser.close();
});
