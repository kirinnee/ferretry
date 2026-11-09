/**
 * ORPHAN NOTICE RETRIES: how long the Warden leaves an orphaned card's notice alone after it failed to land.
 *
 * WHY. A notice the Agenda refuses is not remembered as told (`orphans.ts`), so every sweep tried it again: a
 * board that already held its maximum of unresolved items refused the same 31 notices every two minutes, about
 * 930 journal lines an hour, none of which could ever succeed.
 *
 * THE RULE. Keyed by card, and remembering WHAT was tried ({@link orphanTellKey}: how, about which finished
 * ferret, to whom):
 *
 * - each failure of the SAME try waits longer before the next: {@link ORPHAN_RETRY_BASE_MS}, then twice it, four
 *   times it, … and {@link ORPHAN_RETRY_CEILING_MS} at most;
 * - a DIFFERENT try (the card changed hands, its owner ferret finished, the notice moves to another board) is
 *   made at once: a new situation is never hidden behind an old failure;
 * - a card that is no longer orphaned forgets its failures, and a try that lands forgets them too.
 *
 * Pure: no IO, no clock, no globals.
 */
import type { CardId } from '@ferretry/plugin-board/contract';
import { instantMs, isoFromMs } from './time.ts';

/** The first wait after a failed try: a little over two sweeps. */
const ORPHAN_RETRY_BASE_MS = 5 * 60_000;

/** The longest wait between two tries of the same notice. */
const ORPHAN_RETRY_CEILING_MS = 6 * 60 * 60_000;

/** What the Warden remembers of one card's failing notice. */
export interface OrphanRetry {
  /** The try that failed ({@link orphanTellKey}). */
  readonly key: string;
  /** Failures of this same try in a row. */
  readonly failures: number;
  /** Before this instant the same try is not made again. */
  readonly retryAt: string;
  /** Why the last try failed, in words. */
  readonly reason: string;
}

/** Every card whose notice is failing, keyed by card id. */
export type OrphanRetryMemory = Readonly<Record<string, OrphanRetry>>;

/** The identity of one try: how the owner is told, about which finished ferret, and where. */
export const orphanTellKey = (tell: {
  readonly kind: string;
  readonly assignee: string;
  readonly sessionId: string;
}): string => `${tell.kind}|${tell.assignee}|${tell.sessionId}`;

/** How long after the `failures`-th failure of one try the next may be made. */
export function orphanRetryDelayMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  const rungs = Math.min(Math.floor(failures) - 1, 16);
  return Math.min(ORPHAN_RETRY_CEILING_MS, ORPHAN_RETRY_BASE_MS * 2 ** rungs);
}

/** Whether a try is still being waited out: the same try, failed before, and its time has not come. */
export function orphanTryHeld(held: OrphanRetry | undefined, key: string, nowMs: number): boolean {
  if (held?.key !== key) return false;
  const retryAt = instantMs(held.retryAt);
  return retryAt !== undefined && nowMs < retryAt;
}

/** What a try that just failed leaves behind, and whether the failure is news (a new try, or a new reason). */
export function orphanTryFailed(
  held: OrphanRetry | undefined,
  key: string,
  reason: string,
  nowMs: number,
): { readonly retry: OrphanRetry; readonly news: boolean } {
  const same = held?.key === key;
  const failures = same ? held.failures + 1 : 1;
  return {
    retry: { key, failures, retryAt: isoFromMs(nowMs + orphanRetryDelayMs(failures)), reason },
    news: !same || held.reason !== reason,
  };
}

/** The failures kept for the cards still orphaned: a card that recovered, or left its lane, forgets them. */
export function keepOrphanRetries(
  memory: OrphanRetryMemory,
  current: ReadonlySet<CardId>,
): Record<string, OrphanRetry> {
  return Object.fromEntries(Object.entries(memory).filter(([taskId]) => current.has(taskId as CardId)));
}
