/**
 * ONE AGENDA ITEM, IN FOCUS — an OVERLAY over the MESSAGE LIST only. The agenda row and the real composer stay where
 * they are, visible and typeable, below it; the transcript stays mounted underneath (its scroll position is simply
 * kept) and nothing of it shows or takes focus while this is open.
 *
 * ONE COLUMN, the composer's own width at every breakpoint, top to bottom:
 *
 *   head     the title and the one-line description (the item's ask), with where it stands, ‹ n of N ›, the snooze
 *            clock and ✕ beside the title
 *   card     everything to read and answer (`agenda-item-card.tsx`): premise and context, the question, the options,
 *            whatever sections the ferret added, the version picker, and the ONE answer row
 *   history  the conversation about the item, newest at the bottom, just above the composer
 *
 * THE HEAD STICKS to the top of the scroller, and a one-row answer (choice, approval, to-do, notice, review) is drawn in
 * a DOCK that sticks to its bottom, so the title, the pager and the buttons are in reach however long the card runs. A
 * card answered in words (reply, mixed, form) has no dock: the composer is its answer. The scroller keeps room for both
 * (`scroll-padding`), so a focused field never lands behind one.
 *
 * The body is the ONE scroller (`overscroll-behavior: contain`). ✕ and Esc go back to the chat; ‹ › page through the
 * items without answering; ← ↑ → answer on a keyboard and ↓ is Not needed, exactly as the swipes (a field or a button
 * keeps its own keys). Everything typed goes through the composer: this view has no text field of its own.
 */

import type { AgendaCardAnswer, AgendaItem } from '@ferretry/protocol';
import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useQuoteMenu } from '../../components/quote-menu.tsx';
import { useDoneClose } from '../../hooks/use-done-close.ts';
import { answerAction } from '../../lib/agenda-answers.ts';
import { agendaCardHead } from '../../lib/agenda-card-head.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { DISMISS_ACTION, type InboxAction, swipeMap } from '../../lib/agenda-inbox.ts';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { composerQuoteTarget } from '../../lib/quote.ts';
import { agendaHeading } from './agenda-delivery.tsx';
import { AgendaItemCard } from './agenda-item-card.tsx';
import { AgendaItemHistory } from './agenda-item-history.tsx';
import { AgendaSnoozeMenu } from './agenda-snooze-menu.tsx';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { StackPager } from './stack-pager.tsx';
import { useDoneCloseFlow } from './use-done-close-flow.ts';

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
  /** The machine the item is on: with it, an item that offers to close its card draws "Done · closes &F12". */
  readonly daemonId?: DaemonId;
  /** What ✕ is called: "Back to the chat", unless the host is somewhere else (the Inbox). */
  readonly closeLabel?: string;
  /**
   * The item cannot be answered here — it is parked or resolved (`agenda-settled.tsx`): this is drawn in the answer
   * row's place, and the arrow keys answer nothing.
   */
  readonly settled?: ReactNode;
  /**
   * Where a question the owner replied to stands (`agenda-settled.tsx`): drawn above the answer row, which stays
   * live — the reply does not answer the question, so its own options stay answerable.
   */
  readonly parkedNote?: ReactNode;
  /** The form an `input` item is answered with (`InputCardHost`): drawn in the card, in the answer row's place. */
  readonly inputForm?: ReactNode;
  /** A ferret's paste plan (`CopyPlanHost`): drawn in the card, in the answer row's place. */
  readonly planForm?: ReactNode;
}

/** Keys that are a field's or a button's own. */
const ownsKeys = (target: EventTarget): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, select, button, a, summary, [contenteditable]') !== null;

const KEY_DIRECTION: Readonly<Record<string, 'left' | 'up' | 'right'>> = {
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowRight: 'right',
};

