/**
 * THE COMMAND BAR — Cmd/Ctrl+K, one dialog, mounted once for the app's life. Copied from today's
 * `shell/command-palette.tsx`: the dialog, the combobox, the keyboard and pointer rules and the footer are today's;
 * the result kinds today's palette hard-coded (sessions, cards, agenda, settings) are gone, because what the bar
 * lists is contributed as {@link CommandBarSource}s (`command-bar-model.ts`) — the shell's own destinations and layout
 * commands now, plugins' entries later.
 *
 * Today's four cautions hold unchanged:
 *   CASING   — matching runs on raw lowercase fields (`palette-ranking.ts`); rendering shows the entry's own label.
 *   FOCUS    — `useDialogFocus` is the ONLY focus trap in this app and this file does not add a second one. It owns
 *              restore-to-opener, which returns you to whatever you were typing in when you hit Escape.
 *   COMBOBOX — the input keeps focus the whole time and points at the active row with `aria-activedescendant`, rather
 *              than moving focus row to row (moving focus breaks IMEs and screen-reader typing echo).
 *   COST WHEN CLOSED — closed, this renders `null` and asks no source for anything.
 */

import { ArrowDown, ArrowUp, CornerDownLeft, Search } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMAND_BAR_IDS,
  type CommandBarEntry,
  type CommandBarSource,
  clampActiveIndex,
  commandBarCountLabel,
  commandBarFocusPolicy,
  commandBarOptionId,
  commandBarResults,
  nextActiveIndex,
} from './command-bar-model.ts';
import { useDialogFocus } from './hooks/use-dialog-focus.ts';
import { useLayoutMode } from './hooks/use-layout-mode.ts';
import { paletteShortcutLabel } from './palette-shortcut.ts';

/** Deliberately slower than a keystroke: a fast typist should hear one settled count, not a stream. */
const ANNOUNCE_DEBOUNCE_MS = 300;

export interface CommandBarProps {
  readonly open: boolean;
  /**
   * Bumped every time the shortcut fires. Pressing it while the bar is already open puts you back in the query box
   * (and selects what is there) rather than doing nothing.
   */
  readonly focusSignal: number;
  readonly onClose: () => void;
  readonly sources: readonly CommandBarSource[];
  /** A touch-first reader: the box is not focused on open, so no keyboard covers the results. */
  readonly touchAffected?: boolean;
  readonly placeholder?: string;
}

