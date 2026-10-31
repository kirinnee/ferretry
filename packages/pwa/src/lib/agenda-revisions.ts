/**
 * A CARD AS A LIVING SUMMARY of its discussion: what the last edit changed, how long ago, and what each earlier
 * version said. Pure functions over the item's `revisions` (oldest first, each with the fields it changed and
 * those fields as they were) — nothing here draws anything.
 */

import type { AgendaItem, AgendaRevisableField, AgendaRevision } from '@ferretry/protocol';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const POINT = /^\s*[-*•]\s+(\S.*)$/u;
const NESTED_MARKER = /^(?:(?:[-*•]|\d+[.)])\s+)+(?=\S)/u;

/** The points of a text written as bullets (every non-blank line one), or `null` when it is prose. */
export function bulletPoints(text: string): readonly string[] | null {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '');
  const points = lines.map(line => POINT.exec(line)?.[1]?.trim().replace(NESTED_MARKER, ''));
  return lines.length > 0 && points.every(point => point !== undefined) ? (points as string[]) : null;
}

/** The fields that are read as a list of points, so a revision can mark single bullets rather than the whole. */
export const POINT_FIELDS: ReadonlySet<AgendaRevisableField> = new Set([
  'premise',
  'decided',
  'stillOpen',
  'context',
  'impact',
]);

/** How a field is named to a reader. */
export const FIELD_LABEL: Readonly<Record<AgendaRevisableField, string>> = {
  subject: 'Question',
  why: 'Why it matters',
  context: 'Context',
  howToResolve: 'How to resolve',
  ask: 'Answer type',
  title: 'Title',
  kind: 'Kind',
  answers: 'Answers',
  premise: 'Premise',
  decided: 'Decided so far',
  stillOpen: 'Still open',
  terms: 'Terms',
  questions: 'Questions',
  optionDetails: 'Option details',
  recommendation: 'Recommendation',
  impact: 'Impact',
  urgency: 'Urgency',
  blockingNow: 'Blocking now',
  willBlock: 'Will block',
  neededBy: 'Needed by',
  links: 'Links',
  steps: 'Steps',
  body: 'More detail',
};

/** The most recent edit, or `null` when the item was never edited. */
export const lastRevision = (item: Pick<AgendaItem, 'revisions'>): AgendaRevision | null =>
  item.revisions?.at(-1) ?? null;

/** What the last edit changed, as the reader should see it marked. */
export interface RevisionHighlight {
  /** Point-form fields: the bullets that are new or reworded, by their text. */
  readonly points: Readonly<Partial<Record<AgendaRevisableField, ReadonlySet<string>>>>;
  /** Every other changed field, whole. */
  readonly fields: ReadonlySet<AgendaRevisableField>;
}

const NO_HIGHLIGHT: RevisionHighlight = { points: {}, fields: new Set() };

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The text of `field` on the item as it stands now. */
const currentText = (item: AgendaItem, field: AgendaRevisableField): string =>
  textOf((item as unknown as Record<string, unknown>)[field]);

/**
 * What to mark after the last edit: for a point-form field, each bullet that was not among the earlier version's
 * (new or reworded); for any other changed field, the field as a whole. An edit that only removed lines marks
 * nothing in that field — there is no line to draw it on.
 */
export const revisionHighlight = (item: AgendaItem): RevisionHighlight => {
  const revision = lastRevision(item);
  if (revision === null) return NO_HIGHLIGHT;
  const points: Partial<Record<AgendaRevisableField, ReadonlySet<string>>> = {};
  const fields = new Set<AgendaRevisableField>();
  for (const field of revision.changed) {
    if (!POINT_FIELDS.has(field)) {
      fields.add(field);
      continue;
    }
    const now = currentText(item, field);
    const nowPoints = bulletPoints(now);
    if (nowPoints === null) {
      if (now.trim() !== '') fields.add(field);
      continue;
    }
    const before = bulletPoints(textOf((revision.previous as Record<string, unknown>)[field])) ?? [];
    const known = new Set(before.map(point => point.trim()));
    const fresh = nowPoints.filter(point => !known.has(point.trim()));
    if (fresh.length > 0) points[field] = new Set(fresh);
  }
  return { points, fields };
};

/** Whether anything is marked: the card shows no "changed" chrome for an edit that left nothing to mark. */
export const hasHighlight = (highlight: RevisionHighlight): boolean =>
  highlight.fields.size > 0 || Object.keys(highlight.points).length > 0;

