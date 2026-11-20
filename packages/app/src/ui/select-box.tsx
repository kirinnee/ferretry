/**
 * THE SELECT BOX: a drop-in for the browser's own select element, drawn by the app, so every theme styles it and a phone is not handed the
 * browser's wheel. One value (a string), a list of options, and a label that is required: a visible `<label htmlFor>` should
 * carry the same words as `label` (the picker's rule), and `label` is what the dialog is titled.
 *
 *   A MOUSE      a button with the chosen option and a chevron. It opens a popover listbox under the button (flipped above
 *                it when the room below is short), with a search field on top once the list is long (`searchable="auto"`:
 *                more than 7 options). The popover is drawn in `document.body`, so no card's `overflow` clips it.
 *   A PHONE      (a container under 600px, or a coarse primary pointer) the same panel in a centred `Dialog`: search focused,
 *                the list scrolling inside it, a Cancel button, the page behind inert. "Container" is the button's nearest
 *                ancestor that is a CSS container (`container-type`), else the window, so a narrow pane in a wide window
 *                gets the dialog too.
 *
 * The keyboard is ARIA 1.2's combobox over a listbox: the button is the one tab stop; opening moves the focus to the search
 * field (or to the list when there is none) and the cursor travels by `aria-activedescendant`, never by moving focus row to
 * row. ↑/↓ move, Home/End jump (with an empty search), Enter picks, Escape closes and gives the focus back, Tab closes.
 * A letter typed on a list with no search field jumps to the next option that starts with it.
 *
 * NEVER FOR A SECRET: the search text is local state, never stored or sent (secrets stay `SecretInput`). Picking the value
 * that is already chosen closes the box without calling `onChange`, as a native select does.
 */
import { Check, ChevronDown, Search, SearchX } from 'lucide-react';
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from './dialog.tsx';
import { useDialogFocus } from './hooks/use-dialog-focus.ts';
import { cn } from './lib/class-names.ts';
import { placePopover } from './lib/popover-placement.ts';
import {
  filterOptions,
  firstEnabled,
  isSearchable,
  lastEnabled,
  type SelectOption,
  type Searchable,
  sectionOptions,
  startCursor,
  stepCursor,
  typeahead,
} from './select-box-model.ts';

export type { SelectOption, Searchable } from './select-box-model.ts';

export interface SelectBoxProps {
  /** The control's accessible name and the dialog's title. Required: a select with no name is unusable by a screen reader. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /** The button's element id, so a visible `<label htmlFor>` points at it. */
  readonly id?: string;
  /** What the button says when `value` is none of the options. */
  readonly placeholder?: string;
  readonly searchable?: Searchable;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly 'aria-describedby'?: string;
}

/** A container narrower than this (the window when the button sits in none), or a coarse primary pointer, gets the centred dialog. */
const DIALOG_WIDTH = 600;
const DIALOG_QUERY = `(max-width: ${DIALOG_WIDTH - 0.02}px), (pointer: coarse)`;
/** The tallest the popover grows before its list scrolls. */
const POPOVER_MAX_HEIGHT = 320;
const POPOVER_MIN_WIDTH = 220;
const EDGE = 8;
const GAP = 4;

const subscribeDialogMode = (notify: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DIALOG_QUERY);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const readDialogMode = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DIALOG_QUERY).matches;

/** The nearest ancestor that is a CSS container (`container-type` other than `normal`), or null. */
const containerOf = (element: HTMLElement): HTMLElement | null => {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const type = getComputedStyle(at).containerType;
    if (type !== '' && type !== 'normal') return at;
  }
  return null;
};

/** Whether the button sits in a container narrower than the dialog threshold, kept live as the container resizes. */
const useNarrowContainer = (anchor: { readonly current: HTMLElement | null }): boolean => {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const button = anchor.current;
    if (button === null) return;
    const container = containerOf(button);
    if (container === null) return setNarrow(false);
    const measure = (): void => setNarrow(container.getBoundingClientRect().width < DIALOG_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [anchor]);
  return narrow;
};

/** Whether a pick is shown in a centred dialog (a phone, a narrow pane) rather than a popover (a mouse). */
const useDialogMode = (anchor: { readonly current: HTMLElement | null }): boolean => {
  const byWindow = useSyncExternalStore(subscribeDialogMode, readDialogMode, () => false);
  return useNarrowContainer(anchor) || byWindow;
};

interface PanelProps {
  /** The listbox element's id, which the button's `aria-controls` names. */
  readonly listId: string;
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly value: string;
  readonly search: boolean;
  /** Text the search field opens with (a letter typed on the closed button). */
  readonly seed: string;
  readonly onPick: (value: string) => void;
  /** Tab leaves the list: the popover closes on it, the dialog traps it instead. */
  readonly onTab?: () => void;
}

