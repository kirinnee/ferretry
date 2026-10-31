/**
 * WHAT KIND OF AGENDA ITEM THIS IS, said in the item's own words: a small badge (a word and an icon, tinted by a
 * theme token — never a colour alone) and one line on what the reader is being asked to do. The kinds are the
 * protocol's (`agendaCardKind`); a to-do that carries steps is called a to-do, one that does not, a task.
 */

import { type AgendaItem, type AgendaKind, agendaCardKind } from '@ferretry/protocol';
import {
  BadgeCheck,
  CircleCheck,
  KeyRound,
  ListChecks,
  ListTodo,
  type LucideIcon,
  MessageCircleReply,
  ShieldQuestion,
  StickyNote,
} from 'lucide-react';

type AgendaTypeTone = 'decision' | 'approval' | 'todo' | 'review' | 'note' | 'reply';

export interface AgendaTypeMeta {
  readonly kind: AgendaKind;
  readonly tone: AgendaTypeTone;
  readonly label: string;
  readonly hint: string;
  readonly icon: LucideIcon;
}

const META: Readonly<Record<AgendaKind, Omit<AgendaTypeMeta, 'kind'>>> = {
  choice: { tone: 'decision', label: 'Decision', hint: 'Pick one — it is yours to decide', icon: ListChecks },
  yesno: { tone: 'decision', label: 'Decision', hint: 'Yes or no — it is yours to decide', icon: CircleCheck },
  permission: { tone: 'approval', label: 'Approval', hint: 'Allow or deny what is asked below', icon: ShieldQuestion },
  task: { tone: 'todo', label: 'Task', hint: 'Do it, then mark it done', icon: ListTodo },
  review: {
    tone: 'review',
    label: 'Review',
    hint: 'Read the reasoning, then accept it or ask for changes',
    icon: BadgeCheck,
  },
  info: { tone: 'note', label: 'Note', hint: 'Nothing to decide — read it, then say got it', icon: StickyNote },
  reply: { tone: 'reply', label: 'Reply', hint: 'Write back in your own words', icon: MessageCircleReply },
  input: {
    tone: 'approval',
    label: 'Input',
    hint: 'Fill it in below — Ferretry types it where it is asked for',
    icon: KeyRound,
  },
};

export const agendaTypeMeta = (item: Pick<AgendaItem, 'kind' | 'ask' | 'steps'>): AgendaTypeMeta => {
  const kind = agendaCardKind(item);
  const meta = META[kind];
  const todo = kind === 'task' && (item.steps?.length ?? 0) > 0;
  return { kind, ...meta, ...(todo ? { label: 'To-do', hint: 'Work through the steps, then mark it done' } : {}) };
};

/** The badge and its one line, at the top of an item's body. */
export function AgendaTypeBadge({ item }: { readonly item: Pick<AgendaItem, 'kind' | 'ask' | 'steps'> }) {
  const meta = agendaTypeMeta(item);
  const Icon = meta.icon;
  return (
    <p className="fy-item-type" data-agenda-type={meta.kind} data-tone={meta.tone}>
      <span className="fy-item-type__badge">
        <Icon aria-hidden="true" size={13} />
        {meta.label}
      </span>
      <span className="fy-item-type__hint">{meta.hint}</span>
    </p>
  );
}