const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? '' : 's'}`;

/** "Updated 5 min ago" — or `null` when the item was never edited. */
export const updatedAgo = (item: Pick<AgendaItem, 'revisions'>, now: number): string | null => {
  const revision = lastRevision(item);
  if (revision === null) return null;
  const then = Date.parse(revision.at);
  if (!Number.isFinite(then)) return 'Updated';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${plural(hours, 'hour')} ago`;
  return `Updated ${plural(Math.round(hours / 24), 'day')} ago`;
};

/** "3 decided · 2 still open", or `null` when the item carries neither list. */
export const decidedSummary = (item: Pick<AgendaItem, 'decided' | 'stillOpen'>): string | null => {
  const count = (text: string | undefined): number => (text?.trim() ? (bulletPoints(text)?.length ?? 1) : 0);
  const decided = count(item.decided);
  const open = count(item.stillOpen);
  if (decided === 0 && open === 0) return null;
  return [decided === 0 ? null : `${String(decided)} decided`, open === 0 ? null : `${String(open)} still open`]
    .filter((part): part is string => part !== null)
    .join(' · ');
};

/**
 * A field as it was, in words a reader can scan: text as itself, a list of words as bullets, a list of other things
 * as its size, an answer type by name. `null` when the field was empty.
 */
export const describePrevious = (field: AgendaRevisableField, value: unknown): string | null => {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((entry): entry is string => typeof entry === 'string'))
      return value.map(entry => `- ${entry}`).join('\n');
    return plural(value.length, field === 'terms' ? 'term' : 'entry').replace('entrys', 'entries');
  }
  if (typeof value === 'object') {
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind === 'string') return kind.replaceAll('-', ' ');
    const decision = (value as { decision?: unknown }).decision;
    if (typeof decision === 'string') return decision;
  }
  return 'Changed';
};

/** One earlier version, read-only: when, by whom, which fields changed and what each said before. */
export interface RevisionEntry {
  readonly at: string;
  readonly by: AgendaRevision['by'];
  readonly changed: readonly {
    readonly field: AgendaRevisableField;
    readonly label: string;
    /** The field as it was; `null` when it was empty. */
    readonly before: string | null;
  }[];
}

const BY_WORD: Readonly<Record<AgendaRevision['by'], string>> = {
  human: 'You',
  agent: 'The ferret',
  daemon: 'Ferretry',
};

export const revisionAuthor = (by: AgendaRevision['by']): string => BY_WORD[by];

/** The earlier versions, newest first. */
export const revisionList = (item: Pick<AgendaItem, 'revisions'>): readonly RevisionEntry[] =>
  [...(item.revisions ?? [])].reverse().map(revision => ({
    at: revision.at,
    by: revision.by,
    changed: revision.changed.map(field => ({
      field,
      label: FIELD_LABEL[field],
      before: describePrevious(field, (revision.previous as Record<string, unknown>)[field]),
    })),
  }));

/** When an edit was made, in the fewest words: "8:54" today, "Mon 8:54" within the week, else "Oct 29". */
export const revisionStamp = (at: string, now: number): string => {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return at;
  const today = new Date(now);
  const day = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(today) - day(when)) / 86_400_000);
  const clock = `${String(when.getHours())}:${String(when.getMinutes()).padStart(2, '0')}`;
  if (days === 0) return clock;
  if (days > 0 && days < 7) return `${WEEKDAYS[when.getDay()] as string} ${clock}`;
  return `${MONTHS[when.getMonth()] as string} ${String(when.getDate())}`;
};

/**
 * The item as it read at version `number` (1 = as first raised): every later edit undone, newest first, each changed
 * field set back to what that edit's `previous` says it was — a field absent there was absent before the edit. A
 * number past the newest is the item as it stands.
 */
export const itemAtVersion = (item: AgendaItem, number: number): AgendaItem => {
  const edits = item.revisions ?? [];
  const undone = edits.slice(Math.max(0, number - 1));
  const fields = { ...(item as unknown as Record<string, unknown>) };
  for (const edit of [...undone].reverse()) {
    const previous = edit.previous as Record<string, unknown>;
    for (const field of edit.changed) {
      if (previous[field] === undefined) delete fields[field];
      else fields[field] = previous[field];
    }
  }
  return { ...(fields as unknown as AgendaItem), revisions: edits.slice(0, Math.max(0, number - 1)) } as AgendaItem;
};

/** How long ago, in the fewest characters: "just now", "3m ago", "2h ago", "4d ago". */
export const shortAgo = (at: string, now: number): string => {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
};

/** How many versions the item has: one as raised, one more per edit. */
export const versionCount = (item: Pick<AgendaItem, 'revisions'>): number => (item.revisions?.length ?? 0) + 1;
