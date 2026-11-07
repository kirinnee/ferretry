/**
 * The board a Done · closes reads, as Agenda's own small fixture: Agenda's opaque board shapes (`CardForClose`,
 * `DoneCloseBoard`) and nothing of Board's tests or app. The lanes are Ferretry's classic lane set — the
 * ids and categories a Done reads.
 */

import type { DoneCloseResult } from '../../../app/lib/agenda-done-close.ts';
import type { CardForClose } from '../../../app/lib/agenda-done-close.ts';
import type { DoneCloseBoard, DoneCloseCardState } from '../../../app/hooks/use-done-close.ts';
import { daemonConnection } from '../../../app/shell.ts';

export const laptop = daemonConnection({ daemonId: 'daemon/laptop' });

type LaneSet = NonNullable<CardForClose['laneSet']>;

/** Ferretry's lanes before board v3: what a Done needs of them (an id and a category each, and the Done lane). */
export const laneSetFor = (): LaneSet => ({
  lanes: [
    { id: 'todo', category: 'backlog' },
    { id: 'plan', category: 'active' },
    { id: 'implement', category: 'active' },
    { id: 'review', category: 'review' },
    { id: 'merged', category: 'shipped' },
    { id: 'released', category: 'shipped' },
    { id: 'tested', category: 'verify' },
    { id: 'closed', category: 'closed' },
  ],
  doneLane: 'closed',
});

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

/** What the fake board's read answers: the card on its lanes, or `null` for a card the board does not have. */
export type BoardRead = { readonly task: BoardCard; readonly laneSet: LaneSet } | null;

/** A move's answer: the card where it landed, or the board's refusal. */
export type BoardMove =
  | { readonly ok: true; readonly read: BoardRead }
  | { readonly ok: false; readonly message: string };

export const moved = (read: BoardRead): BoardMove => ({ ok: true, read });
export const refusedMove = (message: string): BoardMove => ({ ok: false, message });

/**
 * A board a host would hand the ask surfaces: each card is read once on first ask, and a move is recorded as
 * `<id>:move:<lane>` before it answers. `act` moves a card as Board would, publishing where it landed.
 */
export const fakeDoneCloseBoard = (
  options: { readonly task?: () => Promise<BoardRead>; readonly act?: () => Promise<BoardMove> } = {},
): DoneCloseBoard & {
  readonly moves: string[];
  readonly act: (id: string, laneId: string) => Promise<DoneCloseResult>;
} => {
  const moves: string[] = [];
  const listeners = new Set<() => void>();
  const states = new Map<string, DoneCloseCardState>();
  const read = options.task ?? (async () => ({ task: card('F1', { laneId: 'tested' }), laneSet: laneSetFor() }));
  const publish = (id: string, state: DoneCloseCardState): void => {
    states.set(id, state);
    for (const listener of listeners) listener();
  };
  const stateOf = (answer: BoardRead): DoneCloseCardState =>
    answer === null
      ? { status: 'ready', missing: true }
      : {
          status: 'ready',
          missing: false,
          title: answer.task.title,
          card: { laneId: answer.task.laneId, dropped: answer.task.dropped !== null, laneSet: answer.laneSet },
        };
  const act = async (id: string, laneId: string): Promise<DoneCloseResult> => {
    moves.push(`${id}:move:${laneId}`);
    const answer =
      options.act === undefined ? moved({ task: card(id, { laneId }), laneSet: laneSetFor() }) : await options.act();
    if (!answer.ok) return { ok: false, message: answer.message };
    publish(id, stateOf(answer.read));
    return { ok: true };
  };
  return {
    moves,
    act,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cardState: (_daemonId, id) => {
      const known = states.get(id);
      if (known !== undefined) return known;
      const loading: DoneCloseCardState = { status: 'loading', missing: false };
      states.set(id, loading);
      read().then(
        answer => publish(id, stateOf(answer)),
        () => publish(id, { status: 'failed', missing: false }),
      );
      return loading;
    },
    move: (_daemonId, id, _card, laneId) => act(id, laneId),
  };
};
