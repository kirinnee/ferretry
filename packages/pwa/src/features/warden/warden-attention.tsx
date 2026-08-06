/**
 * The Warden's fleet-wide answer to "who needs me, and why?".
 *
 * This deliberately has no ambient client or module cache. A composition host
 * supplies the authoritative view and receives every navigation/action with
 * the exact paired connection that owns it. That keeps a list, report, or
 * action from one daemon from being shown or sent through another pairing.
 */

import {
  Bell,
  Check,
  CircleAlert,
  Clock3,
  Gavel,
  HelpCircle,
  LoaderCircle,
  Play,
  RotateCcw,
  SquareX,
  UserRound,
} from 'lucide-react';

import { displayCallsign } from '../../lib/callsign.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { relativeTime } from '../../lib/session-screens.ts';

export type WardenAttentionOutcome = 'items' | 'clean-sweep' | 'degraded' | 'no-sweep';
export type WardenJudgementState = 'judged' | 'pending' | 'queued' | 'failed' | 'none';
export type WardenAction = 'nudge' | 'resume' | 'restart' | 'stop' | 'migrate' | 'leave';
export type WardenAttentionVerdictKind = 'killed' | 'revived' | 'nudged' | 'cleared' | 'needs_human' | 'unknown';

export interface WardenRecommendation {
  readonly action: WardenAction;
  readonly reason: string;
  readonly wrapper?: string;
}

export interface WardenJudgement {
  readonly state: WardenJudgementState;
  readonly verdict?: WardenAttentionVerdictKind;
  readonly reason?: string;
  readonly at?: string;
  readonly stale?: boolean;
  readonly reportPath?: string;
  readonly judgedBy?: { readonly wrapper?: string; readonly model?: string; readonly wardenSessionId?: string };
}

export interface FleetAttentionItem {
  readonly id?: string;
  readonly sessionId: string;
  readonly teammate?: string;
  readonly sessionStatus?: string;
  readonly subject?: string;
  readonly why?: string;
  readonly context?: string;
  readonly waitingSince?: string;
  readonly source?: string;
  readonly judgement?: WardenJudgement;
  readonly recommendation?: WardenRecommendation;
}

export interface WardenAttentionView {
  readonly items?: readonly FleetAttentionItem[];
  readonly outcome?: WardenAttentionOutcome;
  readonly lastSweepAt?: string;
  readonly generatedAt?: string;
  readonly boardsWithParseErrors?: readonly string[];
  readonly wardenDegraded?: { readonly reason?: string; readonly since?: string };
  readonly verdictCoverage?: { readonly truncated?: boolean; readonly limit?: number };
}

export type WardenAttentionState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly reason: string }
  | { readonly status: 'stale'; readonly view: WardenAttentionView; readonly reason: string }
  | { readonly status: 'ready'; readonly view: WardenAttentionView };

export const STALE_HEADLINE = 'Can’t refresh who needs you';

const judgementMeta: Record<
  WardenJudgementState,
  { readonly label: string; readonly cls: string; readonly Icon: typeof Gavel }
> = {
  judged: { label: 'Judged', cls: 'text-accent border-accent bg-accent-soft', Icon: Gavel },
  pending: { label: 'Warden checking', cls: 'text-muted border-border bg-surface-2', Icon: LoaderCircle },
  queued: { label: 'Warden queued', cls: 'text-muted border-border bg-surface-2', Icon: Clock3 },
  failed: { label: 'Warden failed', cls: 'text-err border-err-border bg-err-bg', Icon: CircleAlert },
  none: { label: 'No matching judgement', cls: 'text-warn border-warn-border bg-warn-bg', Icon: HelpCircle },
};

const verdictWord: Record<WardenAttentionVerdictKind, string> = {
  killed: 'killed the session',
  revived: 'revived the session',
  nudged: 'nudged the agent',
  cleared: 'cleared it',
  needs_human: 'needs a human',
  unknown: 'reviewed it',
};

const actionMeta: Record<Exclude<WardenAction, 'leave'>, { readonly label: string; readonly Icon: typeof Bell }> = {
  nudge: { label: 'Nudge session', Icon: Bell },
  resume: { label: 'Resume session', Icon: Play },
  restart: { label: 'Restart session', Icon: RotateCcw },
  stop: { label: 'Stop session', Icon: SquareX },
  migrate: { label: 'Migrate session', Icon: RotateCcw },
};

/** A transient fault preserves a useful result, but marks it untrustworthy. */
export const nextStateOnFailure = (state: WardenAttentionState, reason: string): WardenAttentionState =>
  state.status === 'ready' || state.status === 'stale'
    ? { status: 'stale', view: state.view, reason }
    : { status: 'error', reason };

