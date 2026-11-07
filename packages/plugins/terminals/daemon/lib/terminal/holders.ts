import type { TerminalHolder, TerminalHolderStanding } from '@ferretry/protocol';
import type { TerminalOwnerStanding, TerminalRecord } from './contracts.ts';

/**
 * WHO IS HOLDING THE TERMINAL SLOTS — as pure decisions.
 *
 * A terminal belongs to a ferret, and a ferret that has COMPLETED or been STOPPED has no use for its
 * shells. They outlived it, though, and the daemon's global limit counts every one: seven finished
 * ferrets once held all 24 slots and nothing new could open. These functions group the open terminals by
 * owner, say which owners are finished, and word the refusal so the person who reads it knows exactly
 * who to blame.
 */

/** The session statuses after which a ferret's terminals are no use to it. */
export const FINISHED_SESSION_STATUSES: ReadonlySet<string> = new Set(['completed', 'stopped']);

/** The status word of a session that no longer exists. */
export const REMOVED_SESSION_STATUS = 'removed';

/**
 * Where an owner stands, from the status its session records.
 *
 * `undefined` is a session this daemon does not hold: it was removed (or never existed), and a shell
 * nobody can address is exactly what boot reconciliation exists to close. Every status that is not
 * plainly finished is `live` — a stalled or failed ferret is revived by the Warden, and a terminal
 * closed under it would be a loss nobody asked for.
 */
export function standingOfSessionStatus(status: string | undefined): Omit<TerminalOwnerStanding, 'label'> {
  if (status === undefined) return { standing: 'gone', status: REMOVED_SESSION_STATUS };
  return { standing: FINISHED_SESSION_STATUSES.has(status) ? 'finished' : 'live', status };
}

/** Terminals grouped by owner, largest first; equal holders in label order so the answer is stable. */
export function groupTerminalHolders(
  records: readonly Pick<TerminalRecord, 'ownerId'>[],
  standings: ReadonlyMap<string, TerminalOwnerStanding>,
): TerminalHolder[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.ownerId, (counts.get(record.ownerId) ?? 0) + 1);
  return [...counts]
    .map(([sessionId, count]): TerminalHolder => {
      const known = standings.get(sessionId);
      return {
        sessionId,
        label: known?.label ?? sessionId,
        standing: known?.standing ?? 'live',
        status: known?.status ?? 'unknown',
        count,
      };
    })
    .toSorted((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/** Whether a holder's terminals may be closed without asking anyone. */
export function isReclaimable(standing: TerminalHolderStanding): boolean {
  return standing !== 'live';
}

/**
 * The refusal when the whole daemon is full: how many are open and who holds them, finished holders
 * first so the reclaimable ones are the first thing read, and what to do about it.
 */
export function describeCapacity(open: number, holders: readonly TerminalHolder[]): string {
  if (holders.length === 0) return `global terminal capacity reached: ${String(open)} terminals open.`;
  const ordered = [...holders].toSorted(
    (left, right) => Number(isReclaimable(right.standing)) - Number(isReclaimable(left.standing)),
  );
  const who = ordered.map(holder => `${String(holder.count)} by ${holder.label} (${holder.status})`).join(', ');
  const reclaimable = holders.some(holder => isReclaimable(holder.standing));
  const remedy = reclaimable
    ? 'Close the finished ones in Settings or with `fy terminal close --all-finished`.'
    : 'Close one you no longer need.';
  return `global terminal capacity reached: ${String(open)} terminals open: ${who}. ${remedy}`;
}
