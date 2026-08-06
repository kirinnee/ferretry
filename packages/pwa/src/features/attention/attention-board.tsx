import { useState, type ReactNode } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldQuestion,
  UserRoundCheck,
  X,
} from 'lucide-react';
import type {
  AttentionAsk,
  AttentionBy,
  AttentionItem,
  AttentionResponse,
  AttentionSnapshot,
  ResolvedAttentionItem,
} from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { cn } from '../../lib/class-names.ts';
import { Button } from '../../shell/primitives.tsx';
import { AttentionAnswerControls } from './attention-answer-controls.tsx';

export type AttentionTone = AttentionAsk['kind'] | 'none' | 'unknown';
type Action = (id: string, action: AttentionResponse | null, dismissed?: boolean) => void;

export const attentionKindMeta = (
  item: Pick<AttentionItem, 'source' | 'ask'>,
): { tone: AttentionTone; label: string; icon: typeof CircleAlert; action: string } => {
  if (!item.ask)
    return {
      tone: 'none',
      label: sourceLabel(item.source),
      icon: CircleHelp,
      action: 'No answer shape recorded — clear it by acting',
    };
  switch (item.ask.kind) {
    case 'permission':
      return { tone: 'permission', label: 'Permission', icon: ShieldQuestion, action: 'Approve or reject' };
    case 'multiple-choice':
      return { tone: 'multiple-choice', label: 'Pick one', icon: ListChecks, action: 'Choose an answer' };
    case 'answer-review':
      return { tone: 'answer-review', label: 'Review answer', icon: BadgeCheck, action: 'Accept it, or ask for more' };
    case 'open-question':
      return { tone: 'open-question', label: 'Open question', icon: MessageCircleQuestion, action: 'Write an answer' };
    default:
      return {
        tone: 'unknown',
        label: 'Damaged attention',
        icon: CircleHelp,
        action: 'The requested action is malformed. Repair it before treating this as resolved',
      };
  }
};

export const sourceLabel = (source: AttentionItem['source']): string =>
  ({ task: 'Blocked task', question: 'Question', 'agent-raised': 'Agent request' })[source] ?? 'Unknown source';

export const attentionReference = (id: string): string => `!${id}`;
export const attentionAge = (waitingSince: string, now = Date.now()): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(waitingSince)) / 60_000));
  if (minutes < 1) return 'waiting now';
  if (minutes < 60) return `waiting ${minutes}m`;
  if (minutes < 1_440) return `waiting ${Math.floor(minutes / 60)}h`;
  return `waiting ${Math.floor(minutes / 1_440)}d`;
};
export const collapsesByDefault = (text: string): boolean =>
  text.trim().length > 220 || text.trim().split('\n').length > 4;
export const describeResponse = (response: AttentionResponse): string => {
  if (response.kind === 'permission') return response.decision === 'approve' ? 'Approved' : 'Rejected';
  if (response.kind === 'multiple-choice') return `Chose “${response.choice}”`;
  if (response.kind === 'answer-review')
    return response.verdict === 'good' ? 'Answer accepted' : `Clarification requested: ${response.clarification}`;
  return `Answered: ${response.answer}`;
};

/**
 * An agent's display name is optional in the recorded ledger and is null for most
 * real work, so the session it acted from is the fallback that carries audit value:
 * a person can look a session up, where a generic placeholder identifies nobody.
 */
const agentLabel = (name: string | null, session: string | null): string =>
  name ?? session ?? 'an unidentified session';

const actor = (by: AttentionBy, name: string | null, session: string | null): string =>
  by === 'agent' ? `agent ${agentLabel(name, session)}` : by === 'human' ? 'you' : 'the daemon';

type AttentionResolution = Pick<
  ResolvedAttentionItem,
  'resolvedBy' | 'resolvedByName' | 'resolvedBySession' | 'disposition' | 'response'
>;

