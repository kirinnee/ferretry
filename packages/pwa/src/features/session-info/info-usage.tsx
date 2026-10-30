/**
 * Info › Usage: how full this ferret's context is, what its turns have cost, and how much of its
 * login's quota is left.
 *
 * Every number has a source and none is invented: context and turns are the session's own state, the
 * token and cost totals are this session's analytics read, and the quota is the daemon's passive usage
 * feed for the login. A total the analytics could not price says "unknown" — never $0.00 — and a login
 * with no quota reading says "usage unknown".
 */

import type { AnalyticsAggregateResult, AnalyticsResponse, SessionView } from '@ferretry/protocol';
import { BarChart3 } from 'lucide-react';
import { contextReadout } from '../../lib/context-ring.ts';
import type { ResolvedQuota } from '../../lib/usage.ts';
import { quotaMoneyText, quotaResetsIn } from '../../shell/quota-readout.tsx';
import { formatTokens, formatUsd } from '../analytics/analytics-overview.ts';
import { INFO_HINT } from './info-model.ts';
import { InfoMeter, InfoRow, InfoSection } from './info-parts.tsx';

export type InfoAnalyticsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly response: AnalyticsResponse }
  | { readonly kind: 'failed'; readonly reason: string };

export interface InfoUsageProps {
  readonly view: SessionView;
  readonly analytics: InfoAnalyticsRead;
  readonly quota: ResolvedQuota | null;
  readonly now: number;
  /** Opens this session's full analytics. */
  readonly onOpenAnalytics?: () => void;
}

/** One aggregate row for the whole session, summed over whatever the response grouped by. */
const total = (response: AnalyticsResponse): AnalyticsAggregateResult | null =>
  response.kind === 'aggregate' ? (response.results[0] ?? null) : null;

const measure = (value: { readonly value: number | null; readonly known: number; readonly total: number }) =>
  value.value === null ? null : value.value;

function Tokens({ read }: { readonly read: InfoAnalyticsRead }) {
  if (read.kind === 'loading') return <span className="fy-info-muted">Reading…</span>;
  if (read.kind === 'failed') return <span className="fy-info-muted">Couldn’t read: {read.reason}</span>;
  const row = total(read.response);
  if (row === null) return <span className="fy-info-muted">No turns recorded yet</span>;
  const part = (label: string, value: number | null) => (value === null ? null : `${label} ${formatTokens(value)}`);
  const parts = [
    part('in', measure(row.inputTokens)),
    part('out', measure(row.outputTokens)),
    part('cache', measure(row.cachedInputTokens)),
  ].filter(text => text !== null);
  return <>{parts.length === 0 ? <span className="fy-info-muted">unknown</span> : parts.join(' · ')}</>;
}

function Cost({ read }: { readonly read: InfoAnalyticsRead }) {
  if (read.kind !== 'ready') return <span className="fy-info-muted">{read.kind === 'loading' ? 'Reading…' : '—'}</span>;
  const row = total(read.response);
  const cost = row === null ? null : row.equivalentApiCostUsdMicros;
  if (cost === null || cost.value === null)
    return <span className="fy-info-muted">usage unknown — no pricing for this model</span>;
  const partial = cost.known < cost.total ? ` (${cost.total - cost.known} turns unpriced)` : '';
  return (
    <>
      {formatUsd(cost.value)}
      <span className="fy-info-muted">this ferret{partial}</span>
    </>
  );
}

const windowRow = (label: string, percent: number | undefined, resetAt: number | undefined, now: number) => {
  if (percent === undefined) return null;
  const resets = quotaResetsIn(resetAt, now);
  return (
    <InfoRow key={label} label={label}>
      <InfoMeter label={`${label} quota used`} percent={percent} />
      {resets === null ? null : <span className="fy-info-muted">resets in {resets}</span>}
    </InfoRow>
  );
};

export function InfoUsage({ view, analytics, quota, now, onOpenAnalytics }: InfoUsageProps) {
  const windows = [
    windowRow('5 hours', quota?.fiveHourPercent, quota?.fiveHourResetAt, now),
    windowRow('Week', quota?.weeklyPercent, quota?.weeklyResetAt, now),
  ].filter(row => row !== null);
  return (
    <>
      <InfoSection>
        <InfoRow hint={INFO_HINT.context} label="Context">
          {view.context !== undefined ? (
            <>
              <InfoMeter label="Context used" percent={view.context.percent} />
              <span className="fy-info-muted">{contextReadout(view.context).text}</span>
            </>
          ) : view.state.contextPercent === undefined ? (
            <span className="fy-info-muted">Not reported yet</span>
          ) : (
            <InfoMeter label="Context used" percent={view.state.contextPercent} />
          )}
        </InfoRow>
        <InfoRow label="Turns">{String(view.state.turn)}</InfoRow>
        <InfoRow label="Tokens" mono>
          <Tokens read={analytics} />
        </InfoRow>
        <InfoRow hint={INFO_HINT.cost} label="Cost (equiv.)">
          <Cost read={analytics} />
        </InfoRow>
        {onOpenAnalytics === undefined ? null : (
          <InfoRow label="Analytics">
            <button
              className="fy-info-inline-action"
              data-info-open-analytics=""
              onClick={onOpenAnalytics}
              type="button"
            >
              <BarChart3 aria-hidden="true" size={12} />
              Open this ferret’s analytics
            </button>
          </InfoRow>
        )}
      </InfoSection>
      <InfoSection title={`Login quota · ${view.config.agent}`}>
        {windows.length === 0 ? (
          <InfoRow hint={INFO_HINT.quota} label="Quota">
            {quotaMoneyText(quota) ?? <span className="fy-info-muted">usage unknown</span>}
          </InfoRow>
        ) : (
          windows
        )}
        {quota?.atLimit === true ? <InfoRow label="State">At its limit</InfoRow> : null}
      </InfoSection>
    </>
  );
}
