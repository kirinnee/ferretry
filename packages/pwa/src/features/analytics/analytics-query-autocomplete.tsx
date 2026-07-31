/** Accessible, grammar-aware query input for daemon-scoped analytics surfaces. */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Loader2, Search, SearchX, ShieldAlert } from 'lucide-react';

import {
  analyticsCompletions,
  type AnalyticsCompletion,
  type AnalyticsCompletionSources,
} from './analytics-query-complete.ts';

export type AnalyticsAutocompleteStatus = 'ready' | 'loading' | 'error';
export type AnalyticsAutocompleteAction =
  | { readonly type: 'ignore' }
  | { readonly type: 'navigate'; readonly index: number }
  | { readonly type: 'accept'; readonly index: number }
  | { readonly type: 'close' }
  | { readonly type: 'run' };

export const nextAnalyticsCompletionIndex = (count: number, current: number, direction: 1 | -1): number =>
  count <= 0 ? -1 : current < 0 ? (direction === 1 ? 0 : count - 1) : (current + direction + count) % count;

export const analyticsAutocompleteKeyAction = (
  key: string,
  state: { readonly open: boolean; readonly count: number; readonly activeIndex: number; readonly composing?: boolean },
): AnalyticsAutocompleteAction => {
  if (state.composing) return { type: 'ignore' };
  const usable = state.open && state.count > 0;
  if (key === 'Escape') return state.open ? { type: 'close' } : { type: 'ignore' };
  if (key === 'ArrowDown' || key === 'ArrowUp')
    return usable
      ? {
          type: 'navigate',
          index: nextAnalyticsCompletionIndex(state.count, state.activeIndex, key === 'ArrowDown' ? 1 : -1),
        }
      : { type: 'ignore' };
  if (key === 'Tab')
    return usable && state.activeIndex >= 0 ? { type: 'accept', index: state.activeIndex } : { type: 'ignore' };
  return key === 'Enter'
    ? usable && state.activeIndex >= 0
      ? { type: 'accept', index: state.activeIndex }
      : { type: 'run' }
    : { type: 'ignore' };
};

export const applyAnalyticsCompletion = (
  value: string,
  range: { readonly start: number; readonly end: number },
  replacement: string,
) => {
  const start = Math.max(0, Math.min(value.length, range.start));
  const end = Math.max(start, Math.min(value.length, range.end));
  const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  const caret = start + replacement.length;
  return { value: next, selection: { start: caret, end: caret } };
};

export type ValueCacheEntry =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly values: readonly string[] }
  | { readonly status: 'error'; readonly error: string };
export interface LabelValueCache {
  entry(label: string): ValueCacheEntry | undefined;
  request(label: string): Promise<void>;
}