/**
 * A dismissal is audit evidence, not a generic completed state. The badge makes
 * clears performed without the human especially easy to scan — and it keeps an
 * agent that answered on the human's behalf distinct from one that withdrew its
 * own request, because only the recorded response separates the two.
 */
export function resolutionBadge({
  resolvedBy,
  resolvedByName,
  resolvedBySession,
  disposition,
  response,
}: AttentionResolution): { label: string; className: string; icon: typeof Check } {
  const agent = agentLabel(resolvedByName, resolvedBySession);
  if (disposition === 'dismissed') {
    if (resolvedBy === 'agent') {
      return {
        label: `dismissed by agent ${agent}`,
        className: 'border-warn/50 bg-warn/10 text-warn',
        icon: Bot,
      };
    }
    if (resolvedBy === 'human') {
      return {
        label: 'dismissed by you',
        className: 'border-border bg-surface-2 text-muted',
        icon: UserRoundCheck,
      };
    }
    return {
      label: 'dismissed by the daemon',
      className: 'border-border bg-surface-2 text-muted',
      icon: Check,
    };
  }
  if (resolvedBy === 'agent') {
    return {
      label: `${response ? 'answered' : 'retracted'} by agent ${agent}`,
      className: 'border-warn/50 bg-warn/10 text-warn',
      icon: Bot,
    };
  }
  if (resolvedBy === 'human') {
    return {
      label: 'done by you',
      className: 'border-ok/50 bg-ok/10 text-ok',
      icon: UserRoundCheck,
    };
  }
  return {
    label: 'cleared by the daemon',
    className: 'border-border bg-surface-2 text-muted',
    icon: Check,
  };
}

const prose = (text: string, className = '') => (
  <p className={cn('kt-attn-prose m-0 whitespace-pre-wrap break-words', className)}>{text}</p>
);

export interface AttentionBoardProps {
  readonly connection: DaemonConnection;
  readonly snapshot: AttentionSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busyId?: string | null;
  readonly now?: number;
  readonly onAction: Action;
}

