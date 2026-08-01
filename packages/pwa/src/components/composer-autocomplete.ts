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

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { fieldScore } from '../shell/palette-ranking.ts';

export type ComposerTrigger = '/' | '@';

export type ComposerAutocompleteKind =
  | 'command'
  | 'skill'
  | 'agent'
  | 'file'
  | 'directory'
  | 'task'
  | 'attention'
  | 'pin';

export interface ComposerReferenceTierLegendItem {
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
  const [load, setLoad] = useState<LoadState>(IDLE_LOAD);
  const pendingSelection = useRef<{ readonly expectedValue: string; readonly selection: ComposerSelection } | null>(
    null,
  );

  const match = useMemo(() => detectComposerTrigger(value, selection), [selection, value]);
  const provider = match ? (providers.find(item => item.trigger === match.trigger) ?? null) : null;
  const matchTriggerText = match?.triggerText ?? match?.trigger;
  const tokenDismissed =
    match !== null &&
    dismissed?.trigger === match.trigger &&
    dismissed.triggerText === matchTriggerText &&
    dismissed.start === match.start;
  const open =
    match !== null && provider !== null && !disabled && !tokenDismissed && (provider.shouldOpen?.(match) ?? true);
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
      setActiveIndex(firstEnabled(candidates));
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
  const boundedActive = activeIndex >= 0 && activeIndex < candidates.length ? activeIndex : firstEnabled(candidates);
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
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (boundedActive >= 0) accept(boundedActive);
        return true;
      }
      return false;
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
