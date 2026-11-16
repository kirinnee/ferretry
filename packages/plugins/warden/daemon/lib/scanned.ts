/**
 * When each ferret was last SCANNED by a sweep, so a ferret caller is told only when ITS lineage was last looked at.
 *
 * The global `lastSweepAt` is fleet activity: it moves when a sweep scans anyone, and a ferret that read it could watch
 * (and its agenda outcome, no-sweep or clean-sweep or overdue, would change with) a sweep that looked at nobody of its
 * own. A sweep therefore records, per ferret it scanned, the instant it did; a scoped reader's "last swept" is the
 * newest instant among the ferrets it may read, and absent when none was ever scanned. The owner and a person still
 * read the global `lastSweepAt`.
 *
 * Pure: every input is a value.
 */
import type { WardenReadScope } from './ferret-view.ts';
import type { WardenRuntimeState } from './state.ts';

/** The ferrets a sweep that ran at `at` scanned, merged into what earlier sweeps recorded. A ferret the fleet no longer lists is forgotten. */
export function scannedAfter(
  previous: Readonly<Record<string, string>> | undefined,
  fleet: readonly { readonly config: { readonly id: string } }[],
  scanned: readonly { readonly config: { readonly id: string } }[],
  at: string,
): Record<string, string> {
  const listed = new Set(fleet.map(session => session.config.id));
  const kept = Object.entries(previous ?? {}).filter(([id]) => listed.has(id));
  return { ...Object.fromEntries(kept), ...Object.fromEntries(scanned.map(session => [session.config.id, at])) };
}

/** The latest sweep that scanned a ferret the scope may read; `undefined` when none did. */
export function lineageSweptAt(
  scanned: Readonly<Record<string, string>> | undefined,
  scope: WardenReadScope,
): string | undefined {
  let newest: string | undefined;
  for (const [id, at] of Object.entries(scanned ?? {}))
    if (scope.mayRead(id) && (newest === undefined || Date.parse(at) > Date.parse(newest))) newest = at;
  return newest;
}

/** `lastSweepAt` as a reader may see it: the global one for the owner, the lineage's own for a scoped reader. */
export function sweptField(
  state: Pick<WardenRuntimeState, 'lastSweepAt' | 'scanned'>,
  scope: WardenReadScope | undefined,
): { readonly lastSweepAt?: string } {
  const at = scope === undefined ? state.lastSweepAt : lineageSweptAt(state.scanned, scope);
  return at === undefined ? {} : { lastSweepAt: at };
}
