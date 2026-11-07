/**
 * THE THREE BUTTONS OF A CARD IN A NOTICE (`AgendaItem.cards`), as the board's own writes: Open goes to the
 * card's page, Start a ferret is `POST /v1/board/tasks/:id/start` (a NEW ferret on the card, or the one that already holds it), Close is the board's drop with the
 * reason the owner confirmed. Nothing here is a second path to the daemon: each is the verb the board page uses,
 * so the daemon's authorization applies to it exactly as it does there, and a refusal comes back in its words.
 *
 * The board is Board's: this half takes its two writes through {@link AgendaCardsBoard}, a port the host binds to
 * Board's own actions, and its pages through the shell's route table ({@link AgendaLinks}), so no Board path is
 * spelled here.
 */

import type { AgendaCardOutcome, AgendaCardsActions, BoardTaskId } from '../features/agenda/agenda-cards-list.tsx';
import type { AgendaLinks } from './agenda-links.ts';
import type { DaemonId } from './machine.ts';

/** A board write's answer: the value, or the daemon's refusal (`status` 0 when no answer came). */
export type BoardResult<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const boardOk = <T>(value: T): BoardResult<T, never> => ({ ok: true, value });
export const boardErr = <E>(error: E): BoardResult<never, E> => ({ ok: false, error });

/** A refusal as the board answers it. */
interface BoardRefusal {
  readonly status: number;
  readonly message: string;
}

/** A card on one machine. */
interface BoardCardTarget {
  readonly daemonId: DaemonId;
  readonly id: BoardTaskId;
}

/** The two board writes a notice's buttons make. */
export interface AgendaCardsBoard {
  /** Starts a ferret on the card; `key` makes a retry of one click the same request. */
  readonly start: (
    target: BoardCardTarget,
    key?: string,
  ) => Promise<BoardResult<{ readonly started: boolean; readonly sessionId: string }, BoardRefusal>>;
  /** Drops the card with the reason the board records. */
  readonly drop: (target: BoardCardTarget, reason: string) => Promise<BoardResult<unknown, BoardRefusal>>;
}

export const agendaCardsActions = (
  board: AgendaCardsBoard,
  daemonId: DaemonId,
  onNavigate: (to: string) => void,
  links: Pick<AgendaLinks, 'card' | 'chat'>,
): AgendaCardsActions => {
  const target = (id: BoardTaskId): BoardCardTarget => ({ daemonId, id });
  const refused = (message: string): AgendaCardOutcome => ({ ok: false, message });
  // One key per Start click: kept while the request got no answer (the next click is a retry of it, and the daemon
  // answers a repeat with the first result), dropped once the daemon has answered, so a later click is new work.
  const pending = new Map<BoardTaskId, string>();
  return {
    open: id => {
      // A card's page is Board's; with Board not installed there is no page to open.
      const page = links.card(daemonId, id);
      if (page !== undefined) onNavigate(page);
    },
    start: async id => {
      const key = pending.get(id) ?? crypto.randomUUID();
      pending.set(id, key);
      const started = await board.start(target(id), key);
      if (started.ok || started.error.status !== 0) pending.delete(id);
      return started.ok
        ? started.value.started
          ? { ok: true, note: 'Started: a new ferret is working on this card.' }
          : { ok: true, ferret: started.value.sessionId, note: 'A ferret is already working on this card.' }
        : refused(started.error.message);
    },
    openChat: sessionId => onNavigate(links.chat(daemonId, sessionId)),
    close: async (id, reason) => {
      const dropped = await board.drop(target(id), reason);
      return dropped.ok ? { ok: true, note: 'Closed. The card is off the board.' } : refused(dropped.error.message);
    },
  };
};
