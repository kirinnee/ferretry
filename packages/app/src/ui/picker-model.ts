/**
 * EVERYTHING A PICKER DECIDES, WORKED OUT WITHOUT A DOM.
 *
 * The daemon account and project pickers are the same control twice: a text box
 * whose typed value is the thing that gets submitted, with the host's own
 * catalogue offered beside it as a convenience. The hard parts are all
 * arithmetic and classification — which rows survive the query and in what
 * order, which row `aria-activedescendant` points at after an arrow key, and
 * WHICH OF FIVE list states is true right now — so they live here as pure
 * functions rather than as expressions inside JSX.
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE:
 *
 *  1. **THE TYPED VALUE IS THE SOURCE OF TRUTH.** Nothing here can change the
 *     string a person typed. `filterPickerOptions` narrows what is OFFERED and
 *     `pickerKeyAction` says which row was chosen; committing that row's literal
 *     value is the caller's decision, made in one place. A picker that could not
 *     be typed into would be a worse control than the bare input it replaces,
 *     because a wrapper can exist on a host without appearing in the last
 *     published catalogue.
 *
 *  2. **A FAILED READ IS NOT AN EMPTY LIST.** `PickerSource` distinguishes
 *     "still reading", "the read failed" and "the read succeeded", and
 *     `pickerList` then splits that last case into "the host published nothing"
 *     and "the host published things, none of which match what you typed". Four
 *     different facts, four different sentences, decided in ONE place from
 *     positive evidence. Collapsing any pair of them is how a browser ends up
 *     telling somebody their machine has no accounts because a request timed
 *     out.
 *
 *  3. **AN UNAVAILABLE ROW IS UNPICKABLE, NOT UNSAYABLE.** A disabled option is
 *     skipped by every navigation key and refused by Enter, so nobody chooses
 *     one by accident. Its literal value stays typeable, because the daemon —
 *     not this browser — is the thing that gets to refuse a launch, and it will
 *     say why in its own words.
 *
 * There is deliberately NO domain vocabulary in here. This module has never
 * heard of an account, a wrapper, a quota, a project or a path: `search` is
 * whatever the consumer decided is matchable and `label`/`detail` are whatever
 * it decided is readable. The presentation layer that knows those words renders
 * its own rows.
 */

/**
 * One offered choice.
 *
 * `value` and `search` are separate on purpose, and the separation is the whole
 * reason matching is predictable. `value` is the literal string that would be
 * committed to the input — a wrapper name, an absolute path — while `search` is
 * EXPLICIT match text the consumer composes. Deriving the haystack from the
 * rendered label instead would mean a display change silently altering which
 * rows a query finds, which is exactly the class of drift the palette's own
 * "casing" note warns about.
 */
export interface PickerOption {
  /** Committed verbatim when this row is chosen. Never normalised here. */
  readonly value: string;
  /** The primary rendered line, for the default row. */
  readonly label: string;
  /** Everything filter-as-you-type matches against. Explicit, never derived. */
  readonly search: string;
  /** A quieter second rendered line, for the default row. */
  readonly detail?: string;
  /** Unpickable — skipped by navigation and refused by Enter. Still typeable. */
  readonly disabled?: boolean;
  /** Why, in the daemon's words. Rendered so "disabled" is never unexplained. */
  readonly disabledReason?: string;
}

/**
 * What the consumer's read of its host produced. This is the shape a
 * daemon-scoped slice adapts to: `status: 'loading'` becomes `loading`, an error
 * becomes `failed`, and a settled read becomes `ready` — including a `ready`
 * carrying zero options, which is a positive claim about the host rather than an
 * absence of evidence.
 */
