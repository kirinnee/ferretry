/**
 * WHAT CHANGED BETWEEN TWO VERSIONS OF AN AGENDA ITEM (docs/agenda.md § The item view, "Changes"): pure functions over
 * two whole items (the daemon keeps every version in full) that say, section by section, what was added, removed or
 * reworded, down to the word. Nothing here draws anything or reads a clock: the view draws each mark with a sign and
 * a line style as well as a colour, so a change never depends on colour alone.
 */

import type { AgendaItem, AgendaVersionList, AgendaVersionSummary } from '@ferretry/protocol';
import { revisionStamp } from './agenda-revisions.ts';

/** One run of words: kept as it was, added, or removed. */
export interface WordRun {
  readonly kind: 'same' | 'added' | 'removed';
  readonly text: string;
}

/** The most token pairs the word diff compares; a longer edit is shown as the old text out and the new text in. */
const MAX_CELLS = 4_000_000;

const TOKEN = /\s+|[^\s]+/gu;

const tokens = (text: string): readonly string[] => text.match(TOKEN) ?? [];

/** Adjacent runs of the same kind, joined: "a b" removed is one run, not three. */
const merged = (runs: readonly WordRun[]): readonly WordRun[] => {
  const out: WordRun[] = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (last?.kind === run.kind) out[out.length - 1] = { kind: run.kind, text: last.text + run.text };
    else out.push(run);
  }
  return out;
};

