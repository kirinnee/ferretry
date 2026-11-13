/**
 * WHAT CHANGED BETWEEN TWO VERSIONS OF AN AGENDA ITEM (docs/agenda.md § The item view, "Changes"): pure functions over
 * two whole items (the daemon keeps every version in full) that say, section by section, what was added, removed or
 * reworded. Nothing here draws anything or reads a clock: the view draws each mark with a sign and a line style as well
 * as a colour, so a change never depends on colour alone.
 *
 * HOW A TEXT IS COMPARED, coarse to fine, so a rewrite reads as a rewrite and a small edit as a small edit:
 *
 * 1. LINES. Terms, steps, ask options and bullets are one entry a line. Equal lines are kept; the lines between them are
 *    paired in order by how alike they are, and a line with no partner is removed or added whole.
 * 2. SENTENCES. Inside a paired line, the same again, sentence by sentence.
 * 3. WORDS. Inside a paired sentence, a word diff, tidied so a stray "the" never splits one change into confetti.
 *
 * A pair that shares fewer than {@link REWRITE_SIMILARITY} of its words is a REWRITE: the old block is shown removed and
 * the new block added, never woven together word by word.
 */

import {
  type AgendaItem,
  agendaStage,
  type AgendaVersionList,
  type AgendaVersionSummary,
  formatTaskRef,
} from '@ferretry/core-asks/contract';
import { STAGE_WORDS } from './agenda-item-sections.ts';
import { revisionStamp } from './agenda-revisions.ts';

/** One run of words: kept as it was, added, or removed. */
export interface WordRun {
  readonly kind: 'same' | 'added' | 'removed';
  readonly text: string;
}

/** The share of words (2·common ÷ both lengths) two texts must keep for the diff to weave them word by word. */
export const REWRITE_SIMILARITY = 0.5;

/** The most token pairs one word comparison reads; a longer edit is shown as the old text out and the new text in. */
const MAX_CELLS = 4_000_000;

/** The most line pairs one block of lines is paired over; more are shown as the old lines out and the new lines in. */
const MAX_LINE_PAIRS = 2_500;

/** A kept word this short (or two of them) between two changes is folded into the change: "the", "of", "a". */
const SHORT_WORD = 3;

const TOKEN = /\s+|[^\s]+/gu;

const wordCount = (text: string): number => text.split(/\s+/u).filter(word => word !== '').length;

const tokens = (text: string): readonly string[] => text.match(TOKEN) ?? [];

const spaces = (token: string): boolean => /^\s/u.test(token);

/** Adjacent runs of the same kind, joined: "a b" removed is one run, not three. */
const merged = (runs: readonly WordRun[]): readonly WordRun[] => {
  const out: WordRun[] = [];
  for (const run of runs) {
    if (run.text === '') continue;
    const last = out.at(-1);
    if (last?.kind === run.kind) out[out.length - 1] = { kind: run.kind, text: last.text + run.text };
    else out.push(run);
  }
  return out;
};

/** The most word-pair cells one whole diff spends on likeness scores and word matches; past it, cheaper methods stand in. */
const WORK_BUDGET = 12_000_000;

/** The most piece-pair cells one anchoring of lines or sentences spends on exact matches. */
const PIECE_BUDGET = 16_000_000;

/** The deepest the anchoring digs into the gaps between anchors; a gap past it is shown as a block. */
const MAX_DEPTH = 48;

/** What is left to spend; one is made for each whole diff, so a large rewrite cannot freeze the page. */
interface Work {
  left: number;
}

const freshWork = (): Work => ({ left: WORK_BUDGET });

/** Spends `cells` of the work when that is allowed (and, under `cap`, small enough for one table). */
const spend = (work: Work, cells: number, cap = MAX_CELLS): boolean => {
  if (cells > cap || cells > work.left) return false;
  work.left -= cells;
  return true;
};

/** The longest common run of two token lists, as a table read from the end. The caller keeps the product small. */
const lcsTable = (a: readonly string[], b: readonly string[]): Uint32Array => {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  return table;
};

/** How many tokens two lists share at their start, and then at their end. */
const sharedEnds = (a: readonly string[], b: readonly string[]): { readonly head: number; readonly tail: number } => {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail += 1;
  return { head, tail };
};

/** One kept piece: its place in the old list and in the new one. */
type Match = readonly [number, number];

