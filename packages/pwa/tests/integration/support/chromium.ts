/**
 * ONE Chromium for the whole test process, launched exactly once.
 *
 * WHAT WAS MEASURED, and it took three rounds to localize. With both `fy-render`
 * integration files in ONE Bun process — an unisolated/direct combined run — the
 * run does not fail, it wedges. Instrumented step by step, the surviving stall is
 * precise: `fixture done`, `reads done`, `server done`, `launch start`, and then
 * nothing until the hook budget expires. The same file ALONE reaches `launch done`
 * and passes 12/12 in 9 s.
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
 * The repair is to make "the first launch" happen once. A memoised promise means the
 * second caller awaits the same initialisation instead of starting a competing one.
 *
 * WHERE THAT MEMO NOW BITES. The official integration entrypoints run with one
 * isolated worker (`--parallel=1`), which implies `--isolate` — a fresh global per
 * file — so each file launches its own browser and there is no second caller in the
 * same global to race it. The memo is still load-bearing for a DIRECT same-process
 * invocation (several files in one Bun process, no `--parallel`): there the two
 * `beforeAll` hooks DO share one global, the second awaits the first launch, and the
 * wedge stays fixed. It is harmless under isolation, where each file's single call
 * is the first.
 *
 * THE BROWSER IS NEVER CLOSED BY A TEST. An `afterAll` would be actively wrong:
 * hooks are per file, so the first file's teardown would close the browser the
 * second file is about to use and the relaunch would be back. Each file still owns
 * its CONTEXTS and closes them, which is where isolation actually lives — a context
 * has its own cookie jar, storage and permissions — so sharing the browser process
 * weakens no claim either file makes. The security file's default-context cookie
 * assertions are unaffected, because the visual file only ever uses `newContext()`.
 *
 * WHO REAPS IT, since no test does. Playwright itself: `launch()` registers the
 * browser with playwright's own process-exit handling, which kills the engine it
 * spawned. That is checked rather than assumed — the verification for this repair
 * counts Chromium processes after the run and finds none.
 *
 * A `launchServer()` + `connect()` variant was tried first, for a `BrowserServer`
 * handle this module could `kill` synchronously — `Browser` exposes no public
 * `process()`, and a `process.on('exit')` handler cannot await a `close()`. It was
 * abandoned on measurement: under Bun the FIRST `launchServer` never resolved, where
 * plain `launch()` resolves in about 200 ms. Reaching for a handle we do not need
 * would have traded a fixed wedge for a new one.
 */
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
 * The process's browser. Both integration files await this in `beforeAll`, and
 * FIRST — before any other setup — so there is one obvious ordering rather than a
 * per-file one.
 *
 * A rejection is not remembered, so one transient launch failure does not poison
 * every later file in the run.
 */
export const sharedChromium = (): Promise<Browser> => {
  if (shared !== null) return shared;
  const started = launch();
  shared = started;
  started.catch(() => {
    if (shared === started) shared = null;
  });
  return started;
};

/**
 * DELIBERATELY NO EXIT HOOK HERE.
 *
 * There is nothing this module could usefully do in one. An exit handler cannot
 * await `browser.close()`, and `Browser` gives no synchronous handle to kill — so a
 * hook would be a comment pretending to be cleanup. Playwright's own exit handling
 * already kills the engine it launched, and the repair's verification counts
 * Chromium processes afterwards to show that it does.
 */
