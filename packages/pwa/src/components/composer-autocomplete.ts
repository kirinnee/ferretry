/**
 * The composer's trigger engine — detection, ranking and token replacement.
 *
 * Ported from kteam's `src/components/composer-autocomplete-engine.ts`. `/`
 * does something (commands and skills), a LEADING RUN of `@` selects one
 * reference family, and each family's own sigil opens it directly. This module
 * is the pure half: it decides what a trigger is, what "best match" means, and
 * what the draft looks like after a candidate is accepted. Providers
 * deliberately do less — they receive the active query and return candidate
 * data. This module also carries the source hook controller that drives a live
 * textarea. The rendered listbox belongs to kteam's separate
 * `src/components/ComposerAutocomplete.tsx`, not the assigned engine source,
 * and remains an explicit migration gap; engine coverage must not be mistaken
 * for a complete, visible composer surface.
 *
 * `!` IS ATTENTION HERE, AND NOTHING ELSE. `!` shell mode is NOT in this file
 * and is not coming back without a decision: it needs a new tmux inject send
 * path, which is the mechanism behind kteam's measured triple-execution bug,
 * and a SHELL COMMAND running three times is materially worse than a prompt
 * running three times. The `!` branch below opens the Attention family, it can
 * never run anything, and it is not that decision being quietly reversed.
 *
 * THE DIRECT SIGILS ARE DELIBERATELY HARDER TO OPEN THAN `@`, `/` or `%`.
 * Those three are acts nobody performs by accident. `:`, `&`, `!` and `$` are
 * ordinary prose — `note: `, `A & B`, `done!`, `$HOME` — so a menu that behaved
 * like the others would appear mid-sentence and, because the first row is
 * selected on `@` and `/`, would answer the reader's Enter by inserting a
 * reference instead of sending their message. Two rules prevent that, and both
 * are load-bearing rather than polish:
 *
 *   AT LEAST ONE QUERY CHARACTER. A bare sigil never opens anything.
 *   NOTHING IS PRESELECTED. The list opens with no active row, so Enter falls
 *   straight through to the host until ArrowDown or a pointer chooses a row.
 */

import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  acceptsDirectReferenceQuery,
  DIRECT_REFERENCE_SIGILS,
  type DirectReferenceSigil,
  isReferenceLeftBoundary,
} from '../lib/references.ts';
import { fieldScore } from '../shell/palette-ranking.ts';

/**
 * `%` IS ITS OWN TRIGGER RATHER THAN A FIFTH `@` TIER.
 *
 * The `@` run is repetition-as-selection, and the families behind it are all
 * FLEET-WIDE records: files in the session tree, agents, tasks, attention. A
 * surface is not one of those — it is a live thing inside THIS session, and a
 * fifth tier would have been `@@@@@`, five keystrokes for the family a reader
 * reaches for while watching an agent work. It also keeps the tiers stable:
 * renumbering them would have moved every existing family under the reader.
 *
 * The direct sigils come from the reference grammar itself, so this union has
 * exactly one owner for the four of them: adding a fifth family's sigil to
 * `references.ts` adds it here, and a picker can never offer a sigil the
 * renderer would not parse.
 */
export type ComposerTrigger = '/' | '@' | '%' | DirectReferenceSigil;

export type ComposerAutocompleteKind =
  | 'command'
  | 'skill'
  | 'agent'
  | 'file'
  | 'directory'
  | 'task'
  | 'attention'
  | 'surface';

export interface ComposerReferenceTierLegendItem {
  readonly tier: 1 | 2 | 3 | 4;
  readonly trigger: string;
  readonly label: string;
  /** The sigil that opens this family directly. Files have none: `@` IS tier 1. */
  readonly direct?: DirectReferenceSigil;
}

/**
 * Frequency order, not alphabetical order. Files and source locations are typed
 * most; people are next; durable fleet records follow. Kept as data so provider
 * routing, UI teaching and tests cannot drift independently — including the
 * tier-to-direct-sigil mapping, which is the same fact read from the other end.
 *
 * THERE IS NO FIFTH TIER. Pins were one; they are a top link strip rather than
 * a reference family (handover #63), and readable composer text rather than a
 * second grammar. Template libraries are not a tier either — no build of this
 * app has ever had one, and this list is the guard that keeps it that way.
 */
