/**
 * THE CARDS A NOTICE IS ABOUT (`AgendaItem.cards`) — one row per card, each with its own three buttons on ONE line:
 * Open, Start a ferret, Close (a phone's width holds them; the accessible names say the card: "Open card &B1"). The line is the daemon's own (it says the card, where it waits and why nothing
 * will happen); the buttons are the owner's, and each goes through the same authorization as the board's own
 * (`AgendaCardsHost`). Got it is not here: it dismisses the whole notice and stays on the answer row.
 *
 * The notice does not repeat its subject above the list: every card's line is here, so each says which card its
 * buttons are for.
 *
 * A card a live ferret already holds is not started a second time: the daemon answers with that ferret, the row's
 * line says so in place of "no ferret is assigned" (which would now be untrue), and Start becomes "Open its chat",
 * which goes to that ferret.
 *
 * Close asks first, in the row: the card leaves the board, so the owner sees what is about to happen, may edit the
 * reason the daemon will record, and must say yes. A refusal is shown on the row in the daemon's words and the
 * buttons stay, so the owner can try the other one.
 */

import { type AgendaCardRow, type BoardTaskIdSchema, formatTaskRef } from '../../wire/index.ts';
import { type ReactNode, useState } from 'react';
import type { z } from 'zod';
import { defaultAgendaProse } from './agenda-prose.tsx';

/** A board card's id (`B12`), as an ask names it. */
export type BoardTaskId = z.infer<typeof BoardTaskIdSchema>;

/** What a button did: a plain sentence either way, so the row can say it without knowing the board. */
export type AgendaCardOutcome =
  | { readonly ok: true; readonly note: string; readonly ferret?: string }
  | { readonly ok: false; readonly message: string };

export interface AgendaCardsActions {
  /** Shows the card. */
  readonly open: (id: BoardTaskId) => void;
  /** Starts a new ferret on the card; `ferret` in the answer means one already held it and nothing was started. */
  readonly start: (id: BoardTaskId) => Promise<AgendaCardOutcome>;
  /** Shows the chat of the ferret that holds the card. */
  readonly openChat: (sessionId: string) => void;
  /** Drops the card, with the reason the board records. */
  readonly close: (id: BoardTaskId, reason: string) => Promise<AgendaCardOutcome>;
}

/** What the owner's Close records when they do not say more. */
const NOBODY_TAIL = /\s+is waiting in .*, but no ferret is assigned, so nothing will happen to it\.$/u;

/** The row's line once a live ferret holds the card: the daemon's words about the card, minus "nobody is on it". */
const heldLine = (line: string, ref: string): string => {
  const head = line.replace(NOBODY_TAIL, '').trim();
  return `${head === line.trim() || head === '' ? ref : head} — a ferret has picked it up.`;
};

export const CLOSE_CARD_REASON = 'Closed by the owner: no ferret was working on it.';

type RowState =
  | { readonly step: 'idle' }
  | { readonly step: 'working'; readonly what: 'start' | 'close' }
  | { readonly step: 'confirming'; readonly reason: string }
  | { readonly step: 'done'; readonly note: string };

const IDLE: RowState = { step: 'idle' };