export function CommandBar({
  open,
  focusSignal,
  onClose,
  sources,
  touchAffected = false,
  placeholder = 'Search places and commands…',
}: CommandBarProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const layout = useLayoutMode();

  // Modality is latched for one opening so a convertible changing pointer mode cannot re-run the dialog focus
  // effect or summon a keyboard mid-use.
  const latchedTouch = useRef(touchAffected);
  if (!open) latchedTouch.current = touchAffected;
  const focusPolicy = commandBarFocusPolicy(latchedTouch.current);

  const { onKeyDown: trapKeyDown } = useDialogFocus(open, panelRef, onClose, {
    autoFocus: focusPolicy.dialogAutoFocus,
  });

  const found = useMemo(
    () => (open ? commandBarResults(sources, query) : { groups: [], results: [] }),
    [open, sources, query],
  );
  const activeIndex = clampActiveIndex(active, found.results.length);
  const activeEntry = activeIndex >= 0 ? found.results[activeIndex] : undefined;

  // Opening (or re-pressing the shortcut) puts the caret in the box and selects what is there. The signal already
  // served is remembered so a re-render while open never re-selects the query under a reader mid-edit.
  const focusedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !focusPolicy.inputAutoFocus) {
      focusedFor.current = null;
      return;
    }
    if (focusedFor.current === focusSignal) return;
    const input = inputRef.current;
    if (!input) return;
    focusedFor.current = focusSignal;
    input.focus();
    input.select();
  }, [open, focusSignal, focusPolicy.inputAutoFocus]);

  // Closing resets the query so the next shortcut opens at rest rather than on a stale search.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setActive(0);
    setAnnouncement('');
  }, [open]);

  useEffect(() => {
    if (!open || !activeEntry) return;
    document.getElementById(commandBarOptionId(activeEntry))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeEntry]);

  const resultCount = found.results.length;
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setAnnouncement(commandBarCountLabel(resultCount)), ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, resultCount]);

  const run = useCallback(
    (entry: CommandBarEntry) => {
      onClose();
      entry.run();
    },
    [onClose],
  );

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // An IME candidate window owns the arrow keys while it is up.
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        if (!activeEntry) return;
        event.preventDefault();
        run(activeEntry);
        return;
      }
      const next = nextActiveIndex(active, found.results.length, event.key);
      if (next === null) return;
      event.preventDefault();
      setActive(next);
    },
    [active, activeEntry, found.results.length, run],
  );

  // Hooks above, early return below: `useDialogFocus`'s restore-to-opener runs only if it is called every render.
  if (!open) return null;

  const trimmed = query.trim();

  return (
    <div className="kt-overlay fixed inset-x-0 z-50 flex justify-center px-3 pt-[12vh]">
      {/* Scrim. A real button, so a click and a keyboard activation dismiss the same way. */}
      <button
        type="button"
        aria-label="Close the command bar"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-scrim"
      />
      <div
        id={COMMAND_BAR_IDS.panel}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        onKeyDown={trapKeyDown}
        className="kt-panel relative z-10 flex w-[min(560px,92vw)] min-h-0 flex-col font-ui"
        style={{ maxHeight: 'min(60vh, calc(var(--app-h, 100dvh) - 14vh))' }}
      >
        <div className="flex shrink-0 items-center gap-sm border-b border-border-soft px-panel py-row-y">
          <Search size={14} className="shrink-0 text-faint" aria-hidden="true" />
          <input
            id={COMMAND_BAR_IDS.input}
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={COMMAND_BAR_IDS.listbox}
            aria-activedescendant={activeEntry ? commandBarOptionId(activeEntry) : undefined}
            aria-autocomplete="list"
            aria-label="Search places and commands"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              // A new query is a new list; start at the top of it.
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder={placeholder}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-ui text-ui text-fg outline-none placeholder:text-faint"
          />
        </div>

        {/* The bar's OWN scroller; an overlay that never nests inside the page's. */}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-xs py-xs">
          <div id={COMMAND_BAR_IDS.listbox} role="listbox" aria-label="Results">
            {found.groups.map(group => {
              const headingId = `${COMMAND_BAR_IDS.listbox}-group-${group.offset}`;
              return (
                <fieldset key={group.heading} className="m-0 min-w-0 border-0 p-0" aria-labelledby={headingId}>
                  <div id={headingId} className="kt-label px-cell-x pb-xs pt-xs">
                    {group.heading}
                  </div>
                  {group.entries.map((entry, index) => {
                    const resultIndex = group.offset + index;
                    return (
                      <CommandBarOption
                        key={entry.id}
                        id={commandBarOptionId(entry)}
                        selected={resultIndex === activeIndex}
                        onActivate={() => run(entry)}
                        onHover={() => setActive(resultIndex)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="font-semibold text-fg">{entry.label}</span>
                          {entry.description === undefined ? null : (
                            <span className="truncate text-meta text-muted">{entry.description}</span>
                          )}
                        </span>
                      </CommandBarOption>
                    );
                  })}
                </fieldset>
              );
            })}
          </div>
          {trimmed !== '' && found.results.length === 0 && (
            <p className="m-0 px-cell-x py-row-y text-cell text-muted">
              Nothing matches <span className="mono text-fg-soft">{trimmed}</span>.
            </p>
          )}
        </div>

        {/* Key hints are for a keyboard: a phone opened this with a tap and has no ↑↓, ↵ or esc. */}
        {latchedTouch.current && layout === 'drawer' ? null : <Footer />}

        {/* Spoken, never shown. `sr-only` and not `hidden`, which would take it out of the accessibility tree. */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </div>
    </div>
  );
}

/**
 * One row of the listbox. ACTIVATION IS POINTER-UP, NOT CLICK, and pointer-DOWN calls `preventDefault()`: that keeps
 * the caret in the query box while a reader clicks a row, and a press that slides off a row does not fire.
 * `tabIndex={-1}` for the same reason: an option is pointed AT by `aria-activedescendant`, never focused.
 */
function CommandBarOption({
  id,
  selected,
  onActivate,
  onHover,
  children,
}: {
  readonly id: string;
  readonly selected: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
  readonly children: ReactNode;
}) {
  const pointer = useRef<number | null>(null);
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-active={selected ? 'true' : undefined}
      onPointerDown={event => {
        pointer.current = event.pointerId;
        event.preventDefault();
      }}
      onPointerUp={event => {
        if (pointer.current === event.pointerId) onActivate();
        pointer.current = null;
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      onPointerMove={onHover}
      className="kt-navrow min-h-[44px] cursor-pointer items-start"
    >
      {children}
    </div>
  );
}

function Footer() {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-sm border-t border-border-soft px-panel py-row-y text-meta text-muted">
      <span className="inline-flex items-center gap-xs">
        <ArrowUp size={11} aria-hidden="true" />
        <ArrowDown size={11} aria-hidden="true" />
        move
      </span>
      <span className="inline-flex items-center gap-xs">
        <CornerDownLeft size={11} aria-hidden="true" />
        open
      </span>
      <span className="inline-flex items-center gap-xs">
        <span className="mono">esc</span>
        close
      </span>
      <span className="ml-auto text-faint">{`${paletteShortcutLabel()} from anywhere`}</span>
    </div>
  );
}
