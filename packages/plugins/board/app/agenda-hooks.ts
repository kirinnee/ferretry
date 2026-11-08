/**
 * WHAT BOARD PROVIDES TO AGENDA'S ASKS: the three app hooks Agenda offers (`agenda.card-answer`,
 * `agenda.lane-proposal`, `agenda.card-reference`), each built per daemon over this half's own client and the one
 * runtime its views share (`boardRuntimeOf`). Agenda draws the ask; Board acts on the card. Neither half imports the
 * other: the hook names and the value shapes are the agreement, and Agenda narrows what it is given.
 *
 * - `agenda.card-answer` — an ask's "Done · closes" and a notice's Start and Close. Done is the board's own one-tap
 *   answer (`boardDone`: the board's declared Done lane, else its first closing lane), planned as every owner move is
 *   (`planMove`), and sent as ONE `POST /v1/board/cards/:cardId` `{ action: 'move', to }`: the request today's Done
 *   sent. A card that is already closed sends nothing; one the board has no Done for is refused here, before any
 *   request. The daemon's route still decides: its refusal comes back in its own words.
 *   Done is exactly-once per card while a move is in flight: a second tap (the screen and the side panel both showing
 *   one ask, or two clicks in a frame) is answered by the first one's outcome and sends nothing more.
 * - `agenda.lane-proposal` — Edit on a lane proposal opens the project's lane editor (`laneEditDestination`).
 * - `agenda.card-reference` — `&F12` proves only against the card ids this machine holds (`createCardReferenceResolver`
 *   over `GET /v1/board/ids`, kept live by `board.changed`), and opens the card's page.
 *
 * Not here, on purpose: "Not good" and "Send back". Those were the to-test rows of today's task list, which 5.0 deleted;
 * they are card asks answered through Asks (the card's own gate), so no Board move backs them and `board-move.ts` is
 * reached only through Done's `planMove`.
 */

import type { AppHookContext, AppHookProviders } from '@ferretry/app';
import { CardIdSchema, type CardId } from '../contract/index.ts';
import { createBoardActions } from './lib/board-actions.ts';
import { boardDone } from './lib/board-done.ts';
import { planMove } from './lib/board-move.ts';
import type { BoardCardState } from './lib/board-store.ts';
import { type CardReferenceResolver, createCardReferenceResolver } from './lib/card-reference-context.ts';
import { laneEditDestination } from './lib/lane-proposal-link.ts';
import { THIS_MACHINE } from './lib/machine.ts';
import { boardPath, cardPagePath } from './lib/paths.ts';
import { type BoardRuntime, boardRuntimeOf } from './views/runtime.ts';

/** A card write's answer, as Agenda reads it. */
type Write<Value = undefined> =
  | ({ readonly ok: true } & (Value extends undefined ? unknown : { readonly value: Value }))
  | { readonly ok: false; readonly status: number; readonly message: string };

/** One card as an ask reads it. */
interface CardView {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  readonly missing: boolean;
  readonly title?: string | undefined;
  /** Done has nothing left to do. */
  readonly closed: boolean;
}

const refused = (message: string, status = 0): Write<never> => ({ ok: false, status, message });
const NOT_A_CARD = 'that is not a card id';
const UNREAD = 'the card could not be read';
const NO_DONE = 'the board has no Done for this card';

const cardIdOf = (written: string): CardId | undefined => {
  const parsed = CardIdSchema.safeParse(written.trim().toUpperCase());
  return parsed.success ? parsed.data : undefined;
};

/** The board's one-tap answer for a card as read: where Done moves it, or that it is already closed. */
const doneOf = (state: BoardCardState) => {
  const { task, laneSet } = state;
  if (task === null) return null;
  const category = laneSet?.lanes.find(lane => lane.id === task.laneId)?.category ?? null;
  return boardDone({ laneSet, category, dropped: task.dropped !== null });
};

const STATUS: Readonly<Record<BoardCardState['status'], CardView['status']>> = {
  idle: 'idle',
  loading: 'loading',
  ready: 'ready',
  error: 'failed',
};