export const COMPOSER_REFERENCE_TIERS: readonly ComposerReferenceTierLegendItem[] = [
  { tier: 1, trigger: '@', label: 'Files' },
  { tier: 2, trigger: '@@', label: 'Agents', direct: ':' },
  { tier: 3, trigger: '@@@', label: 'Tasks', direct: '&' },
  { tier: 4, trigger: '@@@@', label: 'Attention', direct: '!' },
];

/**
 * Which suggestion families a host offers. Every switch is SUGGESTIONS ONLY: a
 * disabled family still parses, still proves and still links wherever a reader
 * authored it, and `addReferenceToComposer` still inserts one. Turning a menu
 * off removes an offer, never a capability.
 *
 * `/` and `%` are deliberately not governed. `/` is the harness command line —
 * a reader who has typed it at the start of an empty draft is not writing prose
 * — and `%` cannot be typed by accident either.
 */
export interface ComposerSuggestionSwitches {
  /**
   * The WHOLE `@` ladder, bare `@` files included, not only the repeated tiers.
   *
   * That is the harder reading of the two and it is the one the Settings switch
   * promises out loud — "files with @, agents with @@, tasks with @@@, attention
   * with @@@@". Exempting tier 1 would have left a reader who switched `@`
   * suggestions off still getting a file menu, which is a copy that lies rather
   * than a menu that helps. Authoring `@src/api.ts` by hand still parses, still
   * proves and still links, and "Add to chat" still inserts one.
   */
  readonly mentionSuggestions: boolean;
  /** The `:` `&` `!` direct sigils. */
  readonly directReferenceSuggestions: boolean;
  /** `$` skills. `/` skills are unaffected, so a skill is always reachable. */
  readonly skillSuggestions: boolean;
}

/** Absent means enabled, so a host that knows nothing about these gets today's
 *  behaviour and an older stored preference reads as "all on". The field names
 *  are `DeviceControls`' own, because the persisted preference and the
 *  suppression rule are one fact and a rename between them is where it breaks. */
export const DEFAULT_COMPOSER_SUGGESTIONS: ComposerSuggestionSwitches = {
  mentionSuggestions: true,
  directReferenceSuggestions: true,
  skillSuggestions: true,
};

/**
 * The one place a switch decides anything.
 *
 * Providers answer `shouldOpen` from it and the tier legend is filtered by it,
 * so a chip can never teach a menu that will not open. Enforcing it in the host
 * instead would take `@` and `/` down with it, which is exactly what these
 * switches must not do.
 */
export function composerSuggestionsAllow(
  suggestions: ComposerSuggestionSwitches,
  match: Pick<ComposerTriggerMatch, 'trigger'>,
): boolean {
  if (match.trigger === '@') return suggestions.mentionSuggestions;
  if (match.trigger === '$') return suggestions.skillSuggestions;
  if (match.trigger === '/' || match.trigger === '%') return true;
  return suggestions.directReferenceSuggestions;
}

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
  /** Visual section inside a provider's merged result list. */
  readonly group?: string;
  /** Coarse source priority before fuzzy score. The unified reference picker
   *  keeps its small named sets ahead of the thousands-deep filesystem. */
  readonly rankPriority?: number;
  /** Compact state/action word shown at the row's trailing edge. */
  readonly badge?: string;
  /** Complete replacement for the active token, including its sigil. */
  readonly replacement: string;
  /** Final selections close with a separating space; directories stay open. */
  readonly append?: 'space' | 'none';
  readonly disabled?: boolean;
  /** Honest explanation for a visible but refused row. */
  readonly disabledReason?: string;
}

export interface ComposerProviderContext {
  readonly query: string;
  readonly match: ComposerTriggerMatch;
  readonly signal: AbortSignal;
}

export interface ComposerProviderResult {
  readonly candidates: readonly ComposerAutocompleteCandidate[];
  /** Files search only their final path segment; other providers omit this. */
  readonly filterQuery?: string;
  readonly contextLabel?: string;
  readonly notice?: string;
}

