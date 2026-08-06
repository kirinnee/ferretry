/**
 * THE COMMAND PALETTE — Cmd/Ctrl+K, one dialog, mounted once for the app's life.
 * Ported from kteam `ui/src/components/CommandPalette.tsx`.
 *
 * Destinations, commands, settings and sessions share this one search surface.
 * Destinations come from the top bar's own `APP_BAR_DESTINATIONS` through
 * `palette-destinations.ts`, so a destination added to the bar is searchable
 * here with no edit in this file — and every one of them is route-guarded there,
 * so nothing is offered that the router would quietly resolve to somewhere else.
 *
 * On a phone this dialog is the primary navigation surface: the bar has one
 * icon-sized opener and no room for a tab strip.
 *
 * Four things this file is careful about:
 *
 *   CASING       — matching runs on RAW lowercase fields (`palette-ranking.ts`
 *                  owns the scoring), rendering runs through `displayCallsign`.
 *                  The two must never be the same string; see `lib/callsign.ts`.
 *   FOCUS        — `useDialogFocus` is the ONLY focus trap in this app and this
 *                  file does not add a second one. It also owns
 *                  restore-to-opener, which is what returns you to the composer
 *                  you were typing in when you hit Escape.
 *   COMBOBOX     — the input keeps focus the whole time and points at the active
 *                  row with `aria-activedescendant`, rather than moving focus
 *                  row to row. Typing and arrowing interleave constantly here;
 *                  focus that keeps jumping out of the input is the pattern that
 *                  breaks IMEs and screen-reader typing echo.
 *   COST WHEN    — closed, this renders `null` and touches none of its inputs,
 *   CLOSED         so a globally-mounted palette costs the page nothing.
 *
 * TWO DEPARTURES FROM KTEAM, both forced by this app's shape:
 *
 * 1. ONE DAEMON'S PALETTE. kteam read the fleet from a module singleton and
 *    navigated to bare paths. Here the daemon, its sessions and the navigation
 *    callback are all props, so the palette of one daemon can neither list nor
 *    navigate into another's surfaces.
 * 2. COMMANDS AND SETTINGS ARE INJECTED. kteam hard-coded its one command
 *    (browser login) and imported the settings catalog directly. Both are props
 *    here: the shell's chrome should not be the second place that decides what
 *    the app can do. Settings arrive through the catalog's query function, not
 *    a second list this component searches under a weaker rule.
 */