/** Pure, render-testable attention surface. Its data and actions are already bound to one daemon connection. */
export function AttentionBoard({
  connection,
  snapshot,
  loading,
  error,
  busyId = null,
  now = Date.now(),
  onAction,
}: AttentionBoardProps) {
  const [background, setBackground] = useState<Record<string, boolean>>({});
  const items = snapshot?.items ?? [];
  const resolved = snapshot?.resolved ?? [];
  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col"
      aria-label="Attention ledger"
      data-daemon={connection.daemonId}
    >
      <header className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-sm">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-warn/40 bg-warn/10 text-warn">
            <CircleAlert size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="m-0 font-display text-title font-semibold tracking-display text-fg">Attention</h1>
            <p className="m-0 text-meta text-faint">
              {items.length} unresolved · oldest first · every clear records who did it
            </p>
          </div>
        </div>
      </header>
      {error && (
        <p role="alert" className="m-0 border-b border-err/30 bg-err/5 px-panel py-row-y text-meta text-err">
          Could not verify attention: {error}
        </p>
      )}
      {snapshot?.parseErrors !== undefined && snapshot.parseErrors > 0 && !error && (
        <p role="alert" className="m-0 border-b border-err/30 bg-err/5 px-panel py-row-y text-meta text-err">
          The daemon reported {snapshot.parseErrors} parse errors; repair the file before trusting this list.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin" data-attention-scroller>
        <div className="mx-auto w-full max-w-2xl px-panel">
          {loading && !snapshot ? (
            <p role="status" className="flex items-center justify-center gap-xs py-8 text-cell text-muted">
              <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />
              Loading attention ledger…
            </p>
          ) : error && !snapshot ? (
            <AttentionUnavailable />
          ) : items.length === 0 && (snapshot?.parseErrors ?? 0) > 0 ? (
            <AttentionUnavailable damaged />
          ) : items.length === 0 ? (
            <div className="py-10 text-center">
              <Check size={18} className="mx-auto mb-sm text-muted" aria-hidden="true" />
              <p className="m-0 text-cell font-medium text-fg">Nothing needs attention.</p>
              <p className="m-0 mt-xs text-meta text-faint">Resolved items remain in the audit below.</p>
            </div>
          ) : (
            <ol className="m-0 flex list-none flex-col divide-y divide-border-soft p-0">
              {items.map((item, index) => (
                <AttentionRow
                  key={item.id}
                  item={item}
                  oldest={index === 0}
                  busy={busyId === item.id}
                  now={now}
                  background={background[item.id] ?? !collapsesByDefault(item.context ?? '')}
                  onBackground={() =>
                    setBackground(value => ({
                      ...value,
                      [item.id]: !(value[item.id] ?? !collapsesByDefault(item.context ?? '')),
                    }))
                  }
                  onAction={onAction}
                />
              ))}
            </ol>
          )}
          <ResolutionAudit items={resolved} />
        </div>
      </div>
    </section>
  );
}

function AttentionUnavailable({ damaged = false }: { readonly damaged?: boolean }) {
  return (
    <div className="py-10 text-center" role="alert">
      <CircleAlert size={18} className="mx-auto mb-sm text-err" aria-hidden="true" />
      <p className="m-0 text-cell font-medium text-fg">Attention needs human verification.</p>
      <p className="m-0 mt-xs text-meta text-faint">
        {damaged
          ? 'The daemon reported damaged attention data. Repair it before assuming no action is needed.'
          : 'The attention ledger could not be read. Reconnect or repair the paired daemon before assuming no action is needed.'}
      </p>
    </div>
  );
}

function AttentionRow({
  item,
  oldest,
  busy,
  now,
  background,
  onBackground,
  onAction,
}: {
  readonly item: AttentionItem;
  readonly oldest: boolean;
  readonly busy: boolean;
  readonly now: number;
  readonly background: boolean;
  readonly onBackground: () => void;
  readonly onAction: Action;
}) {
  const kind = attentionKindMeta(item);
  const KindIcon = kind.icon;
  return (
    <li
      data-kind={kind.tone}
      data-oldest={oldest || undefined}
      className="kt-attn kt-attn-rail relative min-w-0 py-md pl-sm"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
        <span className="kt-attn-chip kt-label inline-flex shrink-0 items-center gap-1 px-badge-x py-0.5">
          <KindIcon size={11} aria-hidden="true" />
          {kind.label}
        </span>
        <span className="mono text-meta text-faint">{attentionReference(item.id)}</span>
        {oldest && <span className="kt-label kt-attn-ink">oldest</span>}
        <span className="ml-auto inline-flex items-center gap-xs text-meta text-faint">
          <Clock3 size={11} />
          {attentionAge(item.waitingSince, now)}
        </span>
      </div>
      {prose(item.subject, 'mt-xs text-row font-semibold leading-tight text-fg')}
      <Part part="why" icon={<CircleAlert size={11} />} label="Why now">
        {prose(item.why, 'mt-0.5 text-cell leading-base text-muted')}
      </Part>
      {item.context && (
        <div data-part="context" className="kt-attn-part min-w-0">
          <button type="button" className="kt-attn-toggle" aria-expanded={background} onClick={onBackground}>
            <ChevronRight size={13} className="kt-attn-chevron" />
            <BookOpen size={11} />
            <span className="kt-label kt-attn-part-ink">Background</span>
            {!background && <span className="ml-auto text-meta text-faint">show</span>}
          </button>
          {background && prose(item.context, 'pb-xs text-meta leading-base text-muted')}
        </div>
      )}
      <Part
        part="action"
        icon={<ArrowRight size={11} />}
        label="What clears this"
        className="kt-attn-part-rail mt-sm pl-sm"
      >
        {prose(item.howToResolve, 'mt-0.5 text-cell leading-base text-muted')}
      </Part>
      <div className="mt-sm flex flex-col gap-xs">
        <p className="m-0 text-meta text-faint" data-attention-action>
          {kind.action}.
        </p>
        {kind.tone === 'unknown' ? (
          <p role="alert" className="m-0 text-meta text-err">
            Cannot offer a response for this damaged attention item. Repair it before treating it as resolved.
          </p>
        ) : item.ask ? (
          <AttentionAnswerControls ask={item.ask} busy={busy} onRespond={response => onAction(item.id, response)} />
        ) : (
          <>
            <div className="flex justify-end">
              <Button size="sm" className="min-h-[44px]" disabled={busy} onClick={() => onAction(item.id, null)}>
                {busy ? (
                  <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <UserRoundCheck size={14} />
                )}
                Mark done
              </Button>
            </div>
          </>
        )}
      </div>
      <div className="mt-sm flex flex-wrap items-center gap-x-sm gap-y-xs text-meta text-faint">
        <span>
          {sourceLabel(item.source)} · raised by {actor(item.raisedBy, item.raisedByName, item.raisedBySession)} ·{' '}
          {new Date(item.waitingSince).toLocaleString()}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAction(item.id, null, true)}
          className="ml-auto inline-flex min-h-[44px] items-center gap-xs rounded-control px-cell-x text-meta text-faint hover:bg-surface-2 hover:text-fg disabled:opacity-50"
        >
          <X size={13} />
          Dismiss without answering
        </button>
      </div>
    </li>
  );
}