/** The places a longest increasing run of `pairs` (by new place) passes through; `pairs` is in old-place order. */
const increasingRun = (pairs: readonly Match[]): readonly Match[] => {
  const tails: number[] = [];
  const before = new Array<number>(pairs.length).fill(-1);
  pairs.forEach(([, j], index) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (((pairs[tails[mid] as number] as Match)[1] as number) < j) lo = mid + 1;
      else hi = mid;
    }
    before[index] = lo > 0 ? (tails[lo - 1] as number) : -1;
    tails[lo] = index;
  });
  const run: Match[] = [];
  for (let at = tails.length > 0 ? (tails.at(-1) as number) : -1; at >= 0; at = before[at] as number)
    run.push(pairs[at] as Match);
  return run.reverse();
};

/**
 * The pieces two lists keep, in order, as the places they sit in each. Equal pieces at both ends are kept; a middle
 * small enough is matched exactly (a longest common run) and paid for from `work`; a larger one is anchored in linear
 * time on the pieces that occur once on each side (kept in order, the longest such run), and each gap between anchors is
 * matched again the same way. So two far-apart edits in a long text stay two small edits however long the text is.
 */
const matching = (a: readonly string[], b: readonly string[], work: Work): readonly Match[] => {
  const out: Match[] = [];
  const span = (aLo: number, aHi: number, bLo: number, bHi: number, depth: number): void => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      out.push([aLo, bLo]);
      aLo += 1;
      bLo += 1;
    }
    const tail: Match[] = [];
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      aHi -= 1;
      bHi -= 1;
      tail.push([aHi, bHi]);
    }
    if (aLo < aHi && bLo < bHi) middle(aLo, aHi, bLo, bHi, depth);
    for (let k = tail.length - 1; k >= 0; k -= 1) out.push(tail[k] as Match);
  };
  const middle = (aLo: number, aHi: number, bLo: number, bHi: number, depth: number): void => {
    const n = aHi - aLo;
    const m = bHi - bLo;
    if (spend(work, n * m)) {
      const sliceA = a.slice(aLo, aHi);
      const sliceB = b.slice(bLo, bHi);
      const table = lcsTable(sliceA, sliceB);
      const width = m + 1;
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (sliceA[i] === sliceB[j]) {
          out.push([aLo + i, bLo + j]);
          i += 1;
          j += 1;
        } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) i += 1;
        else j += 1;
      }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    const onceInB = new Map<string, number>();
    for (let j = bLo; j < bHi; j += 1) onceInB.set(b[j] as string, onceInB.has(b[j] as string) ? -1 : j);
    const onceInA = new Map<string, number>();
    for (let i = aLo; i < aHi; i += 1) onceInA.set(a[i] as string, onceInA.has(a[i] as string) ? -1 : i);
    const shared: Match[] = [];
    for (let i = aLo; i < aHi; i += 1) {
      const j = onceInB.get(a[i] as string);
      if (onceInA.get(a[i] as string) === i && j !== undefined && j >= 0) shared.push([i, j]);
    }
    const anchors = increasingRun(shared);
    let i = aLo;
    let j = bLo;
    for (const anchor of anchors) {
      span(i, anchor[0], j, anchor[1], depth + 1);
      out.push(anchor);
      i = anchor[0] + 1;
      j = anchor[1] + 1;
    }
    if (anchors.length > 0) span(i, aHi, j, bHi, depth + 1);
  };
  span(0, a.length, 0, b.length, 0);
  return out;
};

/** The words of a text, spaces left out. */
const wordsOf = (text: string): readonly string[] => tokens(text).filter(token => !spaces(token));

/**
 * How alike two texts are, 0 to 1: twice the words they share, in order, over the words they have. Spaces never count,
 * so two texts are not alike for sharing "the". Two empty texts are the same; a text too large to compare reads as the
 * words it shares at its two ends.
 */
export const similarity = (before: string, after: string): number => {
  const a = wordsOf(before);
  const b = wordsOf(after);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const { head, tail } = sharedEnds(a, b);
  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  const cells = middleA.length * middleB.length;
  const middle = cells === 0 || cells > MAX_CELLS ? 0 : (lcsTable(middleA, middleB)[0] as number);
  return (2 * (head + tail + middle)) / (a.length + b.length);
};

