/**
 * The pieces every "This folder" sub-tab panel is built from (copied from today's PWA
 * `features/context-rail/context-rail-parts.tsx`, `context-rail-model.ts` and the failure words of `mcp-model.ts`): a
 * lazy read, the search-and-chips header, the loading / failed / empty notes and the search every row list shares.
 * Shared so the Skills panel, the MCP panel and every later list cannot drift into different ways of saying the same
 * thing.
 *
 * There is no "this machine is too old" branch: a daemon that lacks a plugin is blocked by the shell before a panel
 * mounts (§9.6, `blockedLine`), so a read that fails here is a failure, said as one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextChip } from './filter-chips.tsx';
import { ContextFilterChips } from './filter-chips.tsx';
import { Button } from './primitives.tsx';
import { SidePaneSearch } from './side-pane-search.tsx';

// ── Search and chips ───────────────────────────────────────────────────────────────────────────────────────────────

/** Case- and locale-insensitive substring search over every field a row offers. */
export const matchesQuery = (query: string, ...fields: readonly (string | null | undefined)[]): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return fields.some(field => field?.toLocaleLowerCase().includes(needle) === true);
};

/** The chips of one list, each counted over the rows that match the current search. */
export const chipsFor = <K extends string, R>(
  order: readonly K[],
  labels: Readonly<Record<K, string>>,
  rows: readonly R[],
  inChip: (row: R, chip: K) => boolean,
): ContextChip<K>[] =>
  order.map(key => ({ key, label: labels[key], count: rows.filter(row => inChip(row, key)).length }));

/** Honest zero-state copy: a filtered-out list is not an empty one. `empty` is what a list with no rows says. */
export const contextEmptyCopy = (empty: string, total: number, query: string, chipLabel: string): string => {
  const needle = query.trim();
  if (total > 0 && needle !== '') return `Nothing under ${chipLabel} matches “${needle}”.`;
  if (total > 0) return `Nothing under ${chipLabel}.`;
  return empty;
};

// ── A lazy read ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ContextLoad<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ContextRead<T> {
  readonly load: ContextLoad<T>;
  readonly reload: () => void;
}

/** A one-shot read the list can cancel and repeat. */
export type ContextLoader<T> = (signal: AbortSignal) => Promise<T>;

/** What a failed read says. The daemon's own sentence when it gave one. */
export const loadFailureReason = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : 'The daemon did not answer.';

/**
 * Reads once `wanted`, and keeps the answer while the reader looks elsewhere. A read is cancelled only by a newer one (a
 * new loader, a retry) or by the list going away. A refresh keeps the rows on screen; a NEW loader is another ferret's
 * list, and the old rows must not stand in for it.
 */
export function useContextRead<T>(loader: ContextLoader<T>, wanted: boolean): ContextRead<T> {
  const [started, setStarted] = useState(wanted);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<ContextLoad<T>>({ kind: 'idle' });
  const shown = useRef(loader);
  if (wanted && !started) setStarted(true);

  // `attempt` is in the list although the body never reads it: bumping it IS the retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    const same = shown.current === loader;
    shown.current = loader;
    setLoad(previous => (same && previous.kind === 'ready' ? previous : { kind: 'loading' }));
    loader(controller.signal).then(
      value => {
        if (!controller.signal.aborted) setLoad({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoad({ kind: 'failed', reason: loadFailureReason(error) });
      },
    );
    return () => controller.abort();
  }, [loader, started, attempt]);

  const reload = useCallback(() => setAttempt(value => value + 1), []);
  return { load, reload };
}

// ── The header every list has ──────────────────────────────────────────────────────────────────────────────────────

export interface ContextFilterBarProps<K extends string> {
  readonly searchLabel: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly chips: readonly ContextChip<K>[];
  readonly chip: K;
  readonly onChipChange: (chip: K) => void;
  readonly debounceMs?: number;
}

