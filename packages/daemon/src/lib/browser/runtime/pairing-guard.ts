import type { BrowserActGuard, BrowserAfterCheck, BrowserGuardPage, BrowserPairingState } from './service.ts';

/**
 * THE PAIRING-SCREEN GUARD (docs/pairing.md, "Never show it to an agent").
 *
 * What an agent is handed of a page (its words, markup, picture, log, script result, or whether some text is on it) is
 * refused while a document that script on that page could reach shows a pairing code, and a check BEFORE the operation
 * is not enough: the code can arrive while the operation runs. So a guard hands back an {@link BrowserAfterCheck} and
 * {@link underGuard} runs it once the operation has finished, its answer or its error in hand, and lets neither out
 * when the page showed a code at any point in between.
 */

/** A look that could not be made: it says the marker is there, because a refusal costs one read and a miss a credential. */
const UNKNOWN: BrowserPairingState = { marked: true, epochs: {} };

/** What the page's pairing documents say now; a page that cannot be asked, or a browser that cannot answer, is marked. */
async function look(page: BrowserGuardPage): Promise<BrowserPairingState> {
  if (page.pairing === undefined) return UNKNOWN;
  try {
    return await page.pairing();
  } catch {
    return UNKNOWN;
  }
}

/** Whether a document that was counted before has shown a code since: its counter moved, or a new one came with one. */
function showedACodeSince(before: BrowserPairingState, now: BrowserPairingState): boolean {
  return Object.entries(now.epochs).some(([page, epoch]) => epoch !== (before.epochs[page] ?? 0));
}

/**
 * Refuses (with the error `refusal` builds) when a pairing document is shown now, and otherwise gives back the check to
 * run after the operation: it refuses when one is shown then, or one was shown in between (a counter that moved).
 */
export async function holdPairingScreen(page: BrowserGuardPage, refusal: () => Error): Promise<BrowserAfterCheck> {
  const before = await look(page);
  if (before.marked) throw refusal();
  return async () => {
    const now = await look(page);
    if (now.marked || showedACodeSince(before, now)) throw refusal();
  };
}

/**
 * Runs `work` under a guard, inside the page's queue: the guard first (it may refuse), then the work, then the check the
 * guard handed back — for a failure as well as an answer, since a script's error text is page content too. A refusal
 * from that check replaces both, and nothing the page said gets out.
 */
export async function underGuard<T>(
  guard: BrowserActGuard | undefined,
  page: BrowserGuardPage,
  work: () => Promise<T>,
): Promise<T> {
  const after = await guard?.(page);
  if (typeof after !== 'function') return await work();
  let done: T;
  try {
    done = await work();
  } catch (error) {
    await after();
    throw error;
  }
  await after();
  return done;
}
