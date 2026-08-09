/** Fleet-wide analytics, scoped to the paired daemon selected by the route. */

import type { AnalyticsResponse } from '@ferretry/protocol';
import { ChartNoAxesCombined, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { fetchAnalytics } from './analytics-api.ts';
import { AnalyticsQueryAutocomplete } from './analytics-query-autocomplete.tsx';
import { AnalyticsResponseView, analyticsErrorMessage } from './analytics-response-view.tsx';
import { AnalyticsTimeSeries } from './analytics-time-series.tsx';
import type { AnalyticsStarter } from './session-analytics-query.ts';

export const GLOBAL_ANALYTICS_DEFAULT_QUERY = 'sum by (day)';

/** One starter shape serves both analytics destinations; it is declared with the pure query grammar. */
export type { AnalyticsStarter } from './session-analytics-query.ts';

export const GLOBAL_ANALYTICS_STARTERS: readonly AnalyticsStarter[] = [
  {
    id: 'daily',
    label: 'Daily',
    query: GLOBAL_ANALYTICS_DEFAULT_QUERY,
    hint: 'Sessions, tokens, and equivalent API cost per UTC day.',
  },
  { id: 'weekly', label: 'Weekly', query: 'sum by (week)', hint: 'The same ledger rolled up by ISO week.' },
  { id: 'models', label: 'By model', query: 'sum by (model)', hint: 'Fleet totals by attributed model.' },
  {
    id: 'pricing-coverage',
    label: 'Pricing coverage',
    query: 'sum by (token_data)',
    hint: 'Groups known and unknown token evidence. Equivalent-cost coverage on each row exposes unpriced sessions without treating them as zero.',
  },
  {
    id: 'identity-check',
    label: 'Identity check',
    query: 'count by (model, pricing_model)',
    hint: 'Selected model beside transcript pricing model; different values expose attribution disagreement.',
  },
  { id: 'average', label: 'Average', query: 'avg by (model)', hint: 'Average measures per grouped model.' },
  { id: 'maximum', label: 'Maximum', query: 'max by (model)', hint: 'Largest per-session measures by model.' },
  {
    id: 'status',
    label: 'Status count',
    query: 'count by (status)',
    hint: 'Session counts only; no token or cost measures.',
  },
];

export type AnalyticsRequest = (daemon: DaemonConnection, query?: string) => Promise<AnalyticsResponse>;

export interface GlobalAnalyticsPageProps {
  readonly connection: DaemonConnection;
  /** Injectable for deterministic render and screenshot harnesses. */
  readonly requestAnalytics?: AnalyticsRequest;
}

/**
 * The route-level analytics screen. Its request serial is deliberately local
 * to this mounted daemon connection: a late response from daemon A cannot
 * overwrite the fresh screen after navigation switches to daemon B.
 */
export function GlobalAnalyticsPage({ connection, requestAnalytics = fetchAnalytics }: GlobalAnalyticsPageProps) {
  const queryId = useId();
  const [query, setQuery] = useState(GLOBAL_ANALYTICS_DEFAULT_QUERY);
  const [result, setResult] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(true);
  const requestSerial = useRef(0);
  const treeIds = useMemo(() => [], []);
  const [renderedDaemon, setRenderedDaemon] = useState(connection.daemonId);

  // Invalidate daemon A during the re-scoped render. Waiting for an effect
  // cleanup leaves one committed frame in which A can still publish under B.
  if (renderedDaemon !== connection.daemonId) {
    setRenderedDaemon(connection.daemonId);
    requestSerial.current += 1;
    setQuery(GLOBAL_ANALYTICS_DEFAULT_QUERY);
    setQuerying(true);
    setResult(null);
    setError(null);
  }

  const runQuery = useCallback(
    async (source: string) => {
      const serial = ++requestSerial.current;
      setQuerying(true);
      setError(null);
      setResult(null);
      try {
        const response = await requestAnalytics(connection, source.trim() || undefined);
        if (serial !== requestSerial.current) return;
        setQuery(response.query);
        setResult(response);
      } catch (reason) {
        if (serial === requestSerial.current) setError(analyticsErrorMessage(reason));
      } finally {
        if (serial === requestSerial.current) setQuerying(false);
      }
    },
    [connection, requestAnalytics],
  );

  useEffect(() => {
    setQuery(GLOBAL_ANALYTICS_DEFAULT_QUERY);
    void runQuery(GLOBAL_ANALYTICS_DEFAULT_QUERY);
    return () => {
      requestSerial.current += 1;
    };
  }, [runQuery]);

  const loadValues = useCallback(
    async (label: string): Promise<readonly string[]> => {
      const response = await requestAnalytics(connection, `count by (${label})`);
      if (response.kind !== 'aggregate') return [];
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
    <main
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
      aria-label="Global analytics"
      data-daemon={connection.daemonId}
    >
      <div className="mx-auto grid w-full max-w-[1500px] min-w-0 gap-4 px-2 pb-8 pt-3 sm:px-5 sm:pt-5">
        <header className="relative overflow-hidden rounded-panel border-panel border-border-strong bg-surface-2 px-4 py-4 shadow-panel sm:px-5">
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-1 bg-accent shadow-[8px_0_0_var(--border-soft)]"
          />
          <div className="relative grid gap-2 pl-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="min-w-0">
              <p className="mono m-0 text-2xs uppercase tracking-[0.18em] text-accent">Fleet ledger / all sessions</p>
              <h1 className="m-0 mt-1 font-display text-2xl font-semibold leading-tight text-fg">Global analytics</h1>
              <p className="m-0 mt-1 max-w-[68ch] text-cell leading-base text-muted">
                Query every indexed session. The daily default drives the charts and ledger below from one daemon
                response; cached reads and writes retain their harness-specific rates from the operator's catalog.
              </p>
            </div>
            <div className="flex items-center gap-2 border-t border-border-soft pt-2 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <ChartNoAxesCombined size={18} className="text-accent" aria-hidden="true" />
              <div>
                <span className="kt-label block">Default query</span>
                <span className="mono text-cell text-fg">{GLOBAL_ANALYTICS_DEFAULT_QUERY}</span>
              </div>
            </div>
          </div>
        </header>

        <section aria-labelledby="global-analytics-query" className="grid min-w-0 gap-3">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="global-analytics-query" className="kt-label m-0 text-fg-soft">
              Query the fleet
            </h2>
            <p className="m-0 text-meta text-muted">UTC calendar buckets · archived and active sessions</p>
          </header>

          <div
            className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin"
            aria-label="Query starters"
            role="toolbar"
          >
            {GLOBAL_ANALYTICS_STARTERS.map(starter => (
              // `outline` at the DEFAULT size: kteam's starters are a bare
              // `kt-btn`, and `size="sm"` would swap the control height,
              // inline padding and font size for the compact set.
              <Button
                key={starter.id}
                type="button"
                variant="outline"
                className="min-h-[44px] shrink-0 text-xs"
                title={starter.hint}
                onClick={() => {
                  setQuery(starter.query);
                  void runQuery(starter.query);
                }}
                disabled={querying}
              >
                {starter.label}
              </Button>
            ))}
          </div>

          <form
            className="flex min-w-0 gap-2"
            onSubmit={event => {
              event.preventDefault();
              void runQuery(query);
            }}
          >
            <label htmlFor={queryId} className="sr-only">
              Global analytics query
            </label>
            <AnalyticsQueryAutocomplete
              key={connection.daemonId}
              inputId={queryId}
              value={query}
              onValueChange={setQuery}
              onRun={() => void runQuery(query)}
              disabled={querying}
              sources={{ treeIds }}
              loadValues={loadValues}
              placeholder={GLOBAL_ANALYTICS_DEFAULT_QUERY}
            />
            {/* Run is the DEFAULT outline control, exactly as in kteam. A primary
                fill would make the query box the loudest thing on a page whose
                subject is the result below it. */}
            <Button type="submit" variant="outline" disabled={querying} className="min-h-[44px] shrink-0">
              {querying ? (
                <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                'Run'
              )}
              {querying && <span className="sr-only">Running query</span>}
            </Button>
          </form>

          <div aria-live="polite" aria-busy={querying} className="grid min-w-0 gap-4">
            {querying && (
              <p role="status" className="m-0 py-6 text-center text-cell text-muted">
                Reading the fleet ledger…
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="m-0 rounded-control border border-err/40 bg-err/10 px-3 py-2 text-cell text-err"
              >
                Analytics could not load: {error} Unknown data was not treated as zero.
              </p>
            )}
            {result?.kind === 'aggregate' && <AnalyticsTimeSeries response={result} />}
            {result && <AnalyticsResponseView response={result} />}
          </div>

          {result && (
            <p className="m-0 text-2xs text-faint">
              Index: {result.index.tokenSessions} token-complete of {result.index.sessions};{' '}
              {result.index.pendingTranscriptSources} source
              {result.index.pendingTranscriptSources === 1 ? '' : 's'} pending
              {result.index.refreshing ? ' (backfill in progress)' : ''}. Equivalent API cost applies the rates this
              daemon's operator configured; it is never subscription spend.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
