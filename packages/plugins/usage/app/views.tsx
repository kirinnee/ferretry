/**
 * THE VIEWS THE MANIFEST DECLARES, composed from today's components: the Insights screens (`insights`,
 * `insights-query`), the top-bar quota readout (`top:quota`), a ferret's own insights (`ferret.side:insights`) and the
 * three Settings tabs (`budgets`, `model-pricing`, `performance`). Each takes the daemon's client the shell built the
 * half with; none reaches a daemon any other way.
 */
import { useOptionalRouter } from '@ferretry/app';
import type { ComposerAccount } from '@ferretry/plugin-conversation/contract';
import { createElement, type ReactNode } from 'react';
import { GlobalAnalyticsPage } from './features/analytics/global-analytics-page.tsx';
import { SessionAnalyticsSurface } from './features/analytics/session-analytics-surface.tsx';
import { BudgetsSettings } from './features/settings/budgets-settings.tsx';
import { PerformanceSettings } from './features/settings/performance-settings.tsx';
import { PricingSettings } from './features/settings/pricing-settings.tsx';
import { useUsage } from './hooks/use-usage.ts';
import type { PerformanceRecorder } from './lib/performance/recorder.ts';
import type { DaemonUsageStore } from './lib/usage-store.ts';
import { type InsightsView, type UsageClient, useDaemonConnection } from './shell.ts';
import { InsightsFrame } from './shell/insights-frame.tsx';
import { ComposerQuota } from './shell/composer-quota.tsx';
import { QuotaReadout } from './shell/quota-readout.tsx';

const noNavigate = (): void => undefined;

/** `insights` and `insights-query`: Insights inside its frame, on the page the address names. */
export function InsightsScreen({ client, view }: { readonly client: UsageClient; readonly view: InsightsView }) {
  const connection = useDaemonConnection();
  const navigate = useOptionalRouter()?.navigate ?? noNavigate;
  return (
    <InsightsFrame current="insights" daemonId={connection.daemonId} onNavigate={to => navigate(to)}>
      <GlobalAnalyticsPage connection={connection} client={client} view={view} onNavigate={to => navigate(to)} />
    </InsightsFrame>
  );
}

/** `ferret.side:insights`: what the ferret in view has cost so far. */
export function FerretInsightsPanel({ client, subject }: { readonly client: UsageClient; readonly subject?: string }) {
  const connection = useDaemonConnection();
  if (subject === undefined) return null;
  return createElement(SessionAnalyticsSurface, {
    connection,
    client,
    scope: { daemonId: connection.daemonId, sessionId: subject },
  });
}

/**
 * `top:quota`: the quota readout in the top bar, from the daemon's cached account feed (`GET /v1/usage`). The login
 * of the ferret in view is Ferrets' to name, so the readout shows that account when `subject` names one the feed
 * carries and otherwise the account closest to its limit; unknown stays "quota —", never 0%.
 */
export function QuotaPanel({ store, subject }: { readonly store: DaemonUsageStore; readonly subject?: string }) {
  const connection = useDaemonConnection();
  const slice = useUsage(store, connection);
  const accounts = slice.feed?.accounts ?? [];
  const named = accounts.find(account => account.agent === subject);
  const tightest = [...accounts].sort(
    (left, right) =>
      Math.max(right.fiveHourPercent ?? 0, right.weeklyPercent ?? 0) -
      Math.max(left.fiveHourPercent ?? 0, left.weeklyPercent ?? 0),
  )[0];
  const account = named ?? tightest;
  const quota =
    account === undefined ? null : store.quotaFor(connection.daemonId, { state: {}, config: { agent: account.agent } });
  return createElement(QuotaReadout, { quota, showUnknown: true, className: 'text-meta' });
}

/**
 * `composer.tools:composer-quota`: the quota of the account THIS ferret runs on, on the composer's context row. Today's
 * composer read it from the session itself: the usage the ferret's monitor stamped, else the feed row of `config.agent`.
 * Conversation's composer hands both as `account` (`ComposerToolsProps`; `subject` is the ferret id, which no feed row
 * is named after). Without an account, or when the feed does not name it, it says "usage unknown": the account nearest
 * its limit is not that ferret's, so it is never drawn as the composer's own (unknown is not a confident number).
 */
export function ComposerQuotaPanel({
  store,
  account,
}: {
  readonly store: DaemonUsageStore;
  readonly account?: ComposerAccount;
}) {
  const connection = useDaemonConnection();
  useUsage(store, connection);
  const quota =
    account === undefined
      ? null
      : store.quotaFor(connection.daemonId, { state: account.usage ?? {}, config: { agent: account.agent } });
  return createElement(ComposerQuota, { quota });
}

export function BudgetsTab({ client }: { readonly client: UsageClient }): ReactNode {
  const connection = useDaemonConnection();
  return createElement(BudgetsSettings, { connection, client });
}

export function ModelPricingTab({ client }: { readonly client: UsageClient }): ReactNode {
  const connection = useDaemonConnection();
  return createElement(PricingSettings, { connection, client });
}

export function PerformanceTab({
  client,
  recorder,
}: {
  readonly client: UsageClient;
  readonly recorder: PerformanceRecorder;
}): ReactNode {
  const connection = useDaemonConnection();
  return createElement(PerformanceSettings, { connection, client, recorder });
}