/** A cheap likeness, 0 to 1: the words two texts share as a bag, out of both, in no order. Linear, not quadratic. */
export const bagSimilarity = (before: string, after: string): number => {
  const a = wordsOf(before);
  const b = wordsOf(after);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let common = 0;
  for (const word of b) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      common += 1;
      counts.set(word, left - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
};

/** A kept run small enough, between two changes, to be folded into them. */
const foldable = (run: WordRun): boolean => {
  const words = run.text.split(/\s+/u).filter(word => word !== '');
  return words.length <= 2 && words.every(word => word.length <= SHORT_WORD);
};

/**
 * A SEMANTIC CLEANUP of a word diff: a kept run of spaces or of one or two short words between two changes joins the
 * change, so "removed · the · added · of · removed" reads as one old block and one new block, not alternating scraps.
 */
const tidy = (runs: readonly WordRun[]): readonly WordRun[] => {
  const out: WordRun[] = [];
  let removed = '';
  let added = '';
  const flush = (): void => {
    if (removed !== '') out.push({ kind: 'removed', text: removed });
    if (added !== '') out.push({ kind: 'added', text: added });
    removed = '';
    added = '';
  };
  runs.forEach((run, index) => {
    const between =
      run.kind === 'same' &&
      index > 0 &&
      index < runs.length - 1 &&
      runs[index - 1]?.kind !== 'same' &&
      runs[index + 1]?.kind !== 'same' &&
      foldable(run);
    if (run.kind === 'same' && !between) {
      flush();
      out.push(run);
      return;
    }
    if (run.kind !== 'added') removed += run.text;
    if (run.kind !== 'removed') added += run.text;
  });
  flush();
  return merged(out);
};

/** The runs of two lists from the pieces they keep; `between` says what became of the stretch between two kept pieces. */
const runsFrom = (
  a: readonly string[],
  b: readonly string[],
  kept: readonly Match[],
  between: (from: readonly string[], to: readonly string[]) => readonly WordRun[],
): readonly WordRun[] => {
  const runs: WordRun[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of kept) {
    runs.push(...between(a.slice(i, pi), b.slice(j, pj)), { kind: 'same', text: a[pi] as string });
    i = pi + 1;
    j = pj + 1;
  }
  runs.push(...between(a.slice(i), b.slice(j)));
  return merged(runs);
};

const gapRuns = (from: readonly string[], to: readonly string[]): readonly WordRun[] => [
  { kind: 'removed', text: from.join('') },
  { kind: 'added', text: to.join('') },
];

/** The words of `before` and `after` as runs, in reading order: removed words come before the words that replace them. */
export const diffWords = (before: string, after: string, work: Work = freshWork()): readonly WordRun[] => {
  const a = tokens(before);
  const b = tokens(after);
  return tidy(runsFrom(a, b, matching(a, b, work), gapRuns));
};

/** The pieces of a text that end where a sentence or a line does, spaces kept, so they join back into the text. */
const LINES = /(?<=\n)/u;
const SENTENCES = /(?<=[.!?]\s+)(?=\S)/u;
const piecesOf = (text: string, splitter: RegExp): readonly string[] => text.split(splitter).filter(p => p !== '');

/** How two pieces are scored for pairing: exactly, or, when the work budget is spent, by a cheap bag of words. */
interface Likeness {
  readonly exact: (a: string, b: string) => number;
  readonly rough: (a: string, b: string) => number;
}

/**
 * Pairs the pieces of two texts in order and says what became of each: kept (equal), paired with one alike enough to
 * be compared inside, or removed or added whole. The pairing is the order-keeping one that keeps the most likeness.
 * Scoring every pair costs the product of the two texts' words, taken from `work`; when that is more than is left, the
 * cheap likeness scores instead, so a large rewrite still comes back at once.
 */
const pair = (
  before: readonly string[],
  after: readonly string[],
  inner: (a: string, b: string) => readonly WordRun[],
  like: Likeness,
  work: Work,
): readonly WordRun[] => {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_LINE_PAIRS) return merged(gapRuns(before, after));
  const alike = spend(work, wordCount(before.join('')) * wordCount(after.join('')), Number.POSITIVE_INFINITY)
    ? like.exact
    : like.rough;
  const width = m + 1;
  const likeness = new Float64Array(n * m);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const a = before[i] as string;
      const b = after[j] as string;
      const score = a === b ? 2 : alike(a, b);
      likeness[i * m + j] = score >= REWRITE_SIMILARITY ? score : 0;
    }
  }
  const best = new Float64Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const score = likeness[i * m + j] as number;
      best[i * width + j] = Math.max(
        best[(i + 1) * width + j] as number,
        best[i * width + j + 1] as number,
        score > 0 ? score + (best[(i + 1) * width + j + 1] as number) : 0,
      );
    }
  }
  const runs: WordRun[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const score = likeness[i * m + j] as number;
    if (score > 0 && (best[i * width + j] as number) === score + (best[(i + 1) * width + j + 1] as number)) {
      const a = before[i] as string;
      const b = after[j] as string;
      if (a === b) runs.push({ kind: 'same', text: a });
      else runs.push(...inner(a, b));
      i += 1;
      j += 1;
    } else if ((best[(i + 1) * width + j] as number) >= (best[i * width + j + 1] as number)) {
      runs.push({ kind: 'removed', text: before[i] as string });
      i += 1;
    } else {
      runs.push({ kind: 'added', text: after[j] as string });
      j += 1;
    }
  }
  for (; i < n; i += 1) runs.push({ kind: 'removed', text: before[i] as string });
  for (; j < m; j += 1) runs.push({ kind: 'added', text: after[j] as string });
  return merged(runs);
};