export interface ComposerAutocompleteProvider {
  readonly id: string;
  readonly trigger: ComposerTrigger;
  readonly label: string;
  readonly legend?: readonly ComposerReferenceTierLegendItem[];
  /** Changes when a store-backed provider's live source changes. */
  readonly snapshotKey?: unknown;
  initialCandidates?(context: ComposerProviderContext): ComposerProviderResult | undefined;
  shouldOpen?(match: ComposerTriggerMatch): boolean;
  reset?(): void;
  candidates(context: ComposerProviderContext): Promise<ComposerProviderResult> | ComposerProviderResult;
}

export type ComposerAutocompleteStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ComposerAutocompleteSnapshot {
  readonly open: boolean;
  readonly status: ComposerAutocompleteStatus;
  readonly provider: ComposerAutocompleteProvider | null;
  readonly match: ComposerTriggerMatch | null;
  readonly candidates: readonly ComposerAutocompleteCandidate[];
  readonly activeIndex: number;
  readonly activeId?: string;
  readonly contextLabel?: string;
  readonly notice?: string;
  readonly error?: string;
}

export interface ComposerAutocompleteController extends ComposerAutocompleteSnapshot {
  readonly listboxId: string;
  /** An open list vetoes any host re-focus recovery. */
  readonly blocksRefocus: boolean;
  syncSelection(selection: ComposerSelection): void;
  handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /**
   * The IME seam, in two halves, because a composition is a state and not a key.
   *
   * `handleKeyDown` already refuses a composing keystroke, but detection runs
   * from `onChange`, which fires on every composition UPDATE. Without this a
   * Japanese, Chinese or Korean composition containing `:` or `&` opens a menu
   * over the IME's own candidate window, and accepting there would rewrite
   * bytes the IME still owns. So: no list opens while a composition is active,
   * and `endComposition` re-detects against the caret the IME finally left —
   * a reference the composition ended on is offered immediately rather than
   * waiting for one more keystroke.
   */
  startComposition(): void;
  endComposition(selection?: ComposerSelection): void;
  accept(index: number): void;
  close(): void;
  readonly textareaAria: {
    readonly 'aria-autocomplete'?: 'list';
    readonly 'aria-controls'?: string;
    readonly 'aria-expanded'?: boolean;
    readonly 'aria-activedescendant'?: string;
    readonly 'aria-haspopup'?: 'listbox';
  };
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
  while (end < value.length && !TOKEN_SPACE.test(value[end] ?? '')) end++;
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

/** The mention rule plus the surface sigil itself. `%%` must not open the list:
 *  the reference grammar refuses a `%` immediately before a token, so a candidate
 *  accepted there would insert a dead token the renderer could never prove. */
const WORD_BEFORE_SURFACE = /[\p{L}\p{N}_\-.\\/@%]/u;

/**
 * The next sigil STRICTLY before `upTo`, or -1 once there is none.
 *
 * `String.prototype.lastIndexOf` clamps a negative `fromIndex` to 0 rather than
 * answering -1, so `'@a b'.lastIndexOf('@', -1)` is 0 — the very candidate the
 * caller just rejected. Both backward scans below were written with a bare
 * `lastIndexOf(sigil, start - 1)` and therefore SPUN FOREVER whenever the
 * rejected candidate sat at index 0: a draft of `@a b` with the caret at the end
 * froze the composer, and with it the tab, because the query contained a space
 * and the scan restarted on the same sigil. Refusing a negative bound is the fix,
 * and it belongs here so neither scan can reintroduce it.
 */
const previousSigil = (haystack: string, sigil: string, upTo: number): number =>
  upTo < 0 ? -1 : haystack.lastIndexOf(sigil, upTo);

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

    if (start === 0 || !WORD_BEFORE_MENTION.test(value[start - 1] ?? '')) {
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

    candidate = previousSigil(before, '@', start - 1);
  }
  return null;
}

/**
 * The surface trigger: exactly one `%`, at a token boundary.
 *
 * The boundary rule is the mention rule, so `50%` and `a%b` are a percentage and
 * a word — not an offer to address a terminal. There is no run: repeating the
 * sigil selects nothing, so `%%` is prose.
 */