import {
  ArrowDown,
  ArrowUp,
  Compass,
  CornerDownLeft,
  KeyRound,
  type LucideIcon,
  Plus,
  Search,
  Settings,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { useLayoutMode } from '../hooks/use-layout-mode.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import { APP_BAR_DESTINATIONS } from './app-bar.tsx';
import type { AppBarDestinationLike, DestinationPaletteEntry } from './palette-destinations.ts';
import {
  clampActiveIndex,
  nextActiveIndex,
  PALETTE_IDS,
  type PaletteCommand,
  type PaletteResult,
  type PaletteSession,
  type PaletteSettingsEntry,
  paletteCountLabel,
  paletteFocusPolicy,
  paletteGroupHeading,
  paletteResultId,
  paletteResults,
  paletteSettingHref,
} from './palette-model.ts';
import { paletteShortcutLabel } from './palette-shortcut.ts';
import { StatusMark } from './status-mark.tsx';

/**
 * Deliberately slower than the keystroke that changes the result set: a fast
 * typist should hear one settled count, not a stream of intermediate ones.
 */
const ANNOUNCE_DEBOUNCE_MS = 300;

/** Stable identities so an omitted prop does not re-derive the result list on
 *  every render. */
const NO_COMMANDS: readonly PaletteCommand[] = [];
const NO_SETTINGS = (): readonly PaletteSettingsEntry[] => [];

/** A top-bar destination that may also carry the mark the bar draws for it. */
export interface PaletteDestinationSource extends AppBarDestinationLike {
  readonly Icon?: LucideIcon;
}

/** One settings owner answers the whole search question for this daemon. */
export type PaletteSettingsSource = (daemon: DaemonId, query: string) => readonly PaletteSettingsEntry[];

/**
 * Icons come from the bar for its own destinations, so the same page is not
 * drawn with two different marks in two places.
 */
const destinationIcon = (id: string, destinations: readonly PaletteDestinationSource[]): LucideIcon => {
  const barIcon = destinations.find(destination => `destination-${destination.id}` === id)?.Icon;
  if (barIcon) return barIcon;
  return id === 'destination-new-session' ? Plus : Compass;
};

export interface CommandPaletteProps {
  readonly open: boolean;
  /**
   * Bumped every time the shortcut fires. Pressing the shortcut while the
   * palette is already open must put you back in the query box (and select what
   * is there) rather than doing nothing — a re-press is a reader saying "I meant
   * this".
   */
  readonly focusSignal: number;
  readonly onClose: () => void;
  /** The daemon whose sessions and settings this palette is searching. */
  readonly daemon: DaemonId;
  /** That daemon's fleet, already flattened by `paletteSessionEntries`. */
  readonly sessions: readonly PaletteSession[];
  readonly onNavigate: (href: string) => void;
  /**
   * Opens a settings section in place. Supplied only by a host that has a
   * settings drawer; without it a section row navigates to its anchor on every
   * layout.
   */
  readonly onOpenSetting?: (settingId: string) => void;
  readonly commands?: readonly PaletteCommand[];
  readonly settings?: PaletteSettingsSource;
  readonly destinations?: readonly PaletteDestinationSource[];
  /**
   * True when the reader is on touch. Their palette gets the dialog focused
   * rather than the text box: autofocusing an input on a phone summons the
   * on-screen keyboard over the results they opened the palette to read.
   */
  readonly touchAffected?: boolean;
  /** False on a session route, where Cmd/Ctrl+K belongs to file/task search. */
  readonly shortcutAvailable?: boolean;
}

export function CommandPalette({
  open,
  focusSignal,
  onClose,
  daemon,
  sessions,
  onNavigate,
  onOpenSetting,
  commands = NO_COMMANDS,
  settings = NO_SETTINGS,
  destinations = APP_BAR_DESTINATIONS,
  touchAffected = false,
  shortcutAvailable = true,
}: CommandPaletteProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const layout = useLayoutMode();

  // Modality is latched for one opening so a convertible changing pointer mode
  // cannot re-run the dialog focus effect or summon a keyboard mid-use.
  const latchedTouch = useRef(touchAffected);
  if (!open) latchedTouch.current = touchAffected;
  const focusPolicy = paletteFocusPolicy(latchedTouch.current);

  // Escape, the Tab trap and restore-to-opener. `autoFocus` is false for a
  // keyboard reader because the container is not where focus belongs — the query
  // input is, and the effect below moves it there.
  const { onKeyDown: trapKeyDown } = useDialogFocus(open, panelRef, onClose, {
    autoFocus: focusPolicy.dialogAutoFocus,
  });

  const matchedSettings = useMemo(() => settings(daemon, query), [daemon, query, settings]);
  const groups = useMemo(
    () => paletteResults({ query, daemon, sessions, destinations, commands, settings: matchedSettings }),
    [query, daemon, sessions, destinations, commands, matchedSettings],
  );
  const activeIndex = clampActiveIndex(active, groups.results.length);
  const activeEntry = activeIndex >= 0 ? groups.results[activeIndex] : undefined;

  // Opening (or re-pressing the shortcut) puts the caret in the box and selects
  // whatever is already there, so the next keystroke replaces it.
  //
  // The signal already served is remembered so this only ever fires for a NEW
  // press. Without that, any re-render while the palette is open — a streaming
  // fleet is enough — would re-select the query under a reader mid-edit.
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

  // Closing resets the query so the next shortcut opens on the recents rather
  // than on a stale search. Kept out of the open-effect so it cannot fight the
  // caret.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setActive(0);
    setAnnouncement('');
  }, [open]);

  // Keep the active row in the scroller. `block: 'nearest'` scrolls the palette's
  // own list and nothing else — the page below cannot scroll at all.
  useEffect(() => {
    if (!open || !activeEntry) return;
    document.getElementById(paletteResultId(activeEntry))?.scrollIntoView({ block: 'nearest' });
  }, [open, activeEntry]);

  const resultCount = groups.results.length;
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setAnnouncement(paletteCountLabel(resultCount)), ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, resultCount]);

  const run = useCallback(
    (result: PaletteResult) => {
      onClose();
      if (result.kind === 'command') {
        result.entry.run();
        return;
      }
      if (result.kind === 'destination') {
        onNavigate(result.entry.href);
        return;
      }
      if (result.kind === 'session') {
        onNavigate(daemonSessionPath(daemon, result.entry.id));
        return;
      }
      // A link row (a daemon-global setting that lives on another page)
      // navigates on every layout: there is no settings section to open for it.
      if (result.entry.href) {
        onNavigate(result.entry.href);
        return;
      }
      if (result.entry.settingId !== null && layout === 'drawer' && onOpenSetting) {
        // The palette's focus trap must restore before the settings sheet takes
        // focus, exactly like the details → settings handoff.
        const settingId = result.entry.settingId;
        requestAnimationFrame(() => onOpenSetting(settingId));
        return;
      }
      onNavigate(paletteSettingHref(daemon, result.entry.settingId));
    },
    [daemon, layout, onClose, onNavigate, onOpenSetting],
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
      const next = nextActiveIndex(active, groups.results.length, event.key);
      if (next === null) return;
      event.preventDefault();
      setActive(next);
    },
    [active, activeEntry, groups.results.length, run],
  );

  // Hooks above, early return below: the restore-to-opener contract lives in
  // `useDialogFocus`'s effects, and they only run if the hook is called on every
  // render — including the ones where there is nothing to draw.
  if (!open) return null;

  const trimmed = query.trim();
  const searching = trimmed !== '';

  return (
    <div className="kt-overlay fixed inset-x-0 z-50 flex justify-center px-3 pt-[12vh]">
      {/* Scrim. A real button, so a click and a keyboard activation dismiss the
          same way and a screen reader meets something with a name. */}
      <button
        type="button"
        aria-label="Close the command palette"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-scrim"
      />
      <div
        id={PALETTE_IDS.panel}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={trapKeyDown}
        className="kt-panel relative z-10 flex w-[min(560px,92vw)] min-h-0 flex-col font-ui"
        style={{ maxHeight: 'min(60vh, calc(var(--app-h, 100dvh) - 14vh))' }}
      >
        <div className="flex shrink-0 items-center gap-sm border-b border-border-soft px-panel py-row-y">
          <Search size={14} className="shrink-0 text-faint" aria-hidden="true" />
          <input
            id={PALETTE_IDS.input}
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={PALETTE_IDS.listbox}
            aria-activedescendant={activeEntry ? paletteResultId(activeEntry) : undefined}
            aria-autocomplete="list"
            aria-label="Search app destinations, commands, settings, and sessions"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              // A new query is a new list; start at the top of it.
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search app destinations, commands, settings, and sessions…"
            // Not `.kt-input`: the panel already draws the edge, and a second
            // bordered control inside it reads as a box in a box. Type size and
            // colour still come from tokens.
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-ui text-ui text-fg outline-none placeholder:text-faint"
          />
        </div>

        {/* The palette's OWN scroller. The page below still owns exactly one;
            this is an overlay and never nests inside it. */}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-xs py-xs">
          <div id={PALETTE_IDS.listbox} role="listbox" aria-label="Results">
            {groups.destinations.length > 0 && (
              <fieldset className="m-0 min-w-0 border-0 p-0" aria-labelledby={PALETTE_IDS.destinationsHeading}>
                <div id={PALETTE_IDS.destinationsHeading} className="kt-label px-cell-x pb-xs pt-xs">
                  {paletteGroupHeading('destinations', searching)}
                </div>
                {groups.destinations.map((entry, index) => (
                  <DestinationOption
                    key={entry.id}
                    entry={entry}
                    destinations={destinations}
                    selected={index === activeIndex}
                    onActivate={() => run({ kind: 'destination', entry })}
                    onHover={() => setActive(index)}
                  />
                ))}
              </fieldset>
            )}
            {groups.commands.length > 0 && (
              <fieldset className="m-0 min-w-0 border-0 p-0" aria-labelledby={PALETTE_IDS.commandsHeading}>
                <div id={PALETTE_IDS.commandsHeading} className="kt-label px-cell-x pb-xs pt-xs">
                  {paletteGroupHeading('commands', searching)}
                </div>
                {groups.commands.map((entry, index) => {
                  const resultIndex = groups.offsets.commands + index;
                  return (
                    <CommandOption
                      key={entry.id}
                      entry={entry}
                      selected={resultIndex === activeIndex}
                      onActivate={() => run({ kind: 'command', entry })}
                      onHover={() => setActive(resultIndex)}
                    />
                  );
                })}
              </fieldset>
            )}
            {groups.settings.length > 0 && (
              <fieldset className="m-0 min-w-0 border-0 p-0" aria-labelledby={PALETTE_IDS.settingsHeading}>
                <div id={PALETTE_IDS.settingsHeading} className="kt-label px-cell-x pb-xs pt-xs">
                  {paletteGroupHeading('settings', searching)}
                </div>
                {groups.settings.map((entry, index) => {
                  const resultIndex = groups.offsets.settings + index;
                  return (
                    <SettingsOption
                      key={entry.id}
                      entry={entry}
                      selected={resultIndex === activeIndex}
                      onActivate={() => run({ kind: 'settings', entry })}
                      onHover={() => setActive(resultIndex)}
                    />
                  );
                })}
              </fieldset>
            )}
            {groups.sessions.length > 0 && (
              <fieldset className="m-0 min-w-0 border-0 p-0" aria-labelledby={PALETTE_IDS.sessionsHeading}>
                <div id={PALETTE_IDS.sessionsHeading} className="kt-label px-cell-x pb-xs pt-xs">
                  {paletteGroupHeading('sessions', searching)}
                </div>
                {groups.sessions.map((entry, index) => {
                  const resultIndex = groups.offsets.sessions + index;
                  return (
                    <SessionOption
                      key={entry.id}
                      entry={entry}
                      selected={resultIndex === activeIndex}
                      onActivate={() => run({ kind: 'session', entry })}
                      onHover={() => setActive(resultIndex)}
                    />
                  );
                })}
              </fieldset>
            )}
          </div>

          {/* Only the searching form. kteam also carried a resting "No sessions
              yet." here, but the shell destinations are offered unconditionally,
              so a resting palette is never empty — that copy was unreachable
              there and would be dead code here. */}
          {searching && groups.results.length === 0 && (
            <p className="m-0 px-cell-x py-row-y text-cell text-muted">
              Nothing matches <span className="mono text-fg-soft">{trimmed}</span>. Try a page (analytics, warden,
              learning, settings), a setting, a teammate callsign, a task, a project folder, or the start of a session
              id.
            </p>
          )}
        </div>

        <Footer shortcutAvailable={shortcutAvailable} />

        {/* Spoken, never shown. `sr-only` and not `hidden`, which would take it
            straight back out of the accessibility tree. */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </div>
    </div>
  );
}

