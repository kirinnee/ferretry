/**
 * The pieces every "This folder" sub-tab is built from: a lazy read, the filter chips, the search and
 * chips header, and the loading / failed / empty notes. Shared so the four sub-tabs cannot drift into
 * four ways of saying the same thing.
 */

import { FyHttpError } from '@ferretry/protocol/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { UPDATE_MACHINE_WHERE } from '../../lib/machine-update-words.ts';
import { Button } from '../../shell/primitives.tsx';
import { SidePaneSearch } from '../../shell/side-pane-search.tsx';
import { type PlainFailure, plainFailure } from '../mcp/mcp-model.ts';
import type { ContextChip } from './context-rail-model.ts';
import type { ContextLoader } from './context-rail-ports.ts';

// ── A lazy read ──────────────────────────────────────────────────────────────────────────────────

export type ContextLoad<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string; readonly outdated?: OutdatedMachine };

/** A machine whose daemon predates the route a read asked for: not a fault, a version. */
export interface OutdatedMachine {
  /** The version the daemon stamped on its answer, when it did. */
  readonly daemonVersion?: string;
}

/** What a failed read says. The daemon's own sentence when it gave one. */
export const loadFailureReason = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : 'The daemon did not answer.';

/**
 * Whether a failed read means "this machine is older than the app": the daemon answered, and said it has
 * no such route. The rail's MCP, Skills and SKILL.md reads lean on routes a daemon gained in 4.82; the app
 * deploys before the machine updates, so this is a normal state, and the daemon's own 404 is the report.
 */
export const outdatedMachine = (error: unknown): OutdatedMachine | undefined =>
  error instanceof FyHttpError && error.status === 404 && error.code === 'unknown_route'
    ? { ...(error.daemonVersion === undefined ? {} : { daemonVersion: error.daemonVersion }) }
    : undefined;

export interface ContextRead<T> {
  readonly load: ContextLoad<T>;
  readonly reload: () => void;
}

/**
 * Reads once the sub-tab is first shown, and keeps the answer while the reader looks elsewhere.
 *
 * A sub-tab nobody opens is never read: the rail opens on Signals, and three reads for tabs the reader
 * may never look at would be three requests to a machine that might be on a phone's relay. Once wanted,
 * a read is cancelled only by a newer one (a new loader, a retry) or by the rail going away.
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
    // A refresh keeps the rows on screen: blanking a list the reader is looking at (or a sign-in sheet
    // open over it) to say "Reading…" for one round trip is worse than a moment of the old answer. A NEW
    // loader is another agent's list, and the old rows must not stand in for it.
    const same = shown.current === loader;
    shown.current = loader;
    setLoad(previous => (same && previous.kind === 'ready' ? previous : { kind: 'loading' }));
    loader(controller.signal).then(
      value => {
        if (!controller.signal.aborted) setLoad({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const outdated = outdatedMachine(error);
        setLoad({ kind: 'failed', reason: loadFailureReason(error), ...(outdated === undefined ? {} : { outdated }) });
      },
    );
    return () => controller.abort();
  }, [loader, started, attempt]);

  const reload = useCallback(() => setAttempt(value => value + 1), []);
  return { load, reload };
}

// ── Filter chips ─────────────────────────────────────────────────────────────────────────────────

export interface ContextFilterChipsProps<K extends string> {
  readonly label: string;
  readonly chips: readonly ContextChip<K>[];
  readonly value: K;
  readonly onChange: (next: K) => void;
}

/**
 * A row of toggle chips with their counts. Toggle buttons with `aria-pressed`, not a tablist — the
 * sub-tabs above are the tabs; these only narrow the list under them — and the family's own `.kt-tab`
 * treatment, so the pressed chip looks native in every theme.
 */
export function ContextFilterChips<K extends string>({ label, chips, value, onChange }: ContextFilterChipsProps<K>) {
  return (
    <div aria-label={label} className="flex min-w-0 flex-wrap gap-xs" role="toolbar" data-context-chips="">
      {chips.map(chip => (
        <button
          aria-pressed={chip.key === value}
          className="kt-tab !px-xs min-w-0 gap-1"
          data-context-chip={chip.key}
          key={chip.key}
          onClick={() => onChange(chip.key)}
          type="button"
        >
          <span className="truncate">{chip.label}</span>
          <span className="mono shrink-0 text-2xs text-faint">{chip.count}</span>
        </button>
      ))}
    </div>
  );
}

// ── The header every sub-tab has ─────────────────────────────────────────────────────────────────

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

// ── Notes ────────────────────────────────────────────────────────────────────────────────────────

export function ContextNote({ children }: { readonly children: string }) {
  return (
    <p className="m-0 py-sm text-cell text-muted" role="status" data-context-note="">
      {children}
    </p>
  );
}

/**
 * A read that failed. Given the machine and what was being read, it says it in plain words — "Liftoff MBP
 * isn't reachable right now" — and keeps the transport's own text behind Details.
 */
interface ContextFailureProps {
  readonly machineName: string;
  /** What was being done, after "Couldn't": "read this ferret's skills". */
  readonly what: string;
  readonly reason: string;
  /** Set when the machine's daemon predates the route: said as an update to make, not as a failure. */
  readonly outdated?: OutdatedMachine;
  /** What the update would let the app show, after "to show": "MCP". Used only with `outdated`. */
  readonly showing?: string;
  readonly onRetry: () => void;
}

export function ContextFailure(props: ContextFailureProps) {
  if (props.outdated !== undefined)
    return (
      <ContextOutdated
        machineName={props.machineName}
        showing={props.showing ?? 'this'}
        outdated={props.outdated}
        onRetry={props.onRetry}
      />
    );
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

/**
 * The machine's daemon is older than the route this tab reads. It says so, and what to do, and does not
 * dress it as an error: nothing is broken, the machine just has not been updated since the app was.
 */
function ContextOutdated({
  machineName,
  showing,
  outdated,
  onRetry,
}: {
  readonly machineName: string;
  readonly showing: string;
  readonly outdated: OutdatedMachine;
  readonly onRetry: () => void;
}) {
  const running = outdated.daemonVersion === undefined ? 'an older version' : `version ${outdated.daemonVersion}`;
  return (
    <div className="flex min-w-0 flex-col gap-xs py-sm" role="status" data-context-outdated="">
      <p className="m-0 break-words text-cell font-semibold text-fg">
        This machine needs an update to show {showing} here
      </p>
      <p className="m-0 break-words text-meta text-muted">
        {`${machineName} is running ${running}, which cannot list this yet — ${UPDATE_MACHINE_WHERE}.`}
      </p>
      <div>
        <Button type="button" size="sm" onClick={onRetry} data-context-retry="">
          Check again
        </Button>
      </div>
    </div>
  );
}
