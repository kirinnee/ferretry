import {
  AGENDA_KIND_LABELS,
  type AgendaAsk,
  type AgendaItem,
  type AgendaResponse,
  type ResolvedAgendaItem,
} from '../../wire/index.ts';
import { shellClock } from '../../shell.ts';
import {
  BadgeCheck,
  Bot,
  Check,
  type CircleAlert,
  CircleHelp,
  ListChecks,
  ListTodo,
  MessageCircleQuestion,
  ShieldQuestion,
  UserRoundCheck,
} from 'lucide-react';

export type AgendaTone = AgendaAsk['kind'] | 'none' | 'unknown';

export const agendaKindMeta = (
  item: Pick<AgendaItem, 'source' | 'ask'>,
): { tone: AgendaTone; label: string; icon: typeof CircleAlert; action: string } => {
  if (!item.ask)
    return {
      tone: 'none',
      label: sourceLabel(item.source),
      icon: CircleHelp,
      action: 'No answer shape recorded — clear it by acting',
    };
  switch (item.ask.kind) {
    case 'permission':
      return {
        tone: 'permission',
        label: AGENDA_KIND_LABELS.permission,
        icon: ShieldQuestion,
        action: 'Approve or reject',
      };
    case 'multiple-choice':
      return {
        tone: 'multiple-choice',
        label: AGENDA_KIND_LABELS.choice,
        icon: ListChecks,
        action: 'Choose an answer',
      };
    case 'answer-review':
      return {
        tone: 'answer-review',
        label: AGENDA_KIND_LABELS.review,
        icon: BadgeCheck,
        action: 'Accept it, or ask for more',
      };
    case 'open-question':
      return {
        tone: 'open-question',
        label: AGENDA_KIND_LABELS.reply,
        icon: MessageCircleQuestion,
        action: 'Write an answer',
      };
    case 'task':
      return {
        tone: 'task',
        label: AGENDA_KIND_LABELS.task,
        icon: ListTodo,
        action: 'Do it, then mark it done — or ask for more info',
      };
    default:
      return {
        tone: 'unknown',
        label: 'Damaged Inbox',
        icon: CircleHelp,
        action: 'The requested action is malformed. Repair it before treating this as resolved',
      };
  }
};

const sourceLabel = (source: AgendaItem['source']): string =>
  ({ task: 'Blocked task', question: 'Question', 'agent-raised': 'Agent request' })[source] ?? 'Unknown source';

export const agendaReference = (id: string): string => `!${id}`;
export const agendaAge = (waitingSince: string, now = shellClock.nowMs()): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(waitingSince)) / 60_000));
  if (minutes < 1) return 'waiting now';
  if (minutes < 60) return `waiting ${minutes}m`;
  if (minutes < 1_440) return `waiting ${Math.floor(minutes / 60)}h`;
  return `waiting ${Math.floor(minutes / 1_440)}d`;
};
export const collapsesByDefault = (text: string): boolean =>
  text.trim().length > 220 || text.trim().split('\n').length > 4;
export const describeResponse = (response: AgendaResponse): string => {
  if (response.kind === 'permission') return response.decision === 'approve' ? 'Approved' : 'Rejected';
  if (response.kind === 'multiple-choice') return `Chose “${response.choice}”`;
  if (response.kind === 'answer-review')
    return response.verdict === 'good' ? 'Answer accepted' : `Clarification requested: ${response.clarification}`;
  if (response.kind === 'form')
    return `Form answered: ${response.answers.map(each => `${each.id}: ${typeof each.picked === 'string' ? each.picked : each.picked.join(', ')}`).join(' · ')}`;
  return `Answered: ${response.answer}`;
};

/**
 * An agent's display name is optional in the recorded ledger and is null for most
 * real work, so the session it acted from is the fallback that carries audit value:
 * a person can look a session up, where a generic placeholder identifies nobody.
 */
const agentLabel = (name: string | null, session: string | null): string =>
  name ?? session ?? 'an unidentified session';

type AgendaResolution = Pick<
  ResolvedAgendaItem,
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
}: AgendaResolution): { label: string; className: string; icon: typeof Check } {
  const agent = agentLabel(resolvedByName, resolvedBySession);
  if (disposition === 'replied') {
    return {
      label: 'replied by you',
      className: 'border-border bg-surface-2 text-muted',
      icon: UserRoundCheck,
    };
  }
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

/*
 * THERE IS NO `AgendaPage` HERE ANY MORE, AND THAT IS THE POINT.
 *
 * It carried its own fetch, its own parse, its own error type and its own
 * session-mismatch check — a second definition of "what this session's Attention
 * is", beside `lib/agenda-client.ts`, which additionally fences a re-pair and
 * feeds the badge from the same store. Two definitions of one fact is the defect
 * `docs/standards/fact-ownership/index.md` exists to remove, so the wrapper and
 * its transport are gone rather than kept in sync. The live surface is
 * `agenda-panel.tsx` over `DaemonAgendaClient`; this board stays a
 * pure, render-testable ledger with its data handed to it.
 */