export const orderedAttentionItems = (items: readonly FleetAttentionItem[] = []): FleetAttentionItem[] => {
  const timestamp = (value?: string): number => {
    const parsed = Date.parse(value ?? '');
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return [...items].sort((left, right) => timestamp(left.waitingSince) - timestamp(right.waitingSince));
};

export const attentionOutcome = (view: WardenAttentionView): WardenAttentionOutcome => {
  if (view.outcome !== undefined) return view.outcome;
  if ((view.items?.length ?? 0) > 0) return 'items';
  if ((view.boardsWithParseErrors?.length ?? 0) > 0) return 'degraded';
  return view.lastSweepAt === undefined ? 'no-sweep' : 'clean-sweep';
};

export const attentionHeadline = (view: WardenAttentionView): string => {
  const agents = new Set((view.items ?? []).map(item => item.sessionId)).size;
  if (agents > 0) return agents === 1 ? '1 agent needs you' : `${agents} agents need you`;
  if (attentionOutcome(view) === 'clean-sweep') return 'No agents need you';
  if (attentionOutcome(view) === 'degraded') return 'Can’t say who needs you';
  return 'No warden judgement yet';
};

export const judgementSummary = (judgement: WardenJudgement): string => {
  if (judgement.state === 'judged') {
    const verdict = judgement.verdict === undefined ? 'reviewed it' : verdictWord[judgement.verdict];
    return judgement.reason ? `Warden: ${verdict} — ${judgement.reason}` : `Warden: ${verdict}`;
  }
  if (judgement.state === 'pending') return 'Warden is checking this now.';
  if (judgement.state === 'queued') return 'Waiting for a warden to pick this up.';
  if (judgement.state === 'failed') return `Warden could not judge — ${judgement.reason ?? 'reason unknown'}`;
  return judgement.reason ?? 'No matching warden judgement for this one.';
};

export interface WardenAttentionProps {
  readonly connection: DaemonConnection;
  readonly state: WardenAttentionState;
  readonly now?: number;
  readonly actionPending?: string;
  readonly onOpenSession?: (request: { readonly connection: DaemonConnection; readonly sessionId: string }) => void;
  readonly onOpenReport?: (request: {
    readonly connection: DaemonConnection;
    readonly reportPath: string;
    readonly sessionId: string;
    readonly attentionId?: string;
  }) => void;
  readonly onRunAction?: (request: {
    readonly connection: DaemonConnection;
    readonly item: FleetAttentionItem;
    readonly recommendation: WardenRecommendation;
  }) => void;
}

/** Render-only surface; the daemon-bound host owns polling, reports, and mutations. */
export function WardenAttention({
  connection,
  state,
  now = Date.now(),
  actionPending,
  onOpenSession,
  onOpenReport,
  onRunAction,
}: WardenAttentionProps) {
  return (
    <section
      aria-labelledby="warden-attention-heading"
      data-daemon={connection.daemonId}
      className="kt-panel flex flex-col gap-3 p-panel"
    >
      <h2 id="warden-attention-heading" className="m-0 flex items-center gap-1.5 text-title font-semibold text-fg">
        <CircleAlert size={16} className="text-warn" aria-hidden="true" />
        Who needs you
      </h2>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNotice reason={state.reason} />}
      {(state.status === 'ready' || state.status === 'stale') && (
        <ReadyBody
          connection={connection}
          view={state.view}
          stale={state.status === 'stale' ? state.reason : undefined}
          now={now}
          actionPending={actionPending}
          onOpenSession={onOpenSession}
          onOpenReport={onOpenReport}
          onRunAction={onRunAction}
        />
      )}
    </section>
  );
}

const Loading = () => (
  <p role="status" className="m-0 flex items-center gap-xs text-row font-semibold text-muted">
    <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    Checking which agents need you…
  </p>
);

const ErrorNotice = ({ reason }: { readonly reason: string }) => (
  <div role="alert" className="rounded-control border border-err-border bg-err-bg px-cell-x py-row-y">
    <p className="m-0 text-row font-semibold text-err">No judgement available</p>
    <p className="m-0 mt-xs text-meta leading-base text-muted">{reason}</p>
    <p className="m-0 mt-xs text-meta leading-base text-faint">Treat this as unknown, not as all clear.</p>
  </div>
);

