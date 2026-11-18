/**
 * `ferret.side:usage`: Info › Usage — how full this ferret's context is, what its turns have cost, and how much of its
 * login's quota is left (today's `session-info/info-usage.tsx`).
 *
 * Every number has a source and none is invented: context and turns are the ferret's live reading (a fact it does not
 * state is unknown; the analytics row stands in only when the live route is unavailable), tokens and cost are this
 * ferret's own analytics row (read scoped to the ferret, where the daemon enforces the id), and the quota is the
 * daemon's passive usage feed for the login the row names. The row gates only tokens, cost and quota. A total the analytics could not price says "unknown", never $0.00, and a login with no
 * quota reading says "usage unknown".
 */
import { useFerretWorkspace, useOptionalRouter } from '@ferretry/app';
import { Loading, RouteLink } from '@ferretry/app/ui';
import { type FerretLiveRead, FerretLiveReadSchema } from '@ferretry/core-ferrets/contract';
import { useEffect, useState } from 'react';
import type { AnalyticsRawSession } from '../../contract/index.ts';
import { fetchSessionAnalytics } from '../features/analytics/analytics-api.ts';
import { costGapReason } from '../features/analytics/analytics-cost-gaps.ts';
import { formatTokens, formatUsd } from '../features/analytics/analytics-overview.ts';
import { analyticsIdQuery } from '../features/analytics/session-analytics-query.ts';
import { useUsage } from '../hooks/use-usage.ts';
import type { DaemonUsageStore } from '../lib/usage-store.ts';
import { browserClock, daemonInsightsPath, type UsageClient, useDaemonConnection } from '../shell.ts';
import { quotaMoneyText, quotaResetsIn } from './quota-readout.tsx';

/** This ferret's own analytics: the `ferret.side` panel Usage's manifest places beside the chat. */
const INSIGHTS_PANEL = 'insights';

/** How often the live turns and context are read again while the panel is open. */
const LIVE_POLL_MS = 10_000;

/** What the live route said: nothing yet, its answer, or that it is not there (an error, a 404, a 501, an odd answer). */
type Live =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly read: FerretLiveRead }
  | { readonly kind: 'unavailable' };

/**
 * The ferret's turns and context as its state document stands now (`GET /v1/ferrets/:ferretId/live`): the analytics
 * end-of-turn row is only the previous turn's numbers during a long turn, so this is read in preference. A successful
 * read is the answer even for a fact it does not state (that fact is unknown, never the row's); the row stands in
 * only when the route itself is unavailable.
 */