/**
 * One row of the listbox, and the pointer contract every row owes the combobox.
 *
 * ACTIVATION IS POINTER-UP, NOT CLICK, and pointer-DOWN calls
 * `preventDefault()`. That is what keeps the caret in the query box while a
 * reader clicks a row: a default pointer-down would move focus to the row, the
 * dialog focus trap would see focus leave the input, and the next keystroke
 * would go nowhere. It also means a press that slides off a row does not fire —
 * the pointer id has to match the one that went down.
 *
 * `tabIndex={-1}` for the same reason: an option is pointed AT by
 * `aria-activedescendant`, never focused.
 */
function PaletteOption({
  id,
  selected,
  onActivate,
  onHover,
  className,
  children,
}: {
  readonly id: string;
  readonly selected: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
  readonly className: string;
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
      className={className}
    >
      {children}
    </div>
  );
}

function CommandOption({
  entry,
  selected,
  onActivate,
  onHover,
}: {
  readonly entry: PaletteCommand;
  readonly selected: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
}) {
  return (
    <PaletteOption
      id={paletteResultId({ kind: 'command', entry })}
      selected={selected}
      onActivate={onActivate}
      onHover={onHover}
      className="kt-navrow min-h-[44px] cursor-pointer items-start"
    >
      <KeyRound size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-fg">{entry.label}</span>
        <span className="truncate text-meta text-muted">{entry.description}</span>
      </span>
    </PaletteOption>
  );
}

