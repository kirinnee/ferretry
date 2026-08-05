/**
 * THE PICKER — a text box that offers the host's own catalogue beside it.
 *
 * This is the control the daemon account and project fields both become. It is
 * deliberately NOT a select: the value it produces is whatever is in the text
 * box, and the list is an offer. Everything about the way it behaves follows
 * from that one decision.
 *
 *   TYPED VALUE WINS      There is no internal draft and no "selected option"
 *                         state. `value` in, `onValueChange` out; choosing a row
 *                         is just a fast way to type that row's literal string.
 *                         So a wrapper the last published manifest has never
 *                         heard of, or a path registered five seconds ago, can
 *                         still be submitted — and the daemon, which is the only
 *                         thing that actually knows, gets to accept or refuse it.
 *
 *   NEVER DISABLED        There is no `disabled` prop, and a failed catalogue
 *                         read does not take the box away. The one moment a
 *                         person MOST needs to type a value by hand is the
 *                         moment their host would not say what the valid ones
 *                         are; a control that locks itself then is worse than no
 *                         control.
 *
 *   FOCUS STAYS PUT       The input keeps focus for the control's whole life and
 *                         points at the active row with `aria-activedescendant`,
 *                         rather than moving focus row to row. Typing and
 *                         arrowing interleave constantly in a filter box, and
 *                         focus that keeps leaving the input is the pattern that
 *                         breaks IMEs and screen-reader typing echo. This is the
 *                         same contract `shell/command-palette.tsx` documents,
 *                         including its pointer-up activation trick, and for the
 *                         same reasons.
 *
 *   FIVE STATES, FIVE     Loading, failed, published-nothing, matched-nothing
 *   SENTENCES             and a real list are structurally distinct in
 *                         `picker-model.ts` and rendered separately here. A
 *                         failure never draws the same empty panel an honest
 *                         empty catalogue draws.
 *
 * IT KNOWS NO DOMAIN WORDS. Rows are rendered by the consumer through
 * `renderOption`, which is how an account row shows quota and health while a
 * project row shows provenance without either concept appearing in this file.
 * The default row is a label, a detail line and a reason — enough to be useful
 * on its own, and not a pattern anything is forced into.
 */

