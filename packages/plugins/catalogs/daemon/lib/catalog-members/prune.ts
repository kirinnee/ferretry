/**
 * What `shares.json` forgets. A share that is no longer live is kept for 30 days after its time ran out so the
 * owner's list still shows it; after that only the audit events remember it. Every join walks every stored
 * share in constant time, so the list must not grow for ever.
 *
 * Pure: the same document back when nothing is old enough, so a caller can tell whether anything changed.
 */
import type { SharesDocument } from './document.ts';
import { shareState } from './admission.ts';

export const SHARE_KEEP_MS = 30 * 24 * 60 * 60 * 1_000;

export function pruneShares(document: SharesDocument, now: number): SharesDocument {
  const kept = document.shares.filter(
    share => shareState(share, now) === 'live' || Date.parse(share.expiresAt) > now - SHARE_KEEP_MS,
  );
  return kept.length === document.shares.length ? document : { ...document, shares: kept };
}
