/**
 * WHAT KIND OF AGENDA ITEM THIS IS, in one word — the pill in the card's top bar, tinted by a theme token (never a
 * colour alone). The words are the protocol's (`AGENDA_KIND_LABELS`, plain words for what the owner does); only the
 * tone is the app's. A card waiting to be tried is a Test. No line of advice goes with it: the card says what to do by
 * what it asks.
 */

import { AGENDA_KIND_LABELS, type AgendaItem, type AgendaKind, agendaCardKind } from '../../wire/index.ts';
import { gateVerb, gateOf } from '../../lib/gate-items.ts';

type AgendaTypeTone = 'decision' | 'approval' | 'todo' | 'review' | 'note' | 'reply';

export interface AgendaTypeMeta {
  readonly kind: AgendaKind;
  readonly tone: AgendaTypeTone;
  readonly label: string;
}

const TONES: Readonly<Record<AgendaKind, AgendaTypeTone>> = {
  choice: 'decision',
  yesno: 'decision',
  permission: 'approval',
  task: 'todo',
  review: 'review',
  info: 'note',
  reply: 'reply',
  form: 'reply',
  input: 'approval',
};

export const agendaTypeMeta = (item: Pick<AgendaItem, 'kind' | 'ask' | 'gate' | 'subject'>): AgendaTypeMeta => {
  const kind = agendaCardKind(item);
  const label = gateOf(item) === undefined ? AGENDA_KIND_LABELS[kind] : gateVerb(item);
  return { kind, tone: TONES[kind], label };
};
