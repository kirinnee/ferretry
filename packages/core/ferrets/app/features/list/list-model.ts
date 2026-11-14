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
 * PINNED ferrets lift into "Pinned" above everything, oldest pin first, and are not repeated below. The rest group by
 * folder (Ferrets cannot read the Projects list, so the group key is the normalised folder and its name the folder's
 * base name), newest activity first inside a group, the busiest group first.
 */

import type { ModeFilter } from '@ferretry/app';
import type { FerretSummary } from '../../../contract/index.ts';
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

/** Whether the ferret is the kind a segment asks for. */
export const matchesMode = (ferret: FerretSummary, mode: ModeFilter): boolean =>
  mode === 'all' || modeOf(ferret) === mode;

/**
 * Which ferrets the list draws before the kind is chosen: everything live, the stopped ones only when ticked, a pinned
 * one always, and the open ferret always. `keep` names the open one; a caller that has none passes nothing.
 */
export const listedBeforeMode = (
  ferret: FerretSummary,
  { showStopped }: FerretListFilter,
  keep?: (ferret: FerretSummary) => boolean,
): boolean => keep?.(ferret) === true || showStopped || !isStopped(ferret) || isPinned(ferret);

/** How many ferrets each kind segment would draw. */
interface ModeCounts {
  readonly all: number;
  readonly interactive: number;
  readonly auto: number;
}

/** The tallies the filter controls print, from the ferrets already past the stopped rule. */
export interface ListTallies {
  readonly counts: ModeCounts;
  /** How many stopped ferrets ticking "Show stopped" would add under the kind chosen. */
  readonly hiddenStopped: number;
}

export const listTallies = (
  ferrets: readonly FerretSummary[],
  filter: FerretListFilter,
  keep?: (ferret: FerretSummary) => boolean,
): ListTallies => {
  const listed = ferrets.filter(ferret => listedBeforeMode(ferret, filter, keep));
  return {
    counts: {
      all: listed.length,
      auto: listed.filter(ferret => modeOf(ferret) === 'auto').length,
      interactive: listed.filter(ferret => modeOf(ferret) === 'interactive').length,
    },
    hiddenStopped: ferrets.filter(ferret => !listedBeforeMode(ferret, filter, keep) && matchesMode(ferret, filter.mode))
      .length,
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

/** The group a ferret belongs to: its normalised folder, named by the folder's base name. */
const groupOf = (ferret: FerretSummary): { readonly key: string; readonly name: string } => {
  const key = normalizeFolder(ferret.folder);
  return { key, name: key === '' ? 'ungrouped' : folderBaseName(key) };
};

/** Groups by folder; rows newest first, the busiest group first and ties by name. */
export const groupByFolder = (ferrets: readonly FerretSummary[]): readonly FerretGroup[] => {
  const groups = new Map<string, { name: string; path: string; rows: FerretSummary[] }>();
  for (const ferret of ferrets) {
    const { key, name } = groupOf(ferret);
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
  readonly groups: readonly FerretGroup[];
}

/** The list's whole content in one pass: the groups and the tallies come from the same pool. */
export const ferretListView = (
  ferrets: readonly FerretSummary[],
  filter: FerretListFilter,
  keep?: (ferret: FerretSummary) => boolean,
): FerretListView => {
  const drawn = ferrets.filter(ferret => listedBeforeMode(ferret, filter, keep) && matchesMode(ferret, filter.mode));
  return {
    pinned: drawn.filter(isPinned).sort(byPinOrder),
    groups: groupByFolder(drawn.filter(ferret => !isPinned(ferret))),
    ...listTallies(ferrets, filter, keep),
  };
};

/** The kind segments in the order they are drawn (Interactive first: what a new device opens on), in the reader's words. */
export const MODE_SEGMENTS: readonly { readonly mode: ModeFilter; readonly label: string; readonly hint: string }[] = [
  { mode: 'interactive', label: 'Interactive', hint: 'Interactive — a person drives them' },
  { mode: 'all', label: 'All', hint: 'Every ferret' },
  { mode: 'auto', label: 'Agents', hint: 'Agents — autonomous ferrets that work unattended' },
];

/** What an empty list says: which kind found nothing, and how many stopped ferrets the tick would add. */
export const emptyMessage = (filter: FerretListFilter, hiddenStopped: number): string => {
  const kind = filter.mode === 'all' ? '' : filter.mode === 'auto' ? 'agent ' : 'interactive ';
  if (hiddenStopped > 0) return `No live ${kind}ferrets — ${hiddenStopped} stopped. Tick Show stopped.`;
  return filter.mode === 'all' ? 'No ferrets are running.' : `No ${kind}ferrets.`;
};

/** A home directory, written the way a shell prompt writes it. */
const HOME_PREFIX = /^\/(?:home|Users)\/[^/]+(?=\/|$)/u;

/**
 * The row's directory line: the folder the ferret runs in, with a home directory shortened to `~`. The list truncates
 * it from the LEFT, so the worktree's own name — the part that differs — stays.
 */
export const ferretDirectory = (ferret: FerretSummary): string => ferret.folder.replace(HOME_PREFIX, '~');
