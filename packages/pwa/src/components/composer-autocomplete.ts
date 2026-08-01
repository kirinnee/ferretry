/**
 * The composer's trigger engine — detection, ranking and token replacement.
 *
 * Ported from kteam's `src/components/composer-autocomplete-engine.ts`. `/`
 * does something (commands and skills), while a LEADING RUN of `@` selects one
 * reference family. This module is the pure half: it decides what a trigger is,
 * what "best match" means, and what the draft looks like after a candidate is
 * accepted. Providers deliberately do less — they receive the active query and
 * return candidate data — and the controller/popover that drives a live
 * textarea is a separate concern, not ported yet.
 *
 * `!` shell mode is NOT here and is not coming back without a decision. It
 * needs a new tmux inject send path, which is the mechanism behind kteam's
 * measured triple-execution bug, and a SHELL COMMAND running three times is
 * materially worse than a prompt running three times. There is deliberately no
 * dormant `!` branch to re-enable: adding one is a design decision that has to
 * be made again, with an exactly-once daemon action, not a flag someone flips.
 */

import { fieldScore } from '../shell/palette-ranking.ts';

type ComposerTrigger = '/' | '@';

type ComposerAutocompleteKind = 'command' | 'skill' | 'agent' | 'file' | 'directory' | 'task' | 'attention' | 'pin';

interface ComposerReferenceTierLegendItem {
  readonly tier: 1 | 2 | 3 | 4 | 5;
  readonly trigger: string;
  readonly label: string;
}

/**
 * Frequency order, not alphabetical order. Files and source locations are typed
 * most; people are next; durable fleet records follow. Kept as data so provider
 * routing, UI teaching and tests cannot drift independently.
 */
export const COMPOSER_REFERENCE_TIERS: readonly ComposerReferenceTierLegendItem[] = [
  { tier: 1, trigger: '@', label: 'Files' },
  { tier: 2, trigger: '@@', label: 'Agents' },
  { tier: 3, trigger: '@@@', label: 'Tasks' },
  { tier: 4, trigger: '@@@@', label: 'Attention' },
  { tier: 5, trigger: '@@@@@', label: 'Pins' },
];

export interface ComposerSelection {
  readonly start: number;
  readonly end: number;
}

export interface ComposerTriggerMatch {
  readonly trigger: ComposerTrigger;
  /** Exact sigil bytes at the start of this token (`/`, `@`, `@@`, …). */
  readonly triggerText: string;
  /** Present for `@` runs. Counts beyond the known five stay detectable so the
   *  picker can teach the valid tiers instead of silently breaking the token. */
  readonly referenceTier?: number;
  /** Text after the trigger and before the caret. */
  readonly query: string;
  /** Inclusive trigger offset. */
  readonly start: number;
  /** Exclusive end of the whole trigger token, including text after the caret. */
  readonly end: number;
  readonly caret: number;
}

export interface ComposerAutocompleteCandidate {
  readonly id: string;
  readonly kind: ComposerAutocompleteKind;
  readonly label: string;
  /** Secondary line shown in the row. Also participates in fuzzy matching. */
  readonly detail?: string;
  /** Extra search terms that do not need to be rendered. */
  readonly keywords?: string;
  /** Coarse source priority before fuzzy score. The unified reference picker
   *  keeps its small named sets ahead of the thousands-deep filesystem. */
  readonly rankPriority?: number;
  /** Complete replacement for the active token, including its sigil. */
  readonly replacement: string;
  /** Final selections close with a separating space; directories stay open. */
  readonly append?: 'space' | 'none';
  readonly disabled?: boolean;
}

export interface TokenReplacement {
  readonly value: string;
  readonly selection: ComposerSelection;
}

const TOKEN_SPACE = /\s/u;

/** A bare `@` in a large directory should offer a list, not a file manager. At
 *  44px a row, 20 is already ~880px of content behind a ~220px window; 60 was a
 *  2,600px scroller nobody reaches the bottom of, and refining the query is
 *  faster than flicking past it. */
export const MAX_AUTOCOMPLETE_RESULTS = 20;

function clampSelection(value: string, selection: ComposerSelection): ComposerSelection {
  const start = Math.max(0, Math.min(value.length, Math.trunc(selection.start)));
  const end = Math.max(start, Math.min(value.length, Math.trunc(selection.end)));
  return { start, end };
}

/**
 * An input event reports the caret for its NEW value before the controlled
 * parent has rendered that value back. Do not clamp to the old value here, or
 * `/` typed into an empty draft becomes caret 0 and every query stays one
 * character behind. The next render's detector performs the real value-bounded
 * clamp.
 */
export function pendingComposerInputSelection(selection: ComposerSelection): ComposerSelection {
  const start = Math.max(0, Math.trunc(selection.start));
  const end = Math.max(start, Math.trunc(selection.end));
  return { start, end };
}

function tokenEnd(value: string, caret: number): number {
  let end = caret;
  while (end < value.length && !TOKEN_SPACE.test(value[end]!)) end++;
  return end;
}

function slashTrigger(value: string, caret: number): ComposerTriggerMatch | null {
  const first = value.search(/\S/u);
  if (first < 0 || value[first] !== '/' || caret < first + 1) return null;
  const query = value.slice(first + 1, caret);
  if (TOKEN_SPACE.test(query)) return null;
  return { trigger: '/', triggerText: '/', query, start: first, end: tokenEnd(value, caret), caret };
}

