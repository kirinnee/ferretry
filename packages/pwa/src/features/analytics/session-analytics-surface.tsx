// SESSION COST — the side pane's answer to "what has this session cost so far?".
//
// Answer first: two numbers (this session, and this session with its children), then the split by
// model, then the context, turns and cache share. No table and no query box: every row is a label, a
// bar and an amount, so the amount is on screen at any pane width down to 320px. The query language is
// one link away — "Open in Analytics" arrives at the Analytics page with this session's tree already
// in Custom query.
//
// Two reads, both through the paired connection the pane was given. The session's own row goes through
// the session-scoped read, where the DAEMON enforces the id, so nothing in this pane can widen into a
// fleet query. Its children come from one read of the session's tree, filtered to its descendants here.
// A daemon or session switch remounts the body (it is keyed), so a late answer for the previous session
// lands in an unmounted instance and is never shown.

import type { AnalyticsRawSession, AnalyticsResponse } from '@ferretry/protocol';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonAnalyticsPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { useDaemonFetch } from '../../lib/store.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { fetchAnalytics, fetchSessionAnalytics } from './analytics-api.ts';
import { CostSplit, UnpricedChip } from './analytics-cost-rows.tsx';
import type { AnalyticsRequest } from './analytics-custom-query.tsx';
import { formatTokens, formatUsd } from './analytics-overview.ts';
import { analyticsErrorMessage } from './analytics-response-view.tsx';
import { analyticsIdQuery } from './session-analytics-query.ts';
import { type SessionCost, sessionCost, sessionTreeMatcher } from './session-cost.ts';

/** Injectable request seam for the session-scoped read. */
export type SessionAnalyticsRequest = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  query?: string,
) => Promise<AnalyticsResponse>;

/** The query "Open in Analytics" carries: cost by model across this session's whole tree. */
export const sessionAnalyticsLinkQuery = (session: Pick<AnalyticsRawSession, 'id' | 'tree'>): string =>
  `sum by (model) ${sessionTreeMatcher(session)}`;

export interface SessionAnalyticsSurfaceProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Injectable for deterministic render and screenshot harnesses. */
  readonly requestAnalytics?: SessionAnalyticsRequest;
  /** Injectable fleet read used for the session's tree. */
  readonly requestFleetAnalytics?: AnalyticsRequest;
}

/** The scrolling content only; the side pane owns the titlebar and close chrome. */
export function SessionAnalyticsSurface({
  connection,
  scope,
  requestAnalytics: injected,
  requestFleetAnalytics: injectedFleet,
}: SessionAnalyticsSurfaceProps) {
  // Through the carrier router by default: a paired device has no bearer value of its own to read with.
  const fetcher = useDaemonFetch();
  const requestAnalytics = useMemo<SessionAnalyticsRequest>(
    () => injected ?? ((daemon, target, query) => fetchSessionAnalytics(daemon, target, query, fetcher)),
    [fetcher, injected],
  );
  const requestFleet = useMemo<AnalyticsRequest>(
    () => injectedFleet ?? ((daemon, query) => fetchAnalytics(daemon, query, fetcher)),
    [fetcher, injectedFleet],
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-4 pt-3 scroll-thin">
      <SessionCostBody
        key={`${scope.daemonId}\u0000${scope.sessionId}`}
        connection={connection}
        daemonId={scope.daemonId}
        sessionId={scope.sessionId}
        requestAnalytics={requestAnalytics}
        requestFleet={requestFleet}
      />
    </div>
  );
}

type CostState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'not-counted' }
  | { readonly status: 'ready'; readonly cost: SessionCost };

const rawRows = (response: AnalyticsResponse): readonly AnalyticsRawSession[] =>
  response.kind === 'raw' ? response.results : [];

