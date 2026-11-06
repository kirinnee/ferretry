/**
 * THE CARDS A NOTICE IS ABOUT (`AgendaItem.cards`), ANSWERED AS ONE FORM (&B165; docs/agenda.md § One model: the agenda
 * asks, the card shows). The notice is the agenda item that asks; each card is only named — its line is the daemon's
 * own (it says the card, where it waits and why nothing will happen), with a way to open it — and the owner picks, per
 * card, **Start a ferret**, **Close it** or **Leave it** (the default). ONE Send answers the whole notice: it does each
 * pick through the same authorization as the board's own writes (`AgendaCardsHost`), and when every pick took, it
 * answers the notice as Got it (`onSent`). There is no per-card button row and no second Got it.
 *
 * A card a live ferret already holds is not started a second time: the daemon answers with that ferret, the row's line
 * says so in place of "no ferret is assigned" (which would now be untrue), and the row offers its chat instead.
 *
 * Each card is ONE compact row: its name and where it waits, "Open" beside it, then the three picks. Send closes the
 * block in normal flow, so it never covers a row. Close shows what is about to happen before Send — the card leaves the
 * board — and the reason the daemon will record, which the owner may edit. A refusal is shown on its row in the daemon's words; the notice stays open, the picks stay,
 * and the next Send only does what has not taken yet.
 */

import { type AgendaCardRow, type BoardTaskId, formatTaskRef } from '@ferretry/protocol';
import { type ReactNode, useState } from 'react';
import { defaultAgendaProse } from './agenda-prose.tsx';

/** What a pick did: a plain sentence either way, so the row can say it without knowing the board. */
export type AgendaCardOutcome =
  | { readonly ok: true; readonly note: string; readonly ferret?: string }
  | { readonly ok: false; readonly message: string };

export interface AgendaCardsActions {
  /** Where the card's page is, for the row's link. */
  readonly cardPath: (id: BoardTaskId) => string;
  /** Shows the card. */
  readonly open: (id: BoardTaskId) => void;
  /** Starts a new ferret on the card; `ferret` in the answer means one already held it and nothing was started. */
  readonly start: (id: BoardTaskId) => Promise<AgendaCardOutcome>;
  /** Shows the chat of the ferret that holds the card. */
  readonly openChat: (sessionId: string) => void;
  /** Where that chat is, for the row's link. */
  readonly chatPath: (sessionId: string) => string;
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

/**
 * The card and where it waits, in few words: "&B1 Fix it" and, on a screen wide enough, "· in Review/CI". A line in other
 * words is shown as it is.
 */
const WAITING_LINE = /^(.*?) is waiting in (.+?),(?: but)? no ferret is assigned\b.*$/su;
const compactLine = (line: string): { readonly name: string; readonly place: string | null } => {
  const [, name, place] = WAITING_LINE.exec(line.trim()) ?? [];
  return name === undefined || place === undefined ? { name: line, place: null } : { name, place: ` · in ${place}` };
};

export const CLOSE_CARD_REASON = 'Closed by the owner: no ferret was working on it.';

/** The owner's pick for one card. */
export type AgendaCardPick = 'start' | 'close' | 'leave';

const PICKS: readonly (readonly [AgendaCardPick, string])[] = [
  ['start', 'Start a ferret'],
  ['close', 'Close it'],
  ['leave', 'Leave it'],
];

/** What a Send did to one card. */
type RowResult =
  | { readonly kind: 'done'; readonly note: string }
  | { readonly kind: 'held'; readonly ferret: string }
  | { readonly kind: 'problem'; readonly message: string };

/** A card whose pick already took is not done again by the next Send. */
const settled = (result: RowResult | undefined): boolean => result !== undefined && result.kind !== 'problem';

/** Activates a link with the app's own navigation, keeping the browser's own ways (a new tab) for a modified click. */
const linkClick =
  (go: () => void) =>
  (event: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly preventDefault: () => void }) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    go();
  };