function useLive(client: UsageClient, subject: string | undefined): Live {
  const [live, setLive] = useState<Live>({ kind: 'loading' });
  useEffect(() => {
    if (subject === undefined) return;
    let current = true;
    const read = (): void => {
      client.call('GET /v1/ferrets/:ferretId/live', { params: { ferretId: subject } }).then(
        answer => {
          if (!current) return;
          const parsed = FerretLiveReadSchema.safeParse(answer);
          setLive(parsed.success ? { kind: 'read', read: parsed.data } : { kind: 'unavailable' });
        },
        () => {
          if (current) setLive({ kind: 'unavailable' });
        },
      );
    };
    setLive({ kind: 'loading' });
    read();
    const timer = setInterval(read, LIVE_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [client, subject]);
  return live;
}

/** The context and turns as the panel draws them, and where they came from. */
type Figures =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'known';
      readonly contextPercent: number | null;
      readonly contextWindow: number | null;
      readonly contextTokens: number | null;
      readonly turns: number | null;
    };

/** Live when the route answered (a fact it leaves out is unknown); the analytics row only when the route is unavailable. */
function figuresOf(live: Live, analytics: Read, row: AnalyticsRawSession | null): Figures {
  if (live.kind === 'read')
    return {
      kind: 'known',
      contextPercent: live.read.contextPercent,
      contextWindow: live.read.contextPercent === null ? null : live.read.contextWindow,
      contextTokens: live.read.contextPercent === null ? null : live.read.contextTokens,
      turns: live.read.turns,
    };
  if (live.kind === 'loading' || analytics.kind === 'loading') return { kind: 'pending' };
  return {
    kind: 'known',
    contextPercent: row?.contextEndPercent ?? null,
    contextWindow: null,
    contextTokens: null,
    turns: row?.turns ?? null,
  };
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly row: AnalyticsRawSession | null }
  | { readonly kind: 'failed'; readonly reason: string };

/** “124K of 200K tokens”: the used count only beside the window it is out of; the window alone says “of 200K tokens”. */
function contextWordsOf(figures: Extract<Figures, { kind: 'known' }>): string | null {
  if (figures.contextWindow === null) return null;
  const window = formatTokens(figures.contextWindow);
  return figures.contextTokens === null
    ? `of ${window} tokens`
    : `${formatTokens(figures.contextTokens)} of ${window} tokens`;
}

const percentOf = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

function Row({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 items-baseline justify-between gap-sm text-cell"
      data-info-row={label}
      {...(hint === undefined ? {} : { title: hint })}
    >
      <span className="text-muted">{label}</span>
      <span className="flex min-w-0 items-baseline gap-xs">{children}</span>
    </div>
  );
}

const Muted = ({ children }: { readonly children: React.ReactNode }) => <span className="text-muted">{children}</span>;

function Meter({ label, percent }: { readonly label: string; readonly percent: number }) {
  const value = percentOf(percent);
  return (
    <span className="flex items-center gap-xs">
      <progress aria-label={label} max={100} value={value} />
      <span className="mono tabular-nums">{value}%</span>
    </span>
  );
}

function tokensText(row: AnalyticsRawSession): string {
  const part = (label: string, value: number | null) => (value === null ? null : `${label} ${formatTokens(value)}`);
  const parts = [
    part('in', row.inputTokens),
    part('out', row.outputTokens),
    part('cache', row.cachedInputTokens),
  ].filter((text): text is string => text !== null);
  return parts.length === 0 ? 'unknown' : parts.join(' · ');
}

export function FerretUsageInfoPanel({
  client,
  store,
  subject,
  now = () => browserClock.now().getTime(),
}: {
  readonly client: UsageClient;
  readonly store: DaemonUsageStore;
  readonly subject?: string;
  readonly now?: () => number;
}) {
  const connection = useDaemonConnection();
  const router = useOptionalRouter();
  const workspace = useFerretWorkspace();
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const live = useLive(client, subject);
  useUsage(store, connection);
  useEffect(() => {
    if (subject === undefined) return;
    let current = true;
    setRead({ kind: 'loading' });
    fetchSessionAnalytics(
      connection,
      client,
      { daemonId: connection.daemonId, sessionId: subject },
      analyticsIdQuery(subject),
    ).then(
      response => {
        if (!current) return;
        const row = response.kind === 'raw' ? (response.results.find(entry => entry.id === subject) ?? null) : null;
        setRead({ kind: 'ready', row });
      },
      (reason: unknown) => {
        if (current) setRead({ kind: 'failed', reason: reason instanceof Error ? reason.message : String(reason) });
      },
    );
    return () => {
      current = false;
    };
  }, [client, connection, subject]);
  if (subject === undefined) return null;

  // Inside this ferret's own workspace, on this daemon, whose layout places the Insights panel, the link brings THIS
  // ferret's analytics on screen (v4 opened the ferret-scoped pane); anywhere else it is the machine's Insights page.
  const here =
    workspace !== null &&
    workspace.daemon === connection.daemonId &&
    workspace.ferret === subject &&
    workspace.shows(INSIGHTS_PANEL)
      ? workspace
      : null;
  const row = read.kind === 'ready' ? read.row : null;
  // The live reading wins: the analytics row is the end of the PREVIOUS turn while a long one runs. The row gates only
  // what the row alone holds (tokens, cost, quota); the live context, turns and Insights link stand without it.
  const figures = figuresOf(live, read, row);
  const contextWords = figures.kind === 'known' ? contextWordsOf(figures) : null;
  const contextHint =
    figures.kind === 'known' && figures.contextTokens !== null && figures.contextWindow !== null
      ? `${figures.contextTokens.toLocaleString('en-US')} of ${figures.contextWindow.toLocaleString('en-US')} tokens used in the context window`
      : null;
  const liveTurns = live.kind === 'read' ? (live.read.turns ?? 0) : 0;
  const quota =
    row?.agent == null ? null : store.quotaFor(connection.daemonId, { state: {}, config: { agent: row.agent } });
  const stamp = now();
  const windows = [
    ['5 hours', quota?.fiveHourPercent, quota?.fiveHourResetAt],
    ['Week', quota?.weeklyPercent, quota?.weeklyResetAt],
  ].flatMap(([label, percent, resetAt]) => {
    if (percent === undefined) return [];
    const resets = quotaResetsIn(resetAt as number | undefined, stamp);
    return [
      <Row key={label as string} label={label as string}>
        <Meter label={`${label} quota used`} percent={percent as number} />
        {resets === null ? null : <Muted>resets in {resets}</Muted>}
      </Row>,
    ];
  });

  return (
    <section aria-label="Usage" className="grid min-w-0 gap-sm px-panel py-3" data-info-usage={read.kind}>
      {read.kind === 'loading' ? <Loading kind="bar" label="Reading…" /> : null}
      {read.kind === 'failed' ? <Muted>Couldn’t read: {read.reason}</Muted> : null}
      {read.kind === 'ready' && row === null && liveTurns === 0 ? <Muted>No turns recorded yet</Muted> : null}
      <Row label="Context" {...(contextHint === null ? {} : { hint: contextHint })}>
        {figures.kind === 'pending' ? (
          <Loading kind="bar" label="Reading…" />
        ) : figures.contextPercent === null ? (
          <Muted>Not reported yet</Muted>
        ) : (
          <>
            <Meter label="Context used" percent={figures.contextPercent} />
            {contextWords === null ? null : <Muted>{contextWords}</Muted>}
          </>
        )}
      </Row>
      <Row label="Turns">
        {figures.kind === 'pending' ? (
          <Loading kind="bar" label="Reading…" />
        ) : figures.turns === null ? (
          <Muted>unknown</Muted>
        ) : (
          String(figures.turns)
        )}
      </Row>
      {row === null ? null : (
        <>
          <Row label="Tokens">{tokensText(row)}</Row>
          <Row label="Cost (equiv.)">
            {row.equivalentApiCostUsdMicros === null ? (
              <Muted>
                usage unknown — {row.costGap == null ? 'no pricing for this model' : costGapReason(row.costGap)}
              </Muted>
            ) : (
              <>
                {formatUsd(row.equivalentApiCostUsdMicros)}
                <Muted>this ferret</Muted>
              </>
            )}
          </Row>
        </>
      )}
      <Row label="Insights">
        <RouteLink
          className="text-cell"
          data-info-open-insights=""
          title={here === null ? 'Open the machine’s Insights' : 'Show this ferret’s Insights panel'}
          to={daemonInsightsPath(connection.daemonId)}
          {...(here === null
            ? router
              ? { onNavigate: router.navigate }
              : {}
            : { onNavigate: () => here.showPanel(INSIGHTS_PANEL) })}
        >
          Open Insights
        </RouteLink>
      </Row>
      {row === null ? null : (
        <>
          <h3 className="m-0 mt-2 text-meta font-semibold text-muted">Login quota · {row.agent ?? 'unknown login'}</h3>
          {windows.length === 0 ? (
            <Row label="Quota">{quotaMoneyText(quota) ?? <Muted>usage unknown</Muted>}</Row>
          ) : (
            windows
          )}
          {quota?.atLimit === true ? <Row label="State">At its limit</Row> : null}
        </>
      )}
    </section>
  );
}
