import type { BrowserActAfter, BrowserActGuard, BrowserGuardPage } from './service.ts';

/**
 * THE GUARD EVERY AGENT READ OF A PAGE RUNS WHEN THE PAGE MAY SHOW A PAIRING CODE (docs/pairing.md, "Never show it to an
 * agent"). It runs inside the page's own queue BEFORE the act, so a marked page — or any window of its opener group, a
 * same-origin frame of it included — never reaches the page; and it hands back the check that runs AFTER the act, success
 * or failure, which refuses when the page or its group was marked at ANY point in between: the marker is on now, a code
 * was shown and has gone (the sighting count moved) or the group changed. What the act read, or why it failed, is then
 * never shown. A page that cannot be asked is one that cannot be shown (fail closed).
 *
 * `refuse` makes the caller's own refusal (a tool error, an API error): the sentence is the caller's, and it names no
 * content. A person's calls never come here.
 */
export function pairingScreenGuard(refuse: () => Error): BrowserActGuard {
  return async (page: BrowserGuardPage): Promise<BrowserActAfter> => {
    const before = await page.pairingState?.();
    if (before === undefined || before.marked) throw refuse();
    return async later => {
      const now = await later.pairingState?.();
      if (now === undefined || now.marked || now.seen !== before.seen || now.pages !== before.pages) throw refuse();
    };
  };
}
