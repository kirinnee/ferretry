/**
 * INSIGHTS › ANALYTICS › QUERY — ask the ledger any question in the analytics query language.
 *
 * The page is one editor (text box plus helpers that rewrite the text), the answer as a chart and a
 * table, the reader's saved queries and a handful of examples. The text is the source of truth: the
 * link a query is run from carries it (`onQueryChange`, mirrored into `?q=` by the shell), a saved query
 * is that text under a name, and nothing is parsed here — the protocol grammar owns that.
 *
 * Everything below the frame is keyed by the daemon, so switching daemons mounts a fresh body and a late
 * answer from the previous one cannot reach the screen.
 */

import type { AnalyticsResponse } from '@ferretry/protocol';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonFetch } from '../../lib/store.tsx';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import { Button } from '../../shell/primitives.tsx';
import { fetchAnalytics } from './analytics-api.ts';
import { ANALYTICS_QUERY_DEFAULT, AnalyticsQueryEditor, type AnalyticsRequest } from './analytics-custom-query.tsx';
import { ANALYTICS_QUERY_EXAMPLES } from './analytics-query-examples.ts';
import { readAnalyticsQuery } from './analytics-query-text.ts';
import { AnalyticsResponseView, analyticsErrorMessage } from './analytics-response-view.tsx';
import {
  addSavedQuery,
  browserSavedQueriesStorage,
  loadSavedQueries,
  persistSavedQueries,
  removeSavedQuery,
  type SavedAnalyticsQuery,
  type SavedQueriesStorage,
} from './analytics-saved-queries.ts';

export interface AnalyticsQueryPageProps {
  readonly connection: DaemonConnection;
  /** Every connected machine; only said in the caption — fan-out belongs to `requestAnalytics`. */
  readonly connections?: readonly DaemonConnection[];
  /** Injectable for deterministic render and screenshot harnesses. */
  readonly requestAnalytics?: AnalyticsRequest;
  /** The clock "ran at" reads. */
  readonly now?: () => Date;
  /** A query handed in by a link; it is run at once. */
  readonly initialQuery?: string | null;
  /** Called with the canonical query after each run, so the shell can mirror it into `?q=`. */
  readonly onQueryChange?: (query: string) => void;
  /** Injectable browser storage for saved queries. */
  readonly savedStorage?: SavedQueriesStorage;
}

const newId = (): string => globalThis.crypto.randomUUID();

export function AnalyticsQueryPage({
  connection,
  connections,
  requestAnalytics: injected,
  now,
  initialQuery,
  onQueryChange,
  savedStorage,
}: AnalyticsQueryPageProps) {
  const fetcher = useDaemonFetch();
  const requestAnalytics = useMemo<AnalyticsRequest>(
    () => injected ?? ((daemon, query) => fetchAnalytics(daemon, query, fetcher)),
    [fetcher, injected],
  );
  return (
    <main
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
      aria-label="Analytics query"
      data-daemon={connection.daemonId}
    >
      <QueryBody
        key={connection.daemonId}
        connection={connection}
        machines={connections?.length ?? 1}
        requestAnalytics={requestAnalytics}
        now={now ?? (() => new Date())}
        initialQuery={initialQuery ?? null}
        onQueryChange={onQueryChange}
        savedStorage={savedStorage}
      />
    </main>
  );
}

function QueryBody({
  connection,
  machines,
  requestAnalytics,
  now,
  initialQuery,
  onQueryChange,
  savedStorage,
}: {
  readonly connection: DaemonConnection;
  readonly machines: number;
  readonly requestAnalytics: AnalyticsRequest;
  readonly now: () => Date;
  readonly initialQuery: string | null;
  readonly onQueryChange: ((query: string) => void) | undefined;
  readonly savedStorage: SavedQueriesStorage | undefined;
}) {
  const [text, setText] = useState(initialQuery || ANALYTICS_QUERY_DEFAULT);
  const [result, setResult] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const serial = useRef(0);
  const lastResult = useRef<AnalyticsResponse | null>(null);

  const run = useCallback(
    async (source: string) => {
      const mine = ++serial.current;
      setQuerying(true);
      setError(null);
      try {
        const response = await requestAnalytics(connection, source.trim() || undefined);
        if (mine !== serial.current) return;
        lastResult.current = response;
        setText(response.query);
        setResult(response);
        setRanAt(now().toISOString().slice(11, 16));
        onQueryChange?.(response.query);
      } catch (reason) {
        if (mine === serial.current) {
          setResult(null);
          setError(analyticsErrorMessage(reason));
        }
      } finally {
        if (mine === serial.current) setQuerying(false);
      }
    },
    [connection, now, onQueryChange, requestAnalytics],
  );

  useEffect(() => {
    if (initialQuery) void run(initialQuery);
    return () => {
      serial.current += 1;
    };
  }, [initialQuery]);

  const runText = useCallback(
    (source: string) => {
      setText(source);
      void run(source);
    },
    [run],
  );

  const loadValues = useCallback(
    async (label: string): Promise<readonly string[]> => {
      const response = (lastResult.current?.parsed.groupBy as readonly string[] | undefined)?.includes(label)
        ? lastResult.current
        : await requestAnalytics(connection, `count by (${label})`);
      if (response?.kind !== 'aggregate') return [];
      return [
        ...new Set(
          response.results
            .map(row => row.labels[label])
            .filter((value): value is string => typeof value === 'string' && value.length > 0),
        ),
      ].sort();
    },
    [connection, requestAnalytics],
  );

  return (
    <div className={`${INSIGHTS_COLUMN_CLASS} grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 pb-8 pt-3`}>
      <p className="m-0 text-meta text-muted">
        Ask any question of the session ledger · {machines > 1 ? `across ${machines} machines` : 'this machine'}
      </p>

      <AnalyticsQueryEditor
        value={text}
        onValueChange={setText}
        onRun={() => void run(text)}
        querying={querying}
        loadValues={loadValues}
      />

      <div aria-live="polite" aria-busy={querying} className="grid min-w-0 gap-4" data-analytics-query-result="">
        {querying && (
          <p role="status" className="m-0 py-3 text-cell text-muted">
            Running the query…
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 rounded-control border border-err/40 bg-err/10 px-3 py-2 text-cell text-err">
            The query failed: {error}
          </p>
        )}
        {!querying && !error && !result && (
          <p className="m-0 text-cell text-muted">Run a query, or start from an example below.</p>
        )}
        {result && (
          <>
            <AnalyticsResponseView response={result} chart />
            {ranAt && <p className="m-0 text-2xs text-faint">Ran at {ranAt} UTC</p>}
          </>
        )}
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-4 sm:grid-cols-2">
        <SavedQueries text={text} onRun={runText} storage={savedStorage} />
        <Examples onRun={runText} />
      </div>
    </div>
  );
}