export function ContextFilterBar<K extends string>({
  searchLabel,
  query,
  onQueryChange,
  chips,
  chip,
  onChipChange,
  debounceMs,
}: ContextFilterBarProps<K>) {
  return (
    <div className="flex min-w-0 flex-col gap-xs">
      <SidePaneSearch
        ariaLabel={searchLabel}
        placeholder={`${searchLabel}…`}
        value={query}
        onChange={onQueryChange}
        {...(debounceMs === undefined ? {} : { debounceMs })}
      />
      <ContextFilterChips label="Filter" chips={chips} value={chip} onChange={onChipChange} />
    </div>
  );
}

// ── Notes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ContextNote({ children }: { readonly children: string }) {
  return (
    <p className="m-0 py-sm text-cell text-muted" role="status" data-context-note="">
      {children}
    </p>
  );
}

// ── Failures, in plain words ───────────────────────────────────────────────────────────────────────────────────────

export interface PlainFailure {
  /** The sentence a person reads: "Liftoff MBP isn't reachable right now". */
  readonly headline: string;
  /** The raw text, for Details only. Absent when the headline already is it. */
  readonly details?: string;
}

const UNREACHABLE =
  /could not reach|couldn.t reach|failed to fetch|fetch failed|network|econnrefused|econnreset|enotfound|socket|connection (?:closed|lost|refused)|relay|offline|carrier|websocket|load failed/iu;
const NOT_ANSWERING = /did not answer|timed? ?out|timeout/iu;
/** A refusal the daemon already words for people: a grant, a step-up, a missing ferret. */
const ALREADY_PLAIN = /has not granted|passkey|unlock|not allowed|no ferret/iu;

/**
 * A failed read or act, in words a person reads, with the transport's own text kept for Details:
 * "Liftoff MBP isn't reachable right now" rather than "could not reach fyd at 127.0.0.1:…".
 *
 * `answered`: the machine itself answered with a refusal it worded. Its text can say "couldn't reach" or
 * "network error" about somewhere ELSE — a sign-in provider — so it is never read as this machine being
 * unreachable: the headline is the act that failed, and the machine's words are the Details.
 */
export function plainFailure(reason: string, machineName: string, what: string, answered = false): PlainFailure {
  const raw = reason.trim();
  if (answered) return { headline: `Couldn’t ${what}`, ...(raw === '' ? {} : { details: raw }) };
  if (NOT_ANSWERING.test(raw)) return { headline: `${machineName} isn’t answering right now`, details: raw };
  if (UNREACHABLE.test(raw)) return { headline: `${machineName} isn’t reachable right now`, details: raw };
  if (ALREADY_PLAIN.test(raw) && raw.length <= 200) return { headline: raw };
  return { headline: `Couldn’t ${what}`, ...(raw === '' ? {} : { details: raw }) };
}

export interface ContextFailureProps {
  readonly machineName: string;
  /** What was being done, after "Couldn't": "read this ferret's skills". */
  readonly what: string;
  readonly reason: string;
  readonly onRetry: () => void;
}

/** A read that failed, said in plain words with the transport's own text behind Details, and a Try again. */
export function ContextFailure(props: ContextFailureProps) {
  const failure: PlainFailure = plainFailure(props.reason, props.machineName, props.what);
  return (
    <div className="flex min-w-0 flex-col gap-xs py-sm" role="alert" data-context-failed="">
      <p className="m-0 break-words text-cell font-semibold text-fg">{failure.headline}</p>
      {failure.details === undefined ? null : (
        <details className="min-w-0 text-meta text-muted" data-context-failed-details="">
          <summary className="cursor-pointer select-none">Details</summary>
          <span className="block break-words font-mono text-2xs">{failure.details}</span>
        </details>
      )}
      <div>
        <Button type="button" size="sm" onClick={props.onRetry} data-context-retry="">
          Try again
        </Button>
      </div>
    </div>
  );
}
