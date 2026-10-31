/**
 * WHAT KIND OF AGENDA ITEM THIS IS, in one word — the pill in the card's top bar, tinted by a theme token (never a
 * colour alone). The kinds are the protocol's (`agendaCardKind`); a to-do that carries steps is called a to-do, one
 * that does not, a task. No line of advice goes with it: the card says what to do by what it asks.
 */

import { type AgendaItem, type AgendaKind, agendaCardKind } from '@ferretry/protocol';

type AgendaTypeTone = 'decision' | 'approval' | 'todo' | 'review' | 'note' | 'reply';

export interface AgendaTypeMeta {
  readonly kind: AgendaKind;
  readonly tone: AgendaTypeTone;
  readonly label: string;
}

const META: Readonly<Record<AgendaKind, Omit<AgendaTypeMeta, 'kind'>>> = {
  choice: { tone: 'decision', label: 'Decision' },
  yesno: { tone: 'decision', label: 'Decision' },
  permission: { tone: 'approval', label: 'Approval' },
  task: { tone: 'todo', label: 'Task' },
  review: { tone: 'review', label: 'Review' },
  info: { tone: 'note', label: 'Note' },
  reply: { tone: 'reply', label: 'Reply' },
  input: { tone: 'approval', label: 'Input' },
};

export const agendaTypeMeta = (item: Pick<AgendaItem, 'kind' | 'ask' | 'steps'>): AgendaTypeMeta => {
  const kind = agendaCardKind(item);
  const todo = kind === 'task' && (item.steps?.length ?? 0) > 0;
  return { kind, ...META[kind], ...(todo ? { label: 'To-do' } : {}) };
};
