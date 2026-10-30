/**
 * ONE AGENDA ITEM, IN FOCUS — a full-width, full-height OVERLAY over the chat column. The chat stays mounted
 * underneath (its scroll position is simply kept); nothing of it shows or takes focus while this is open.
 *
 *   top     STICKY   the title, the ask (two lines), where the item stands, ‹ n of N › and ✕
 *   body    SCROLLS  the ONE scroller (`overscroll-behavior: contain`, no nested scroller): the ask in full,
 *                    what's going on, why it matters, decided, still open, terms as a Term | Meaning table, steps,
 *                    mock-ups, then the item's history — revisions and what was said about it
 *   bottom  STICKY   the action bar, which takes the composer's place (`agenda-answer-bar.tsx`)
 *
 * Top and bottom are flex items outside the scroller, so scrolling the body moves neither. ✕, Esc and ↓ go back
 * to the chat; ← ↑ → answer on a keyboard (a field or a button keeps its own keys).
 */

import type { AgendaItem } from '@ferretry/protocol';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import { type InboxAction, questionAnswersAction, swipeMap } from '../../lib/agenda-inbox.ts';
import { AgendaItemHistory } from './agenda-item-history.tsx';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { agendaAsk } from './agenda-row.tsx';
import { AgendaAnswerBar } from './agenda-answer-bar.tsx';
import { AgendaBriefSections } from './agenda-brief.tsx';
import { AgendaConfigChange } from './agenda-config-change.tsx';
import { AgendaDelivery, agendaHeading } from './agenda-delivery.tsx';
import { AgendaDetail } from './agenda-detail.tsx';
import { useDownSwipe } from './use-down-swipe.ts';

export interface AgendaItemViewProps {
  readonly item: AgendaItem;
  readonly ferret: string;
  readonly now?: number;
  readonly history: readonly HistoryEvent[];
  readonly position: { readonly index: number; readonly total: number };
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  /** Back to the chat. */
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** The primary pointer is touch: answers swipe. */
  readonly swipeable: boolean;
  /** An answer, carrying the typed text as its note. */
  readonly onAct: (action: InboxAction, note: string) => void;
  /** Adds the item to the next reply, with whatever is typed in the bar, and returns to the chat. */
  readonly onReply: (typed: string) => void;
  readonly onSend: (text: string) => Promise<void>;
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  readonly renderProse: (text: string) => ReactNode;
}

/** Keys that are a field's or a button's own. */
/** The detail without its premise: the daemon also writes a confirmed change into it for older apps, and the change is drawn on its own. */
const withoutPremise = (item: AgendaItem): AgendaItem => {
  const { premise, ...rest } = item;
  return rest;
};

const ownsKeys = (target: EventTarget): boolean =>
  target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable]') !== null;

export function AgendaItemView({
  item,
  ferret,
  now = Date.now(),
  history,
  position,
  onPrevious,
  onNext,
  onClose,
  busy,
  error,
  swipeable,
  onAct,
  onReply,
  onSend,
  onProgress,
  renderProse,
}: AgendaItemViewProps) {
  const root = useRef<HTMLElement | null>(null);
  const [picks, setPicks] = useState<readonly string[]>([]);
  const model = cardModel(item);
  const map = swipeMap(item);
  const questions = item.questions ?? [];
  const sendable =
    model.perQuestion && picks.some(pick => pick.trim() !== '') ? questionAnswersAction(questions, picks) : null;
  const status = agendaStatus(item, agendaAuthor(item, ferret), now);
  const ask = agendaAsk(item);
  const pull = useDownSwipe(onClose, swipeable);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the dialog again whenever another item opens
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [item.id]);

  const picker = model.perQuestion
    ? {
        answers: picks,
        disabled: busy,
        onAnswer: (index: number, text: string) =>
          setPicks(current => {
            const next = questions.map((_, at) => current[at] ?? '');
            next[index] = text;
            return next;
          }),
      }
    : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (ownsKeys(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape' || event.key === 'ArrowDown') {
      event.preventDefault();
      onClose();
      return;
    }
    const direction = { ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right' }[event.key] as
      | 'left'
      | 'up'
      | 'right'
      | undefined;
    const action = direction === undefined || busy ? undefined : map[direction];
    if (action === undefined) return;
    event.preventDefault();
    onAct(action, '');
  };

  return (
    <section
      aria-label={agendaHeading(item)}
      aria-modal="true"
      className="fy-item-view"
      data-agenda-view={item.id}
      onKeyDown={onKeyDown}
      ref={root}
      role="dialog"
      tabIndex={-1}
    >
      <header className="fy-item-view__top" data-agenda-top="" {...pull}>
        <div className="fy-item-view__nav">
          {status === null ? <span /> : <AgendaStatusPill status={status} />}
          <div className="fy-item-view__pager">
            <button
              aria-label="Previous item"
              className="fy-item-view__step"
              disabled={onPrevious === undefined}
              onClick={onPrevious}
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={18} />
            </button>
            <span className="fy-item-view__where" data-agenda-where="">
              {position.index + 1} of {position.total}
            </span>
            <button
              aria-label="Next item"
              className="fy-item-view__step"
              disabled={onNext === undefined}
              onClick={onNext}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={18} />
            </button>
            <button
              aria-label="Back to the chat"
              className="fy-item-view__step fy-item-view__close"
              data-agenda-close=""
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
        </div>
        <h2 className="fy-item-view__title" data-agenda-title="">
          {agendaHeading(item)}
        </h2>
        {ask === null ? null : (
          <p className="fy-item-view__ask" data-agenda-ask="">
            {ask}
          </p>
        )}
      </header>
      <div className="fy-item-view__body" data-agenda-body="">
        <div className="fy-item-view__column">
          <AgendaDelivery busy={busy} ferret={ferret} item={item} onAct={action => onAct(action, '')} />
          {model.showAsk || picker !== undefined ? (
            <AgendaBriefSections
              askShown
              collapsible={false}
              item={item}
              part="card"
              renderProse={renderProse}
              {...(model.perQuestion && model.recommendation !== undefined
                ? { recommendation: model.recommendation }
                : {})}
              {...(model.showAsk ? { ask: item.subject } : {})}
              {...(picker === undefined ? {} : { picker })}
            />
          ) : null}
          <AgendaConfigChange item={item} />
          <AgendaDetail
            busy={busy}
            item={item.confirms === undefined ? item : withoutPremise(item)}
            layout="full"
            renderProse={renderProse}
            {...(onProgress === undefined ? {} : { onProgress })}
          />
          <AgendaItemHistory events={history} ferret={ferret} now={now} prose={renderProse} />
        </div>
      </div>
      <AgendaAnswerBar
        busy={busy}
        error={error}
        ferret={ferret}
        item={item}
        map={map}
        model={model}
        onAct={onAct}
        onReply={onReply}
        onClose={onClose}
        onSend={onSend}
        swipeable={swipeable}
        {...(model.perQuestion
          ? {
              sendAnswers: {
                ready: sendable !== null,
                onSend: (note: string) => {
                  if (sendable === null || busy) return;
                  onAct(sendable, note);
                  setPicks([]);
                },
              },
            }
          : {})}
      />
    </section>
  );
}
