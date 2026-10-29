/**
 * A CARD AS A LIVING SUMMARY of its discussion: what the last edit changed, how long ago, and what each earlier
 * version said. Pure functions over the item's `revisions` (oldest first, each with the fields it changed and
 * those fields as they were) — nothing here draws anything.
 */

import type { AttentionItem, AttentionRevisableField, AttentionRevision } from '@ferretry/protocol';

const POINT = /^\s*[-*•]\s+(\S.*)$/u;

/** The points of a text written as bullets (every non-blank line one), or `null` when it is prose. */
export function bulletPoints(text: string): readonly string[] | null {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '');
  const points = lines.map(line => POINT.exec(line)?.[1]?.trim());
  return lines.length > 0 && points.every(point => point !== undefined) ? (points as string[]) : null;
}

/** The fields that are read as a list of points, so a revision can mark single bullets rather than the whole. */
const POINT_FIELDS: ReadonlySet<AttentionRevisableField> = new Set([
  'premise',
  'decided',
  'stillOpen',
  'context',
  'impact',
]);

/** How a field is named to a reader. */
const FIELD_LABEL: Readonly<Record<AttentionRevisableField, string>> = {
  subject: 'Question',
  why: 'Why it matters',
  context: 'Why it matters',
  howToResolve: 'How to resolve',
  ask: 'Answer type',
  title: 'Title',
  kind: 'Kind',
  answers: 'Answers',
  premise: "What's going on",
  decided: 'Decided so far',
  stillOpen: 'Still open',
  terms: 'Terms',
  questions: 'Questions',
  recommendation: 'Recommendation',
  impact: 'Impact',
  urgency: 'Urgency',
  links: 'Links',
  steps: 'Steps',
  body: 'More detail',
};

export const revisionFieldLabel = (field: AttentionRevisableField): string => FIELD_LABEL[field];

/** The most recent edit, or `null` when the item was never edited. */
export const lastRevision = (item: Pick<AttentionItem, 'revisions'>): AttentionRevision | null =>
  item.revisions?.at(-1) ?? null;

/** What the last edit changed, as the reader should see it marked. */
export interface RevisionHighlight {
  /** Point-form fields: the bullets that are new or reworded, by their text. */
  readonly points: Readonly<Partial<Record<AttentionRevisableField, ReadonlySet<string>>>>;
  /** Every other changed field, whole. */
  readonly fields: ReadonlySet<AttentionRevisableField>;
}

const NO_HIGHLIGHT: RevisionHighlight = { points: {}, fields: new Set() };

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The text of `field` on the item as it stands now. */
const currentText = (item: AttentionItem, field: AttentionRevisableField): string =>
  textOf((item as unknown as Record<string, unknown>)[field]);

/**
 * What to mark after the last edit: for a point-form field, each bullet that was not among the earlier version's
 * (new or reworded); for any other changed field, the field as a whole. An edit that only removed lines marks
 * nothing in that field — there is no line to draw it on.
 */
export const revisionHighlight = (item: AttentionItem): RevisionHighlight => {
  const revision = lastRevision(item);
  if (revision === null) return NO_HIGHLIGHT;
  const points: Partial<Record<AttentionRevisableField, ReadonlySet<string>>> = {};
  const fields = new Set<AttentionRevisableField>();
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
export const updatedAgo = (item: Pick<AttentionItem, 'revisions'>, now: number): string | null => {
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
export const decidedSummary = (item: Pick<AttentionItem, 'decided' | 'stillOpen'>): string | null => {
  const count = (text: string | undefined): number => (text?.trim() ? (bulletPoints(text)?.length ?? 1) : 0);
  const decided = count(item.decided);
  const open = count(item.stillOpen);
  if (decided === 0 && open === 0) return null;
  return [decided === 0 ? null : `${String(decided)} decided`, open === 0 ? null : `${String(open)} still open`]
    .filter((part): part is string => part !== null)
    .join(' · ');
};

/** A field as it was, in words a reader can scan: text as itself, a list as its size, an answer type by name. */
export const describePrevious = (field: AttentionRevisableField, value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'Nothing yet';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'Nothing yet';
    if (value.every((entry): entry is string => typeof entry === 'string')) return value.join('; ');
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
  readonly by: AttentionRevision['by'];
  readonly changed: readonly {
    readonly field: AttentionRevisableField;
    readonly label: string;
    readonly before: string;
  }[];
}

const BY_WORD: Readonly<Record<AttentionRevision['by'], string>> = {
  human: 'You',
  agent: 'The ferret',
  daemon: 'Ferretry',
};

export const revisionAuthor = (by: AttentionRevision['by']): string => BY_WORD[by];

/** The earlier versions, newest first. */
export const revisionList = (item: Pick<AttentionItem, 'revisions'>): readonly RevisionEntry[] =>
  [...(item.revisions ?? [])].reverse().map(revision => ({
    at: revision.at,
    by: revision.by,
    changed: revision.changed.map(field => ({
      field,
      label: FIELD_LABEL[field],
      before: describePrevious(field, (revision.previous as Record<string, unknown>)[field]),
    })),
  }));