function ReadyBody({
  connection,
  view,
  stale,
  now = Date.now(),
  actionPending,
  onOpenSession,
  onOpenReport,
  onRunAction,
}: Omit<WardenAttentionProps, 'state'> & { readonly view: WardenAttentionView; readonly stale?: string }) {
  const items = orderedAttentionItems(view.items);
  const outcome = attentionOutcome(view);
  const brokenBoards = view.boardsWithParseErrors ?? [];
  const sweep =
    view.lastSweepAt === undefined
      ? 'No sweep has run. This is not a clean bill of health.'
      : `Last sweep ${relativeTime(view.lastSweepAt, now)}`;
  return (
    <>
      <div>
        <p className={cn('m-0 text-row font-semibold', stale === undefined ? 'text-fg' : 'text-warn')}>
          {stale === undefined ? attentionHeadline(view) : STALE_HEADLINE}
        </p>
        <p className="m-0 mt-0.5 text-meta leading-base text-faint">
          {stale === undefined
            ? sweep
            : `Last good answer ${relativeTime(view.generatedAt ?? view.lastSweepAt, now)} · not refreshed since`}
        </p>
      </div>
      {stale !== undefined && (
        <p
          role="alert"
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-cell-x py-1.5 text-meta leading-base text-warn"
        >
          Last result is stale — {stale}. Not an all-clear: someone may need you since.
        </p>
      )}
      {view.wardenDegraded && (
        <p
          role="alert"
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-cell-x py-1.5 text-meta leading-base text-warn"
        >
          Warden degraded: {view.wardenDegraded.reason ?? 'reason unknown'}
        </p>
      )}
      {brokenBoards.length > 0 && (
        <p className="m-0 text-meta leading-base text-warn">
          {brokenBoards.length} attention board{brokenBoards.length === 1 ? '' : 's'} could not be read — items on them
          are missing here.
        </p>
      )}
      {view.verdictCoverage?.truncated && (
        <p className="m-0 text-meta leading-base text-faint">
          Showing {view.verdictCoverage.limit ? `the recent ${view.verdictCoverage.limit}` : 'a recent slice of'}{' '}
          verdicts. Older judgements may be outside this window.
        </p>
      )}
      {items.length === 0 ? (
        <EmptyOutcome outcome={outcome} stale={stale !== undefined} />
      ) : (
        <ol className="m-0 flex list-none flex-col gap-sm p-0">
          {items.map((item, index) => (
            <AttentionRow
              key={`${item.sessionId}:${item.id ?? index}`}
              connection={connection}
              item={item}
              oldest={index === 0}
              now={now}
              pending={actionPending === `${item.sessionId}:${item.id ?? ''}`}
              onOpenSession={onOpenSession}
              onOpenReport={onOpenReport}
              onRunAction={onRunAction}
            />
          ))}
        </ol>
      )}
    </>
  );
}

const EmptyOutcome = ({ outcome, stale }: { readonly outcome: WardenAttentionOutcome; readonly stale: boolean }) => {
  const message = stale
    ? 'Nobody was waiting at the last check. That check is stale — not an all-clear.'
    : outcome === 'clean-sweep'
      ? 'Nothing is waiting on you right now.'
      : outcome === 'degraded'
        ? 'The warden check is incomplete. This is not an all-clear.'
        : 'Nobody has been checked yet.';
  const Icon = stale || outcome !== 'clean-sweep' ? CircleAlert : Check;
  return (
    <p className="m-0 flex items-center gap-xs text-cell text-muted">
      <Icon size={15} className={stale || outcome !== 'clean-sweep' ? 'text-warn' : 'text-ok'} aria-hidden="true" />
      {message}
    </p>
  );
};