function CardRow({
  card,
  actions,
  renderProse,
}: {
  readonly card: AgendaCardRow;
  readonly actions: AgendaCardsActions;
  readonly renderProse: (text: string) => ReactNode;
}) {
  const id = card.task.id;
  const [state, setState] = useState<RowState>(IDLE);
  const [problem, setProblem] = useState<string | null>(null);
  const [held, setHeld] = useState<{ readonly ferret: string } | null>(null);
  const ref = formatTaskRef({ id });

  const run = async (what: 'start' | 'close', go: () => Promise<AgendaCardOutcome>): Promise<void> => {
    setProblem(null);
    setState({ step: 'working', what });
    const outcome = await go();
    if (outcome.ok && outcome.ferret !== undefined) {
      setHeld({ ferret: outcome.ferret });
      setState(IDLE);
      return;
    }
    if (outcome.ok) {
      setState({ step: 'done', note: outcome.note });
      return;
    }
    setProblem(outcome.message);
    setState(IDLE);
  };

  const working = state.step === 'working';
  return (
    <li className="flex min-w-0 flex-col gap-2" data-agenda-card-row={id}>
      <div
        className="min-w-0 break-words text-ui text-fg"
        data-agenda-card-line=""
        {...(held === null ? {} : { role: 'status' })}
      >
        {renderProse(held === null ? card.line : heldLine(card.line, ref))}
      </div>
      {state.step === 'done' ? (
        <p className="m-0 text-ui text-muted" data-agenda-card-done="" role="status">
          {state.note}
        </p>
      ) : state.step === 'confirming' ? (
        <fieldset
          aria-label={`Close ${id}`}
          className="m-0 flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
          data-agenda-card-confirm=""
        >
          <p className="m-0 text-ui text-fg">
            Close this card? It leaves the board and nothing more will happen to it. The reason is kept on the card.
          </p>
          <label className="flex flex-col gap-1 text-meta text-muted">
            Reason
            <input
              className="min-h-[44px] rounded-control border border-border bg-surface px-3 text-ui text-fg"
              data-agenda-card-reason=""
              onChange={event => setState({ step: 'confirming', reason: event.currentTarget.value })}
              type="text"
              value={state.reason}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className="kt-btn min-h-[44px]"
              data-agenda-card-confirm-close=""
              disabled={state.reason.trim() === ''}
              onClick={() => void run('close', () => actions.close(id, state.reason.trim() || CLOSE_CARD_REASON))}
              type="button"
            >
              Yes, close it
            </button>
            <button
              className="kt-btn min-h-[44px]"
              data-agenda-card-keep=""
              onClick={() => setState(IDLE)}
              type="button"
            >
              Keep it
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="flex gap-2" data-agenda-card-buttons="">
          <button
            aria-label={`Open card ${ref}`}
            className="kt-btn kt-btn--sm min-h-[44px] min-w-0 flex-1"
            data-agenda-card-open=""
            disabled={working}
            onClick={() => actions.open(id)}
            type="button"
          >
            Open
          </button>
          {held === null ? (
            <button
              aria-label={`Start a ferret on ${ref}`}
              className="kt-btn kt-btn--sm min-h-[44px] min-w-0 flex-1"
              data-agenda-card-start=""
              disabled={working}
              onClick={() => void run('start', () => actions.start(id))}
              type="button"
            >
              {state.step === 'working' && state.what === 'start' ? 'Starting…' : 'Start a ferret'}
            </button>
          ) : (
            <button
              aria-label={`Open the chat of the ferret on ${ref}`}
              className="kt-btn kt-btn--sm min-h-[44px] min-w-0 flex-1"
              data-agenda-card-chat=""
              disabled={working}
              onClick={() => actions.openChat(held.ferret)}
              type="button"
            >
              Open its chat
            </button>
          )}
          <button
            aria-label={`Close card ${ref}`}
            className="kt-btn kt-btn--sm min-h-[44px] min-w-0 flex-1"
            data-agenda-card-close=""
            disabled={working}
            onClick={() => {
              setProblem(null);
              setState({ step: 'confirming', reason: CLOSE_CARD_REASON });
            }}
            type="button"
          >
            {state.step === 'working' && state.what === 'close' ? 'Closing…' : 'Close'}
          </button>
        </div>
      )}
      {problem === null ? null : (
        <p className="m-0 text-ui text-err" data-agenda-card-problem="" role="alert">
          {problem}
        </p>
      )}
    </li>
  );
}

export function AgendaCardsList({
  cards,
  actions,
  renderProse = defaultAgendaProse,
}: {
  readonly cards: readonly AgendaCardRow[];
  readonly actions: AgendaCardsActions;
  readonly renderProse?: (text: string) => ReactNode;
}) {
  return (
    <ul aria-label="Cards" className="m-0 flex list-none flex-col gap-4 p-0" data-agenda-cards="">
      {cards.map(card => (
        <CardRow actions={actions} card={card} key={card.task.id} renderProse={renderProse} />
      ))}
    </ul>
  );
}