/** Keeps the scroller's scroll padding at the height of the sticky head and dock, so nothing scrolled to hides behind them. */
function useScrollPadding(
  body: { readonly current: HTMLElement | null },
  head: { readonly current: HTMLElement | null },
  dock: HTMLElement | null,
): void {
  useEffect(() => {
    const scroller = body.current;
    const bar = head.current;
    if (scroller === null || bar === null || typeof ResizeObserver === 'undefined') return undefined;
    const apply = (): void => {
      scroller.style.scrollPaddingTop = `${bar.offsetHeight}px`;
      scroller.style.scrollPaddingBottom = `${dock?.offsetHeight ?? 0}px`;
    };
    apply();
    const watch = new ResizeObserver(apply);
    watch.observe(bar);
    if (dock !== null) watch.observe(dock);
    return () => watch.disconnect();
  }, [body, head, dock]);
}

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
  settled,
  parkedNote,
  inputForm,
  planForm,
  daemonId,
}: AgendaItemViewProps) {
  const root = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const top = useRef<HTMLElement | null>(null);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  useScrollPadding(body, top, dock);
  const quote = useQuoteMenu(root, quoteScope);
  const model = cardModel(item);
  const map = swipeMap(item);
  const head = agendaCardHead(item);
  const status = agendaStatus(item, agendaAuthor(item, ferret), now);
  const doneClose = useDoneCloseFlow(useDoneClose(daemonId, item), label => onAct({ kind: 'resolve', label }));
  const answerable = settled === undefined && !(inputForm !== undefined && item.kind === 'input');
  const canDismiss = answerable && model.dismissInMenu && !model.notice;
  // Request changes IS the owner's words: sent with what the composer holds, or the owner is put in the composer first.
  const requestChanges = (answer: AgendaCardAnswer): void => {
    const composer = quoteScope === null ? null : composerQuoteTarget(quoteScope);
    const words = composer?.draft().trim() ?? '';
    if (words === '') {
      composer?.replaceDraft(composer.draft());
      return;
    }
    const action = answerAction(answer, words);
    if (action !== null) onAct(action);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the dialog again whenever another item opens
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [item.id]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (ownsKeys(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (busy || !answerable) return;
    if (event.key === 'ArrowDown') {
      if (!canDismiss) return;
      event.preventDefault();
      onAct(DISMISS_ACTION);
      return;
    }
    const direction = KEY_DIRECTION[event.key];
    const action = direction === undefined ? undefined : map[direction];
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
      onKeyDown={onKeyDown}
      {...quote.handlers}
      ref={root}
      role="dialog"
      tabIndex={-1}
    >
      <div className="fy-item-view__body" data-agenda-body="" ref={body}>
        <div className="fy-item-view__column">
          <header className="fy-item-view__head" data-agenda-top="" ref={top}>
            <div className="fy-item-view__pager">
              {status === null ? null : (
                <span className="fy-item-view__status" title={status.label}>
                  <AgendaStatusPill status={status} />
                </span>
              )}
              <StackPager index={position.index} onNext={onNext} onPrevious={onPrevious} total={position.total} />
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
              {head.title}
            </h2>
            {head.description === null ? null : (
              <div className="fy-item-view__desc" data-agenda-ask="">
                {renderProse(head.description)}
              </div>
            )}
          </header>
          <AgendaItemCard
            busy={busy}
            error={error}
            ferret={ferret}
            item={item}
            now={now}
            onAct={onAct}
            renderProse={renderProse}
            swipeable={swipeable}
            answerDock={dock}
            {...(onProgress === undefined ? {} : { onProgress })}
            {...(doneClose === undefined ? {} : { doneClose })}
            {...(settled === undefined ? {} : { settled })}
            {...(parkedNote === undefined ? {} : { parkedNote })}
            {...(inputForm === undefined ? {} : { inputForm })}
            {...(planForm === undefined ? {} : { planForm })}
            {...(quoteScope === null ? {} : { onRequestChanges: requestChanges })}
          />
          <AgendaItemHistory events={history} ferret={ferret} now={now} renderProse={renderProse} />
          <div className="fy-item-view__dock" data-agenda-dock="" ref={setDock} />
        </div>
      </div>
      {quote.menu}
    </section>
  );
}