/** `agenda.card-answer` over one daemon's runtime. */
const cardAnswer = (runtime: BoardRuntime) => {
  // One Done per card at a time: a tap while its move is in flight gets that move's outcome, not a second request.
  const doing = new Map<CardId, Promise<Write>>();
  const { store } = runtime;
  const actions = createBoardActions({
    store,
    connection: daemonId => (daemonId === THIS_MACHINE.daemonId ? THIS_MACHINE : undefined),
  });
  // A view is the same object while the store's card state is (useSyncExternalStore compares snapshots by identity).
  const views = new WeakMap<BoardCardState, CardView>();
  const IDLE: CardView = Object.freeze({ status: 'idle', missing: false, closed: false });
  const viewOf = (state: BoardCardState): CardView => {
    const known = views.get(state);
    if (known !== undefined) return known;
    const view: CardView = Object.freeze({
      status: STATUS[state.status],
      missing: state.missing,
      ...(state.task === null ? {} : { title: state.task.title }),
      closed: doneOf(state)?.kind === 'reopen',
    });
    views.set(state, view);
    return view;
  };
  /** The card's one-tap Done: where it moves, planned as every owner move is, and sent as ONE request. */
  const move = async (id: CardId): Promise<Write> => {
    const state = store.taskState(THIS_MACHINE.daemonId, id);
    if (state.status !== 'ready' || state.task === null) return refused(UNREAD);
    const done = doneOf(state);
    if (done === null) return refused(NO_DONE);
    // A closed card's one-tap answer is Reopen: for a Done there is nothing left to do, and nothing is sent.
    if (done.kind === 'reopen') return { ok: true };
    const plan = planMove(state.laneSet, state.task.laneId, done.laneId);
    if (plan.kind === 'stay') return { ok: true };
    if (plan.kind === 'refused') return refused(plan.message);
    if (plan.kind === 'ask-reason') return refused('Moving a card back needs a reason.');
    const moved = await actions.moveCard(
      { daemonId: THIS_MACHINE.daemonId, id, laneId: state.task.laneId, laneSet: state.laneSet },
      plan.to,
    );
    return moved.ok ? { ok: true } : refused(moved.error.message, moved.error.status);
  };
  return {
    subscribe: store.subscribe,
    watch: (card: string): (() => void) => {
      const id = cardIdOf(card);
      return id === undefined ? () => undefined : store.watchTask(THIS_MACHINE, id, { beat: false });
    },
    card: (card: string): CardView => {
      const id = cardIdOf(card);
      return id === undefined ? IDLE : viewOf(store.taskState(THIS_MACHINE.daemonId, id));
    },
    done: (card: string): Promise<Write> => {
      const id = cardIdOf(card);
      if (id === undefined) return Promise.resolve(refused(NOT_A_CARD));
      const pending = doing.get(id);
      if (pending !== undefined) return pending;
      const sent = move(id).finally(() => doing.delete(id));
      doing.set(id, sent);
      return sent;
    },
    start: async (
      card: string,
      key: string,
    ): Promise<Write<{ readonly started: boolean; readonly ferret: string }>> => {
      const id = cardIdOf(card);
      if (id === undefined) return refused(NOT_A_CARD);
      const started = await actions.start({ daemonId: THIS_MACHINE.daemonId, id }, key);
      return started.ok
        ? { ok: true, value: { started: started.value.started, ferret: started.value.ferret } }
        : refused(started.error.message, started.error.status);
    },
    drop: async (card: string, reason: string): Promise<Write> => {
      const id = cardIdOf(card);
      if (id === undefined) return refused(NOT_A_CARD);
      const dropped = await actions.drop({ daemonId: THIS_MACHINE.daemonId, id }, reason);
      return dropped.ok ? { ok: true } : refused(dropped.error.message, dropped.error.status);
    },
  };
};

/** `agenda.card-reference` over one daemon's runtime. */
const cardReference = (runtime: BoardRuntime, daemon: string) => {
  const { store } = runtime;
  // The proof is the same function while the id list is the same set, so a reader re-renders only when it changes.
  let last: { readonly ids: ReadonlySet<string> | null; readonly proves: CardReferenceResolver } | undefined;
  return {
    subscribe: store.subscribe,
    watch: (): (() => void) => {
      store.watchIds(THIS_MACHINE);
      // The id list has no release (`watchIds` keeps it live for the runtime's life), so there is nothing to give back.
      return () => undefined;
    },
    proves: (): CardReferenceResolver => {
      const ids = store.idsState(THIS_MACHINE.daemonId).ids;
      if (last === undefined || last.ids !== ids)
        last = { ids, proves: createCardReferenceResolver([], ids ?? undefined) };
      return last.proves;
    },
    // Always under THIS hook's daemon, and only for a real card id: anything else opens the daemon's board.
    href: (id: string): string => {
      const card = cardIdOf(id);
      return card === undefined ? boardPath(undefined, daemon) : cardPagePath(card, daemon);
    },
  };
};

/** The half's `shell.hooks`: Agenda's three, each over this half's client on that daemon. */
export const agendaHooks: AppHookProviders = {
  'agenda.card-answer': ({ client }: AppHookContext) => cardAnswer(boardRuntimeOf(client)),
  'agenda.lane-proposal': ({ daemon }: AppHookContext) => ({
    editorFor: (ask: Parameters<typeof laneEditDestination>[0], answer: Parameters<typeof laneEditDestination>[1]) =>
      laneEditDestination(ask, answer, daemon),
  }),
  'agenda.card-reference': ({ client, daemon }: AppHookContext) => cardReference(boardRuntimeOf(client), daemon),
};
