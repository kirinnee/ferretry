/**
 * THE CARDS A NOTICE IS ABOUT (`AgendaItem.cards`) — one row per card, each with its own three buttons: Open card,
 * Start a ferret on it, Close card. The line is the daemon's own (it says the card, where it waits and why nothing
 * will happen); the buttons are the owner's, and each goes through the same authorization as the board's own
 * (`AgendaCardsHost`). Got it is not here: it dismisses the whole notice and stays on the answer row.
 *
 * One card is already named by the notice's own words above the buttons, so its line is shown only when there are
 * several: each line then says which card its buttons are for.
 *
 * Close asks first, in the row: the card leaves the board, so the owner sees what is about to happen, may edit the
 * reason the daemon will record, and must say yes. A refusal is shown on the row in the daemon's words and the
 * buttons stay, so the owner can try the other one.
 */

import type { AgendaCardRow, BoardTaskId } from '@ferretry/protocol';
import { type ReactNode, useState } from 'react';
import { defaultAgendaProse } from './agenda-prose.tsx';

/** What a button did: a plain sentence either way, so the row can say it without knowing the board. */
export type AgendaCardOutcome =
  | { readonly ok: true; readonly note: string }
  | { readonly ok: false; readonly message: string };

export interface AgendaCardsActions {
  /** Shows the card. */
  readonly open: (id: BoardTaskId) => void;
  /** Brings the card's ferret back onto it. */
  readonly start: (id: BoardTaskId) => Promise<AgendaCardOutcome>;
  /** Drops the card, with the reason the board records. */
  readonly close: (id: BoardTaskId, reason: string) => Promise<AgendaCardOutcome>;
}

/** What the owner's Close records when they do not say more. */
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
  showLine,
}: {
  readonly card: AgendaCardRow;
  readonly actions: AgendaCardsActions;
  readonly renderProse: (text: string) => ReactNode;
  readonly showLine: boolean;
}) {
  const id = card.task.id;
  const [state, setState] = useState<RowState>(IDLE);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (what: 'start' | 'close', go: () => Promise<AgendaCardOutcome>): Promise<void> => {
    setProblem(null);
    setState({ step: 'working', what });
    const outcome = await go();
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
      {showLine ? (
        <div className="min-w-0 break-words text-ui text-fg" data-agenda-card-line="">
          {renderProse(card.line)}
        </div>
      ) : null}
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
        <div className="flex flex-wrap gap-2" data-agenda-card-buttons="">
          <button
            className="kt-btn min-h-[44px]"
            data-agenda-card-open=""
            disabled={working}
            onClick={() => actions.open(id)}
            type="button"
          >
            Open card
          </button>
          <button
            className="kt-btn min-h-[44px]"
            data-agenda-card-start=""
            disabled={working}
            onClick={() => void run('start', () => actions.start(id))}
            type="button"
          >
            {state.step === 'working' && state.what === 'start' ? 'Starting…' : 'Start a ferret on it'}
          </button>
          <button
            className="kt-btn min-h-[44px]"
            data-agenda-card-close=""
            disabled={working}
            onClick={() => {
              setProblem(null);
              setState({ step: 'confirming', reason: CLOSE_CARD_REASON });
            }}
            type="button"
          >
            {state.step === 'working' && state.what === 'close' ? 'Closing…' : 'Close card'}
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
        <CardRow
          actions={actions}
          card={card}
          key={card.task.id}
          renderProse={renderProse}
          showLine={cards.length > 1}
        />
      ))}
    </ul>
  );
}
