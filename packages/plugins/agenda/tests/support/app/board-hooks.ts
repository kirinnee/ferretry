/**
 * Stand-ins for Board's `agenda.card-answer` and `agenda.card-reference` hooks (`contract/app-hooks.ts`): what a
 * suite hands Agenda's ask surfaces to prove they are wired to the hook, with every call recorded. Which lane a Done
 * moves a card into is Board's rule (tested in Board); these only answer.
 */
import type { AgendaCardAnswer, AgendaCardReference, AgendaCardView } from '../../../contract/app-hooks.ts';

/** One card on the board, every call recorded. A card in lane `closed` reads as already closed. */
export const fakeAnswer = (laneId = 'tested') => {
  const calls: string[] = [];
  const view: AgendaCardView = {
    status: 'ready',
    missing: false,
    title: 'Pair a second phone',
    closed: laneId === 'closed',
  };
  const answer: AgendaCardAnswer = {
    subscribe: () => () => undefined,
    watch: card => {
      calls.push(`watch:${card}`);
      return () => undefined;
    },
    card: () => view,
    done: async card => {
      calls.push(`done:${card}`);
      return { ok: true };
    },
    start: async (card, key) => {
      calls.push(`start:${card}:${key === '' ? 'no key' : 'key'}`);
      return { ok: true, value: { started: true, ferret: 'mvuc7tsf-0c3d50df' } };
    },
    drop: async (card, reason) => {
      calls.push(`drop:${card}:${reason}`);
      return { ok: false, status: 403, message: 'only the owner closes cards' };
    },
  };
  return { answer, calls };
};

/** `F12` is this machine's card, nothing else is. */
export const fakeReference = (): AgendaCardReference & { readonly watched: string[] } => {
  const watched: string[] = [];
  const proves = (id: string) => id.toUpperCase() === 'F12';
  return {
    watched,
    subscribe: () => () => undefined,
    watch: () => {
      watched.push('ids');
      return () => undefined;
    },
    proves: () => proves,
    href: id => `/board-card/${id}`,
  };
};
