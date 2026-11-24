/**
 * WHAT THE FERRET LIST SHOWS, as pure decisions (today's sessions bar, over `FerretSummary`).
 *
 * WHICH FERRETS. A ferret that is over (stopped) is HIDDEN until the reader ticks "Show stopped". Nothing is cut by age:
 * a stopped ferret is still one you go back to for its transcript, which is why the tick exists and says how many it is
 * hiding. Two exceptions stay listed: the ferret on screen (a list that drops the page you are looking at reads as
 * broken) and a pinned one (a pin is the owner's own word that it matters).
 *
 * COUNTS ARE THE LIST'S OWN PREDICATE. A segment's number is the length of the list that choosing that segment would
 * draw, under the same stopped rule — never a total that stops matching the rows underneath it. "Show stopped (3)" is
 * likewise the stopped ferrets that tick would add under the kind chosen.
 *
 * A ferret whose record names no `mode` (one carried over from a record that never stamped it) is an AGENT, the one
 * reading every daemon reader gives it (`record.mode ?? 'auto'`: the session document, the auto-resume roster, a move's
 * resume), so it is counted and filtered under Agents and never silently under none of the kinds.
 *
 * NEEDS YOU. A ferret with open items waiting on the owner (the Agenda says which: `ferrets.needs-you`) is listed though
 * it is stopped (an unread row that vanished would be an unanswered ferret). While the device's "Group Needs you at the
 * top" is on, those ferrets gather into "Needs you" under Pinned, newest first, and are not repeated below; with it off
 * they stay in their folders, still marked. Nothing else puts a ferret there: a ferret parked on the owner is a status.
 *
 * PINNED ferrets lift into "Pinned" above everything, oldest pin first, and are not repeated below. The rest group by
 * folder, newest activity first inside a group, the busiest group first. Ferrets cannot read the Projects registry, so
 * which registered project a folder belongs to is Projects' answer (`ferrets.list-scope`): its key and name when it
 * covers the folder, else the normalised folder named by its base name.
 *
 * SUB-FERRETS. A ferret started by another (`parent`) is drawn UNDER its parent when both are in the same list (the same
 * Pinned, Needs you or folder group), collapsed behind the parent's chevron. Whatever is not nested under a listed
 * parent stays where it was: a child whose parent is pinned, filtered out or in another folder is a row of its own, so
 * no ferret ever vanishes into a collapsed branch it cannot be found in. A branch opens by itself while it holds the
 * open ferret or one that waits on the owner. The counts are unchanged: a child counts as the ferret it is.
 *
 * FOLDER MODE. While the focus names a group, only that group's ferrets are drawn (Pinned and Needs you included: a
 * focus is the reader's word that nothing else matters now). A focus on a folder no project covers and no ferret is in
 * is STALE (`scopeIsStale`) and the list asks Projects to drop it, once the registry has been read (`known`).
 */

import type { ModeFilter } from '@ferretry/app';
import type {
  FerretListGroupKey,
  FerretListScopeSnapshot,
  FerretNeedsYou,
  FerretSummary,
} from '../../../contract/index.ts';
import { statusMark } from '../../lib/status-mark.tsx';
import { folderBaseName, normalizeFolder } from '../new-ferret/recent-folders.ts';

/** The two controls the list owns: which kind of ferret, and whether the stopped ones are listed. */
export interface FerretListFilter {
  readonly mode: ModeFilter;
  readonly showStopped: boolean;
}

/** Stopped ferrets hidden, only the ferrets a person drives: what a new device's list opens with. */
export const DEFAULT_LIST_FILTER: FerretListFilter = { mode: 'interactive', showStopped: false };

/** The owner pinned this ferret to the top of the list. */
export const isPinned = (ferret: FerretSummary): boolean => ferret.pinnedAt !== undefined;

/** Oldest pin first; the id breaks a tie so the order never shuffles between reads. */
export const byPinOrder = (left: FerretSummary, right: FerretSummary): number =>
  Date.parse(left.pinnedAt ?? '') - Date.parse(right.pinnedAt ?? '') || left.id.localeCompare(right.id);