export function AgendaCardsList({
  cards,
  actions,
  renderProse = defaultAgendaProse,
  onSent,
}: {
  readonly cards: readonly AgendaCardRow[];
  readonly actions: AgendaCardsActions;
  readonly renderProse?: (text: string) => ReactNode;
  /** Every pick took: the notice is answered (Got it). */
  readonly onSent?: (() => void) | undefined;
}) {
  const [picks, setPicks] = useState<Readonly<Record<string, AgendaCardPick>>>({});
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  const [results, setResults] = useState<Readonly<Record<string, RowResult>>>({});
  const [sending, setSending] = useState(false);
  const pickOf = (id: string): AgendaCardPick => picks[id] ?? 'leave';

  const send = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    const next: Record<string, RowResult> = { ...results };
    let failed = false;
    for (const card of cards) {
      const id = card.task.id;
      const pick = pickOf(id);
      if (pick === 'leave' || settled(next[id])) continue;
      const outcome =
        pick === 'start'
          ? await actions.start(id)
          : await actions.close(id, (reasons[id] ?? CLOSE_CARD_REASON).trim() || CLOSE_CARD_REASON);
      if (!outcome.ok) {
        failed = true;
        next[id] = { kind: 'problem', message: outcome.message };
      } else
        next[id] =
          outcome.ferret === undefined
            ? { kind: 'done', note: outcome.note }
            : { kind: 'held', ferret: outcome.ferret };
    }
    setResults(next);
    setSending(false);
    if (!failed) onSent?.();
  };

  return (
    <form
      aria-label="What to do with each card"
      className="m-0 flex min-w-0 flex-col gap-2"
      data-agenda-cards=""
      onSubmit={event => {
        event.preventDefault();
        void send();
      }}
    >
      <ul aria-label="Cards" className="m-0 flex list-none flex-col gap-2 p-0">
        {cards.map(card => {
          const id = card.task.id;
          const ref = formatTaskRef({ id });
          const result = results[id];
          const pick = pickOf(id);
          return (
            <li className="flex min-w-0 flex-col gap-1" data-agenda-card-row={id} key={id}>
              <div className="flex min-w-0 items-center justify-between gap-x-3" data-agenda-card-links="">
                <div
                  className="min-w-0 break-words text-ui text-fg [&_.md]:inline [&_p]:m-0 [&_p]:inline"
                  data-agenda-card-line=""
                  {...(result?.kind === 'held' ? { role: 'status' } : {})}
                >
                  {result?.kind === 'held' ? (
                    renderProse(heldLine(card.line, ref))
                  ) : (
                    <>
                      {renderProse(compactLine(card.line).name)}
                      {compactLine(card.line).place === null ? null : (
                        <span className="hidden text-muted sm:inline" data-agenda-card-place="">
                          {compactLine(card.line).place}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 text-meta">
                  <a
                    className="inline-flex items-center whitespace-nowrap text-accent"
                    data-agenda-card-open=""
                    href={actions.cardPath(id)}
                    onClick={linkClick(() => actions.open(id))}
                  >
                    Open {ref}
                  </a>
                  {result?.kind === 'held' ? (
                    <a
                      className="inline-flex items-center whitespace-nowrap text-accent"
                      data-agenda-card-chat=""
                      href={actions.chatPath(result.ferret)}
                      onClick={linkClick(() => actions.openChat(result.ferret))}
                    >
                      Open its ferret’s chat
                    </a>
                  ) : null}
                </span>
              </div>
              {result?.kind === 'done' ? (
                <p className="m-0 text-ui text-muted" data-agenda-card-done="" role="status">
                  {result.note}
                </p>
              ) : result?.kind === 'held' ? null : (
                <div
                  aria-label={`What to do with ${ref}`}
                  className="flex min-w-0 flex-nowrap justify-between gap-x-2"
                  data-agenda-card-picks=""
                  role="radiogroup"
                >
                  {PICKS.map(([value, label]) => (
                    <label
                      className="flex min-h-[44px] items-center gap-1.5 whitespace-nowrap text-meta text-fg"
                      key={value}
                    >
                      <input
                        checked={pick === value}
                        data-agenda-card-pick={value}
                        disabled={sending}
                        name={`agenda-card-${id}`}
                        onChange={() => setPicks(current => ({ ...current, [id]: value }))}
                        type="radio"
                        value={value}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              )}
              {pick === 'close' && !settled(result) ? (
                <label className="flex flex-col gap-1 text-meta text-muted" data-agenda-card-close-note="">
                  It leaves the board. Reason:
                  <input
                    className="min-h-[40px] rounded-control border border-border bg-surface px-3 text-ui text-fg"
                    data-agenda-card-reason=""
                    disabled={sending}
                    onChange={event => {
                      const reason = event.currentTarget.value;
                      setReasons(current => ({ ...current, [id]: reason }));
                    }}
                    type="text"
                    value={reasons[id] ?? CLOSE_CARD_REASON}
                  />
                </label>
              ) : null}
              {result?.kind === 'problem' ? (
                <p className="m-0 text-ui text-err" data-agenda-card-problem="" role="alert">
                  {result.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {/* Send ends the block, in normal flow: it never lies over a row (a sticky bar did, and hid the last card's picks). */}
      <div className="fy-qr__row fy-cards-send" data-agenda-quick-replies="">
        <button
          className="kt-btn fy-qr__chip"
          data-agenda-answer-option="Send"
          data-agenda-cards-send=""
          data-variant="primary"
          disabled={sending}
          type="submit"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