/**
 * Pairs the pieces of two texts. Equal pieces at both ends are kept first; when what lies between is still too large to
 * pair at once, the pieces that stay equal anchor it (exactly when small, in linear time when large), and only the gaps
 * between anchors are paired (each under its own cap), so one changed word in a long report never turns the whole report
 * into a block out and a block in.
 */
const align = (
  before: readonly string[],
  after: readonly string[],
  inner: (a: string, b: string) => readonly WordRun[],
  like: Likeness,
  work: Work,
): readonly WordRun[] => {
  const { head, tail } = sharedEnds(before, after);
  const middleA = before.slice(head, before.length - tail);
  const middleB = after.slice(head, after.length - tail);
  const front: WordRun = { kind: 'same', text: before.slice(0, head).join('') };
  const back: WordRun = { kind: 'same', text: before.slice(before.length - tail).join('') };
  if (middleA.length * middleB.length <= MAX_LINE_PAIRS) {
    return merged([front, ...pair(middleA, middleB, inner, like, work), back]);
  }
  const kept = matching(middleA, middleB, { left: PIECE_BUDGET });
  return merged([front, ...runsFrom(middleA, middleB, kept, (a, b) => pair(a, b, inner, like, work)), back]);
};

/** The fewest words a sentence has for keeping it word for word to make two lines a pair. */
const KEPT_SENTENCE_WORDS = 3;

/** Scores two lines: by `score`, or, when they share a whole sentence, at least as alike as a rewrite may be. */
const lineLikeness = (score: (a: string, b: string) => number) => (a: string, b: string) => {
  const words = score(a, b);
  if (words >= REWRITE_SIMILARITY) return words;
  const kept = new Set(
    piecesOf(a, SENTENCES)
      .map(sentence => sentence.trim())
      .filter(sentence => wordCount(sentence) >= KEPT_SENTENCE_WORDS),
  );
  return piecesOf(b, SENTENCES).some(sentence => kept.has(sentence.trim())) ? REWRITE_SIMILARITY : words;
};

const SENTENCE_LIKENESS: Likeness = { exact: similarity, rough: bagSimilarity };
const LINE_LIKENESS: Likeness = { exact: lineLikeness(similarity), rough: lineLikeness(bagSimilarity) };

/**
 * What changed between two texts, as runs in reading order. Equal lines stay; alike lines are compared sentence by
 * sentence and word by word; a line with no like partner, and a pair that is a rewrite, are a whole block out and a
 * whole block in. Joining the runs that are not added gives `before` exactly; those not removed give `after`. The work
 * is bounded (see {@link WORK_BUDGET}), so a very large rewrite is answered at once, a little less finely.
 */
export const diffText = (before: string, after: string): readonly WordRun[] => {
  if (before === after) return merged([{ kind: 'same', text: after }]);
  const work = freshWork();
  const bySentence = (a: string, b: string): readonly WordRun[] =>
    align(piecesOf(a, SENTENCES), piecesOf(b, SENTENCES), (x, y) => diffWords(x, y, work), SENTENCE_LIKENESS, work);
  return align(piecesOf(before, LINES), piecesOf(after, LINES), bySentence, LINE_LIKENESS, work);
};

/** The lines a long unchanged run keeps beside a change. */
const FOLD_CONTEXT = 3;

/** A long unchanged stretch, shown as how many lines it hides. */
export interface FoldedRun {
  readonly kind: 'folded';
  readonly lines: number;
}