/** The ferret is over: the status mark's own finished class, so the list and the mark never disagree. */
export const isStopped = (ferret: FerretSummary): boolean => statusMark(ferret).klass === 'finished';

/** The kind a ferret is: its recorded mode, and an agent when the record names none (as the daemon reads it). */
const modeOf = (ferret: FerretSummary): 'auto' | 'interactive' => ferret.mode ?? 'auto';

/**
 * Whether the ferret is the owner's — the "Mine" segment: one they drive (interactive) OR one a person started. The New
 * ferret form starts an `auto` ferret by default, so a ferret the owner made from the browser is autonomous yet theirs;
 * the record's `birth` says who first started it. A ferret an agent started, or whose record names no birth, is not.
 */
const isMine = (ferret: FerretSummary): boolean => modeOf(ferret) === 'interactive' || ferret.birth === 'person';

/** Whether the ferret is the kind a segment asks for. Mine and Agents may share a ferret: it is both theirs and autonomous. */
export const matchesMode = (ferret: FerretSummary, mode: ModeFilter): boolean =>
  mode === 'all' || (mode === 'interactive' ? isMine(ferret) : modeOf(ferret) === mode);

/**
 * Which ferrets the list draws before the kind is chosen: everything live, the stopped ones only when ticked, a pinned
 * one always, and the open ferret always. `keep` names the open one; a caller that has none passes nothing.
 */
export const listedBeforeMode = (
  ferret: FerretSummary,
  { showStopped }: FerretListFilter,
  keep?: (ferret: FerretSummary) => boolean,
  needing?: NeedingYou,
): boolean =>
  keep?.(ferret) === true || showStopped || !isStopped(ferret) || isPinned(ferret) || needsYou(ferret, needing);

/** Which ferrets wait on the owner, by ferret id (`ferrets.needs-you`); absent when nobody says. */
export type NeedingYou = ReadonlyMap<string, FerretNeedsYou>;

/** The ferret has open items waiting on the owner. */
const needsYou = (ferret: FerretSummary, needing: NeedingYou | undefined): boolean => needing?.has(ferret.id) === true;

/** What the list reads of Needs you: who waits, and whether the device gathers them at the top. */
export interface NeedsYouRead {
  readonly needing: NeedingYou;
  readonly group: boolean;
}

/** Newest `latestAt` first; the id keeps the order from shuffling between reads. */
const byNeedsYouOrder =
  (needing: NeedingYou) =>
  (left: FerretSummary, right: FerretSummary): number =>
    Date.parse(needing.get(right.id)?.latestAt ?? '') - Date.parse(needing.get(left.id)?.latestAt ?? '') ||
    left.id.localeCompare(right.id);

/** How many ferrets each kind segment would draw. */
interface ModeCounts {
  readonly all: number;
  readonly interactive: number;
  readonly auto: number;
}

/** The tallies the filter controls print, from the ferrets already past the stopped rule. */
export interface ListTallies {
  readonly counts: ModeCounts;
  /** How many stopped ferrets switching on "Show stopped" would add under the kind chosen. */
  readonly hiddenStopped: number;
}

export const listTallies = (
  ferrets: readonly FerretSummary[],
  filter: FerretListFilter,
  keep?: (ferret: FerretSummary) => boolean,
  needing?: NeedingYou,
): ListTallies => {
  const listed = ferrets.filter(ferret => listedBeforeMode(ferret, filter, keep, needing));
  return {
    counts: {
      all: listed.length,
      auto: listed.filter(ferret => modeOf(ferret) === 'auto').length,
      interactive: listed.filter(isMine).length,
    },
    hiddenStopped: ferrets.filter(
      ferret => !listedBeforeMode(ferret, filter, keep, needing) && matchesMode(ferret, filter.mode),
    ).length,
  };
};

/** One folder's ferrets. */
export interface FerretGroup {
  readonly name: string;
  /** The group KEY (the normalised folder), not a display path. */
  readonly path: string;
  readonly rows: readonly FerretSummary[];
}