function SessionCostBody({
  connection,
  daemonId,
  sessionId,
  requestAnalytics,
  requestFleet,
}: {
  readonly connection: DaemonConnection;
  readonly daemonId: DaemonSessionScope['daemonId'];
  readonly sessionId: string;
  readonly requestAnalytics: SessionAnalyticsRequest;
  readonly requestFleet: AnalyticsRequest;
}) {
  const [state, setState] = useState<CostState>({ status: 'loading' });
  const router = useOptionalRouter();

  useEffect(() => {
    let current = true;
    const load = async (): Promise<CostState> => {
      const own = await requestAnalytics(connection, { daemonId, sessionId }, analyticsIdQuery(sessionId));
      const session = rawRows(own).find(row => row.id === sessionId);
      if (session === undefined) return { status: 'not-counted' };
      const tree = await requestFleet(connection, sessionTreeMatcher(session));
      return {
        status: 'ready',
        cost: sessionCost(session, rawRows(tree), tree.kind === 'raw' && tree.truncated),
      };
    };
    load().then(
      next => {
        if (current) setState(next);
      },
      (reason: unknown) => {
        if (current) setState({ status: 'error', error: analyticsErrorMessage(reason) });
      },
    );
    return () => {
      current = false;
    };
  }, [connection, daemonId, requestAnalytics, requestFleet, sessionId]);

  const linkSession = state.status === 'ready' ? state.cost.session : { id: sessionId, tree: null };
  const link = `${daemonAnalyticsPath(daemonId)}?q=${encodeURIComponent(sessionAnalyticsLinkQuery(linkSession))}`;

  return (
    <section aria-label="Session cost" className="grid min-w-0 gap-md" data-session-cost={state.status}>
      <div aria-live="polite" aria-busy={state.status === 'loading'} className="grid min-w-0 gap-md">
        {state.status === 'loading' && (
          <p role="status" className="m-0 py-3 text-cell text-muted">
            Reading this session's cost…
          </p>
        )}
        {state.status === 'error' && (
          <p role="alert" className="m-0 text-meta text-err">
            Cost could not load: {state.error} Nothing was assumed to be zero.
          </p>
        )}
        {state.status === 'not-counted' && (
          <p className="m-0 text-cell text-muted">
            Not counted yet. A session's cost is recorded once it finishes, and this one has not been indexed.
          </p>
        )}
        {state.status === 'ready' && <SessionCostFigures cost={state.cost} />}
      </div>
      <RouteLink
        to={link}
        {...(router ? { onNavigate: router.navigate } : {})}
        className="inline-flex min-h-[44px] items-center gap-xs justify-self-start text-meta text-accent hover:underline"
        data-open-analytics=""
      >
        Open in Analytics
        <ChevronRight size={14} aria-hidden="true" />
      </RouteLink>
    </section>
  );
}

function CostFigure({
  label,
  value,
  note,
  unpriced,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly unpriced: number;
}) {
  return (
    <div className="grid min-w-0 content-start gap-xs bg-surface px-sm py-sm" data-cost-figure={label}>
      <span className="text-meta text-muted">{label}</span>
      <span className="flex flex-wrap items-center gap-xs">
        <span className="mono text-title font-semibold tabular-nums text-fg">{value}</span>
        <UnpricedChip count={unpriced} />
      </span>
      <span className="text-2xs text-muted">{note}</span>
    </div>
  );
}

function SessionCostFigures({ cost }: { readonly cost: SessionCost }) {
  const own = cost.session.equivalentApiCostUsdMicros;
  const facts = [
    ...(cost.session.contextEndPercent === null ? [] : [`Context at ${Math.round(cost.session.contextEndPercent)}%`]),
    ...(cost.session.turns === null ? [] : [`${cost.session.turns} turns`]),
    ...(cost.cacheReadPercent === null ? [] : [`cache reads ${Math.round(cost.cacheReadPercent)}%`]),
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-border bg-border">
        <CostFigure
          label="This session"
          value={own === null ? 'Unpriced' : formatUsd(own)}
          note={cost.session.tokens === null ? 'Tokens not counted' : `${formatTokens(cost.session.tokens)} tokens`}
          unpriced={0}
        />
        <CostFigure
          label="With children"
          value={formatUsd(cost.withChildrenMicros)}
          note={`${cost.children}${cost.childrenPartial ? '+' : ''} child${cost.children === 1 ? '' : 'ren'}`}
          unpriced={cost.unpriced}
        />
      </div>
      <CostSplit label="Equivalent cost by model" shares={cost.models} unpriced={cost.unpriced} />
      {facts.length > 0 && <p className="m-0 text-meta text-muted">{facts.join(' · ')}</p>}
      <p className="m-0 text-2xs text-muted">
        Equivalent API cost: what these tokens cost at API rates, never billed spend.
      </p>
    </>
  );
}