import { ChevronDown, LoaderCircle, SearchX, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/class-names.ts';
import {
  clampPickerIndex,
  type PickerIds,
  type PickerOption,
  type PickerSource,
  pickerIdBase,
  pickerIds,
  pickerKeyAction,
  pickerList,
  pickerListOptions,
  pickerOptionEnabled,
  pickerOptionId,
  pickerStaleReason,
  pickerStatusLabel,
} from './picker-model.ts';

export interface PickerComboboxProps<Option extends PickerOption> {
  /**
   * The control's accessible name, and the stem of the listbox's own name. A
   * consumer rendering its own visible `<label htmlFor>` should pass `id` and
   * the same words here, so the two cannot disagree.
   */
  readonly label: string;
  /** The typed value. This, not a selection, is what the surface submits. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** The host read, already adapted from whatever daemon-scoped slice owns it. */
  readonly source: PickerSource<Option>;
  /**
   * The input's element id. Supplied VERBATIM when given, because a caller that
   * passes one is pointing its own `<label htmlFor>` at it; generated and
   * sanitised otherwise, so two pickers on one page never collide.
   */
  readonly id?: string;
  readonly placeholder?: string;
  readonly describedBy?: string;
  readonly inputClassName?: string;
  /**
   * Row rendering, so quota, health or provenance stay out of this file.
   *
   * `active` is the keyboard cursor. `selected` is "this row's value is what is
   * currently in the box" — a different fact, and the one a row uses to draw a
   * tick: in a control whose text is the output, the committed answer is visible
   * in the input while the cursor is somewhere else entirely.
   */
  readonly renderOption?: (
    option: Option,
    state: { readonly active: boolean; readonly selected: boolean },
  ) => ReactNode;
  /**
   * Fired in addition to `onValueChange` when a row was CHOSEN rather than
   * typed. The one thing a consumer cannot recover from the value alone — an
   * account's default model, say — is which option object it came from.
   */
  readonly onSelect?: (option: Option) => void;
  /**
   * What a positively empty catalogue says. Domain-specific in a way this file
   * cannot guess: "this host publishes no accounts" and "no folders are
   * registered and none have been used" are different facts about different
   * things.
   */
  readonly emptyNotice?: string;
  /**
   * What a query that matched nothing says.
   *
   * An override replaces the whole sentence, INCLUDING the default's echo of the
   * query — which is safe because the live region's own wording is model-owned
   * and always names the query, so a reader who cannot see the strip still hears
   * what did not match.
   */
  readonly noMatchNotice?: string;
  /**
   * What a positively empty catalogue SAYS OUT LOUD, when that is narrower than
   * "nothing is published".
   *
   * The model's own sentence is the honest default for a host that publishes
   * nothing at all. It is wrong for a consumer that has FILTERED: a migration
   * offering only same-harness accounts on a host full of the other kind has an
   * empty list and a fleet that is not empty, and telling a screen-reader user
   * the daemon publishes nothing would be a claim about the host drawn from a
   * decision this control made. `emptyNotice` already fixes the visible half;
   * this is the spoken half, and they exist as a pair so the two channels cannot
   * disagree.
   */
  readonly emptyStatus?: string;
}

/** Shared panel chrome: the popover silhouette every state is drawn inside. */
const PANEL_CLASS =
  'absolute inset-x-0 top-[calc(100%+var(--gap-xs))] z-40 overflow-hidden rounded-panel border-panel border-border-strong bg-surface shadow-popover';

/** Shared notice chrome: one row's worth of height, so no state jumps the panel. */
const NOTICE_CLASS = 'flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta leading-base';

export function PickerCombobox<Option extends PickerOption>({
  label,
  value,
  onValueChange,
  source,
  id,
  placeholder,
  describedBy,
  inputClassName,
  renderOption = defaultPickerRow,
  onSelect,
  emptyNotice,
  noMatchNotice,
  emptyStatus,
}: PickerComboboxProps<Option>) {
  const generated = useId();
  const base = id ?? pickerIdBase(generated);
  const ids: PickerIds = pickerIds(base);
  /**
   * The popup itself, which is NOT the same element as the option list.
   *
   * `aria-expanded` says a popup is showing, so `aria-controls` has to name the
   * thing that is showing — and in four of the five states that thing is a notice
   * rather than a listbox. Pointing at the listbox id in those states would be a
   * reference to an element that is not in the document, which is worse than
   * silence: a reader is told to go somewhere that does not exist. So the panel
   * carries its own id and `aria-controls` names the panel, while
   * `aria-activedescendant` stays restricted to a real list of options.
   *
   * Derived here rather than added to `pickerIds`, which is a shared shape this
   * change has no business widening.
   */
  const panelId = `${base}-panel`;
  const [focused, setFocused] = useState(false);
  // Escape closes the list without closing the field. Held separately from
  // focus so dismissing does not eject the caret, and cleared by the next
  // keystroke — a person who carries on typing is asking to see matches again.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  const list = useMemo(() => pickerList(source, value), [source, value]);
  const options = pickerListOptions(list);
  const open = focused && !dismissed;
  const activeIndex = clampPickerIndex(options, active);
  const activeId = activeIndex >= 0 ? pickerOptionId(base, activeIndex) : undefined;
  // Only ever announced against a listbox that is really in the document:
  // `aria-controls` pointing at an absent id is a broken reference, and the four
  // notice states have no listbox at all.
  const listboxMounted = open && list.kind === 'options';
  const staleReason = pickerStaleReason(list);

  // Keep the active row inside the panel's own scroller. `block: 'nearest'`
  // moves this list and nothing else; the page below cannot scroll.
  useEffect(() => {
    if (activeId === undefined || !listboxMounted) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId, listboxMounted]);

  const accept = (option: Option): void => {
    onValueChange(option.value);
    onSelect?.(option);
    // Choosing is a completed answer, so the list gets out of the way. The
    // caret stays where it is: the next thing a person does is often edit the
    // value they just picked.
    setDismissed(true);
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const action = pickerKeyAction(event.key, {
      open,
      options,
      activeIndex,
      composing: event.nativeEvent.isComposing,
    });
    if (action.kind === 'ignore') return;
    event.preventDefault();
    if (action.kind === 'close') {
      setDismissed(true);
      return;
    }
    if (action.kind === 'accept') {
      const option = options[action.index];
      if (option !== undefined) accept(option);
      return;
    }
    // `open` and `move` differ only in whether the panel was already showing,
    // and clearing a dismissal that is not set costs nothing.
    setDismissed(false);
    setActive(action.index);
  };

  return (
    <div className="relative min-w-0">
      <input
        id={ids.input}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        // The panel whenever one is showing, in every state; the ACTIVE ROW only
        // when there is a real list to have a cursor in.
        aria-controls={open ? panelId : undefined}
        aria-activedescendant={listboxMounted ? activeId : undefined}
        aria-describedby={describedBy}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        // 44px is the touch floor for the whole control family; `.kt-input`
        // already sizes its text from `--text-input`, which cannot resolve below
        // 16px on a phone, so iOS never focus-zooms this field.
        className={cn('kt-input !min-h-[44px] w-full pr-9', inputClassName)}
        placeholder={placeholder}
        value={value}
        onChange={event => {
          onValueChange(event.target.value);
          // A new query is a new list; start at the top of it, and take back any
          // dismissal, because typing is a request to see what matches.
          setActive(0);
          setDismissed(false);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
      />
      {/* Decorative, and deliberately not a button: a second focusable thing
          inside a combobox is one more stop between a keyboard reader and the
          list, and the list already opens on focus and on ArrowDown. */}
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint"
        size={15}
      />

      {open ? (
        <div className={PANEL_CLASS} data-picker-state={list.kind} id={panelId}>
          {/* Above the rows, not instead of them. A refresh that failed over a
              read that had succeeded leaves usable rows AND a warning, and this
              is the strip that lets a surface show both rather than picking one.
              It is not an `alert`: the rows below are still worth using, and the
              live region already carries the same fact politely. */}
          {staleReason === undefined ? null : (
            <p
              className="m-0 flex items-start gap-sm border-b border-warn-border bg-warn-bg px-control-x py-1 text-2xs leading-base text-warn"
              data-picker-stale="true"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={13} />
              <span className="min-w-0">{staleReason}</span>
            </p>
          )}
          {list.kind === 'options' ? (
            <div
              className="max-h-[min(280px,max(88px,calc(var(--app-h,100dvh)*0.34)))] overflow-y-auto overscroll-contain scroll-thin [touch-action:pan-y]"
              id={ids.listbox}
              role="listbox"
              aria-label={`${label} choices`}
            >
              {list.options.map((option, index) => (
                <PickerRow
                  active={index === activeIndex}
                  id={pickerOptionId(base, index)}
                  key={option.value}
                  onActivate={() => accept(option)}
                  onHover={() => setActive(index)}
                  option={option}
                  render={renderOption}
                  // Compared verbatim, because the value was committed verbatim.
                  // Anything cleverer here would claim a row is the current
                  // answer when the daemon would read the two strings apart.
                  selected={option.value === value}
                />
              ))}
            </div>
          ) : list.kind === 'loading' ? (
            <p className={cn(NOTICE_CLASS, 'm-0 text-muted')}>
              <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" size={15} />
              Reading the available choices…
            </p>
          ) : list.kind === 'failed' ? (
            // The daemon's own words, kept whole. A read that failed is a
            // different panel from an empty one, and it says so in colour, in
            // its icon and in its text.
            <p className={cn(NOTICE_CLASS, 'm-0 items-start text-err')} role="alert">
              <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={15} />
              <span className="min-w-0">
                {list.reason}
                <span className="mt-0.5 block text-muted">This field still accepts a typed value.</span>
              </span>
            </p>
          ) : list.kind === 'empty' ? (
            <p className={cn(NOTICE_CLASS, 'm-0 text-muted')}>
              <SearchX aria-hidden="true" className="shrink-0" size={15} />
              {emptyNotice ?? 'Nothing is published to choose from.'}
            </p>
          ) : noMatchNotice === undefined ? (
            <p className={cn(NOTICE_CLASS, 'm-0 text-muted')}>
              <SearchX aria-hidden="true" className="shrink-0" size={15} />
              No match for <span className="mono text-fg-soft">{list.query}</span>. It is still submitted as typed.
            </p>
          ) : (
            <p className={cn(NOTICE_CLASS, 'm-0 text-muted')}>
              <SearchX aria-hidden="true" className="shrink-0" size={15} />
              {noMatchNotice}
            </p>
          )}
        </div>
      ) : null}

      {/* Spoken, never shown. `sr-only` rather than `hidden`, which would take it
          straight back out of the accessibility tree. Undebounced on purpose:
          the sentence is a settled count of the CURRENT list, `aria-live`
          already coalesces politely, and a timer here would be one more thing
          to leak on unmount. */}
      <span aria-atomic="true" aria-live="polite" className="sr-only" id={ids.status} role="status">
        {/* The model owns every sentence but one. A consumer that filtered its own
            options knows something this control cannot: that the empty list is a
            fact about the FILTER rather than about the host. `staleReason` is
            re-appended by hand so an override cannot silently drop the warning the
            model would have carried. */}
        {list.kind === 'empty' && emptyStatus !== undefined
          ? `${emptyStatus}${pickerStaleReason(list) === undefined ? '' : ' These choices may be out of date.'}`
          : pickerStatusLabel(list)}
      </span>
    </div>
  );
}

/**
 * One row, and the pointer contract every row owes the combobox.
 *
 * ACTIVATION IS POINTER-UP, AND POINTER-DOWN CALLS `preventDefault()`. That is
 * what keeps the caret in the text box while somebody clicks a row: a default
 * pointer-down would move focus to the row, the input would blur, and the panel
 * would close under the finger before the tap completed. It also means a press
 * that slides off a row never fires, because the pointer id has to match the one
 * that went down.
 *
 * `tabIndex={-1}` for the same reason: a row is pointed AT by
 * `aria-activedescendant`, never focused.
 *
 * A disabled row keeps all of it except the activation. It still reports
 * `aria-disabled`, still renders its reason, and still swallows pointer-down —
 * so tapping an unavailable account does nothing at all rather than quietly
 * closing the panel.
 */
function PickerRow<Option extends PickerOption>({
  active,
  id,
  onActivate,
  onHover,
  option,
  render,
  selected,
}: {
  readonly active: boolean;
  readonly id: string;
  readonly onActivate: () => void;
  readonly onHover: () => void;
  readonly option: Option;
  readonly render: (option: Option, state: { readonly active: boolean; readonly selected: boolean }) => ReactNode;
  readonly selected: boolean;
}) {
  const pointer = useRef<number | null>(null);
  const enabled = pickerOptionEnabled(option);
  return (
    <div
      aria-disabled={enabled ? undefined : true}
      aria-selected={active}
      className={cn(
        'flex min-h-[44px] w-full select-none items-start gap-sm border-l-[3px] border-l-transparent px-control-x py-row-y text-left text-cell outline-none',
        enabled ? 'cursor-pointer text-fg hover:bg-surface-2' : 'cursor-not-allowed text-muted',
        active && 'border-l-accent bg-accent-soft shadow-active',
      )}
      data-active={active ? 'true' : undefined}
      // Distinct from `aria-selected`, which ARIA reserves for the cursor in a
      // combobox listbox. This one says "the box already holds this value", so a
      // theme can mark the committed row without lying to a screen reader about
      // where the cursor is.
      data-current={selected ? 'true' : undefined}
      id={id}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      onPointerDown={event => {
        pointer.current = event.pointerId;
        event.preventDefault();
      }}
      onPointerMove={onHover}
      onPointerUp={event => {
        if (pointer.current === event.pointerId && enabled) onActivate();
        pointer.current = null;
      }}
      role="option"
      tabIndex={-1}
    >
      {render(option, { active, selected })}
    </div>
  );
}

/**
 * The row a consumer gets for free: the label, an optional detail line, and the
 * reason an unavailable row is unavailable.
 *
 * Exported because it is also the thing a custom renderer wraps — a consumer
 * that wants the standard two lines PLUS a quota badge should compose this
 * rather than restate it.
 */
export function defaultPickerRow(option: PickerOption): ReactNode {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="mono truncate font-medium text-current">{option.label}</span>
      {option.detail === undefined ? null : <span className="truncate text-meta text-muted">{option.detail}</span>}
      {option.disabledReason === undefined ? null : (
        <span className="truncate text-meta text-warn">{option.disabledReason}</span>
      )}
    </span>
  );
}
