/**
 * The shape of the cross-account harness history pool a plan asks for and a preview reports, and the pure decisions
 * about where the pool lives. Claude and Codex each get one independent pool; existing state is renamed into it and
 * each account home receives absolute symlinks back to it.
 *
 * GAP(conversation): the planner and the executor that fill these in are Conversation's (today's
 * `shared-history.ts` and its file adapter); only the shapes a runtime's plan carries, and the pool paths it names,
 * are here. Delete this file when Conversation's contract exports them.
 *
 * Pure.
 */
import { join } from 'node:path';
import type { HarnessKind } from './manifest.ts';

export type SharedHistoryEntryType = 'directory' | 'file';

export interface SharedHistoryHome {
  /** Stable, path-safe account identity used only to partition preserved conflicts. */
  readonly account: string;
  readonly path: string;
}

export interface SharedHistoryRequest {
  readonly kind: HarnessKind;
  /** `<FY_HOME>/fleet/shared`; the harness kind is appended by the planner. */
  readonly poolRoot: string;
  /** All homes of this harness kind, in the order provisioning will materialize them. */
  readonly homes: readonly SharedHistoryHome[];
}

export type SharedHistoryChange =
  | {
      readonly kind: 'create-pooled-entry';
      readonly path: string;
      readonly entryType: SharedHistoryEntryType;
    }
  | { readonly kind: 'move'; readonly source: string; readonly destination: string }
  | {
      readonly kind: 'collision';
      readonly incoming: string;
      readonly pooled: string;
      readonly winner: string;
      readonly loser: string;
      readonly preservedAt: string;
    }
  | {
      readonly kind: 'merge-jsonl';
      readonly source: string;
      readonly destination: string;
      readonly sourcePreservedAt: string;
    }
  | { readonly kind: 'link'; readonly path: string; readonly target: string }
  | { readonly kind: 'already-shared'; readonly path: string; readonly target: string };

/** One account home that could not be observed, and therefore has no plan of its own. */
export interface SharedHistoryRefusal {
  readonly account: string;
  /** The account home exactly as it was configured. */
  readonly home: string;
  /** The path the filesystem refused, which may be the home itself or something under it. */
  readonly path: string;
  readonly reason: string;
}

/** The exact read-only report used by dry-run and returned after a successful materialization. */
export interface SharedHistoryPreview {
  readonly kind: HarnessKind;
  readonly pool: string;
  readonly moved: number;
  readonly conflicts: number;
  readonly links: number;
  readonly changes: readonly SharedHistoryChange[];
  /**
   * Source directories the move drains and then removes, innermost first.
   *
   * Every directory here has all of its children renamed into the pool and is then removed while
   * empty. Only the outermost of them — the account-home entry itself — gets a link to the pool put
   * back in its place; the nested ones are removed with nothing put back, because their contents now
   * live under the pooled entry that the entry link reaches. The removal is refused and the whole
   * move rolled back if anything appeared in one meanwhile, so this names mutations that really
   * happen rather than intentions.
   */
  readonly emptiedSourceDirectories: readonly string[];
  /**
   * Homes excluded from this plan because the filesystem refused to read them.
   *
   * A dry run stays truthful and read-only: the remaining homes are still planned in full, and a
   * materialization refuses outright rather than moving a fleet it could only partly observe.
   */
  readonly refusals: readonly SharedHistoryRefusal[];
}


/** `<fleet>/shared`, the directory every harness pool lives under. */
export function sharedHistoryPoolRoot(fleetDirectory: string): string {
  return join(fleetDirectory, 'shared');
}

/** `<fleet>/shared/<harness>`, the one pool every runtime of that harness reads and writes (H1). */
export function sharedHistoryPoolDirectory(fleetDirectory: string, kind: HarnessKind): string {
  return join(sharedHistoryPoolRoot(fleetDirectory), kind);
}

/**
 * The pool request for EVERY harness, with no switch.
 *
 * History is always shared in the account model (H1): there is no `sharedHistory` setting to read,
 * so a harness is pooled whenever it has a runtime. A harness with no home yet still gets its
 * request, because the planner treats an empty home list as "create the pool, link nothing" — and a
 * runtime added later then joins a pool that already exists rather than starting a private one.
 */
export function sharedHistoryPoolRequests(
  fleetDirectory: string,
  homes: Readonly<Record<HarnessKind, readonly SharedHistoryHome[]>>,
): readonly SharedHistoryRequest[] {
  const poolRoot = sharedHistoryPoolRoot(fleetDirectory);
  return (['claude', 'codex'] as const).map(kind => ({ kind, poolRoot, homes: homes[kind] }));
}