/** The search field and the listbox, the same in the popover and in the dialog. */
function SelectPanel({ listId, label, options, value, search, seed, onPick, onTab }: PanelProps) {
  const optionId = (index: number): string => `${listId}-o${index}`;
  const [query, setQuery] = useState(seed);
  const visible = useMemo(() => filterOptions(options, query), [options, query]);
  const [cursor, setCursor] = useState(() =>
    seed === '' ? startCursor(options, value) : firstEnabled(filterOptions(options, seed)),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // A passive effect on purpose: it runs after the container's own layout-effect focus, so the field wins.
  useEffect(() => {
    const field = search ? inputRef.current : listRef.current;
    field?.focus({ preventScroll: true });
    if (search && inputRef.current !== null) inputRef.current.setSelectionRange(seed.length, seed.length);
  }, [search, seed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a narrower list moves the row under the cursor, so `visible` is a trigger; `optionId` is derived from `listId` alone
  useEffect(() => {
    if (cursor >= 0) document.getElementById(optionId(cursor))?.scrollIntoView({ block: 'nearest' });
  }, [cursor, visible, listId]);

  const pick = (index: number): void => {
    const option = visible[index];
    if (option !== undefined && option.disabled !== true) onPick(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const listKeys = !search || query === '';
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor(at => (at === -1 ? firstEnabled(visible) : stepCursor(visible, at, 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor(at => (at === -1 ? lastEnabled(visible) : stepCursor(visible, at, -1)));
    } else if (event.key === 'Home' && listKeys) {
      event.preventDefault();
      setCursor(firstEnabled(visible));
    } else if (event.key === 'End' && listKeys) {
      event.preventDefault();
      setCursor(lastEnabled(visible));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(cursor);
    } else if (event.key === 'Tab') onTab?.();
    else if (!search && event.key === ' ') {
      event.preventDefault();
      pick(cursor);
    } else if (!search && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      setCursor(at => typeahead(visible, at, event.key));
    }
  };

  const hasResults = visible.length > 0;
  const activeId = hasResults && cursor >= 0 ? optionId(cursor) : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys belong to the focused search field or listbox inside; this wrapper only hears them bubble
    <div className="fy-sb__panel" onKeyDown={onKeyDown}>
      {search ? (
        <div className="fy-sb__search">
          <Search aria-hidden="true" className="fy-sb__search-icon" size={16} />
          <input
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-label={`Search ${label}`}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="fy-sb__input"
            enterKeyHint="search"
            onChange={event => {
              const next = event.target.value;
              setQuery(next);
              const left = filterOptions(options, next);
              setCursor(next === '' ? startCursor(left, value) : firstEnabled(left));
            }}
            placeholder="Search…"
            ref={inputRef}
            spellCheck={false}
            type="search"
            value={query}
          />
        </div>
      ) : null}
      {hasResults ? (
        <div
          aria-activedescendant={search ? undefined : activeId}
          aria-label={label}
          className="fy-sb__list"
          id={listId}
          // Keeps the focus where it is (the search field) when a row is pressed; the pick itself is the click.
          onMouseDown={event => event.preventDefault()}
          ref={listRef}
          role="listbox"
          tabIndex={search ? undefined : -1}
        >
          {sectionOptions(visible).map(section => {
            const sectionKey = section.items[0]?.option.value ?? '';
            const rows = section.items.map(({ option, index }) => (
              // biome-ignore lint/a11y/useFocusableInteractive: the cursor travels by aria-activedescendant; focus stays on the search field or the listbox
              // biome-ignore lint/a11y/useKeyWithClickEvents: the panel handles every key (Enter picks the cursor row); a click is the pointer's way to the same pick
              <div
                aria-disabled={option.disabled === true ? true : undefined}
                aria-selected={option.value === value}
                className="fy-sb__opt"
                data-active={index === cursor ? 'true' : undefined}
                id={optionId(index)}
                key={option.value}
                onClick={() => pick(index)}
                onMouseMove={() => {
                  if (option.disabled !== true && index !== cursor) setCursor(index);
                }}
                role="option"
              >
                {option.icon === undefined ? null : <span className="fy-sb__icon">{option.icon}</span>}
                <span className="fy-sb__text">
                  <span className="fy-sb__label" data-label="">
                    {option.label}
                  </span>
                  {option.hint === undefined ? null : <span className="fy-sb__hint">{option.hint}</span>}
                </span>
                {option.value === value ? <Check aria-hidden="true" className="fy-sb__check" size={16} /> : null}
              </div>
            ));
            return section.heading === undefined ? (
              <Fragment key={sectionKey}>{rows}</Fragment>
            ) : (
              // biome-ignore lint/a11y/useSemanticElements: a fieldset is not valid inside a listbox; the group role is the ARIA way to head a run of options
              <div aria-label={section.heading} key={sectionKey} role="group">
                <div aria-hidden="true" className="fy-sb__heading">
                  {section.heading}
                </div>
                {rows}
              </div>
            );
          })}
        </div>
      ) : (
        // The empty filter removes the listbox, so the result region takes its id: the open button's `aria-controls` (which a combobox
        // must carry while expanded) always names an element that exists.
        <div className="fy-sb__empty" data-select-empty="" id={listId} role="status">
          <SearchX aria-hidden="true" size={16} />
          <span>No match for “{query}”</span>
        </div>
      )}
    </div>
  );
}

interface PopoverProps {
  readonly anchor: HTMLElement;
  /** Escape, a pick or Tab: the focus goes back to the button. */
  readonly onClose: () => void;
  /** A click elsewhere: the focus stays where the click put it. */
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}

interface Place {
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly top?: number;
  readonly bottom?: number;
}

/** The panel in a popover under (or above) its button, held inside the window and following it on scroll and resize. */
function SelectPopover({ anchor, onClose, onDismiss, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  useDialogFocus(true, ref, onClose, { autoFocus: false });

  useLayoutEffect(() => {
    const measure = (): void => {
      const element = ref.current;
      if (element === null) return;
      const box = anchor.getBoundingClientRect();
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      const width = Math.min(Math.max(box.width, POPOVER_MIN_WIDTH), viewport.width - 2 * EDGE);
      // Its natural height, at the widest it may grow: set, read, and let React apply the placement before the paint.
      element.style.width = `${width}px`;
      element.style.maxHeight = `${POPOVER_MAX_HEIGHT}px`;
      const natural = element.getBoundingClientRect().height;
      const spot = placePopover(
        { left: box.left, right: box.left + width, top: box.top, bottom: box.bottom },
        { width, height: natural },
        viewport,
        EDGE,
        GAP,
      );
      const above = spot.top < box.top;
      setPlace({
        left: spot.left,
        width,
        maxHeight: spot.maxHeight,
        ...(above ? { bottom: viewport.height - (spot.top + spot.maxHeight) } : { top: spot.top }),
      });
    };
    measure();
    const onScroll = (event: Event): void => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target) === true)) measure();
    };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (ref.current?.contains(event.target) === true || anchor.contains(event.target)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor, onDismiss]);

  const style: CSSProperties =
    place === null
      ? { left: 0, top: -9_999 }
      : { left: place.left, width: place.width, maxHeight: place.maxHeight, top: place.top, bottom: place.bottom };
  return createPortal(
    <div className="kt-popover fy-sb__popover z-[60]" data-select-popover="" ref={ref} style={style}>
      {children}
    </div>,
    document.body,
  );
}

export function SelectBox({
  label,
  value,
  onChange,
  options,
  id,
  placeholder = 'Choose…',
  searchable = 'auto',
  disabled = false,
  className,
  'aria-describedby': describedBy,
}: SelectBoxProps) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState('');
  const asDialog = useDialogMode(triggerRef);
  const giveFocusBack = useRef(false);
  const search = isSearchable(searchable, options.length);
  const chosen = options.find(option => option.value === value);

  // After the commit that closes it (when the dialog's page is no longer inert): the focus returns to the button.
  useEffect(() => {
    if (open || !giveFocusBack.current) return;
    giveFocusBack.current = false;
    triggerRef.current?.focus({ preventScroll: true });
  }, [open]);

  const openWith = (text: string): void => {
    if (disabled) return;
    setSeed(text);
    setOpen(true);
  };
  const close = (restoreFocus: boolean): void => {
    giveFocusBack.current = restoreFocus;
    setOpen(false);
  };
  const pick = (next: string): void => {
    close(true);
    if (next !== value) onChange(next);
  };
  const panel = (
    <SelectPanel
      label={label}
      listId={listId}
      onPick={pick}
      onTab={asDialog ? undefined : () => close(true)}
      options={options}
      search={search}
      seed={seed}
      value={value}
    />
  );

  return (
    <>
      <button
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className={cn('kt-input fy-sb__trigger', className)}
        data-select-box=""
        disabled={disabled}
        id={id}
        onClick={() => (open ? close(true) : openWith(''))}
        onKeyDown={event => {
          if (open || disabled) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openWith('');
          } else if (
            search &&
            event.key.length === 1 &&
            event.key !== ' ' &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();
            openWith(event.key);
          }
        }}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="fy-sb__value" data-placeholder={chosen === undefined ? '' : undefined}>
          {chosen?.label ?? placeholder}
        </span>
        <ChevronDown aria-hidden="true" className="fy-sb__chev" size={16} />
      </button>
      {open && asDialog ? (
        <Dialog
          footer={
            <button className="kt-btn" onClick={() => close(true)} type="button">
              Cancel
            </button>
          }
          onClose={() => close(true)}
          open
          scroller="content"
          title={label}
          width="28rem"
          zIndexClass="z-[60]"
        >
          {panel}
        </Dialog>
      ) : null}
      {open && !asDialog && triggerRef.current !== null ? (
        <SelectPopover anchor={triggerRef.current} onClose={() => close(true)} onDismiss={() => close(false)}>
          {panel}
        </SelectPopover>
      ) : null}
    </>
  );
}
