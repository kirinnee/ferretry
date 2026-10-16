/**
 * CUSTOM QUERY — the analytics query language, kept and moved out of the way.
 *
 * The language is the tool for questions the overview does not answer, so it sits last on the page,
 * closed until somebody opens it. The diagnostic starters (pricing coverage, identity check, …) live
 * inside it rather than being the page's main controls. Nothing is requested until a query is run; a
 * link that arrives with `?q=` (the session cost pane's "Open in Analytics") opens it and runs that
 * query at once.
 *
 * The component is keyed by its daemon by the page, so a daemon switch mounts a fresh one: an in-flight
 * answer from the previous daemon lands in an unmounted instance and is never shown.
 */

import type { AnalyticsResponse } from '@ferretry/protocol';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { AnalyticsQueryAutocomplete } from './analytics-query-autocomplete.tsx';
import { AnalyticsResponseView, analyticsErrorMessage } from './analytics-response-view.tsx';
import type { AnalyticsStarter } from './session-analytics-query.ts';

export const GLOBAL_ANALYTICS_DEFAULT_QUERY = 'sum by (day)';

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

export interface AnalyticsCustomQueryProps {
  readonly connection: DaemonConnection;
  readonly requestAnalytics: AnalyticsRequest;
  /** A query handed in by a link; it opens the section and runs at once. */
  readonly initialQuery?: string | null;
}

export function AnalyticsCustomQuery({ connection, requestAnalytics, initialQuery }: AnalyticsCustomQueryProps) {
  const queryId = useId();
  const [open, setOpen] = useState(Boolean(initialQuery));
  const [query, setQuery] = useState(initialQuery || GLOBAL_ANALYTICS_DEFAULT_QUERY);
  const [result, setResult] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);
  const requestSerial = useRef(0);
  const treeIds = useMemo(() => [], []);

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
    if (initialQuery) void runQuery(initialQuery);
    return () => {
      requestSerial.current += 1;
    };
  }, [initialQuery, runQuery]);

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
    <section
      aria-labelledby={`${queryId}-title`}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3"
      data-analytics-custom-query=""
    >
      <h2 id={`${queryId}-title`} className="m-0 min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex min-h-[44px] w-full min-w-0 items-center gap-sm text-left text-cell font-semibold text-fg"
        >
          <ChevronRight
            size={16}
            aria-hidden="true"
            className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
          Custom query
          {!open && (
            <span className="min-w-0 truncate text-meta font-normal text-muted">
              Any grouping, in the analytics query language
            </span>
          )}
        </button>
      </h2>

      {open && (
        <div className="grid min-w-0 gap-3">
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
              inputId={queryId}
              value={query}
              onValueChange={setQuery}
              onRun={() => void runQuery(query)}
              disabled={querying}
              sources={{ treeIds }}
              loadValues={loadValues}
              placeholder={GLOBAL_ANALYTICS_DEFAULT_QUERY}
            />
            <Button type="submit" variant="outline" disabled={querying} className="min-h-[44px] shrink-0">
              {querying ? (
                <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                'Run'
              )}
              {querying && <span className="sr-only">Running query</span>}
            </Button>
          </form>

          <div className="flex flex-wrap gap-xs" aria-label="Query starters" role="toolbar">
            {GLOBAL_ANALYTICS_STARTERS.map(starter => (
              <Button
                key={starter.id}
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-[44px] text-xs"
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

          <div aria-live="polite" aria-busy={querying} className="grid min-w-0 gap-4">
            {querying && (
              <p role="status" className="m-0 py-3 text-cell text-muted">
                Running the query…
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="m-0 rounded-control border border-err/40 bg-err/10 px-3 py-2 text-cell text-err"
              >
                The query failed: {error}
              </p>
            )}
            {result && <AnalyticsResponseView response={result} />}
          </div>
        </div>
      )}
    </section>
  );
}
