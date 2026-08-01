/**
 * THE ONE SET OF FLEET FILTERS. Ported from the `ModeSegment` and `Controls`
 * halves of kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * The sidebar OWNS instant search, the All/Auto/Interactive segment, the RC
 * filter and include-finished — and every other fleet surface reflects the same
 * values rather than keeping a second copy to drift. Narrowing the fleet here
 * narrows it everywhere at once.
 *
 * WHAT CHANGED — survey rows 35-37. kteam's `Controls` read and wrote a module
 * singleton store, so one daemon's filters would have been every daemon's. Here
 * the values and their setter arrive as props from a `(daemonId, …)`-scoped
 * controls store, and the transcript search is a callback the host routes to the
 * daemon the column is showing. Nothing in this file can name a daemon it was
 * not given.
 *
 * TWO FEATURES, ONE BOX. The instant filter narrows the list as you type; Enter
 * runs the daemon-side full-text transcript search and Escape clears both. That
 * is exactly the behaviour the box had before it moved into the sidebar, and the
 * accessible name says so.
 */

import { Radio, Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ModeFilter } from '../lib/controls.ts';
import type { ModeCounts } from '../lib/fleet-grouping.ts';
import { MODE_HINT } from './mode-badge.tsx';

/** The segment order, which is also the cycle order the rail's one button uses. */
export const MODE_SEGMENT_ORDER: readonly ModeFilter[] = ['all', 'auto', 'interactive'];

/** Short enough that three segments share a 248px column without truncating. */
export const MODE_SEGMENT_LABEL: Record<ModeFilter, string> = {
  all: 'All',
  auto: 'Auto',
  interactive: 'Interactive',
};

/**
 * The count on a segment is what clicking it WOULD show under the other filters,
 * so the tooltip says so rather than leaving it to read as a fleet-wide total.
 */
export const modeSegmentTitle = (mode: ModeFilter, counts: ModeCounts): string =>
  mode === 'all'
    ? `every session matching the current search and filters (${counts.all})`
    : `${MODE_HINT[mode]}\n${counts[mode]} match the current search and filters`;

export interface ModeSegmentProps {
  readonly value: ModeFilter;
  readonly counts: ModeCounts;
  readonly onChange: (next: ModeFilter) => void;
  /** Rendered by lucide at the call site so the icons are not imported twice. */
  readonly iconFor?: (mode: ModeFilter) => React.ReactNode;
}

export function ModeSegment({ counts, iconFor, onChange, value }: ModeSegmentProps) {
  return (
    // A row of toggle buttons, not a WAI-ARIA tablist: each carries
    // `aria-pressed` and native Tab/Space/Enter is then exactly right.
    // `role="toolbar"` supports `aria-label` and has no HTML element to be
    // rewritten into — unlike `role="group"`, which demands a `<fieldset>`.
    <div
      aria-label="Filter by mode"
      className="flex rounded-control border border-border bg-surface p-0.5"
      role="toolbar"
    >
      {MODE_SEGMENT_ORDER.map(mode => (
        <button
          aria-pressed={value === mode}
          // `.kt-tab` + the `aria-pressed` already on this button: the selected
          // treatment is the family's (pill in Ember, notched mono caps in
          // Mission, hard block in Neo) instead of a hardcoded surface.
          //
          // `!px-xs` is the ONE override here. `.kt-tab`'s control padding is a
          // toolbar figure (10-14px); three segments share a 248px column, so at
          // 14px a side "Interactive" truncates to two characters.
          className="kt-tab !px-xs min-w-0 flex-1 justify-center"
          key={mode}
          onClick={() => onChange(mode)}
          title={modeSegmentTitle(mode, counts)}
          type="button"
        >
          {iconFor?.(mode)}
          <span className="truncate">{MODE_SEGMENT_LABEL[mode]}</span>
          <span className="mono shrink-0 text-2xs text-faint">{counts[mode]}</span>
        </button>
      ))}
    </div>
  );
}

/** The four filters this column owns, as one patch the host writes back. */
export interface FleetFilterValues {
  readonly query: string;
  readonly mode: ModeFilter;
  readonly rcOnly: boolean;
  readonly includeFinished: boolean;
}

export interface FleetFiltersProps {
  readonly values: FleetFilterValues;
  readonly counts: ModeCounts;
  readonly onChange: (patch: Partial<FleetFilterValues>) => void;
  /** Enter: the daemon-side transcript search, which the instant filter is not. */
  readonly onSearchSubmit?: (query: string) => void;
  /** Escape and the clear button both discard the daemon-side results too. */
  readonly onSearchClear?: () => void;
  /**
   * Focus the box on mount. Deliberately NOT set when a touch drawer merely
   * opens — that would raise the keyboard over the list it was opened to read.
   */
  readonly autoFocusSearch?: boolean;
  readonly iconFor?: (mode: ModeFilter) => React.ReactNode;
}

export function FleetFilters({
  autoFocusSearch = false,
  counts,
  iconFor,
  onChange,
  onSearchClear,
  onSearchSubmit,
  values,
}: FleetFiltersProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // `/` from anywhere focuses the search box. It used to be the dashboard's
  // shortcut and had to check the visible route; the box is on every route now,
  // so it simply works.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (autoFocusSearch) inputRef.current?.focus();
  }, [autoFocusSearch]);

  const clear = () => {
    onChange({ query: '' });
    onSearchClear?.();
  };

  return (
    <div className="flex flex-col gap-sm">
      <div className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2 text-faint" size={13} />
        <input
          aria-label="Search sessions — Enter also searches transcripts"
          // `.kt-input` brings the themed edge, radius, focus ring AND the input
          // type size, which themes.css floors at 16px under 640px — a hardcoded
          // 12.5px made iOS zoom the whole drawer whenever this box was focused.
          //
          // The two `!` overrides are the icon gutters: `.kt-input` sets
          // `padding` as a shorthand, so `pl-7`/`pr-7` cannot win on source order.
          className="kt-input !pl-7 !pr-7"
          onChange={event => onChange({ query: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSearchSubmit?.(values.query);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              clear();
            }
          }}
          placeholder="Search fleet…  ( / )"
          ref={inputRef}
          // `text`, not `search`: WebKit adds its own clear affordance to a search
          // input, which would sit next to ours and behave differently.
          type="text"
          value={values.query}
        />
        {values.query ? (
          <button
            aria-label="Clear search"
            className="absolute right-1.5 rounded-control p-0.5 text-faint hover:text-fg"
            onClick={clear}
            type="button"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>

      <ModeSegment counts={counts} iconFor={iconFor} onChange={mode => onChange({ mode })} value={values.mode} />

      <div className="flex items-center gap-sm">
        <button
          aria-pressed={values.rcOnly}
          // The pressed edge takes `.kt-tab [aria-pressed='true']`, drawn in
          // `--accent` (>=4.5:1 in all ten themes) rather than `--accent-border`,
          // which measures 1.2-2.9:1 on surface in six of them.
          className="kt-tab shrink-0"
          onClick={() => onChange({ rcOnly: !values.rcOnly })}
          title="only sessions launched with Remote Control (steerable from claude.ai / your phone)"
          type="button"
        >
          <Radio size={10} />
          rc only
        </button>
        <label className="inline-flex cursor-pointer items-center gap-sm text-fg-soft text-meta">
          <input
            checked={values.includeFinished}
            className="h-3 w-3"
            onChange={event => onChange({ includeFinished: event.target.checked })}
            type="checkbox"
          />
          finished
        </label>
      </div>
    </div>
  );
}