export const createLabelValueCache = (
  load: (label: string) => Promise<readonly string[]>,
  notify: (snapshot: ReadonlyMap<string, ValueCacheEntry>) => void,
): LabelValueCache => {
  const entries = new Map<string, ValueCacheEntry>();
  const publish = (label: string, entry: ValueCacheEntry) => {
    entries.set(label, entry);
    notify(new Map(entries));
  };
  return {
    entry: label => entries.get(label),
    async request(label) {
      if (entries.has(label)) return;
      publish(label, { status: 'loading' });
      try {
        publish(label, { status: 'ready', values: await load(label) });
      } catch (error) {
        publish(label, { status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
};

const contextLabel = {
  aggregation: 'Aggregation',
  clause: 'Next clause',
  'grouping-label': 'Group by label',
  'matcher-label': 'Filter label',
  'matcher-value': 'Filter value',
} as const;

export function AnalyticsCompletionList({
  open,
  status,
  candidates,
  activeIndex,
  listboxId,
  context,
  notice,
  error,
  onAccept,
}: {
  readonly open: boolean;
  readonly status: AnalyticsAutocompleteStatus;
  readonly candidates: readonly AnalyticsCompletion[];
  readonly activeIndex: number;
  readonly listboxId: string;
  readonly context: keyof typeof contextLabel;
  readonly notice?: string;
  readonly error?: string;
  readonly onAccept: (index: number) => void;
}) {
  if (!open) return null;
  const copy =
    status === 'loading'
      ? 'Loading label values'
      : status === 'error'
        ? 'Label values unavailable'
        : candidates.length
          ? `${candidates.length} analytics suggestions`
          : 'No matching analytics suggestions';
  return (
    <div
      className="absolute inset-x-0 top-[calc(100%+var(--gap-xs))] z-40 overflow-hidden rounded-panel border-panel border-border-strong bg-surface shadow-popover"
      data-analytics-autocomplete={contextLabel[context]}
    >
      <div className="flex min-h-[34px] items-center border-b border-border-soft bg-surface-2 px-control-x py-1">
        <span className="min-w-0 flex-1 truncate text-meta font-semibold uppercase tracking-label text-fg-soft">
          {contextLabel[context]}
        </span>
      </div>
      <div className="relative max-h-[min(240px,max(88px,calc(var(--app-h,100dvh)*0.3)))] overflow-y-auto overscroll-contain scroll-thin [touch-action:pan-y]">
        {status === 'loading' ? (
          <div
            className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
            role="status"
          >
            <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading values…
          </div>
        ) : status === 'error' ? (
          <div className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-err" role="alert">
            <ShieldAlert size={15} aria-hidden="true" />
            {error ?? 'Label values unavailable'}
          </div>
        ) : candidates.length === 0 ? (
          <div
            className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
            role="status"
          >
            <SearchX size={15} aria-hidden="true" />
            {notice ?? 'No matching analytics suggestions'}
          </div>
        ) : (
          <div id={listboxId} role="listbox" aria-label="Analytics query suggestions">
            {candidates.map((candidate, index) => (
              <CompletionRow
                key={candidate.id}
                candidate={candidate}
                index={index}
                active={index === activeIndex}
                optionId={`${listboxId}-option-${index}`}
                onAccept={onAccept}
              />
            ))}
          </div>
        )}
      </div>
      {notice && candidates.length > 0 && (
        <div
          className="border-t border-border-soft bg-warn-bg px-control-x py-1 text-2xs leading-base text-warn"
          role="status"
        >
          {notice}
        </div>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copy}
      </span>
    </div>
  );
}

function CompletionRow({
  candidate,
  index,
  active,
  optionId,
  onAccept,
}: {
  readonly candidate: AnalyticsCompletion;
  readonly index: number;
  readonly active: boolean;
  readonly optionId: string;
  readonly onAccept: (index: number) => void;
}) {
  const pointer = useRef<number | null>(null);
  return (
    <div
      id={optionId}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      data-active={active || undefined}
      className={`group flex min-h-[44px] w-full cursor-pointer select-none items-center gap-sm border-l-[3px] border-l-transparent px-control-x py-row-y text-left text-fg outline-none hover:bg-surface-2${active ? ' border-l-accent bg-accent-soft shadow-active' : ''}`}
      onPointerDown={event => {
        pointer.current = event.pointerId;
        event.preventDefault();
      }}
      onPointerUp={event => {
        if (pointer.current === event.pointerId) onAccept(index);
        pointer.current = null;
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
    >
      <span className="min-w-0 flex-1 leading-tight">
        <span className="mono block truncate font-medium text-current">{candidate.label}</span>
        {candidate.detail && <span className="block truncate text-meta text-muted">{candidate.detail}</span>}
      </span>
      <span className="mono shrink-0 rounded-badge border border-border-soft bg-surface px-badge-x py-px text-2xs text-faint">
        {candidate.kind}
      </span>
    </div>
  );
}

export function AnalyticsQueryAutocomplete({
  value,
  onValueChange,
  onRun,
  inputId,
  placeholder = 'sum by (model)',
  disabled,
  sources,
  loadValues,
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onRun: () => void;
  readonly inputId?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly sources?: Pick<AnalyticsCompletionSources, 'treeIds'>;
  readonly loadValues: (label: string) => Promise<readonly string[]>;
}) {
  const generatedId = useId();
  const listboxId = `analytics-completions-${generatedId.replace(/:/g, '')}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cache, setCache] = useState<ReadonlyMap<string, ValueCacheEntry>>(new Map());
  const pending = useRef<{ readonly expected: string; readonly start: number; readonly end: number } | null>(null);
  const values = useMemo(() => createLabelValueCache(loadValues, setCache), [loadValues]);
  const valuesFor = useCallback(
    (label: string) => {
      const entry = cache.get(label);
      return entry?.status === 'ready' ? entry.values : undefined;
    },
    [cache],
  );
  const result = useMemo(
    () => analyticsCompletions(value, caret, { valuesFor, treeIds: sources?.treeIds }),
    [caret, sources?.treeIds, value, valuesFor],
  );
  const entry = result.pendingValueLabel ? cache.get(result.pendingValueLabel) : undefined;
  const status: AnalyticsAutocompleteStatus =
    entry?.status === 'error' ? 'error' : result.pendingValueLabel ? 'loading' : 'ready';
  useEffect(() => {
    if (result.pendingValueLabel) void values.request(result.pendingValueLabel);
  }, [result.pendingValueLabel, values]);
  const candidates = result.candidates;
  const bounded = candidates.length ? Math.min(Math.max(activeIndex, 0), candidates.length - 1) : -1;
  const open = focused && !disabled && dismissedAt !== caret;
  useLayoutEffect(() => {
    const next = pending.current;
    const input = inputRef.current;
    if (!next || !input || next.expected !== value || input.value !== value) return;
    pending.current = null;
    input.setSelectionRange(next.start, next.end);
    setCaret(next.end);
  }, [value]);
  const accept = useCallback(
    (index: number) => {
      const candidate = candidates[index];
      if (!candidate) return;
      const next = applyAnalyticsCompletion(value, result.replaceRange, candidate.replacement);
      pending.current = { expected: next.value, start: next.selection.start, end: next.selection.end };
      setActiveIndex(0);
      setDismissedAt(null);
      onValueChange(next.value);
    },
    [candidates, onValueChange, result.replaceRange, value],
  );
  const syncCaret = (input: HTMLInputElement) => setCaret(input.selectionStart ?? input.value.length);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = analyticsAutocompleteKeyAction(event.key, {
      open,
      count: candidates.length,
      activeIndex: bounded,
      composing: event.nativeEvent.isComposing,
    });
    if (action.type === 'ignore') return;
    event.preventDefault();
    if (action.type === 'run') {
      setDismissedAt(caret);
      onRun();
    } else if (action.type === 'close') setDismissedAt(caret);
    else if (action.type === 'navigate') setActiveIndex(action.index);
    else accept(action.index);
  };
  return (
    <span className="relative min-w-0 flex-1">
      <Search
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-[22px] -translate-y-1/2 text-faint"
      />
      <input
        id={inputId}
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open && candidates.length ? listboxId : undefined}
        aria-activedescendant={open && bounded >= 0 ? `${listboxId}-option-${bounded}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="kt-input mono min-h-[44px] w-full pl-9 pr-3"
        value={value}
        placeholder={placeholder}
        onChange={event => {
          setActiveIndex(0);
          setDismissedAt(null);
          onValueChange(event.currentTarget.value);
          syncCaret(event.currentTarget);
        }}
        onSelect={event => syncCaret(event.currentTarget)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      <AnalyticsCompletionList
        open={open}
        status={status}
        candidates={candidates}
        activeIndex={bounded}
        listboxId={listboxId}
        context={result.context}
        notice={result.notice}
        error={entry?.status === 'error' ? entry.error : undefined}
        onAccept={accept}
      />
    </span>
  );
}