function percentTrigger(value: string, caret: number): ComposerTriggerMatch | null {
  const before = value.slice(0, caret);
  let start = before.lastIndexOf('%');
  while (start >= 0) {
    const query = value.slice(start + 1, caret);
    if (
      !TOKEN_SPACE.test(query) &&
      !query.includes('%') &&
      (start === 0 || !WORD_BEFORE_SURFACE.test(value[start - 1] ?? ''))
    )
      return { trigger: '%', triggerText: '%', query, start, end: tokenEnd(value, caret), caret };
    start = previousSigil(before, '%', start - 1);
  }
  return null;
}

/**
 * The direct family sigils: `:` agents, `&` tasks, `!` attention, `$` skills.
 *
 * Three rules, and each one exists because prose contains these characters:
 *
 *   THE GRAMMAR'S OWN LEFT BOUNDARY, imported rather than restated. A picker
 *   that opened where `findReferences` refuses would insert a token the
 *   renderer can never prove, so `note:`, `R&D`, `done!` and `US$5` are inert
 *   by construction rather than by a list of special cases.
 *   THE GRAMMAR'S OWN TOKEN SHAPE, so a query that can never complete never
 *   opens a menu: `$HOME` is a shell variable, `&x` is not a task id.
 *   AT LEAST ONE QUERY CHARACTER, so a bare sigil is always prose. `A & B` and
 *   an emphatic `Yes!` are the common case, not the edge case.
 *
 * The nearest sigil to the caret wins, so a draft that contains several is
 * answered about the one being typed. Each backward scan uses `previousSigil`
 * for the reason recorded there: a bare `lastIndexOf` never terminates.
 */
function directTrigger(value: string, caret: number): ComposerTriggerMatch | null {
  const before = value.slice(0, caret);
  let best: ComposerTriggerMatch | null = null;
  for (const sigil of DIRECT_REFERENCE_SIGILS) {
    let start = before.lastIndexOf(sigil);
    while (start >= 0) {
      const query = value.slice(start + 1, caret);
      if (
        query !== '' &&
        !TOKEN_SPACE.test(query) &&
        isReferenceLeftBoundary(start === 0 ? undefined : value[start - 1]) &&
        acceptsDirectReferenceQuery(sigil, query)
      ) {
        if (best === null || start > best.start)
          best = { trigger: sigil, triggerText: sigil, query, start, end: tokenEnd(value, caret), caret };
        break;
      }
      start = previousSigil(before, sigil, start - 1);
    }
  }
  return best;
}

/**
 * Detect the trigger at a collapsed textarea caret.
 *
 * `/` is limited to the first non-whitespace byte; `@` and `%` are valid at a
 * token boundary; the four direct sigils are valid where the reference grammar
 * would accept the token they begin. A non-collapsed textarea selection never
 * opens a list.
 *
 * ORDER IS LOAD-BEARING, and every step of it is a token one of the others
 * would otherwise eat:
 *
 *   `@` before `%`, so a path containing a percent sign stays one file query —
 *   `@src/a%b` is a filename, and hijacking its tail would replace half of what
 *   the reader typed.
 *   `@` and `%` before the direct sigils, so the interior colon of
 *   `%terminal:ab12` and the line selector of `@src/api.ts:120` stay inside
 *   their own token instead of opening an agent menu.
 *   `/` before `$`, which never actually collides — `/` only opens at the
 *   first non-whitespace byte — but keeps the skills pair reading in one place.
 */
export function detectComposerTrigger(value: string, selection: ComposerSelection): ComposerTriggerMatch | null {
  const safe = clampSelection(value, selection);
  if (safe.start !== safe.end) return null;
  const caret = safe.end;
  return (
    atTrigger(value, caret) ?? percentTrigger(value, caret) ?? slashTrigger(value, caret) ?? directTrigger(value, caret)
  );
}

/** Whether a trigger's menu may select a row before the reader has chosen one.
 *  A direct sigil never does: see this module's header. */
const preselects = (trigger: ComposerTrigger): boolean =>
  !(DIRECT_REFERENCE_SIGILS as readonly string[]).includes(trigger);

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
    if (!after || !TOKEN_SPACE.test(after[0] ?? '')) separator = ' ';
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
    if (!candidates[index]?.disabled) return index;
  }
  return -1;
}