export type PickerSource<Option extends PickerOption> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly options: readonly Option[];
      /**
       * Why these rows may be out of date, when a REFRESH failed over a read
       * that had already succeeded.
       *
       * This is a real simultaneous state rather than a nicety: every
       * daemon-scoped store in this app deliberately keeps its last good answer
       * when a refresh fails, because blanking it would turn "we could not reach
       * the host" into "the host has nothing". So a consumer can hold valid rows
       * AND a failure at once, and without somewhere to put the second fact it
       * would have to throw one of them away — either hiding usable rows behind
       * an error, or showing rows while silently swallowing the news that they
       * are stale.
       *
       * Absent means the rows are as fresh as the last completed read.
       */
      readonly staleReason?: string;
    };

/**
 * What the popover actually shows. Five structurally distinct states, so no
 * renderer can accidentally draw two of them with the same words.
 *
 * `empty` and `no-match` both show an empty list and mean completely different
 * things: the first is the host saying it publishes nothing, the second is this
 * query finding nothing among things it does publish. Only the second is fixed
 * by deleting a character.
 *
 * `staleReason` rides on the three states derived from a settled read, and NOT
 * on `failed`: a read that never succeeded has no stale rows to warn about, and
 * one that succeeded and then went stale is not a failed read. Keeping the two
 * apart in the type is what stops a surface rendering "could not read" over a
 * list it is displaying.
 */
export type PickerList<Option extends PickerOption> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'empty'; readonly staleReason?: string }
  | { readonly kind: 'no-match'; readonly query: string; readonly staleReason?: string }
  | { readonly kind: 'options'; readonly options: readonly Option[]; readonly staleReason?: string };

/** A shared empty identity, so a non-option state does not re-render consumers. */
const NO_OPTIONS: readonly never[] = Object.freeze([]);

const needleOf = (query: string): string => query.trim().toLowerCase();

/**
 * How well one option answers a query: lower is better, `null` is no match.
 *
 * Three tiers rather than a score, because a score invites tie-breaking rules
 * nobody can predict from the outside:
 *
 *   0 — the typed text IS this option's value. The reader has already named it
 *       exactly; it must lead however long the list is.
 *   1 — the match text starts with the query. Typing forward should walk toward
 *       the thing you are typing toward.
 *   2 — the match text contains the query anywhere, and also every option under
 *       an empty query.
 *
 * Ranks are compared with a STABLE sort, so within one tier the consumer's own
 * order survives untouched — which is what lets a consumer put registered
 * folders before ones merely seen in a session list and have that hold.
 */
export const pickerMatchRank = (option: PickerOption, query: string): number | null => {
  const needle = needleOf(query);
  if (needle === '') return 2;
  if (option.value.toLowerCase() === needle) return 0;
  const haystack = option.search.toLowerCase();
  if (haystack.startsWith(needle)) return 1;
  return haystack.includes(needle) ? 2 : null;
};

/**
 * The offered rows for one query, best tier first and otherwise in the order the
 * consumer supplied.
 *
 * `Array.prototype.sort` is stable per spec, which is load-bearing here rather
 * than incidental: it is the only reason a same-tier list keeps a provenance
 * ordering the consumer expressed.
 */
