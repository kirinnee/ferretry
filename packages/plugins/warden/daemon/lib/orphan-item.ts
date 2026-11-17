import { clipAtWord, MAX_AGENDA_DETAIL_LENGTH, MAX_AGENDA_SUBJECT_LENGTH } from './protocol.ts';
import { orphanTitle, type OrphanedTask } from './orphans.ts';

/** The entry of the one machine item every task with nobody working on it is listed on (`standing`, keyed by it). */
export const ORPHANS_ENTRY = 'warden.orphans';

/**
 * How many tasks the item names: the oldest waits first, then a "…and N more." line. A list that grows without bound
 * would never fit an item, and the owner acts on the first few anyway. 10,000 orphans still make one short item.
 */
export const MAX_LISTED_ORPHANS = 12;

/** The longest one row may be: a row that is longer gives way at a word, so a few rows always fit. */
const MAX_ROW_LENGTH = 300;

/** What the one machine item says: its wording, restated whole every sweep (`AsksApi.standing`). */
export interface OrphanItem {
  readonly subject: string;
  readonly why: string;
  readonly howToResolve: string;
  readonly context: string;
}

/** One row per line, then how many are not shown. */
const bodyOf = (rows: readonly string[], hidden: number): string =>
  [...rows, ...(hidden > 0 ? [`…and ${String(hidden)} more.`] : [])].join('\n');

/**
 * The tasks with nobody working on them, as ONE item (docs/agenda.md § The machine agenda; v4's orphan list). The
 * caller keeps the item current with `standing` (the same item as the list changes, nothing written when the wording
 * is the same) and closes it when the list is empty: `undefined`.
 *
 * The body names the first {@link MAX_LISTED_ORPHANS} tasks, oldest wait first, then counts the rest; if even those
 * would not fit an item's detail, whole rows are dropped (and counted) rather than a row cut in two.
 */
export function orphanItem(tasks: readonly OrphanedTask[]): OrphanItem | undefined {
  if (tasks.length === 0) return undefined;
  const ordered = [...tasks].sort(
    (left, right) => left.waitingSince.localeCompare(right.waitingSince) || left.id.localeCompare(right.id),
  );
  const rows = ordered.slice(0, MAX_LISTED_ORPHANS).map(task => `- ${clipAtWord(task.line, MAX_ROW_LENGTH)}`);
  while (rows.length > 1 && bodyOf(rows, ordered.length - rows.length).length > MAX_AGENDA_DETAIL_LENGTH) rows.pop();
  const one = ordered.length === 1;
  return {
    subject: clipAtWord(orphanTitle(ordered.length), MAX_AGENDA_SUBJECT_LENGTH),
    why: one
      ? 'A task only moves when a ferret works on it. This one was handed to a ferret that has since finished, so it will sit where it is until you act.'
      : 'A task only moves when a ferret works on it. These were handed to ferrets that have since finished, so they will sit where they are until you act.',
    howToResolve:
      'For each task: open it to see where it stands, start a ferret on it to carry on, or close it if it is no longer needed. A task leaves this list once a ferret is on it again.',
    context: bodyOf(rows, ordered.length - rows.length),
  };
}