/** Newest life-sign first; a ferret with no readable instant sorts last rather than making the comparator `NaN`. */
const activityAt = (ferret: FerretSummary): number => {
  const parsed = Date.parse(ferret.stateAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const byActivity = (left: FerretSummary, right: FerretSummary): number => activityAt(right) - activityAt(left);

/** Which group a folder files under, as the project provider says ("no say": the list's own folder grouping). */
export type GroupOf = (folder: string) => FerretListGroupKey | null;

/**
 * The group a ferret belongs to: the registered project that covers its folder, as the provider (`ferrets.list-scope`)
 * names it, else its normalised folder named by the folder's base name.
 */
export const groupOf = (ferret: FerretSummary, provided?: GroupOf): FerretListGroupKey => {
  const registered = provided?.(ferret.folder);
  if (registered !== null && registered !== undefined) return registered;
  const key = normalizeFolder(ferret.folder);
  return { key, name: key === '' ? 'ungrouped' : folderBaseName(key) };
};

/** Groups by folder (or by registered project); rows newest first, the busiest group first and ties by name. */
export const groupByFolder = (ferrets: readonly FerretSummary[], provided?: GroupOf): readonly FerretGroup[] => {
  const groups = new Map<string, { name: string; path: string; rows: FerretSummary[] }>();
  for (const ferret of ferrets) {
    const { key, name } = groupOf(ferret, provided);
    const existing = groups.get(key);
    if (existing) existing.rows.push(ferret);
    else groups.set(key, { name, path: key, rows: [ferret] });
  }
  const ordered = [...groups.values()];
  for (const group of ordered) group.rows.sort(byActivity);
  return ordered.sort((left, right) => right.rows.length - left.rows.length || left.name.localeCompare(right.name));
};

export interface FerretListView extends ListTallies {
  /** The owner's pinned ferrets, oldest pin first: the "Pinned" group above all. Not repeated in `groups`. */
  readonly pinned: readonly FerretSummary[];
  /** Ferrets with open items, newest first: the "Needs you" group under Pinned. Empty when the device turned it off. */
  readonly needsYou: readonly FerretSummary[];
  readonly groups: readonly FerretGroup[];
}

/** The list's whole content in one pass: the groups and the tallies come from the same pool. */
export const ferretListView = (
  ferrets: readonly FerretSummary[],
  filter: FerretListFilter,
  keep?: (ferret: FerretSummary) => boolean,
  waiting?: NeedsYouRead,
  scoped?: FerretListScopeSnapshot,
): FerretListView => {
  const needing = waiting?.needing;
  const inScope = (ferret: FerretSummary): boolean =>
    scoped?.scope == null || groupOf(ferret, scoped.groupOf).key === scoped.scope;
  const drawn = ferrets.filter(
    ferret => listedBeforeMode(ferret, filter, keep, needing) && matchesMode(ferret, filter.mode) && inScope(ferret),
  );
  const unpinned = drawn.filter(ferret => !isPinned(ferret));
  const gathered =
    waiting === undefined || !waiting.group ? [] : unpinned.filter(ferret => needsYou(ferret, waiting.needing));
  return {
    pinned: drawn.filter(isPinned).sort(byPinOrder),
    needsYou: waiting === undefined ? [] : [...gathered].sort(byNeedsYouOrder(waiting.needing)),
    groups: groupByFolder(
      unpinned.filter(ferret => !gathered.includes(ferret)),
      scoped?.groupOf,
    ),
    ...listTallies(ferrets, filter, keep, needing),
  };
};

/** One row of the list with the sub-ferrets drawn under it. */
export interface FerretNode {
  readonly ferret: FerretSummary;
  readonly children: readonly FerretNode[];
}

/**
 * The rows as a forest: a ferret whose parent is in the same rows nests under it, in the order the rows came in. A
 * parent chain that loops back on itself (no daemon writes one) is not nested at all, so it can never recurse or drop
 * a row.
 */
export const nestRows = (rows: readonly FerretSummary[]): readonly FerretNode[] => {
  const byId = new Map(rows.map(ferret => [ferret.id, ferret] as const));
  const nestsUnder = (ferret: FerretSummary): boolean => {
    const seen = new Set<string>([ferret.id]);
    let at: FerretSummary | undefined = ferret;
    while (at?.parent !== undefined) {
      const up: FerretSummary | undefined = byId.get(at.parent);
      if (up === undefined) return at !== ferret;
      if (seen.has(up.id)) return false;
      seen.add(up.id);
      at = up;
    }
    return at !== ferret;
  };
  const nested = new Map<string, FerretSummary[]>();
  const roots: FerretSummary[] = [];
  for (const ferret of rows) {
    if (ferret.parent !== undefined && nestsUnder(ferret)) {
      const siblings = nested.get(ferret.parent);
      if (siblings === undefined) nested.set(ferret.parent, [ferret]);
      else siblings.push(ferret);
    } else roots.push(ferret);
  }
  const node = (ferret: FerretSummary): FerretNode => ({
    ferret,
    children: (nested.get(ferret.id) ?? []).map(node),
  });
  return roots.map(node);
};

/** Every ferret under a node, not the node itself. */
export const descendantsOf = (node: FerretNode): readonly FerretSummary[] =>
  node.children.flatMap(child => [child.ferret, ...descendantsOf(child)]);

/**
 * Whether a branch is open before the reader touches it: closed, unless it holds the open ferret or one that waits on
 * the owner (an answer that sat behind a collapsed row would be an unanswered ferret).
 */
export const openByDefault = (
  node: FerretNode,
  isOpen: (ferret: FerretSummary) => boolean,
  needing?: NeedingYou,
): boolean => descendantsOf(node).some(ferret => isOpen(ferret) || needsYou(ferret, needing));

/** The kind segments in the order they are drawn (Mine first: what a new device opens on), in the reader's words. */
export const MODE_SEGMENTS: readonly { readonly mode: ModeFilter; readonly label: string; readonly hint: string }[] = [
  { mode: 'interactive', label: 'Mine', hint: 'Mine — the ferrets you started or drive yourself' },
  { mode: 'all', label: 'All', hint: 'Every ferret' },
  { mode: 'auto', label: 'Agents', hint: 'Agents — autonomous ferrets that work unattended' },
];

/** What an empty list says: which kind found nothing, and how many stopped ferrets the tick would add. */
export const emptyMessage = (filter: FerretListFilter, hiddenStopped: number): string => {
  const kind = filter.mode === 'auto' ? 'agent ' : '';
  const of = filter.mode === 'interactive' ? ' of yours' : '';
  if (hiddenStopped > 0)
    return `No live ${kind}ferrets${of} — ${hiddenStopped} stopped. Switch on Show stopped in the ⋯ menu.`;
  return filter.mode === 'all' ? 'No ferrets are running.' : `No ${kind}ferrets${of}.`;
};

/** A home directory, written the way a shell prompt writes it. */
const HOME_PREFIX = /^\/(?:home|Users)\/[^/]+(?=\/|$)/u;

/**
 * The row's directory line: the folder the ferret runs in, with a home directory shortened to `~`. The list truncates
 * it from the LEFT, so the worktree's own name — the part that differs — stays.
 */
export const ferretDirectory = (ferret: FerretSummary): string => ferret.folder.replace(HOME_PREFIX, '~');

/**
 * The focus names a folder this daemon does not know: no registered project covers it and no ferret files under it. A
 * folder that is known but has no ferrets right now is NOT stale (the list says it is empty); a deleted one is.
 */
export const scopeIsStale = (ferrets: readonly FerretSummary[], scoped: FerretListScopeSnapshot): boolean =>
  scoped.known &&
  scoped.scope !== null &&
  scoped.groupOf(scoped.scope) === null &&
  !ferrets.some(ferret => groupOf(ferret, scoped.groupOf).key === scoped.scope);
