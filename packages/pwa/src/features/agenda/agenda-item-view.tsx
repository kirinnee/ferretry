/**
 * ONE AGENDA ITEM, IN FOCUS — an OVERLAY over the MESSAGE LIST only. The agenda row and the real composer stay
 * where they are, visible and typeable, below it; the transcript stays mounted underneath (its scroll position is
 * simply kept) and nothing of it shows or takes focus while this is open.
 *
 *   top     STICKY   the title, the one-line ask, where the item stands, ‹ n of N › and ✕ — on a PHONE one line:
 *                    the title cut to fit, and the ask is the body's first paragraph unless ⓘ pins it here
 *   body    SCROLLS  the ONE scroller (`overscroll-behavior: contain`, no nested scroller): the questions, what's
 *                    going on, why it matters, decided, still open, options, terms as a Term | Meaning table, steps,
 *                    mock-ups, then the history — what the owner said and what changed
 *   bottom  STICKY   the QUICK REPLIES (`agenda-quick-replies.tsx`), directly above the composer
 *
 * Top and bottom are flex items outside the scroller, so scrolling the body moves neither. Every section is drawn
 * open, in order, as plain Markdown: nothing in the body folds. ✕ and Esc go back to the chat; ↓ SKIPS — on to
 * the next item, or back to the chat when there is none; ← ↑ → answer on a keyboard (a field or a button keeps
 * its own keys). Everything typed goes through the composer: this view has no text field of its own.
 */

import type { AgendaItem, AgendaQuestion } from '@ferretry/protocol';
import { ChevronLeft, ChevronRight, Info, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useQuoteMenu } from '../../components/quote-menu.tsx';
import { readAskPinned, writeAskPinned } from '../../lib/agenda-ask-pin.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { type InboxAction, questionAnswersAction, swipeMap } from '../../lib/agenda-inbox.ts';
import { itemOptions } from '../../lib/agenda-options.ts';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { AgendaConfigChange } from './agenda-config-change.tsx';
import { AgendaDelivery, agendaHeading } from './agenda-delivery.tsx';
import { AgendaDetail } from './agenda-detail.tsx';
import { AgendaItemHistory } from './agenda-item-history.tsx';
import { AgendaQuickReplies } from './agenda-quick-replies.tsx';
import { agendaAsk } from './agenda-row.tsx';
import { AgendaSnoozeMenu } from './agenda-snooze-menu.tsx';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
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
  /** An answer; the host adds the composer's text as its note and closes the view once it is sent. */
  readonly onAct: (action: InboxAction) => void;
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  /** Snooze the item until this instant; absent: the clock button is not drawn. */
  readonly onSnooze?: (until: string) => void;
  readonly renderProse: (text: string) => ReactNode;
  /**
   * The conversation whose composer takes a quote: select any text in the item and "Quote in composer" puts it
   * there, exactly as in the chat (`useQuoteMenu`). Absent: nothing to quote into.
   */
  readonly quoteScope?: DaemonSessionScope | null;
  /** What ✕ is called: "Back to the chat", unless the host is somewhere else (the Inbox). */
  readonly closeLabel?: string;
}

/** The option a question's recommendation names, or '' when it names none. */
const recommendedPick = (question: AgendaQuestion): string => {
  const pick = question.recommended?.trim() ?? '';
  return question.options?.some(option => option.label === pick) === true ? pick : '';
};

/** The detail without its premise: the daemon also writes a confirmed change into it for older apps, and the change is drawn on its own. */
const withoutPremise = (item: AgendaItem): AgendaItem => {
  const { premise, ...rest } = item;
  return rest;
};