/**
 * The runs of a changed text with every long unchanged stretch cut to the lines beside a change ("… 240 unchanged lines
 * …"), so one word edited in a long report is not pages of scrolling. Joining the other runs still reads as the text
 * around the change. A text with no change at all is left whole.
 */
export const foldUnchanged = (runs: readonly WordRun[]): readonly (WordRun | FoldedRun)[] => {
  if (!runs.some(run => run.kind !== 'same')) return runs;
  return runs.flatMap((run, index): (WordRun | FoldedRun)[] => {
    const pieces = run.kind === 'same' ? piecesOf(run.text, LINES) : [];
    const before = index === 0 ? 0 : FOLD_CONTEXT;
    const after = index === runs.length - 1 ? 0 : FOLD_CONTEXT;
    if (run.kind !== 'same' || pieces.length <= before + after + 2) return [run];
    const hidden = pieces.slice(before, pieces.length - after);
    return [
      { kind: 'same', text: pieces.slice(0, before).join('') },
      { kind: 'folded', lines: hidden.length },
      { kind: 'same', text: pieces.slice(pieces.length - after).join('') },
    ].filter(part => part.kind !== 'same' || part.text !== '') as (WordRun | FoldedRun)[];
  });
};

// ---------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------

/**
 * The sections compared: THE TABS first, in tab order — they are the item's live document, the thing that is versioned
 * (&F923): "Where we are now" with the answer to the owner's question, decided so far and still open right after it,
 * then "The full picture", then each of the ferret's own tabs (`ownTabDiffs`, matched by id) and the tab order — then
 * the rest in the order the item view reads them.
 */
const DIFF_SECTIONS = [
  { key: 'whereWeAre', label: 'Where we are now' },
  { key: 'questionAnswer', label: 'Answer to your question' },
  { key: 'decided', label: 'Decided so far' },
  { key: 'stillOpen', label: 'Still open' },
  { key: 'body', label: 'The full picture' },
  { key: 'title', label: 'Title' },
  { key: 'stage', label: 'Type' },
  { key: 'subject', label: 'Question' },
  { key: 'premise', label: 'Premise' },
  { key: 'context', label: 'Context' },
  { key: 'detail', label: 'Detailed context' },
  { key: 'terms', label: 'Terms' },
  { key: 'links', label: 'References' },
  { key: 'ask', label: 'What I need from you' },
  { key: 'questions', label: 'Questions' },
  { key: 'optionDetails', label: 'About each option' },
  { key: 'fields', label: 'Form' },
  { key: 'recommendation', label: 'Recommendation' },
  { key: 'impact', label: 'Impact' },
  { key: 'urgency', label: 'Urgency' },
  { key: 'steps', label: 'Steps' },
  { key: 'cards', label: 'Cards' },
  { key: 'why', label: 'Why it matters' },
  { key: 'howToResolve', label: 'How to resolve' },
] as const;
export type DiffSectionKey = (typeof DIFF_SECTIONS)[number]['key'];
/** How many of the sections are the fixed tabs' (`whereWeAre` … `body`): the ferret's own tabs go right after them. */
const FIXED_TAB_SECTIONS = 5;

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

const choiceNames = (options: readonly { readonly label: string }[] | undefined): string =>
  options === undefined ? '' : options.map(option => option.label).join(' / ');

/** The questions of a multi-decision ask, one line each with the options it offers and the pick it recommends. */
const questionsText = (questions: AgendaItem['questions']): string =>
  (questions ?? [])
    .map((question, index) =>
      [
        `${String(index + 1)}. ${question.question}`,
        question.options === undefined ? '' : `Options: ${choiceNames(question.options)}`,
        question.recommended === undefined ? '' : `Recommended: ${question.recommended}`,
      ]
        .filter(part => part !== '')
        .join(' · '),
    )
    .join('\n');

/** The longer explanation of each option, one line each. */
const optionDetailsText = (details: AgendaItem['optionDetails']): string =>
  (details ?? []).map(entry => `${entry.label}: ${entry.detail.replaceAll(/\s+/gu, ' ').trim()}`).join('\n');

const FIELD_WORDS: Readonly<Record<string, string>> = {
  one: 'pick one',
  many: 'pick any',
  yesno: 'yes or no',
  text: 'in words',
};

