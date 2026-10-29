/**
 * ONE ATTENTION ITEM, AS A CARD THAT STANDS ALONE: a header (what kind of card, which ferret and machine,
 * how long it has waited), the TITLE, the ask, the recommendation when there is one — then, scrolling
 * inside the card, everything the owner needs to decide — and the answer bar pinned under it.
 *
 * It is the one card every place draws — the Attention inbox's deck, where it also swipes, and the
 * sheet over the ferret's own conversation — so an answer reads, and is sent, the same in both. It
 * holds no transport: every answer leaves through `onAct` as an {@link InboxAction}, and the host
 * decides whether it waits out an undo window (the inbox) or goes at once (the sheet).
 *
 * THE ANSWERS ARE THE CARD'S OWN (`cardAnswers`), laid out in the direction a swipe points them, and the
 * reply typed in the box rides along with whichever one is given. An item with several questions is
 * answered one answer per question and sends them together.
 */

import type { AttentionItem } from '@ferretry/protocol';
import { attentionTitle, DEFAULT_ANSWER_LABELS, unswipedChoices } from '@ferretry/protocol';
import { ArrowRight } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { answerAction, cardAnswers, isTextOnlyAsk, kindWord, optionAction } from '../../lib/attention-answers.ts';
import {
  answersPerQuestion,
  hasAttentionBrief,
  historyLine,
  type InboxAction,
  isWaitingOnFerret,
  questionAnswersAction,
  replyAction,
  updatedSinceAsked,
  visibleWhy,
} from '../../lib/attention-inbox.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { AttentionActions } from './attention-actions.tsx';
import { attentionAge, attentionKindMeta, collapsesByDefault } from './attention-board.tsx';
import { AttentionBriefSections, PointForm, RecommendedBadge } from './attention-brief.tsx';
import { useReplyDraft } from './attention-reply-draft.tsx';
import { AttentionBody, AttentionSteps } from './attention-steps.tsx';

/** Where the card came from, in the inbox. Inside its own conversation there is nothing to say. */
export interface AttentionCardOrigin {
  /** The ferret's name, as the sidebar shows it. */
  readonly ferret: string;
  /** The conversation's name — what it is working on — when that is not just the ferret's name. */
  readonly task?: string;
  readonly machine: string;
  /** The conversation, opened at this item. */
  readonly href: string;
  readonly onNavigate: (to: string) => void;
}

export interface AttentionCardProps {
  readonly item: AttentionItem;
  readonly origin?: AttentionCardOrigin;
  /** An answer for this card is on its way. */
  readonly busy?: boolean;
  /** Why the last answer did not land, said on the card it belongs to. */
  readonly error?: string | null;
  /** Draws the swipe arrow on each answer. */
  readonly swipeHints?: boolean;
  /** Ringed and labelled: the item a link or a reference pointed at. */
  readonly highlighted?: boolean;
  readonly now?: number;
  /** How the ask's context is drawn — the conversation renders references; the inbox, prose. */
  readonly renderProse?: (text: string) => ReactNode;
  readonly onAct: (action: InboxAction) => void;
  /** Ticks or unticks one step on the machine; a rejection rolls the tick back. Absent: the steps are read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  /** Pinned above the composer: no origin, the detail folded behind "Details", the reply left to the composer. */
  readonly pinned?: boolean;
  /** Extra DOM id for scroll targets. */
  readonly id?: string;
}

const plainProse = (text: string): ReactNode => <PointForm text={text} />;