function DestinationOption({
  entry,
  destinations,
  selected,
  onActivate,
  onHover,
}: {
  readonly entry: DestinationPaletteEntry;
  readonly destinations: readonly PaletteDestinationSource[];
  readonly selected: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
}) {
  const Icon = destinationIcon(entry.id, destinations);
  return (
    <PaletteOption
      id={paletteResultId({ kind: 'destination', entry })}
      selected={selected}
      onActivate={onActivate}
      onHover={onHover}
      className="kt-navrow min-h-[44px] cursor-pointer items-start"
    >
      <Icon size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-fg">{entry.label}</span>
        <span className="truncate text-meta text-muted">{entry.description}</span>
      </span>
    </PaletteOption>
  );
}

function SettingsOption({
  entry,
  selected,
  onActivate,
  onHover,
}: {
  readonly entry: PaletteSettingsEntry;
  readonly selected: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
}) {
  return (
    <PaletteOption
      id={paletteResultId({ kind: 'settings', entry })}
      selected={selected}
      onActivate={onActivate}
      onHover={onHover}
      className="kt-navrow min-h-[44px] cursor-pointer items-start"
    >
      <Settings size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-fg">{entry.label}</span>
        <span className="truncate text-meta text-muted">{entry.description}</span>
      </span>
    </PaletteOption>
  );
}