export const filterPickerOptions = <Option extends PickerOption>(
  options: readonly Option[],
  query: string,
): readonly Option[] =>
  options
    .map(option => ({ option, rank: pickerMatchRank(option, query) }))
    .filter((entry): entry is { readonly option: Option; readonly rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank)
    .map(entry => entry.option);

/**
 * Which of the five list states is true, from the read and the typed value.
 *
 * The typed value doubles as the query, which is what "filter as you type"
 * means for a control whose text box is also its output: there is no second
 * hidden search string that could disagree with what is on screen.
 */
export const pickerList = <Option extends PickerOption>(
  source: PickerSource<Option>,
  query: string,
): PickerList<Option> => {
  if (source.kind !== 'ready') return source;
  // Carried onto whichever state follows, rather than restated three times: a
  // stale roster is stale whether it filtered down to rows, to nothing, or was
  // empty to begin with.
  const stale = source.staleReason === undefined ? {} : { staleReason: source.staleReason };
  // Asked and answered "nothing", which is a fact about the host. Reported
  // before filtering, because no query can be blamed for an empty catalogue.
  if (source.options.length === 0) return { kind: 'empty', ...stale };
  const options = filterPickerOptions(source.options, query);
  return options.length === 0
    ? { kind: 'no-match', query: query.trim(), ...stale }
    : { kind: 'options', options, ...stale };
};

/** The rows a keyboard can move through: only the `options` state has any. */
export const pickerListOptions = <Option extends PickerOption>(list: PickerList<Option>): readonly Option[] =>
  list.kind === 'options' ? list.options : NO_OPTIONS;

/**
 * Why the rows on screen may be out of date, or `undefined` when nothing says
 * they are.
 *
 * Written as one accessor rather than read off each variant so a renderer cannot
 * remember the warning in the state it happened to think of first. `loading` and
 * `failed` answer `undefined` by construction: neither is displaying rows.
 */
export const pickerStaleReason = <Option extends PickerOption>(list: PickerList<Option>): string | undefined =>
  list.kind === 'loading' || list.kind === 'failed' ? undefined : list.staleReason;

/** Pickable unless the consumer said otherwise. Absent means pickable. */
export const pickerOptionEnabled = (option: PickerOption): boolean => option.disabled !== true;

/**
 * The next PICKABLE index in one direction, wrapping, or `null` when the list
 * offers nothing to land on.
 *
 * Wrapping is deliberate — a short list should return to the top rather than
 * stop dead — and disabled rows are stepped over rather than landed on and
 * refused, because a cursor that parks somewhere Enter will not act reads as a
 * broken control to a screen reader.
 *
 * `null` covers both an empty list and one whose every row is unavailable. The
 * caller must treat it as "this key does nothing", never as index zero.
 */
export const stepPickerIndex = (options: readonly PickerOption[], from: number, step: 1 | -1): number | null => {
  const count = options.length;
  if (count === 0) return null;
  for (let hop = 1; hop <= count; hop += 1) {
    // The double modulo is what makes a negative `from - hop` land back inside
    // the list rather than off the front of it.
    const index = (((from + hop * step) % count) + count) % count;
    const option = options[index];
    if (option !== undefined && pickerOptionEnabled(option)) return index;
  }
  return null;
};

/**
 * The active row, DERIVED and corrected rather than fixed up in an effect.
 *
 * A re-filter can shrink the list or disable the row under the cursor between
 * renders; an effect would commit one frame pointing `aria-activedescendant` at
 * a row that is gone or unpickable. `-1` means there is nothing to point at.
 */
export const clampPickerIndex = (options: readonly PickerOption[], active: number): number => {
  const option = options[active];
  if (option !== undefined && pickerOptionEnabled(option)) return active;
  return stepPickerIndex(options, -1, 1) ?? -1;
};

/** What one key press does. `ignore` means leave the event entirely alone. */
export type PickerAction =
  | { readonly kind: 'ignore' }
  /** Reveal the list and land on this row in one press. */
  | { readonly kind: 'open'; readonly index: number }
  | { readonly kind: 'move'; readonly index: number }
  | { readonly kind: 'accept'; readonly index: number }
  | { readonly kind: 'close' };

export interface PickerKeyState {
  readonly open: boolean;
  /** The FILTERED rows, exactly as rendered. */
  readonly options: readonly PickerOption[];
  /** Already clamped by `clampPickerIndex`; `-1` when nothing is pickable. */
  readonly activeIndex: number;
  /** An IME candidate window owns the arrow keys while it is up. */
  readonly composing: boolean;
}

const IGNORE: PickerAction = { kind: 'ignore' };

/**
 * Where a navigation key starts from, and which way it walks.
 *
 * The closed cases are what make one press do the useful thing: ArrowDown on a
 * closed list starts before the first row and therefore reveals the list AT the
 * first row, and ArrowUp starts past the last one. Home and End name absolute
 * ends and so read the same whether the list was showing or not.
 *
 * `null` means this key is not navigation at all.
 */
const pickerNavigation = (
  key: string,
  state: PickerKeyState,
): { readonly from: number; readonly step: 1 | -1 } | null => {
  switch (key) {
    case 'ArrowDown':
      return { from: state.open ? state.activeIndex : -1, step: 1 };
    case 'ArrowUp':
      return { from: state.open ? state.activeIndex : state.options.length, step: -1 };
    case 'Home':
      return { from: -1, step: 1 };
    case 'End':
      return { from: state.options.length, step: -1 };
    default:
      return null;
  }
};

/**
 * The whole keyboard contract, as one total function.
 *
 * Enter is the interesting refusal. It commits a row only when the list is open
 * AND the cursor is on a pickable one; otherwise it is ignored, which leaves the
 * key to the surrounding form. That is the typed-value rule in keyboard form: a
 * person who typed a wrapper this catalogue has never heard of presses Enter and
 * submits exactly what they typed, rather than having a nearby suggestion
 * substituted for it.
 */
export const pickerKeyAction = (key: string, state: PickerKeyState): PickerAction => {
  if (state.composing) return IGNORE;
  if (key === 'Escape') return state.open ? { kind: 'close' } : IGNORE;
  if (key === 'Enter') {
    if (!state.open) return IGNORE;
    const option = state.options[state.activeIndex];
    return option !== undefined && pickerOptionEnabled(option) ? { kind: 'accept', index: state.activeIndex } : IGNORE;
  }
  const navigation = pickerNavigation(key, state);
  if (navigation === null) return IGNORE;
  const index = stepPickerIndex(state.options, navigation.from, navigation.step);
  if (index === null) return IGNORE;
  return state.open ? { kind: 'move', index } : { kind: 'open', index };
};

/**
 * What the live region says, one sentence per list state.
 *
 * Every failure sentence ends by naming the way out — typing — because the
 * control still works when its catalogue does not, and a reader who cannot see
 * the box has no other way to learn that.
 *
 * Exhaustive with no `default`: the day a sixth list state exists, this stops
 * compiling until somebody decides what it SAYS.
 */
export const pickerStatusLabel = <Option extends PickerOption>(list: PickerList<Option>): string => {
  // Staleness is spoken as well as shown. A reader who cannot see the warning
  // strip would otherwise hear a confident count of rows nobody has re-checked.
  const stale = pickerStaleReason(list) === undefined ? '' : ' These choices may be out of date.';
  switch (list.kind) {
    case 'loading':
      return 'Reading the available choices…';
    case 'failed':
      return 'The available choices could not be read. Type a value instead.';
    case 'empty':
      return `Nothing is published to choose from. Type a value instead.${stale}`;
    case 'no-match':
      return `Nothing matches ${list.query}. Type a value instead.${stale}`;
    case 'options':
      return `${list.options.length} choice${list.options.length === 1 ? '' : 's'} available.${stale}`;
  }
};

export interface PickerIds {
  readonly input: string;
  readonly listbox: string;
  readonly status: string;
}

/**
 * A base id safe to build element ids and `aria-*` references from.
 *
 * `useId()` answers with colons (`:r3:`), which are legal in an id attribute and
 * a menace everywhere else — they need escaping in a CSS selector, so the first
 * `querySelector` written against one throws. Stripping them here means the two
 * pickers on one page get distinct, plain ids and nobody downstream has to know
 * why.
 */
export const pickerIdBase = (generated: string): string => `fy-picker-${generated.replace(/[^a-zA-Z0-9_-]/gu, '')}`;

export const pickerIds = (base: string): PickerIds => ({
  input: base,
  listbox: `${base}-listbox`,
  status: `${base}-status`,
});

/**
 * One row's element id, BY POSITION rather than by value.
 *
 * A value-derived id would survive re-filtering, which sounds better — but the
 * values here are wrapper names and absolute paths, and any sanitiser that made
 * them id-safe could map two distinct values onto one id. Duplicate ids break
 * `aria-activedescendant` precisely for the readers who depend on it, whereas a
 * position is collision-free by construction and every row is re-rendered with
 * its id in the same pass anyway.
 */
export const pickerOptionId = (base: string, index: number): string => `${base}-option-${index}`;
