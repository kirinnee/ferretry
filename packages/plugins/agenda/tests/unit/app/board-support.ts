/**
 * The board a Done · closes reads and closes through, as Agenda's own small fixture: a stand-in for Board's
 * `agenda.card-answer` hook (`contract/app-hooks.ts`) and nothing of Board's tests or app. Which lane a Done moves a
 * card into is Board's rule (tested in Board); this stand-in closes into `closed` and counts a card there as closed.
 */

import type { AgendaCardView, AgendaCardWrite } from '../../../contract/app-hooks.ts';
import type { DoneCloseResult } from '../../../app/lib/agenda-done-close.ts';
import type { DoneCloseBoard } from '../../../app/hooks/use-done-close.ts';
import { daemonConnection } from '../../../app/shell.ts';

export const laptop = daemonConnection({ daemonId: 'daemon/laptop' });

/** A card as the board serves it, as far as a Done reads it; `extra` overrides any field. */
export interface BoardCard {
  readonly id: string;
  readonly title: string;
  readonly laneId: string;
  readonly dropped: { readonly at: string; readonly reason: string } | null;
}

export const card = (id: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  id,
  title: `Card ${id}`,
  laneId: 'implement',
  dropped: null,
  ...extra,
});

export const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** Lets queued reads and their state updates run. */
export const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(done => setTimeout(done, 0));
};

/** What the fake board's read answers: the card, or `null` for a card the board does not have. */
export type BoardRead = { readonly task: BoardCard } | null;

/** A move's answer: the card where it landed, or the board's refusal. */
export type BoardMove =
  | { readonly ok: true; readonly read: BoardRead }
  | { readonly ok: false; readonly message: string };

export const moved = (read: BoardRead): BoardMove => ({ ok: true, read });
export const refusedMove = (message: string): BoardMove => ({ ok: false, message });

/**
 * The board Board's hook would hand the ask surfaces: each card is read once when it is first watched, and a Done is
 * recorded as `<id>:move:closed` before it answers. `act` moves a card as Board would, publishing where it landed.
 */
export const fakeDoneCloseBoard = (
  options: { readonly task?: () => Promise<BoardRead>; readonly act?: () => Promise<BoardMove> } = {},
): DoneCloseBoard & {
  readonly moves: string[];
  readonly act: (id: string, laneId: string) => Promise<DoneCloseResult>;
} => {
  const moves: string[] = [];
  const listeners = new Set<() => void>();
  const states = new Map<string, AgendaCardView>();
  const reads = new Map<string, BoardCard | null>();
  const read = options.task ?? (async () => ({ task: card('F1', { laneId: 'tested' }) }));
  const IDLE: AgendaCardView = { status: 'idle', missing: false, closed: false };
  const publish = (id: string, state: AgendaCardView): void => {
    states.set(id, state);
    for (const listener of listeners) listener();
  };
  const land = (id: string, answer: BoardRead): void => {
    reads.set(id, answer?.task ?? null);
    publish(
      id,
      answer === null
        ? { status: 'ready', missing: true, closed: false }
        : { status: 'ready', missing: false, title: answer.task.title, closed: answer.task.laneId === 'closed' },
    );
  };
  const act = async (id: string, laneId: string): Promise<DoneCloseResult> => {
    moves.push(`${id}:move:${laneId}`);
    const answer = options.act === undefined ? moved({ task: card(id, { laneId }) }) : await options.act();
    if (!answer.ok) return { ok: false, message: answer.message };
    land(id, answer.read);
    return { ok: true };
  };
  const refused = (message: string): AgendaCardWrite => ({ ok: false, status: 0, message });
  return {
    daemonId: laptop.daemonId,
    moves,
    act,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch: id => {
      if (!states.has(id)) {
        publish(id, { status: 'loading', missing: false, closed: false });
        read().then(
          answer => land(id, answer),
          () => publish(id, { status: 'failed', missing: false, closed: false }),
        );
      }
      return () => undefined;
    },
    card: id => states.get(id) ?? IDLE,
    done: async id => {
      const known = reads.get(id);
      if (known === undefined || known === null) return refused('the card could not be read');
      if (known.dropped !== null) return refused('the board has no Done for this card');
      if (known.laneId === 'closed') return { ok: true };
      const closed = await act(id, 'closed');
      return closed.ok ? { ok: true } : refused(closed.message);
    },
  };
};
