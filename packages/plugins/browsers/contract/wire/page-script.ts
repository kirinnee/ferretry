import type { BrowserElementTarget } from './target.ts';

/**
 * AN AGENT'S OWN SCRIPT — the vocabulary the daemon (`browser.eval`, the page queue, the worker client) and the
 * worker's isolated-world runner (`worker/adapters/page-script.ts`) share.
 *
 * It lives here, not beside the runner, so nothing the daemon loads comes from the worker's adapter tree: that tree
 * runs only inside the worker process and is outside the banned-globals check, and a daemon-side import from it
 * would carry an unchecked global into the daemon unseen.
 */

/** The longest origin a world may report; a longer one is dropped (it reads as unreadable), never cut. */
export const PAGE_SCRIPT_ORIGIN_MAX_CHARS = 2_048;

export interface PageScript {
  /** A function expression, `() => …` or `(element) => …`, as the agent wrote it. */
  readonly source: string;
  readonly target?: BrowserElementTarget;
  readonly timeoutMs?: number;
}
