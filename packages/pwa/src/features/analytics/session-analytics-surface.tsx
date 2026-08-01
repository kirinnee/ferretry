// SESSION ANALYTICS — one editable query and the result it owns.
//
// There is intentionally no independent cost summary above this surface. The
// default query IS the normal view; changing it replaces every value below.
// The exact session id is forced through the shared query parser before every
// transport (see `fetchSessionAnalytics`), so editing or deleting the visible
// matcher can never turn this side pane into a fleet query. Connection and
// session are explicit inputs: a daemon or session switch renders any in-flight
// response or error inert, clears the prior ledger during the re-scoped render,
// and rescopes the autocomplete value cache with it.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AnalyticsResponse } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { Button } from '../../shell/primitives.tsx';
import { fetchSessionAnalytics } from './analytics-api.ts';
import { AnalyticsQueryAutocomplete } from './analytics-query-autocomplete.tsx';
import { AnalyticsResponseView, analyticsErrorMessage } from './analytics-response-view.tsx';
import { sessionAnalyticsDefaultQuery, sessionAnalyticsStarterQueries } from './session-analytics-query.ts';

/** Injectable request seam, mirroring GlobalAnalyticsPage but carrying the scope. */
export type SessionAnalyticsRequest = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  query?: string,
) => Promise<AnalyticsResponse>;

/**
 * Distinct, sorted values for one label from an aggregate response. A raw
 * response offers none. Pure so the autocomplete's dedupe/sort behaviour is
 * unit-testable without mounting the combobox.
 */
export const sessionAnalyticsLabelValues = (response: AnalyticsResponse, label: string): readonly string[] => {
  if (response.kind !== 'aggregate') return [];
  return [
    ...new Set(
      response.results
        .map(row => row.labels[label])
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ].sort();
};

export interface SessionAnalyticsSurfaceProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Injectable for deterministic render and screenshot harnesses. */
  readonly requestAnalytics?: SessionAnalyticsRequest;
}

/**
 * The scrolling content only; the side pane owns the titlebar and close chrome.
 *
 * Effects and callbacks key off the STABLE `scope.daemonId`/`scope.sessionId`
 * primitives, never the scope object's identity, so recreating an equivalent
 * scope does not refetch; only a genuine daemon or session change does. Its
 * request serial is local to this mounted (connection, scope) pair, so a late
 * response or error from session A on daemon A cannot overwrite the fresh screen
 * after navigation switches to session B or to daemon B.
 */
export function SessionAnalyticsSurface({
  connection,
  scope,
  requestAnalytics = fetchSessionAnalytics,
}: SessionAnalyticsSurfaceProps) {
  const queryId = useId();
  // Destructure once: every hook below depends on these stable primitives, not
  // on `scope` itself, so an equivalent recreated scope leaves the hooks stable.
  const { daemonId: scopeDaemonId, sessionId } = scope;
  const defaultQuery = useMemo(() => sessionAnalyticsDefaultQuery(sessionId), [sessionId]);
  const starters = useMemo(() => sessionAnalyticsStarterQueries(sessionId), [sessionId]);
  const treeSuggestions = useMemo(() => [{ id: sessionId, detail: 'this session' }], [sessionId]);
  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(true);
  const requestSerial = useRef(0);

  // Clear a prior scope's result/error DURING the re-scoped render (React's
  // canonical "adjust state when a prop changes" pattern), so switching session
  // or daemon never flashes the previous ledger while the new request is loading.
  const [renderedDaemon, setRenderedDaemon] = useState(scopeDaemonId);
  const [renderedSession, setRenderedSession] = useState(sessionId);
  if (scopeDaemonId !== renderedDaemon || sessionId !== renderedSession) {
    setRenderedDaemon(scopeDaemonId);
    setRenderedSession(sessionId);
    requestSerial.current += 1;
    setQuery(defaultQuery);
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
        const response = await requestAnalytics(
          connection,
          { daemonId: scopeDaemonId, sessionId },
          source.trim() || undefined,
        );
        if (serial !== requestSerial.current) return;
        // The daemon returns the enforced, canonical matcher. Showing it makes
        // the executed scope inspectable even if the reader removed it.
        setQuery(response.query);
        setResult(response);
      } catch (reason) {
        if (serial === requestSerial.current) setError(analyticsErrorMessage(reason));
      } finally {
        if (serial === requestSerial.current) setQuerying(false);
      }
    },
    [connection, scopeDaemonId, sessionId, requestAnalytics],
  );

  useEffect(() => {
    setQuery(defaultQuery);
    void runQuery(defaultQuery);
    return () => {
      requestSerial.current += 1;
    };
  }, [defaultQuery, runQuery]);

  // The autocomplete memoises its label-value cache on the identity of
  // `loadValues`, so this callback is rescoped to connection plus both scope
  // fields — otherwise switching daemon or session reuses another scope's values.
  const loadValues = useCallback(
    async (label: string): Promise<readonly string[]> => {
      const response = await requestAnalytics(
        connection,
        { daemonId: scopeDaemonId, sessionId },
        `count by (${label})`,
      );
      return sessionAnalyticsLabelValues(response, label);
    },
    [connection, scopeDaemonId, sessionId, requestAnalytics],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-4 pt-3 scroll-thin">
      <section aria-labelledby="session-analytics-query" className="grid min-w-0 gap-3">
        <header className="grid gap-1 border-l-2 border-accent pl-3">
          <h3 id="session-analytics-query" className="kt-label m-0">
            Query this session
          </h3>
          <p className="m-0 text-meta leading-base text-muted">
            Always constrained to <span className="mono text-fg-soft">{sessionId}</span>. The default{' '}
            <span className="mono">sum by (model)</span> returns tokens and equivalent API cost; the chips expose every
            aggregate supported by the language.
          </p>
        </header>

        <div
          className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin"
          role="toolbar"
          aria-label="Aggregations"
        >
          {starters.map(starter => (
            <Button
              key={starter.id}
              type="button"
              className="min-h-[44px] shrink-0 font-mono text-xs"
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
            Session analytics query
          </label>
          <AnalyticsQueryAutocomplete
            key={`${scopeDaemonId}\u0000${sessionId}`}
            inputId={queryId}
            value={query}
            onValueChange={setQuery}
            onRun={() => void runQuery(query)}
            disabled={querying}
            sources={{ treeIds: treeSuggestions }}
            loadValues={loadValues}
            placeholder="sum by (model)"
          />
          <Button type="submit" className="min-h-[44px] shrink-0" disabled={querying}>
            {querying ? (
              <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              'Run'
            )}
            {querying && <span className="sr-only">Running query</span>}
          </Button>
        </form>

        <div aria-live="polite" aria-busy={querying} className="grid min-w-0 gap-xs">
          {querying && (
            <p role="status" className="m-0 py-3 text-cell text-muted">
              Reading this session’s indexed ledger…
            </p>
          )}
          {error && (
            <p role="alert" className="m-0 text-meta text-err">
              {error} Cost remains unknown; no zero was assumed.
            </p>
          )}
          {result && <AnalyticsResponseView response={result} />}
        </div>

        {result && (
          <p className="m-0 text-2xs text-faint">
            Index: {result.index.tokenSessions} token-complete of {result.index.sessions};{' '}
            {result.index.pendingTranscriptSources} source
            {result.index.pendingTranscriptSources === 1 ? '' : 's'} pending
            {result.index.refreshing ? ' (backfill in progress)' : ''}.
          </p>
        )}
      </section>
    </div>
  );
}
