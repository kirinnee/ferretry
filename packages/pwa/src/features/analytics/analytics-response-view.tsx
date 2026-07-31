/**
 * The single response renderer shared by the analytics destinations.
 *
 * It deliberately derives every displayed value from the response supplied by
 * the daemon that the host selected at runtime. In particular, unknown pricing
 * stays unknown instead of being silently represented as a zero-cost result.
 */
import type { AnalyticsRawSession, AnalyticsResponse } from '@ferretry/protocol';

import { DaemonResponseError } from '../../lib/runtime-models.ts';
import { AnalyticsResultTable, formatUsdMicros } from './analytics-result-table.tsx';

/** Gives the temporarily unavailable analytics index an actionable explanation. */
export const analyticsErrorMessage = (error: unknown): string => {
  if (error instanceof DaemonResponseError && error.status === 503)
    return 'Analytics index is unavailable while the daemon catches up (503).';
  return error instanceof Error ? error.message : String(error);
};

const rawEquivalentCost = (row: AnalyticsRawSession): string => {
  const value = row.equivalentApiCostUsdMicros;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? formatUsdMicros(BigInt(value))
    : 'Cost unknown';
};

/**
 * Renders exactly one daemon response. Hosts own query execution and must pass
 * a response from their current DaemonConnection, preventing cross-daemon
 * caches or requests from entering this presentation layer.
 */
export function AnalyticsResponseView({ response }: { readonly response: AnalyticsResponse }) {
  const scope = (
    <p className="m-0 text-meta text-muted">
      {response.scope.matched} matched · {response.scope.indexed} indexed
    </p>
  );
  if (response.kind === 'aggregate') {
    return (
      <div className="grid min-w-0 gap-xs">
        {scope}
        <AnalyticsResultTable response={response} caption={`Result for ${response.query}`} />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-xs">
      {scope}
      {response.truncated && (
        <p role="status" className="m-0 text-meta text-warn">
          Showing the server-capped result; this query is truncated.
        </p>
      )}
      {response.results.length === 0 ? (
        <p className="m-0 rounded-control border border-border-soft bg-surface px-3 py-3 text-cell text-muted">
          No indexed session matched this query.
        </p>
      ) : (
        response.results.map(row => (
          <div
            key={row.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-control border border-border-soft bg-surface px-3 py-2 text-cell"
          >
            <span className="mono truncate text-2xs text-accent">{row.id}</span>
            <span className="text-right font-medium text-fg">{rawEquivalentCost(row)}</span>
            <span className="text-muted">
              {row.model ?? 'model unknown'} · {row.status ?? 'status unknown'} · {row.tokens ?? 'tokens unknown'}{' '}
              tokens
            </span>
            <span className="text-right text-2xs text-faint">Equivalent API cost</span>
          </div>
        ))
      )}
    </div>
  );
}