function firstEnabled(candidates: readonly ComposerAutocompleteCandidate[]): number {
  return candidates.findIndex(candidate => !candidate.disabled);
}

interface LoadState {
  readonly key: string;
  readonly status: ComposerAutocompleteStatus;
  readonly candidates: readonly ComposerAutocompleteCandidate[];
  readonly contextLabel?: string;
  readonly notice?: string;
  readonly error?: string;
}

const IDLE_LOAD: LoadState = { key: '', status: 'idle', candidates: [] };

/**
 * Connects a controlled textarea to stable, daemon-scoped providers. It never
 * moves DOM focus: preserving a phone keyboard and a held transcript selection
 * are host invariants, not suggestions a completion list may override.
 */
export function useComposerAutocomplete({
  value,
  onValueChange,
  inputRef,
  providers,
  disabled,
  listboxId,
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly providers: readonly ComposerAutocompleteProvider[];
  readonly disabled?: boolean;
  readonly listboxId?: string;
}): ComposerAutocompleteController {
  const generatedId = useId();
  const resolvedListboxId = listboxId ?? `composer-autocomplete-${generatedId.replace(/:/gu, '')}`;
  const [selection, setSelection] = useState<ComposerSelection>({ start: value.length, end: value.length });
  const [dismissed, setDismissed] = useState<{
    readonly trigger: ComposerTrigger;
    readonly triggerText: string;
    readonly start: number;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [composing, setComposing] = useState(false);
  const [load, setLoad] = useState<LoadState>(IDLE_LOAD);
  const pendingSelection = useRef<{ readonly expectedValue: string; readonly selection: ComposerSelection } | null>(
    null,
  );

  const selectionStart = selection.start;
  const selectionEnd = selection.end;
  const match = useMemo(
    () => detectComposerTrigger(value, { start: selectionStart, end: selectionEnd }),
    [selectionEnd, selectionStart, value],
  );
  const provider = match ? (providers.find(item => item.trigger === match.trigger) ?? null) : null;
  const matchTriggerText = match?.triggerText ?? match?.trigger;
  const tokenDismissed =
    match !== null &&
    dismissed?.trigger === match.trigger &&
    dismissed.triggerText === matchTriggerText &&
    dismissed.start === match.start;
  const open =
    match !== null &&
    provider !== null &&
    !disabled &&
    !composing &&
    !tokenDismissed &&
    (provider.shouldOpen?.(match) ?? true);
  const requestKey =
    open && match && provider ? `${provider.id}:${match.start}:${matchTriggerText}:${match.query}` : '';

  useEffect(() => {
    if (match !== null || dismissed === null) return;
    setDismissed(null);
  }, [dismissed, match]);

  useEffect(() => {
    if (!open || match === null || provider === null) {
      setLoad(previous => (previous.status === 'idle' ? previous : IDLE_LOAD));
      setActiveIndex(-1);
      return;
    }
    const abort = new AbortController();
    const ready = (result: ComposerProviderResult) => {
      if (abort.signal.aborted) return;
      const candidates = rankComposerCandidates(result.candidates, result.filterQuery ?? match.query);
      setLoad({
        key: requestKey,
        status: 'ready',
        candidates,
        contextLabel: result.contextLabel,
        notice: result.notice,
      });
      setActiveIndex(preselects(match.trigger) ? firstEnabled(candidates) : -1);
    };
    const failed = (error: unknown) => {
      if (abort.signal.aborted || (error as { readonly name?: string })?.name === 'AbortError') return;
      setLoad({
        key: requestKey,
        status: 'error',
        candidates: [],
        error: error instanceof Error ? error.message : String(error),
      });
      setActiveIndex(-1);
    };
    const context: ComposerProviderContext = { query: match.query, match, signal: abort.signal };
    try {
      const initial = provider.initialCandidates?.(context);
      if (initial !== undefined) ready(initial);
      else {
        setLoad({ key: requestKey, status: 'loading', candidates: [] });
        setActiveIndex(-1);
      }
      const result = provider.candidates(context);
      if (typeof (result as PromiseLike<ComposerProviderResult>).then === 'function')
        void Promise.resolve(result).then(ready, failed);
      else ready(result as ComposerProviderResult);
    } catch (error) {
      failed(error);
    }
    return () => abort.abort();
  }, [match, open, provider, provider?.snapshotKey, requestKey]);

  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    const input = inputRef.current;
    if (pending === null) return;
    if (pending.expectedValue !== value) {
      if (input !== null && input.value === value) pendingSelection.current = null;
      return;
    }
    if (input === null || input.value !== value) return;
    pendingSelection.current = null;
    input.setSelectionRange(pending.selection.start, pending.selection.end);
  }, [inputRef, value]);

  const currentLoad: LoadState = load.key === requestKey ? load : { ...IDLE_LOAD, status: open ? 'loading' : 'idle' };
  const candidates = currentLoad.candidates;
  // The fallback is where "nothing preselected" would otherwise leak back in:
  // an out-of-range or absent index re-derives the first enabled row, and for a
  // direct sigil that is precisely the Enter theft the -1 above prevented.
  const fallbackActive = match !== null && preselects(match.trigger) ? firstEnabled(candidates) : -1;
  const boundedActive = activeIndex >= 0 && activeIndex < candidates.length ? activeIndex : fallbackActive;
  const commit = useCallback(
    (replacement: TokenReplacement) => {
      pendingSelection.current = { expectedValue: replacement.value, selection: replacement.selection };
      setSelection(replacement.selection);
      onValueChange(replacement.value);
    },
    [onValueChange],
  );
  const close = useCallback(() => {
    if (match !== null && matchTriggerText !== undefined)
      setDismissed({ trigger: match.trigger, triggerText: matchTriggerText, start: match.start });
  }, [match, matchTriggerText]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const dismissOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (inputRef.current?.contains(target) || document.getElementById(resolvedListboxId)?.contains(target)) return;
      close();
    };
    document.addEventListener('click', dismissOutside);
    return () => document.removeEventListener('click', dismissOutside);
  }, [close, inputRef, open, resolvedListboxId]);

  const accept = useCallback(
    (index: number) => {
      if (match === null) return;
      const candidate = candidates[index];
      if (candidate === undefined || candidate.disabled) return;
      commit(replaceComposerTrigger(value, match, candidate.replacement, candidate.append ?? 'space'));
    },
    [candidates, commit, match, value],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (event.nativeEvent.isComposing) return false;
      if (!open) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(nextComposerCandidateIndex(candidates, boundedActive, event.key === 'ArrowDown' ? 1 : -1));
        return true;
      }
      if (event.key !== 'Enter' && event.key !== 'Tab') return false;
      // NOTHING SELECTED MEANS THE KEY IS NOT OURS. An open list with no active
      // row used to consume Enter anyway and insert nothing, which was harmless
      // only while every list preselected its first row. A direct-sigil menu
      // opens with none, so swallowing Enter here would eat the send of a
      // message that merely contains `A & B`.
      if (boundedActive < 0) return false;
      event.preventDefault();
      accept(boundedActive);
      return true;
    },
    [accept, boundedActive, candidates, close, open],
  );
  const activeId = boundedActive >= 0 ? `${resolvedListboxId}-option-${boundedActive}` : undefined;
  return {
    open,
    status: currentLoad.status,
    provider,
    match,
    candidates,
    activeIndex: boundedActive,
    activeId,
    contextLabel: currentLoad.contextLabel,
    notice: currentLoad.notice,
    error: currentLoad.error,
    listboxId: resolvedListboxId,
    blocksRefocus: open,
    syncSelection: next => setSelection(pendingComposerInputSelection(next)),
    startComposition: () => setComposing(true),
    endComposition: next => {
      setComposing(false);
      if (next !== undefined) setSelection(pendingComposerInputSelection(next));
    },
    handleKeyDown,
    accept,
    close,
    textareaAria: open
      ? {
          'aria-autocomplete': 'list',
          'aria-controls': resolvedListboxId,
          'aria-expanded': true,
          'aria-activedescendant': activeId,
          'aria-haspopup': 'listbox',
        }
      : {},
  };
}