function SavedQueries({
  text,
  onRun,
  storage,
}: {
  readonly text: string;
  readonly onRun: (query: string) => void;
  readonly storage: SavedQueriesStorage | undefined;
}) {
  const nameId = useId();
  const store = useMemo(() => storage ?? browserSavedQueriesStorage(), [storage]);
  const [saved, setSaved] = useState<readonly SavedAnalyticsQuery[]>(() => loadSavedQueries(store));
  const [name, setName] = useState('');
  const [kept, setKept] = useState(true);
  const valid = readAnalyticsQuery(text).ok && text.trim() !== '' && name.trim() !== '';

  const commit = (next: readonly SavedAnalyticsQuery[]) => {
    setSaved(next);
    setKept(persistSavedQueries(store, next));
  };

  return (
    <section
      aria-labelledby={`${nameId}-title`}
      className="kt-panel grid min-w-0 content-start gap-3 p-3"
      data-analytics-saved=""
    >
      <h3 id={`${nameId}-title`} className="m-0 text-cell font-semibold text-fg">
        Saved queries
      </h3>
      <form
        className="flex min-w-0 gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (!valid) return;
          commit(addSavedQuery(saved, name, text, newId));
          setName('');
        }}
      >
        <label htmlFor={nameId} className="sr-only">
          Name for the current query
        </label>
        <input
          id={nameId}
          className="kt-input min-h-[44px] min-w-0 flex-1"
          value={name}
          maxLength={80}
          placeholder="Name this query"
          onChange={event => setName(event.currentTarget.value)}
        />
        <Button type="submit" variant="outline" disabled={!valid} className="min-h-[44px] shrink-0">
          Save
        </Button>
      </form>
      {!kept && (
        <p role="status" className="m-0 text-2xs text-warn">
          This browser would not keep the list; it lasts until the page closes.
        </p>
      )}
      {saved.length === 0 ? (
        <p className="m-0 text-cell text-muted">Nothing saved yet. Name the query above and save it.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {saved.map(item => (
            <li key={item.id} className="flex min-w-0 items-center gap-2" data-analytics-saved-item={item.name}>
              <button
                type="button"
                onClick={() => onRun(item.query)}
                className="grid min-h-[44px] min-w-0 flex-1 content-center text-left"
                title={item.query}
              >
                <span className="truncate text-cell font-medium text-fg">{item.name}</span>
                <span className="mono truncate text-2xs text-muted">{item.query}</span>
              </button>
              <button
                type="button"
                aria-label={`Delete saved query ${item.name}`}
                onClick={() => commit(removeSavedQuery(saved, item.id))}
                className="kt-btn kt-btn--sm min-h-[44px] min-w-[44px] shrink-0 text-muted"
                data-variant="ghost"
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Examples({ onRun }: { readonly onRun: (query: string) => void }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="kt-panel grid min-w-0 content-start gap-2 p-3"
      data-analytics-examples=""
    >
      <h3 id={titleId} className="m-0 text-cell font-semibold text-fg">
        Examples
      </h3>
      <ul className="m-0 grid list-none gap-1 p-0">
        {ANALYTICS_QUERY_EXAMPLES.map(example => (
          <li key={example.id}>
            <button
              type="button"
              onClick={() => onRun(example.query)}
              title={example.hint}
              className="grid min-h-[44px] w-full min-w-0 content-center text-left"
            >
              <span className="truncate text-cell font-medium text-fg">{example.title}</span>
              <span className="mono truncate text-2xs text-muted">{example.query}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