/** Characters that make the thing before an `@` a WORD rather than a boundary.
 *
 *  The mention sigil has to BEGIN its token. `bob@example.com` is an address and
 *  `a@b` is a word; neither is a file reference, and matching there is not just
 *  a cosmetic false positive — `match.start` is the sigil, so accepting a
 *  candidate would replace `@example.com` and leave `bob` welded to a path.
 *  Dots and slashes are included because they are the interior of the very
 *  things that produce false positives (`a.b@c`, `dir/x@y`).
 *
 *  Anything else — whitespace, or opening punctuation like `(`, `"`, `:` — is a
 *  real boundary, so `see:@src` and `(@src` still open the list. */
const WORD_BEFORE_MENTION = /[\p{L}\p{N}_\-.\\/@]/u;

function atTrigger(value: string, caret: number): ComposerTriggerMatch | null {
  const before = value.slice(0, caret);
  let candidate = before.lastIndexOf('@');
  while (candidate >= 0) {
    // `lastIndexOf` lands on the FINAL sigil in `@@@`; walk to the start of the
    // contiguous run so repetition is the tier rather than a word-boundary
    // failure on the second character.
    let start = candidate;
    while (start > 0 && value[start - 1] === '@') start -= 1;
    let runEnd = start;
    while (runEnd < caret && value[runEnd] === '@') runEnd += 1;

    if (start === 0 || !WORD_BEFORE_MENTION.test(value[start - 1]!)) {
      const query = value.slice(runEnd, caret);
      if (!TOKEN_SPACE.test(query)) {
        const triggerText = value.slice(start, runEnd);
        return {
          trigger: '@',
          triggerText,
          referenceTier: triggerText.length,
          query,
          start,
          end: tokenEnd(value, caret),
          caret,
        };
      }
    }

    candidate = before.lastIndexOf('@', start - 1);
  }
  return null;
}

/**
 * Detect the trigger at a collapsed textarea caret.
 *
 * `/` is limited to the first non-whitespace byte and `@` is valid at a token
 * boundary. `&`, `?` and `#` are ordinary Markdown/prose: tasks and attention
 * are browsed through `@`, while their canonical inserted forms stay `&F12` and
 * `!A3`. A non-collapsed textarea selection never opens a list.
 */
export function detectComposerTrigger(value: string, selection: ComposerSelection): ComposerTriggerMatch | null {
  const safe = clampSelection(value, selection);
  if (safe.start !== safe.end) return null;
  const caret = safe.end;
  return atTrigger(value, caret) ?? slashTrigger(value, caret);
}

/**
 * Replace exactly the active token and return the caret to its new end.
 * Existing whitespace after a final token is reused rather than doubled.
 */
export function replaceComposerTrigger(
  value: string,
  match: Pick<ComposerTriggerMatch, 'start' | 'end'>,
  replacement: string,
  append: 'space' | 'none' = 'space',
): TokenReplacement {
  const before = value.slice(0, match.start);
  let after = value.slice(match.end);
  let separator = '';
  if (append === 'space') {
    if (!after || !TOKEN_SPACE.test(after[0]!)) separator = ' ';
    else if (after[0] === ' ') {
      // Reuse one existing ASCII separator and leave any additional whitespace
      // exactly as the reader typed it.
      separator = ' ';
      after = after.slice(1);
    }
  }
  const next = `${before}${replacement}${separator}${after}`;
  const caret = before.length + replacement.length + separator.length;
  return { value: next, selection: { start: caret, end: caret } };
}

function candidateScore(candidate: ComposerAutocompleteCandidate, query: string): number {
  if (!query) return 1;
  const label = fieldScore(candidate.label, query);
  const supporting = Math.max(fieldScore(candidate.detail ?? '', query), fieldScore(candidate.keywords ?? '', query));
  if (!label && !supporting) return 0;
  // Names dominate descriptions, while a supporting hit still admits a skill
  // whose human description contains the term the reader remembers.
  return label * 3 + supporting;
}

/**
 * Engine-owned filtering and ranking. Providers return facts; they never choose
 * what fuzzy matching means. Disabled filesystem rows stay in the result so the
 * UI can honestly explain why a visible path cannot be inserted.
 */
export function rankComposerCandidates(
  candidates: readonly ComposerAutocompleteCandidate[],
  query: string,
  limit = MAX_AUTOCOMPLETE_RESULTS,
): ComposerAutocompleteCandidate[] {
  if (!query) return candidates.slice(0, limit);
  return candidates
    .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate, query) }))
    .filter(item => item.score > 0)
    .sort(
      (a, b) =>
        (b.candidate.rankPriority ?? 0) - (a.candidate.rankPriority ?? 0) || b.score - a.score || a.index - b.index,
    )
    .slice(0, limit)
    .map(item => item.candidate);
}

/**
 * Find the next selectable row, wrapping and skipping refused filesystem
 * entries. Returns -1 when the result contains information only.
 */
export function nextComposerCandidateIndex(
  candidates: readonly ComposerAutocompleteCandidate[],
  current: number,
  direction: 1 | -1,
): number {
  // The modulo below is the only thing that decides an all-disabled list, so the
  // empty guard exists purely to keep `% 0` out of it.
  if (!candidates.length) return -1;
  // From "nothing selected", ArrowDown means the FIRST row and ArrowUp means the
  // LAST one. Falling through to the modulo below would answer `length - 2` for
  // ArrowUp, which is the second to last — a quietly wrong answer that only
  // shows up once a caller reaches this with no active row.
  let index = current < 0 ? (direction === 1 ? candidates.length - 1 : 0) : current;
  for (let seen = 0; seen < candidates.length; seen++) {
    index = (index + direction + candidates.length) % candidates.length;
    if (!candidates[index]!.disabled) return index;
  }
  return -1;
}
