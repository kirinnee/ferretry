/**
 * THE TABLE AS THE CURRENT SUMMARY: what the owner must act on, what is being worked on, and what has
 * recently merged and released. Newest first, no "who" and no PR numbers (the card detail has them).
 *
 * The lane design is about ACTION first and information second: a card in a lane where the owner has to
 * do something (try it, say Done or Not good) leads the page, then what is in progress, then two compact
 * information sections. Only the information sections follow the time window; "To test" and "Working now"
 * are true now, however old the card is.
 *
 * Pure values in, pure values out: the caller passes `now`.
 */

import type { LaneCategory } from '@ferretry/protocol';
import { inDateRange } from './board-model.ts';
import { groupUnderHuman, type HumanCard, humanScope } from './board-human.ts';
import { ageLabel } from './board-present.ts';
import type { BoardCardOf, BoardListRow } from './board-view.ts';

export const SUMMARY_WINDOWS = ['today', '7d'] as const;
export type SummaryWindow = (typeof SUMMARY_WINDOWS)[number];

export const DEFAULT_SUMMARY_WINDOW: SummaryWindow = '7d';

export const SUMMARY_WINDOW_LABEL: Readonly<Record<SummaryWindow, string>> = {
  today: 'Today',
  '7d': '7 days',
};

export const parseSummaryWindow = (value: string | null): SummaryWindow =>
  SUMMARY_WINDOWS.find(window => window === value) ?? DEFAULT_SUMMARY_WINDOW;

export type SummarySectionId = 'to-test' | 'working' | 'merged' | 'released';

/**
 * Whether a lane of this category is one where the OWNER acts. The lane set will say so itself
 * (the per-lane action/information marker); until a daemon sends it, the verify lane is the action lane.
 */
export const isActionCategory = (category: LaneCategory | null): boolean => category === 'verify';

interface SectionMeta {
  readonly title: string;
  /** Rows of an action section are drawn heavier than an information section's. */
  readonly action: boolean;
  /** Whether the time window narrows this section. */
  readonly windowed: boolean;
}

const SUMMARY_SECTION_ORDER: readonly SummarySectionId[] = ['to-test', 'working', 'merged', 'released'];

export const SUMMARY_SECTIONS: Readonly<Record<SummarySectionId, SectionMeta>> = {
  'to-test': { title: 'To test', action: true, windowed: false },
  working: { title: 'Working now', action: false, windowed: false },
  merged: { title: 'Merged, not released', action: false, windowed: true },
  released: { title: 'Released recently', action: false, windowed: true },
};

/** A row of the summary: the card, where it sits, and when it last mattered. */
export interface SummaryRow extends HumanCard {
  readonly card: BoardCardOf;
  readonly row: BoardListRow;
  readonly section: SummarySectionId;
  /** The instant the row is ordered by and the window counts from. */
  readonly at: string | null;
  /** "merged 2h ago", "released in 4.141.1 · 2h ago", "working now". */
  readonly when: string;
  /** The key of the human card this agent card is drawn under, or `null`. */
  readonly under: string | null;
}

export interface SummarySection {
  readonly id: SummarySectionId;
  readonly title: string;
  readonly action: boolean;
  readonly rows: readonly SummaryRow[];
}

/** "2h ago", "just now": the age as a sentence tail. */
export const agoLabel = (instant: string | null, now: number): string | null => {
  const age = ageLabel(instant, now);
  return age === null ? null : age === 'now' ? 'just now' : `${age} ago`;
};

/** Which section a card belongs to; `null` for a card that is not part of the story (backlog, closed, unplaced). */
export const sectionOf = (card: BoardCardOf, category: LaneCategory | null): SummarySectionId | null => {
  if (category === null) return null;
  if (isActionCategory(category)) return 'to-test';
  if (category === 'active' || category === 'review') return 'working';
  if (category === 'shipped') return card.task.shippedIn === null ? 'merged' : 'released';
  return null;
};