function AttentionRow({
  connection,
  item,
  oldest,
  now,
  pending,
  onOpenSession,
  onOpenReport,
  onRunAction,
}: Pick<WardenAttentionProps, 'connection' | 'onOpenSession' | 'onOpenReport' | 'onRunAction'> & {
  readonly item: FleetAttentionItem;
  readonly oldest: boolean;
  readonly now: number;
  readonly pending: boolean;
}) {
  // ABSENT IS NOT `none`, AND IT IS NEVER `nudge`.
  //
  // A judgement the warden actually made — including its explicit "no matching
  // judgement" — is warden output and is shown. An item the warden never judged
  // carries NEITHER field, and the row must then say nothing on the warden's
  // behalf. Defaulting the pair here is how a human's own permission request
  // came back out of this surface wearing a warden chip and a warden-shaped
  // *Recommended action: nudge* it never earned; the daemon now omits both, so
  // synthesising them is the one thing this renderer must not do.
  const judgement = item.judgement;
  const chip = judgement === undefined ? undefined : judgementMeta[judgement.state];
  const recommendation = item.recommendation;
  // Read once: an optional chain inside the JSX below does not narrow for the
  // click handler that closes over it.
  const reportPath = judgement?.reportPath;
  const callsign = displayCallsign(item.teammate) || item.sessionId;
  return (
    <li
      className={cn(
        'overflow-hidden rounded-control border bg-surface',
        oldest ? 'border-warn/50 shadow-[inset_3px_0_0_var(--warn)]' : 'border-border-soft',
      )}
    >
      <button
        type="button"
        onClick={() => onOpenSession?.({ connection, sessionId: item.sessionId })}
        className="flex min-h-[44px] w-full flex-col gap-xs px-cell-x pb-xs pt-row-y text-left hover:bg-surface-2"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
          <span className="min-w-0 truncate text-cell font-semibold text-fg">{callsign}</span>
          {chip && (
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
                chip.cls,
              )}
            >
              <chip.Icon size={11} aria-hidden="true" />
              {chip.label}
            </span>
          )}
          {item.sessionStatus && (
            <span className="kt-label shrink-0 text-faint">{item.sessionStatus.replaceAll('_', ' ')}</span>
          )}
          {oldest && <span className="kt-label shrink-0 text-warn">oldest</span>}
        </span>
      </button>
      <div className="flex flex-col gap-xs px-cell-x pb-row-y">
        {item.subject && (
          <p className="m-0 whitespace-pre-wrap break-words text-cell font-medium leading-snug text-fg-soft">
            {item.subject}
          </p>
        )}
        <p className="m-0 whitespace-pre-wrap break-words text-cell leading-base text-muted">
          {item.why ?? 'No reason recorded.'}
        </p>
        {item.context && (
          <div className="rounded-control border border-border-soft bg-surface-2 px-cell-x py-1.5">
            <span className="kt-label block text-faint">Context</span>
            <p className="m-0 mt-0.5 whitespace-pre-wrap break-words text-meta leading-base text-muted">
              {item.context}
            </p>
          </div>
        )}
        {recommendation && (
          <Recommendation
            connection={connection}
            item={item}
            recommendation={recommendation}
            pending={pending}
            onRunAction={onRunAction}
          />
        )}
        {judgement && <span className="text-meta leading-base text-muted">{judgementSummary(judgement)}</span>}
        <span className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs text-meta text-faint">
          {judgement && (
            <span className="inline-flex items-center gap-xs">
              <UserRound size={11} aria-hidden="true" />
              {judgement.judgedBy?.wrapper
                ? `Judged by ${judgement.judgedBy.wrapper}${judgement.judgedBy.model ? ` (${judgement.judgedBy.model})` : ''}`
                : 'Judge unknown'}
            </span>
          )}
          <span className="inline-flex items-center gap-xs">
            <Clock3 size={11} aria-hidden="true" />
            waiting {relativeTime(item.waitingSince, now)}
          </span>
        </span>
      </div>
      {reportPath !== undefined && onOpenReport && (
        <div className="border-t border-border-soft">
          <button
            type="button"
            onClick={() =>
              onOpenReport({
                connection,
                reportPath,
                sessionId: item.sessionId,
                attentionId: item.id,
              })
            }
            className="flex min-h-[44px] w-full items-center gap-1.5 px-cell-x py-1.5 text-left text-meta text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Gavel size={12} aria-hidden="true" />
            Open warden report
          </button>
        </div>
      )}
    </li>
  );
}

function Recommendation({
  connection,
  item,
  recommendation,
  pending,
  onRunAction,
}: Pick<WardenAttentionProps, 'connection' | 'onRunAction'> & {
  readonly item: FleetAttentionItem;
  readonly recommendation: WardenRecommendation;
  readonly pending: boolean;
}) {
  if (recommendation.action === 'leave')
    return (
      <div className="rounded-control border border-border-soft bg-surface-2 px-cell-x py-1.5 text-meta leading-base text-muted">
        <span className="kt-label block text-faint">Suggested next step</span>No action needed — {recommendation.reason}
      </div>
    );
  const control = actionMeta[recommendation.action];
  return (
    <div className="flex min-w-0 flex-col gap-xs rounded-control border border-accent-border bg-accent-soft px-cell-x py-1.5">
      <span className="kt-label text-faint">Suggested next step</span>
      <span className="text-meta leading-base text-fg-soft">{recommendation.reason}</span>
      <button
        type="button"
        disabled={pending || !onRunAction || (recommendation.action === 'migrate' && !recommendation.wrapper)}
        onClick={() => onRunAction?.({ connection, item, recommendation })}
        className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-control border border-accent px-cell-x text-meta font-semibold text-accent hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? (
          <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <control.Icon size={14} aria-hidden="true" />
        )}
        {pending ? 'Working…' : control.label}
      </button>
    </div>
  );
}
