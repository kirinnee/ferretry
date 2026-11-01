/**
 * What the provisioner refused to touch, as the Runtimes tab says it.
 *
 * A change's apply can leave an operation as the disk has it (a link below a runtime's folder could be
 * swapped to point into the state home between the check and the step, so nothing there is moved, replaced
 * or removed). The daemon names each one with the runtime it is in and its path inside that runtime's
 * folder. This module groups them and words them; it shows the path INSIDE the runtime and never the
 * folder's place on disk, and it does not echo the daemon's own message, which carries that place.
 */

import type { FleetAccountChangeOutcome, FleetApplyResult, FleetRuntimeView } from '@ferretry/protocol';

export type SkippedEntry = NonNullable<FleetApplyResult['skipped']>[number];

export interface SkippedItem {
  /** Relative to the runtime's folder. */
  readonly within: string;
  readonly reason: string;
}

/** Every skip today has the one cause, so one sentence says it; it names no folder. */
export const SKIPPED_REASON = 'A link here could point outside this runtime, so it was left as it was.';

/**
 * What the outcome of a change left as it was, or `null` when it says nothing about that (a sign-out, a
 * rollback): only an apply that landed describes the whole of what it skipped, `[]` included.
 */
export const skippedFromOutcome = (outcome: FleetAccountChangeOutcome): readonly SkippedEntry[] | null => {
  if (outcome.outcome !== 'applied') return null;
  const { apply } = outcome;
  if (apply.outcome === 'committed') return apply.result.skipped ?? [];
  if (apply.outcome === 'committed-with-history-failure') return apply.committed.skipped ?? [];
  return null;
};

const lastPart = (path: string): string =>
  path
    .split('/')
    .filter(part => part !== '')
    .at(-1) ?? 'an item';

export interface GroupedSkips {
  /** Runtime name → its items. */
  readonly byRuntime: ReadonlyMap<string, readonly SkippedItem[]>;
  /** Entries of no listed runtime: only a path inside a runtime, or the last part of any other, is kept. */
  readonly elsewhere: readonly SkippedItem[];
}

export const groupSkipped = (entries: readonly SkippedEntry[], runtimes: readonly FleetRuntimeView[]): GroupedSkips => {
  const byRuntime = new Map<string, SkippedItem[]>();
  const elsewhere: SkippedItem[] = [];
  for (const entry of entries) {
    const item = { within: entry.within ?? lastPart(entry.path), reason: SKIPPED_REASON };
    const owner = entry.runtime === undefined ? undefined : runtimes.find(runtime => runtime.id === entry.runtime);
    if (owner === undefined) {
      elsewhere.push(item);
      continue;
    }
    byRuntime.set(owner.name, [...(byRuntime.get(owner.name) ?? []), item]);
  }
  return { byRuntime, elsewhere };
};

export const skippedCountLine = (count: number): string => `${String(count)} ${count === 1 ? 'item' : 'items'} skipped`;