export function AttentionCard({
  item,
  origin,
  busy = false,
  error = null,
  swipeHints = false,
  highlighted = false,
  now = Date.now(),
  renderProse = plainProse,
  onAct,
  onProgress,
  id,
  pinned = false,
}: AttentionCardProps) {
  const titleId = useId();
  const draft = useReplyDraft();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [localReply, setLocalReply] = useState('');
  const [replyOpen, setReplyOpen] = useState(false);
  const [localTick, setLocalTick] = useState(0);
  const [picks, setPicks] = useState<readonly string[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const pendingFocus = useRef(false);
  const reply = draft?.text ?? localReply;
  const setReply = draft?.setText ?? setLocalReply;
  const kind = attentionKindMeta(item);
  const KindIcon = kind.icon;
  const answers = cardAnswers(item);
  const extras = unswipedChoices(item);
  const rich = hasAttentionBrief(item);
  const perQuestion = answersPerQuestion(item);
  const textOnly = isTextOnlyAsk(item);
  const context = item.context?.trim() ? item.context : null;
  const longContext = context !== null && collapsesByDefault(context);
  const why = visibleWhy(item);
  const history = historyLine(item.history);
  const updated = updatedSinceAsked(item);
  const body = item.body?.trim() ? item.body : null;
  const questions = item.questions ?? [];
  const sendable = perQuestion ? questionAnswersAction(questions, picks) : null;
  const title = attentionTitle(item);
  const showAsk = item.subject.trim() !== title;
  const recommendation = item.recommendation;
  const hasDismissAnswer = answers.some(answer => answer.does === 'dismiss');
  const ferret = origin?.ferret ?? 'the ferret';
  const focusRequests = (draft?.focusTick ?? 0) + localTick;

  const openReply = (): void => {
    if (replyRef.current !== null) {
      replyRef.current.focus();
      return;
    }
    pendingFocus.current = true;
    setReplyOpen(true);
  };
  // The deck asks for the box when a swipe needs text it has not got.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request opens the box; openReply is stable in effect
  useEffect(() => {
    if (focusRequests > 0) openReply();
  }, [focusRequests]);
  useEffect(() => {
    if (!replyOpen || !pendingFocus.current) return;
    pendingFocus.current = false;
    replyRef.current?.focus();
  }, [replyOpen]);

  const give = (action: InboxAction | null): void => {
    if (action === null) {
      setLocalTick(tick => tick + 1);
      return;
    }
    if (busy) return;
    onAct(action);
    setReply('');
  };
  const sendReply = (): void => {
    const action = replyAction(item, reply);
    if (action === null || busy) return;
    onAct(action);
    setReply('');
  };
  const sendAnswers = (): void => {
    if (sendable === null || busy) return;
    onAct(sendable);
    setPicks([]);
  };

  const bodyAndSteps = (
    <>
      {updated === null ? null : (
        <p className="fy-attn-card__updated m-0" data-attention-updated="">
          <span className="kt-attn-chip kt-label px-badge-x py-0.5">New</span>
          Needs you again — the ferret updated this
          {updated.note === undefined ? '.' : `: ${updated.note}`}
        </p>
      )}
      {body === null ? null : <AttentionBody renderProse={renderProse} text={body} />}
      {item.steps === undefined ? null : (
        <AttentionSteps
          disabled={busy}
          done={item.stepsDone ?? []}
          renderProse={renderProse}
          steps={item.steps}
          {...(onProgress === undefined ? {} : { onProgress })}
        />
      )}
    </>
  );
  const folded = pinned && !detailsOpen && !perQuestion;
  const picker = perQuestion
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

  return (
    <article
      aria-labelledby={titleId}
      className="kt-attn fy-attn-card"
      data-attention-card={item.id}
      data-highlighted={highlighted || undefined}
      data-kind={kind.tone}
      data-pinned={pinned || undefined}
      id={id}
    >
      <header className="fy-attn-card__meta">
        <span className="kt-attn-chip kt-label inline-flex shrink-0 items-center gap-1 px-badge-x py-0.5">
          <KindIcon size={11} aria-hidden="true" />
          <span data-attention-kind="">{kindWord(item)}</span>
        </span>
        {origin === undefined || pinned ? null : (
          <RouteLink
            className="fy-attn-card__origin"
            data-attention-origin=""
            onNavigate={origin.onNavigate}
            title={`Open ${origin.ferret}'s conversation on ${origin.machine}`}
            to={origin.href}
          >
            <span className="fy-attn-card__origin-title">{origin.ferret}</span>
            <span aria-hidden="true">·</span>
            <span className="fy-attn-card__origin-sub">{origin.machine}</span>
          </RouteLink>
        )}
        {highlighted ? <span className="fy-attn-card__pointer">linked</span> : null}
        <span className="ml-auto shrink-0 whitespace-nowrap text-meta text-faint">
          {pinned
            ? attentionAge(item.waitingSince, now).replace(/^waiting /, '')
            : attentionAge(item.waitingSince, now)}
        </span>
      </header>
      <h3 className="fy-attn-card__title" data-attention-title="" id={titleId}>
        {title}
      </h3>
      {showAsk ? (
        <p className="fy-attn-card__ask" data-attention-ask="">
          {item.subject}
        </p>
      ) : null}
      {recommendation === undefined ? null : (
        <p className="fy-attn-card__rec" data-attention-recommendation="">
          <RecommendedBadge />
          <span>
            <strong>{recommendation.decision}</strong>
            {recommendation.why === undefined ? null : <> — {recommendation.why}</>}
          </span>
        </p>
      )}
      <div className="fy-attn-card__scroll" data-attention-scroll="">
        {why === null ? null : (
          <div className="fy-attn-card__why" data-attention-why="">
            {renderProse(why)}
          </div>
        )}
        {pinned && !perQuestion && (rich || context !== null) ? (
          <button
            aria-expanded={detailsOpen}
            className="fy-attn-card__details"
            data-attention-details=""
            onClick={() => setDetailsOpen(open => !open)}
            type="button"
          >
            {detailsOpen ? 'Hide details' : 'Details'}
          </button>
        ) : null}
        {folded ? (
          bodyAndSteps
        ) : rich ? (
          <AttentionBriefSections
            expanded={!pinned}
            item={item}
            renderProse={renderProse}
            showRecommendation={false}
            {...(picker === undefined ? {} : { picker })}
          >
            {bodyAndSteps}
          </AttentionBriefSections>
        ) : (
          <>
            {context === null ? null : (
              <div className="fy-attn-card__context" data-open={!longContext || contextOpen || undefined}>
                {renderProse(context)}
                {longContext ? (
                  <button
                    aria-expanded={contextOpen}
                    className="fy-attn-card__more"
                    onClick={() => setContextOpen(open => !open)}
                    type="button"
                  >
                    {contextOpen ? 'Show less' : 'Show more'}
                  </button>
                ) : null}
              </div>
            )}
            {bodyAndSteps}
          </>
        )}
        {history === null ? null : (
          <p className="fy-attn-card__history m-0 text-meta text-faint" data-attention-history="">
            {history}
          </p>
        )}
      </div>
      {error === null ? null : (
        <p className="m-0 text-meta text-err" role="alert">
          Not sent: {error}
        </p>
      )}
      <AttentionActions
        answers={answers}
        busy={busy}
        canSendReply={replyAction(item, reply) !== null}
        dismissInMenu={!hasDismissAnswer}
        extraOptions={extras}
        onAnswer={answer => give(answerAction(answer, reply))}
        onDismiss={() => {
          const action = answerAction(
            { direction: 'left', does: 'dismiss', label: DEFAULT_ANSWER_LABELS.dismiss },
            reply,
          );
          give(action === null ? null : { ...action, label: 'Dismiss' });
        }}
        onOption={option => give(optionAction(option, reply))}
        onReplyChange={setReply}
        onReplyOpenChange={open => (open ? openReply() : setReplyOpen(false))}
        onSendReply={sendReply}
        reply={reply}
        replyIsAnswer={textOnly && !perQuestion}
        replyOpen={replyOpen}
        replyRef={replyRef}
        showReply={!pinned && !perQuestion}
        swipeHints={swipeHints}
        {...(isWaitingOnFerret(item) ? { waitingOn: ferret } : {})}
        {...(perQuestion ? { sendAnswers: { ready: sendable !== null, onSend: sendAnswers } } : {})}
      />
      {origin === undefined || pinned ? null : (
        <RouteLink
          className="fy-attn-card__open"
          data-attention-open=""
          onNavigate={origin.onNavigate}
          to={origin.href}
        >
          Open conversation
          <ArrowRight size={13} aria-hidden="true" />
        </RouteLink>
      )}
    </article>
  );
}