function SessionOption({
  entry,
  selected,
  onActivate,
  onHover,
}: {
  readonly entry: PaletteSession;
  readonly selected: boolean;
  readonly onActivate: () => void;
  readonly onHover: () => void;
}) {
  return (
    <PaletteOption
      id={paletteResultId({ kind: 'session', entry })}
      selected={selected}
      onActivate={onActivate}
      onHover={onHover}
      className="kt-navrow cursor-pointer items-start"
    >
      <StatusMark view={entry.view} size={8} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-sm">
          <span className="shrink-0 font-semibold text-fg">{entry.headline}</span>
          {entry.task && <span className="min-w-0 flex-1 truncate text-cell text-fg-soft">{entry.task}</span>}
        </span>
        <span className="flex min-w-0 items-baseline gap-sm text-meta text-muted">
          {entry.folderName && <span className="min-w-0 truncate">{entry.folderName}</span>}
          {entry.label && <span className="min-w-0 truncate">· {entry.label}</span>}
          <span className="mono ml-auto shrink-0 text-faint">{entry.shortId}</span>
        </span>
      </span>
    </PaletteOption>
  );
}

/**
 * What the keys do, and the one thing this shortcut is NOT. Cmd/Ctrl+F is the
 * sibling feature (find inside a transcript) and readers will try it here; say so
 * rather than letting them discover a browser find bar over a dialog.
 */
function Footer({ shortcutAvailable }: { readonly shortcutAvailable: boolean }) {
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
      <span className="ml-auto text-faint">
        {shortcutAvailable
          ? `${paletteShortcutLabel()} outside text fields · reopen finder`
          : `${paletteShortcutLabel()} searches this session’s files & tasks`}
      </span>
    </div>
  );
}