function Part({
  part,
  icon,
  label,
  children,
  className = '',
}: {
  readonly part: 'why' | 'action';
  readonly icon: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div data-part={part} className={cn('kt-attn-part min-w-0 mt-sm', className)}>
      <span className="kt-label kt-attn-part-ink inline-flex items-center gap-1">
        {icon}
        {label}
      </span>
      {children}
    </div>
  );
}

function ResolutionAudit({ items }: { readonly items: readonly ResolvedAttentionItem[] }) {
  return (
    <details className="group mt-md border-t border-border-soft pt-row-y">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-sm rounded-control text-cell font-medium text-muted">
        <ChevronDown size={14} className="transition-transform motion-reduce:transition-none group-open:rotate-180" />
        Resolution audit<span className="mono ml-auto text-meta text-faint">{items.length}</span>
      </summary>
      {items.length === 0 ? (
        <p className="m-0 py-row-y text-meta text-faint">No recorded resolutions.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-sm p-0 pb-row-y pt-xs">
          {items.map(item => {
            const badge = resolutionBadge(item);
            const BadgeIcon = badge.icon;
            return (
              <li
                key={`${item.id}:${item.resolvedAt}`}
                className={cn(
                  'min-w-0 border-l-2 pl-sm text-meta leading-base',
                  item.resolvedBy === 'agent' ? 'border-warn/60' : 'border-border-soft',
                )}
              >
                <p className="m-0 font-medium text-muted">{item.subject}</p>
                <p className="m-0 flex flex-wrap items-center gap-x-sm gap-y-xs text-faint">
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
                      badge.className,
                    )}
                  >
                    <BadgeIcon size={11} aria-hidden="true" />
                    {badge.label}
                  </span>
                  <span>
                    {attentionReference(item.id)} · {new Date(item.resolvedAt).toLocaleString()}
                  </span>
                </p>
                {item.response && <p className="m-0 font-medium text-muted">{describeResponse(item.response)}</p>}
                {item.resolutionNote && prose(item.resolutionNote, 'text-faint')}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

/*
 * THERE IS NO `AttentionPage` HERE ANY MORE, AND THAT IS THE POINT.
 *
 * It carried its own fetch, its own parse, its own error type and its own
 * session-mismatch check — a second definition of "what this session's Attention
 * is", beside `lib/attention-client.ts`, which additionally fences a re-pair and
 * feeds the badge from the same store. Two definitions of one fact is the defect
 * `docs/standards/fact-ownership/index.md` exists to remove, so the wrapper and
 * its transport are gone rather than kept in sync. The live surface is
 * `attention-action-modal.tsx` over `DaemonAttentionClient`; this board stays a
 * pure, render-testable ledger with its data handed to it.
 */
