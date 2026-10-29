/**
 * ONE ITEM'S FULL CARD, covering only the chat area (the header, the agenda line and the composer stay visible):
 * the header (who, the status pill, how long it has waited, when it was last updated), the title as the question,
 * then every section in ONE scroll (no scroll bar inside another), and an answer bar pinned at the bottom with
 * the options laid out as the swipes point (← ↑ →, the recommended one on the right; arrows only where it can be
 * swiped), "Add to reply" (↓: the item's "re:" chip into the composer), ‹ 2 of 5 › to the previous / next item
 * and ✕ to close. "Not needed…" is in the ⋯ menu. A swipe starts only from the top strip; the body scrolls.
 */

import type { AttentionItem } from '@ferretry/protocol';
import { ArrowDown, ChevronLeft, ChevronRight, MessageSquarePlus, X } from 'lucide-react';
import { type PointerEvent, type ReactNode, useId, useRef, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import {
  answerAction,
  CLEAR_ACTION,
  type InboxAction,
  optionAction,
  swipeTargets,
} from '../../lib/attention-answers.ts';
import { cardModel } from '../../lib/attention-card-model.ts';
import {
  DISMISS_ACTION,
  historyLine,
  questionAnswersAction,
  SWIPE_SLOP_PX,
  swipeIntent,
  swipeThreshold,
} from '../../lib/attention-inbox.ts';
import { updatedAgo } from '../../lib/attention-revisions.ts';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { AttentionActions } from './attention-actions.tsx';
import { attentionAge } from './attention-board.tsx';
import { AttentionBriefSections } from './attention-brief.tsx';
import { AttentionDelivery } from './attention-delivery.tsx';
import { AttentionDetail } from './attention-detail.tsx';

export interface AttentionFullCardProps {
  readonly item: AttentionItem;
  /** The ferret's name, for the header and "with Johnnie". */
  readonly ferret: string;
  /** Where it sits among the items it pages through; `index` counts from 0 and is said as "2 of 5". */
  readonly position: { readonly index: number; readonly total: number };
  readonly now?: number;
  readonly busy?: boolean;
  /** Why the last answer did not land. */
  readonly error?: string | null;
  /** It can be swiped (a touch screen): arrows on the answers, swipes from the top strip. */
  readonly swipeable: boolean;
  /** An option (or Not needed…): the host attaches the composer's text (`withComposerNote`) and sends it. */
  readonly onAct: (action: InboxAction) => void;
  /** ↓ / "Add to reply": this item's "re:" chip into the composer. */
  readonly onAddReply: () => void;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onClose: () => void;
  /** Ticks or unticks one step on the machine. Absent: the steps are read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  readonly renderProse?: (text: string) => ReactNode;
}

const markdownProse = (text: string): ReactNode => <ChatProse text={text} />;

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  moved: boolean;
  dx: number;
  dy: number;
}

export function AttentionFullCard({
  item,
  ferret,
  position,
  now = Date.now(),
  busy = false,
  error = null,
  swipeable,
  onAct,
  onAddReply,
  onPrevious,
  onNext,
  onClose,
  onProgress,
  renderProse = markdownProse,
}: AttentionFullCardProps) {
  const titleId = useId();
  const [picks, setPicks] = useState<readonly string[]>([]);
  const [offset, setOffset] = useState<{ readonly dx: number; readonly dy: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const model = cardModel(item);
  const status = agendaStatus(item, agendaAuthor(item, ferret), now);
  const ownersTurn = status === null || status.turn === 'owner';
  const questions = item.questions ?? [];
  const sendable =
    model.perQuestion && picks.some(pick => pick.trim() !== '') ? questionAnswersAction(questions, picks) : null;
  const updated = updatedAgo(item, now);
  const history = historyLine(item.history);
  const canSwipe = swipeable && ownersTurn && !model.notice && !busy;
  const give = (action: InboxAction): void => {
    if (!busy) onAct(action);
  };
  const sendAnswers = (): void => {
    if (sendable === null || busy) return;
    onAct(sendable);
    setPicks([]);
  };
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

  // A swipe is read from the top strip only: ← ↑ → answer, ↓ adds the item to the reply.
  const targets = canSwipe ? swipeTargets(item) : {};
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!canSwipe || (event.pointerType === 'mouse' && event.button !== 0)) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.getBoundingClientRect().width,
      moved: false,
      dx: 0,
      dy: 0,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    current.dx = event.clientX - current.startX;
    current.dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(current.dx, current.dy) < SWIPE_SLOP_PX) return;
    current.moved = true;
    setOffset({ dx: current.dx, dy: current.dy });
  };
  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setOffset(null);
    if (!commit || !current.moved) return;
    const down = Math.abs(current.dy) > Math.abs(current.dx) && current.dy >= swipeThreshold(current.width);
    if (down) {
      onAddReply();
      return;
    }
    const intent = swipeIntent(current.dx, current.dy, current.width, targets);
    const target = intent.committed && intent.direction !== null ? targets[intent.direction] : undefined;
    if (target?.action != null) give(target.action);
  };

  return (
    <article
      aria-labelledby={titleId}
      className="fy-full"
      data-attention-full-card={item.id}
      data-notice={model.notice || undefined}
      data-swipeable={canSwipe || undefined}
      data-tone={status?.tone}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="fy-full__top"
        data-attention-handle=""
        data-dragging={offset === null ? undefined : ''}
        onPointerCancel={event => finish(event, false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => finish(event, true)}
        style={
          offset === null ? undefined : { transform: `translate3d(${offset.dx}px, ${Math.min(0, offset.dy)}px, 0)` }
        }
      >
        <header className="fy-full__head">
          <span className="fy-full__who" data-attention-author="">
            {agendaAuthor(item, ferret)}
          </span>
          {status === null ? (
            <span className="fy-full__notice">Notification</span>
          ) : (
            <AgendaStatusPill status={status} />
          )}
          <span className="fy-full__age">{attentionAge(item.waitingSince, now)}</span>
          {updated === null ? null : (
            <span className="fy-full__updated" data-attention-updated-at="">
              {updated}
            </span>
          )}
        </header>
        <h2 className="fy-full__title" data-attention-title="" id={titleId}>
          {model.heading}
        </h2>
      </div>
      <div className="fy-full__body" data-attention-full-scroll="">
        <AttentionDelivery busy={busy} ferret={ferret} item={item} onAct={onAct} />
        {model.showAsk || picker !== undefined ? (
          <AttentionBriefSections
            askShown
            {...(model.showAsk && model.asking ? { askLabel: null } : {})}
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
        <AttentionDetail
          busy={busy}
          item={item}
          layout="full"
          renderProse={renderProse}
          {...(onProgress === undefined ? {} : { onProgress })}
        />
        {history === null ? null : (
          <p className="fy-full__history" data-attention-history="">
            {history}
          </p>
        )}
      </div>
      <footer className="fy-full__bar">
        {error === null ? null : (
          <p className="fy-full__error" role="alert">
            Not sent: {error}
          </p>
        )}
        {ownersTurn ? (
          <AttentionActions
            answers={model.answers}
            arrows={canSwipe}
            busy={busy}
            dismissInMenu={model.dismissInMenu && !model.notice}
            extraOptions={model.extras}
            onAnswer={answer => {
              const action = answerAction(answer, '');
              if (action !== null) give(action);
            }}
            onDismiss={() => give(DISMISS_ACTION)}
            onOption={option => give(optionAction(option, ''))}
            recommendationLine={model.recommendationLine}
            recommended={model.recommended}
            secondaryExtra={
              <button
                className="kt-btn fy-full__reply"
                data-attention-add-reply=""
                disabled={busy}
                onClick={onAddReply}
                type="button"
              >
                <MessageSquarePlus aria-hidden="true" size={14} />
                Add to reply
                {canSwipe ? <ArrowDown aria-hidden="true" size={13} /> : null}
                {canSwipe ? <span className="sr-only">, or swipe down</span> : null}
              </button>
            }
            swipeHints={canSwipe}
            {...(model.composerHint === undefined ? {} : { composerHint: model.composerHint })}
            {...(model.notice ? { clear: () => give(CLEAR_ACTION) } : {})}
            {...(model.perQuestion ? { sendAnswers: { ready: sendable !== null, onSend: sendAnswers } } : {})}
          />
        ) : (
          <div className="fy-full__waiting">
            <p className="fy-full__waiting-line" data-attention-waiting="" role="status">
              {status?.label ?? 'Waiting'} — it will update this.
            </p>
            <button className="kt-btn fy-full__reply" data-attention-add-reply="" onClick={onAddReply} type="button">
              <MessageSquarePlus aria-hidden="true" size={14} />
              Add to reply
            </button>
          </div>
        )}
        <nav aria-label="Agenda items" className="fy-full__nav">
          <button
            aria-label="Previous item"
            className="kt-btn fy-full__step"
            data-attention-previous=""
            disabled={onPrevious === undefined}
            onClick={onPrevious}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={18} />
          </button>
          <span className="fy-full__where" data-attention-position="">
            {position.index + 1} of {position.total}
          </span>
          <button
            aria-label="Next item"
            className="kt-btn fy-full__step"
            data-attention-next=""
            disabled={onNext === undefined}
            onClick={onNext}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={18} />
          </button>
          <button
            aria-label="Close"
            className="kt-btn fy-full__step fy-full__close"
            data-attention-close=""
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </nav>
      </footer>
    </article>
  );
}