const mergedAt = (card: BoardCardOf): string | null => {
  const merged = card.task.links.prs
    .filter(pr => pr.state === 'merged' && pr.mergedAt !== null)
    .map(pr => pr.mergedAt ?? '')
    .sort();
  return merged[merged.length - 1] ?? null;
};

const touchedAt = (card: BoardCardOf): string => card.task.lastTouchedAt ?? card.task.createdAt;

const releasedText = (card: BoardCardOf, now: number): string => {
  const shipped = card.task.shippedIn;
  const ago = agoLabel(shipped?.at ?? null, now);
  const base = shipped === null ? 'released' : `released in ${shipped.version}`;
  return ago === null ? base : `${base} · ${ago}`;
};

const whenOf = (section: SummarySectionId, card: BoardCardOf, at: string | null, now: number): string => {
  const ago = agoLabel(at, now);
  switch (section) {
    case 'to-test':
      return card.task.shippedIn === null ? 'ready to test' : releasedText(card, now);
    case 'released':
      return releasedText(card, now);
    case 'merged':
      return ago === null ? 'merged' : `merged ${ago}`;
    case 'working':
      if (card.task.activity === 'active') return 'working now';
      return ago === null ? card.task.activity : `${card.task.activity} · touched ${ago}`;
  }
};

const atOf = (section: SummarySectionId, card: BoardCardOf): string | null => {
  switch (section) {
    case 'to-test':
    case 'released':
      return card.task.shippedIn?.at ?? touchedAt(card);
    case 'merged':
      return mergedAt(card) ?? touchedAt(card);
    case 'working':
      return touchedAt(card);
  }
};

const newestFirst = (left: SummaryRow, right: SummaryRow): number =>
  (right.at ?? '').localeCompare(left.at ?? '') ||
  left.card.task.id.localeCompare(right.card.task.id, undefined, { numeric: true });

export interface SummaryInput {
  /** Every open card of the board, in a row each. */
  readonly rows: readonly BoardListRow[];
  /** Closed cards, only to find what was released lately and is done with. */
  readonly closedRows?: readonly BoardListRow[];
  readonly window: SummaryWindow;
  readonly now: number;
}

/**
 * The summary: the four sections in order, each newest first, empty ones left out. A closed card appears
 * only under "Released recently", and only if it shipped inside the window. Agent cards (when the board
 * shows them) sit right under the human card they serve.
 */
export const summarySections = ({ rows, closedRows = [], window, now }: SummaryInput): readonly SummarySection[] => {
  const range = { preset: window, from: null, to: null } as const;
  const scope = humanScope([...rows, ...closedRows].map(row => row.card));
  const candidates: SummaryRow[] = [];
  for (const row of rows) {
    const section = sectionOf(row.card, row.category);
    if (section === null) continue;
    const at = atOf(section, row.card);
    if (SUMMARY_SECTIONS[section].windowed && !inDateRange(range, at, now)) continue;
    candidates.push({
      ...row.card,
      card: row.card,
      row,
      section,
      at,
      when: whenOf(section, row.card, at, now),
      under: null,
    });
  }
  for (const row of closedRows) {
    if (row.card.task.shippedIn === null || row.card.task.dropped !== null) continue;
    const at = row.card.task.shippedIn.at;
    if (!inDateRange(range, at, now)) continue;
    candidates.push({
      ...row.card,
      card: row.card,
      row,
      section: 'released',
      at,
      when: releasedText(row.card, now),
      under: null,
    });
  }
  return SUMMARY_SECTION_ORDER.flatMap(id => {
    const members = candidates.filter(candidate => candidate.section === id).sort(newestFirst);
    if (members.length === 0) return [];
    const placed = groupUnderHuman(members, scope).map(({ item, under }) => ({ ...item, under }));
    return [{ id, title: SUMMARY_SECTIONS[id].title, action: SUMMARY_SECTIONS[id].action, rows: placed }];
  });
};
