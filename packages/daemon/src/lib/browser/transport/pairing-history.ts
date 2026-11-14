import { carriesPairingFragment } from '@ferretry/protocol';

/**
 * WHERE EACH PAGE HAS BEEN, kept by the browser worker from what DevTools reports (docs/pairing.md, "Never show it to an
 * agent"): every address a frame COMMITTED, whether it replaced the document or only moved inside it.
 *
 * A pairing link carries its code in the address's fragment, so a commit whose address carried one is proof a code
 * reached that page. This is the evidence the marker in the app's own DOM can never be: it is written by the worker from
 * navigation events, never by page script, it is not reset when the page navigates, and it outlives the page that made it.
 * A page can hide its DOM; it cannot un-commit an address.
 *
 * It is kept as counters by ORIGIN, never as addresses (an address with a fragment IS the credential), and the count
 * only goes up.
 */

/** The most origins the counters name; an origin past this is counted under {@link PAIRING_HISTORY_OVERFLOW}. */
export const PAIRING_HISTORY_ORIGINS_MAX = 64;

/** The bucket for every origin past the bound: a guard reads it as every origin, so the bound can only refuse more. */
export const PAIRING_HISTORY_OVERFLOW = '*';

/** The origin of an address, or `''` when it cannot be told (`about:blank`, an opaque origin, an address that will not parse). */
export function originOfAddress(address: string): string {
  try {
    const origin = new URL(address).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

/** What one commit says: the page, the address and whether it started a new document of the page's main frame. */
export interface PairingCommit {
  readonly address: string;
  /** Whether the commit came from the page's main frame (a frame inside it does not replace the page's document). */
  readonly mainFrame: boolean;
  /** Whether it stayed inside the document (a fragment or history change) rather than replacing it. */
  readonly sameDocument: boolean;
}

/** What the ledger answers for a set of pages. */
export interface PairingHistoryLook {
  /** Commits that carried a pairing fragment, by origin, since the worker started. Never goes down. */
  readonly commits: Readonly<Record<string, number>>;
  /** Whether the document one of those pages shows now was entered by such a commit. */
  readonly linked: boolean;
  /** How many times the ledger lost track of a page's navigation, since the worker started. Never goes down. */
  readonly lost: number;
  /**
   * Whether the ledger has EVER lost track of a navigation and so cannot prove the history complete. Sticky: it does not
   * go when the page that lost it leaves the group, navigates or closes, only with a fresh ledger (a restarted worker).
   */
  readonly blind: boolean;
}

export class PairingNavigationLedger {
  private readonly commits = new Map<string, number>();
  /** Pages whose current document was entered, or later moved, by an address carrying a pairing fragment. */
  private readonly linked = new Set<string>();
  /** How many times a page's navigation could not be followed: a count that only goes up, so an operation it overlapped is told. */
  private lostCount = 0;

  /** Starts keeping a page's history from the address it has now. */
  watch(pageKey: string, address: string): void {
    this.committed(pageKey, { address, mainFrame: true, sameDocument: false });
  }

  /**
   * A page's navigation cannot be followed (DevTools would not say). The address that was missed could have carried a
   * pairing link, so this is evidence of its own and not a page's state: it is counted, and it makes the ledger blind for
   * good, whatever the page does next and wherever it is when the question is asked.
   */
  lost(_pageKey: string): void {
    this.lostCount += 1;
  }

  committed(pageKey: string, commit: PairingCommit): void {
    if (carriesPairingFragment(commit.address)) {
      this.count(originOfAddress(commit.address));
      this.linked.add(pageKey);
      return;
    }
    // Only a NEW document clears what the old one was entered by: a fragment dropped inside the document (a router's
    // `replaceState`) leaves the document, and whatever it still holds, exactly as it was.
    if (commit.mainFrame && !commit.sameDocument) this.linked.delete(pageKey);
  }

  /** The page is gone. Its commits stay counted, and so does any loss: a window that closed has still shown what it showed. */
  closed(pageKey: string): void {
    this.linked.delete(pageKey);
  }

  look(pageKeys: readonly string[]): PairingHistoryLook {
    return {
      commits: Object.fromEntries(this.commits),
      linked: pageKeys.some(key => this.linked.has(key)),
      lost: this.lostCount,
      blind: this.lostCount > 0,
    };
  }

  private count(origin: string): void {
    const key =
      this.commits.has(origin) || this.commits.size < PAIRING_HISTORY_ORIGINS_MAX ? origin : PAIRING_HISTORY_OVERFLOW;
    this.commits.set(key, (this.commits.get(key) ?? 0) + 1);
  }
}