/** The words of `before` and `after` as runs, in reading order: removed words come before the words that replace them. */
export const diffWords = (before: string, after: string): readonly WordRun[] => {
  const a = tokens(before);
  const b = tokens(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail += 1;
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  const keep = (list: readonly string[]): WordRun[] =>
    list.length === 0 ? [] : [{ kind: 'same', text: list.join('') }];
  const front = keep(a.slice(0, head));
  const back = keep(a.slice(a.length - tail));
  if (middleA.length === 0 || middleB.length === 0 || middleA.length * middleB.length > MAX_CELLS) {
    const out: WordRun[] = [
      ...front,
      ...(middleA.length === 0 ? [] : [{ kind: 'removed', text: middleA.join('') } as const]),
      ...(middleB.length === 0 ? [] : [{ kind: 'added', text: middleB.join('') } as const]),
      ...back,
    ];
    return merged(out);
  }
  const width = middleB.length + 1;
  const table = new Uint32Array((middleA.length + 1) * width);
  for (let i = middleA.length - 1; i >= 0; i -= 1) {
    for (let j = middleB.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        middleA[i] === middleB[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const walk: WordRun[] = [];
  let i = 0;
  let j = 0;
  while (i < middleA.length && j < middleB.length) {
    if (middleA[i] === middleB[j]) {
      walk.push({ kind: 'same', text: middleA[i] as string });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      walk.push({ kind: 'removed', text: middleA[i] as string });
      i += 1;
    } else {
      walk.push({ kind: 'added', text: middleB[j] as string });
      j += 1;
    }
  }
  for (; i < middleA.length; i += 1) walk.push({ kind: 'removed', text: middleA[i] as string });
  for (; j < middleB.length; j += 1) walk.push({ kind: 'added', text: middleB[j] as string });
  return merged([...front, ...walk, ...back]);
};

// ---------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------

/** The sections compared, in the order the item view reads them. */
const DIFF_SECTIONS = [
  { key: 'title', label: 'Title' },
  { key: 'subject', label: 'Question' },
  { key: 'premise', label: 'Premise' },
  { key: 'context', label: 'Context' },
  { key: 'detail', label: 'Detailed context' },
  { key: 'terms', label: 'Terms' },
  { key: 'links', label: 'References' },
  { key: 'whereWeAre', label: 'Where we are now' },
  { key: 'decided', label: 'Decided so far' },
  { key: 'stillOpen', label: 'Still open' },
  { key: 'ask', label: 'What I need from you' },
  { key: 'recommendation', label: 'Recommendation' },
  { key: 'impact', label: 'Impact' },
  { key: 'urgency', label: 'Urgency' },
  { key: 'steps', label: 'Steps' },
  { key: 'body', label: 'More detail' },
  { key: 'questionAnswer', label: 'Answer to your question' },
  { key: 'why', label: 'Why it matters' },
  { key: 'howToResolve', label: 'How to resolve' },
] as const;
export type DiffSectionKey = (typeof DIFF_SECTIONS)[number]['key'];

const KIND_WORDS: Readonly<Record<string, string>> = {
  permission: 'Allow or deny',
  'multiple-choice': 'Choose one',
  'answer-review': 'Review',
  'open-question': 'Answer in words',
  task: 'Do this',
};

const scalar = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

/** The ask in words, one line per option: "Choose one" then "- Ship it: the default". */
const askText = (ask: AgendaItem['ask']): string => {
  if (ask === undefined) return '';
  const head = KIND_WORDS[ask.kind] ?? ask.kind;
  if (ask.kind !== 'multiple-choice') return head;
  return [
    head,
    ...ask.options.map(option =>
      option.description === undefined ? `- ${option.label}` : `- ${option.label}: ${option.description}`,
    ),
  ].join('\n');
};

/** Any other structured value, as its text fields on lines: a recommendation's decision, then its reason. */
const objectText = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) return scalar(value);
  return Object.values(value as Record<string, unknown>)
    .map(scalar)
    .filter(text => text !== '')
    .join('\n');
};

/** One section of an item as plain text; empty when the item has none. Lists are one entry a line. */
export const sectionText = (item: AgendaItem, key: DiffSectionKey): string => {
  switch (key) {
    case 'ask':
      return askText(item.ask);
    case 'terms':
      return (item.terms ?? []).map(entry => `${entry.term}: ${entry.meaning}`).join('\n');
    case 'links':
      return (item.links ?? [])
        .map(link =>
          [link.label ?? link.target, link.label === undefined ? undefined : link.target, link.meaning]
            .filter((part): part is string => part !== undefined && part !== '')
            .join(' · '),
        )
        .join('\n');
    case 'steps':
      return (item.steps ?? []).map((step, index) => `${String(index + 1)}. ${step}`).join('\n');
    case 'recommendation':
      return objectText(item.recommendation);
    case 'context':
      return item.context?.trim() ?? '';
    default:
      return scalar((item as unknown as Record<string, unknown>)[key]);
  }
};

/** What happened to a section between two versions. */
type SectionStatus = 'unchanged' | 'added' | 'removed' | 'changed';

/** One section compared: its words, and how many words were added and removed. */
export interface SectionDiff {
  readonly key: DiffSectionKey;
  readonly label: string;
  readonly status: SectionStatus;
  readonly runs: readonly WordRun[];
  readonly addedWords: number;
  readonly removedWords: number;
}

const wordCount = (text: string): number => text.split(/\s+/u).filter(word => word !== '').length;

const countOf = (runs: readonly WordRun[], kind: WordRun['kind']): number =>
  runs.filter(run => run.kind === kind).reduce((sum, run) => sum + wordCount(run.text), 0);

/** Every section of `to` against `from`, in reading order; sections neither version has are left out. */
export const diffItems = (from: AgendaItem, to: AgendaItem): readonly SectionDiff[] =>
  DIFF_SECTIONS.flatMap(({ key, label }): SectionDiff[] => {
    const before = sectionText(from, key);
    const after = sectionText(to, key);
    if (before === '' && after === '') return [];
    const runs = before === after ? ([{ kind: 'same', text: after }] as const) : diffWords(before, after);
    const status: SectionStatus =
      before === after ? 'unchanged' : before === '' ? 'added' : after === '' ? 'removed' : 'changed';
    return [{ key, label, status, runs, addedWords: countOf(runs, 'added'), removedWords: countOf(runs, 'removed') }];
  });

/** The sections that changed: what the view opens; every other section folds under "N unchanged". */
export const changedSections = (diff: readonly SectionDiff[]): readonly SectionDiff[] =>
  diff.filter(section => section.status !== 'unchanged');

/** "2 sections changed · +14 words · −9 words" — what the head of a comparison says. */
export const diffSummary = (diff: readonly SectionDiff[]): string => {
  const changed = changedSections(diff);
  if (changed.length === 0) return 'Nothing changed';
  const added = changed.reduce((sum, section) => sum + section.addedWords, 0);
  const removed = changed.reduce((sum, section) => sum + section.removedWords, 0);
  return [
    `${String(changed.length)} section${changed.length === 1 ? '' : 's'} changed`,
    `+${String(added)} word${added === 1 ? '' : 's'}`,
    `−${String(removed)} word${removed === 1 ? '' : 's'}`,
  ].join(' · ');
};

// ---------------------------------------------------------------------------------------------------
// Which two versions
// ---------------------------------------------------------------------------------------------------

/** Two versions to compare, `from` the older. */
export interface VersionPair {
  readonly from: number;
  readonly to: number;
}

/** The pair in order, the older first. */
export const orderedPair = (a: number, b: number): VersionPair => (a <= b ? { from: a, to: b } : { from: b, to: a });

/** Why a pair is the default: what the head says about it. */
export type DefaultBasis = 'since-seen' | 'never-seen' | 'latest-change';

/**
 * THE DEFAULT COMPARISON: "since you last looked" is this device's last-seen version against the newest. A device that
 * never opened the item compares the first version; one that has seen the newest compares the last change, so the
 * control always has something to show. `null` when the item has fewer than two versions: there is nothing to compare.
 */
export const defaultComparison = (
  list: Pick<AgendaVersionList, 'latest' | 'seen'>,
): { readonly pair: VersionPair; readonly basis: DefaultBasis } | null => {
  if (list.latest < 2) return null;
  if (list.seen === undefined) return { pair: { from: 1, to: list.latest }, basis: 'never-seen' };
  if (list.seen >= list.latest) return { pair: { from: list.latest - 1, to: list.latest }, basis: 'latest-change' };
  return { pair: { from: list.seen, to: list.latest }, basis: 'since-seen' };
};

/** What the head calls the default comparison. */
export const BASIS_WORDS: Readonly<Record<DefaultBasis, string>> = {
  'since-seen': 'Since you last looked',
  'never-seen': 'Since it was raised',
  'latest-change': 'The latest change',
};

const BY_WORDS: Readonly<Record<AgendaVersionSummary['by'], string>> = {
  owner: 'you',
  ferret: 'the ferret',
  daemon: 'Ferretry',
};

/** One version in a picker: "v3 · 8:54 · the ferret · updated". */
export const versionLabel = (version: AgendaVersionSummary, now: number): string =>
  `v${String(version.version)} · ${revisionStamp(version.at, now)} · ${BY_WORDS[version.by]} · ${version.change}`;