/** The fields of a form, one line each: its label, how it is answered, and the options it offers. */
const fieldsText = (fields: AgendaItem['fields']): string =>
  (fields ?? [])
    .map(field =>
      [
        `${field.label} (${FIELD_WORDS[field.type] ?? field.type}${field.required === false ? ', optional' : ''})`,
        field.options === undefined ? '' : `Options: ${choiceNames(field.options)}`,
      ]
        .filter(part => part !== '')
        .join(' · '),
    )
    .join('\n');

/** The cards a notice lists, one line each: its reference, then what the line says. */
const cardsText = (cards: AgendaItem['cards']): string =>
  (cards ?? []).map(card => `${formatTaskRef(card.task)} ${card.line}`).join('\n');

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
    case 'stage':
      return STAGE_WORDS[agendaStage(item)];
    case 'questions':
      return questionsText(item.questions);
    case 'optionDetails':
      return optionDetailsText(item.optionDetails);
    case 'fields':
      return fieldsText(item.fields);
    case 'cards':
      return cardsText(item.cards);
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
  /** A fixed section, one of the ferret's own tabs (`tab:<id>`), or the order of those tabs. */
  readonly key: DiffSectionKey | `tab:${string}` | 'tabOrder';
  readonly label: string;
  readonly status: SectionStatus;
  readonly runs: readonly WordRun[];
  readonly addedWords: number;
  readonly removedWords: number;
}

const countOf = (runs: readonly WordRun[], kind: WordRun['kind']): number =>
  runs.filter(run => run.kind === kind).reduce((sum, run) => sum + wordCount(run.text), 0);

/** One section's two texts compared; nothing when neither version has it. A rename alone still counts as a change. */
const compared = (
  key: SectionDiff['key'],
  label: string,
  before: string,
  after: string,
  renamed = false,
): SectionDiff[] => {
  if (before === '' && after === '') return [];
  const runs = diffText(before, after);
  const status: SectionStatus =
    before === after
      ? renamed
        ? 'changed'
        : 'unchanged'
      : before === ''
        ? 'added'
        : after === ''
          ? 'removed'
          : 'changed';
  return [{ key, label, status, runs, addedWords: countOf(runs, 'added'), removedWords: countOf(runs, 'removed') }];
};

/**
 * The ferret's own tabs compared, matched BY ID so a rename reads "Open risks (was Risks)" rather than a removal and a
 * new tab: the newer version's tabs in its order, then the ones it removed; and a "Tab order" line when the tabs both
 * versions have moved.
 */
const ownTabDiffs = (from: AgendaItem, to: AgendaItem): readonly SectionDiff[] => {
  const before = from.tabs ?? [];
  const after = to.tabs ?? [];
  const was = new Map(before.map(tab => [tab.id, tab]));
  const kept = new Set(after.map(tab => tab.id));
  const sections = [
    ...after.flatMap(tab => {
      const old = was.get(tab.id);
      const renamed = old !== undefined && old.name !== tab.name;
      return compared(
        `tab:${tab.id}`,
        renamed ? `${tab.name} (was ${old.name})` : tab.name,
        old?.body ?? '',
        tab.body,
        renamed,
      );
    }),
    ...before.filter(tab => !kept.has(tab.id)).flatMap(tab => compared(`tab:${tab.id}`, tab.name, tab.body, '')),
  ];
  const shared = (tabs: typeof before): string =>
    tabs
      .filter(tab => was.has(tab.id) && kept.has(tab.id))
      .map(tab => tab.id)
      .join(' ');
  if (shared(before) === shared(after)) return sections;
  return [
    ...sections,
    ...compared(
      'tabOrder',
      'Tab order',
      before.map(tab => tab.name).join(' · '),
      after.map(tab => tab.name).join(' · '),
    ),
  ];
};

/**
 * Every section of `to` against `from`: the tabs first, in tab order, then the rest in reading order; sections neither
 * version has are left out.
 */
export const diffItems = (from: AgendaItem, to: AgendaItem): readonly SectionDiff[] => {
  const fixed = ({ key, label }: (typeof DIFF_SECTIONS)[number]): SectionDiff[] =>
    compared(key, label, sectionText(from, key), sectionText(to, key));
  return [
    ...DIFF_SECTIONS.slice(0, FIXED_TAB_SECTIONS).flatMap(fixed),
    ...ownTabDiffs(from, to),
    ...DIFF_SECTIONS.slice(FIXED_TAB_SECTIONS).flatMap(fixed),
  ];
};

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