/** Keys that are a field's or a button's own. */
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
  onProgress,
  onSnooze,
  renderProse,
  closeLabel = 'Back to the chat',
  quoteScope = null,
}: AgendaItemViewProps) {
  const root = useRef<HTMLElement | null>(null);
  const quote = useQuoteMenu(root, quoteScope);
  const [picks, setPicks] = useState<readonly string[]>([]);
  // On a phone the head is one line and the ask is the body's first paragraph; ⓘ pins it in the head instead.
  const [pinned, setPinned] = useState(readAskPinned);
  const model = cardModel(item);
  const map = swipeMap(item);
  const questions = item.questions ?? [];
  const asked = questions.flatMap((question, index) => (question.options === undefined ? [] : [{ question, index }]));
  const ready = asked.length > 0 && asked.every(({ index }) => (picks[index] ?? '').trim() !== '');
  const agreed = questions.map(recommendedPick);
  const canUseRecommended = asked.length > 0 && asked.every(({ index }) => agreed[index] !== '');
  const sendable = model.perQuestion && ready ? questionAnswersAction(questions, picks) : null;
  const status = agendaStatus(item, agendaAuthor(item, ferret), now);
  const ask = agendaAsk(item);
  const skip = onNext ?? onClose;
  const pull = useDownSwipe(skip, swipeable);

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
      (event.key === 'Escape' ? onClose : skip)();
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
    onAct(action);
  };

  return (
    <section
      aria-label={agendaHeading(item)}
      aria-modal="true"
      className="fy-item-view"
      data-agenda-view={item.id}
      data-ask-pinned={pinned || undefined}
      onKeyDown={onKeyDown}
      {...quote.handlers}
      ref={root}
      role="dialog"
      tabIndex={-1}
    >
      <header className="fy-item-view__top" data-agenda-top="" {...pull}>
        {/* ONE compact head: the controls float right — status dot, n of N, ‹ › and ✕ — and the title flows beside and
            under them, so a long title wraps across the full width instead of into a narrow column. */}
        <div className="fy-item-view__nav">
          <div className="fy-item-view__pager">
            {status === null ? null : (
              <span className="fy-item-view__status" title={status.label}>
                <AgendaStatusPill status={status} />
              </span>
            )}
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
            {ask === null ? null : (
              <button
                aria-label="Pin the ask here"
                aria-pressed={pinned}
                className="fy-item-view__step fy-item-view__info"
                data-agenda-info=""
                onClick={() => {
                  writeAskPinned(!pinned);
                  setPinned(!pinned);
                }}
                type="button"
              >
                <Info aria-hidden="true" size={18} />
              </button>
            )}
            {onSnooze === undefined ? null : (
              <AgendaSnoozeMenu disabled={busy} now={now} onSnooze={onSnooze} triggerClass="fy-item-view__step" />
            )}
            <button
              aria-label={closeLabel}
              className="fy-item-view__step fy-item-view__close"
              data-agenda-close=""
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <h2 className="fy-item-view__title" data-agenda-title="">
            {agendaHeading(item)}
          </h2>
        </div>
        {ask === null ? null : (
          <div className="fy-item-view__ask" data-agenda-ask="">
            {renderProse(ask)}
          </div>
        )}
      </header>
      <div className="fy-item-view__body" data-agenda-body="">
        <div className="fy-item-view__column">
          {ask === null ? null : (
            <div className="fy-item-view__body-ask" data-agenda-body-ask="">
              {renderProse(ask)}
            </div>
          )}
          <AgendaDelivery busy={busy} ferret={ferret} item={item} onAct={onAct} />
          <AgendaConfigChange item={item} />
          <AgendaDetail
            brief={{
              askShown: true,
              askLabel: null,
              ...(model.recommendation === undefined ? {} : { recommendation: model.recommendation }),
              ...(picker === undefined ? {} : { picker }),
            }}
            busy={busy}
            item={item.confirms === undefined ? item : withoutPremise(item)}
            layout="full"
            renderProse={renderProse}
            {...(onProgress === undefined ? {} : { onProgress })}
          />
          <AgendaItemHistory events={history} ferret={ferret} now={now} />
        </div>
      </div>
      <AgendaQuickReplies
        busy={busy}
        error={error}
        map={map}
        model={model}
        onAct={onAct}
        onSkip={skip}
        options={itemOptions(item)}
        swipeable={swipeable}
        {...(item.waitingOn === 'ferret' && !model.notice ? { waitingOn: ferret } : {})}
        {...(model.perQuestion && asked.length > 0
          ? {
              sending: {
                ready: sendable !== null,
                canUseRecommended,
                onSend: () => {
                  if (sendable === null || busy) return;
                  onAct(sendable);
                  setPicks([]);
                },
                onUseRecommended: () => setPicks(agreed),
              },
            }
          : {})}
      />
      {quote.menu}
    </section>
  );
}
