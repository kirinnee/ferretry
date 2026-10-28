/**
 * ONE ATTENTION ITEM, AS A CARD: the conversation it came from (linked), the summary in bold ONCE, the
 * structured brief as collapsible sections, the answers as buttons, one reply field and a ⋯ menu.
 *
 * It is the one card every place draws — the Attention inbox's deck, where it also swipes, and the
 * sheet over the ferret's own conversation — so an option reads, and answers, the same in both. It
 * holds no transport: every answer leaves through `onAct` as an {@link InboxAction}, and the host
 * decides whether it waits out an undo window (the inbox) or goes at once (the sheet).
 *
 * THE OPTION ORDER IS THE SWIPE ORDER (`inboxOptions`), and the first three carry the arrow the swipe
 * uses, so a reader who learns the buttons has learned the gestures. An item with several questions is
 * answered one answer per question and swipes Done / Dismiss only.
 */

import type { AttentionItem } from '@ferretry/protocol';
import { recommendedAttentionOption } from '@ferretry/protocol';
import { ArrowRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import {
  answersPerQuestion,
  hasAttentionBrief,
  historyLine,
  type InboxAction,
  inboxOptions,
  isTask,
  isWaitingOnFerret,
  questionAnswersAction,
  replyAction,
  stepsProgress,
  swipeMap,
  updatedSinceAsked,
  visibleWhy,
} from '../../lib/attention-inbox.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { AttentionActions } from './attention-actions.tsx';
import { attentionAge, attentionKindMeta, attentionReference, collapsesByDefault } from './attention-board.tsx';
import { AttentionBriefSections, PointForm } from './attention-brief.tsx';
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
  /** Draws the swipe arrow beside the first three options. */
  readonly swipeHints?: boolean;
  /** Ringed and labelled: the item a link or a reference pointed at. */
  readonly highlighted?: boolean;
  readonly now?: number;
  /** How the ask's context is drawn — the conversation renders references; the inbox, prose. */
  readonly renderProse?: (text: string) => ReactNode;
  readonly onAct: (action: InboxAction) => void;
  /** Ticks or unticks one step on the machine; a rejection rolls the tick back. Absent: the steps are read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  /** Pinned above the composer: no origin link, the brief folded behind "Details", the reply left to the composer. */
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
  const replyId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [answers, setAnswers] = useState<readonly string[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const kind = attentionKindMeta(item);
  const KindIcon = kind.icon;
  const options = inboxOptions(item);
  const map = swipeMap(item);
  const rich = hasAttentionBrief(item);
  const perQuestion = answersPerQuestion(item);
  const context = item.context?.trim() ? item.context : null;
  const longContext = context !== null && collapsesByDefault(context);
  const why = visibleWhy(item);
  const replyable = replyAction(item, reply);
  const task = isTask(item);
  const progress = stepsProgress(item);
  const history = historyLine(item.history);
  const updated = updatedSinceAsked(item);
  const body = item.body?.trim() ? item.body : null;
  const answer = item.ask?.kind === 'open-question';
  const questions = item.questions ?? [];
  const sendable = perQuestion ? questionAnswersAction(questions, answers) : null;
  const taskState = task
    ? { waiting: isWaitingOnFerret(item), ferret: origin?.ferret ?? 'the ferret', complete: progress.complete }
    : undefined;
  const sendReply = (): void => {
    if (replyable === null || busy) return;
    onAct(replyable);
    setReply('');
  };
  const sendAnswers = (): void => {
    if (sendable === null || busy) return;
    onAct(sendable);
    setAnswers([]);
  };
  const title = origin === undefined ? null : (origin.task ?? origin.ferret);
  const subtitle =
    origin === undefined ? null : origin.task === undefined ? origin.machine : `${origin.ferret} · ${origin.machine}`;
  return (
    <article
      aria-labelledby={`${replyId}-ask`}
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
          {kind.label}
        </span>
        <span className="mono text-meta text-faint">{attentionReference(item.id)}</span>
        {highlighted ? <span className="fy-attn-card__pointer">linked</span> : null}
        <span className="ml-auto shrink-0 whitespace-nowrap text-meta text-faint">
          {pinned
            ? attentionAge(item.waitingSince, now).replace(/^waiting /, '')
            : attentionAge(item.waitingSince, now)}
        </span>
      </header>
      {origin === undefined || pinned ? null : (
        <RouteLink
          className="fy-attn-card__origin"
          data-attention-origin=""
          onNavigate={origin.onNavigate}
          title={`Open ${title}'s conversation on ${origin.machine}`}
          to={origin.href}
        >
          <span aria-hidden="true" className="fy-attn-card__initial">
            {(title ?? '').charAt(0).toUpperCase()}
          </span>
          <span className="fy-attn-card__origin-text">
            <span className="fy-attn-card__origin-title">{title}</span>
            <span className="fy-attn-card__origin-sub">{subtitle}</span>
          </span>
        </RouteLink>
      )}
      <h3 className="fy-attn-card__ask" id={`${replyId}-ask`}>
        {item.subject}
      </h3>
      {why === null ? null : <div className="fy-attn-card__why">{renderProse(why)}</div>}
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
      {pinned && !detailsOpen && !perQuestion ? null : rich ? (
        <AttentionBriefSections
          item={item}
          picker={
            perQuestion
              ? {
                  answers,
                  disabled: busy,
                  onAnswer: (index, text) =>
                    setAnswers(current => {
                      const next = questions.map((_, at) => current[at] ?? '');
                      next[index] = text;
                      return next;
                    }),
                }
              : undefined
          }
          renderProse={renderProse}
        />
      ) : context === null ? null : (
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
      {history === null ? null : (
        <p className="fy-attn-card__history m-0 text-meta text-faint" data-attention-history="">
          {history}
        </p>
      )}
      {error === null ? null : (
        <p className="m-0 text-meta text-err" role="alert">
          Not sent: {error}
        </p>
      )}
      <AttentionActions
        answering={answer}
        busy={busy}
        map={map}
        onAct={onAct}
        onReplyChange={setReply}
        onSendReply={sendReply}
        options={options}
        recommended={recommendedAttentionOption(item)}
        reply={reply}
        replyLabel={answer ? 'Your answer' : `Reply to ${attentionReference(item.id)}`}
        replyable={replyable}
        swipeHints={swipeHints}
        showReply={!pinned}
        {...(taskState === undefined ? {} : { task: taskState })}
        {...(perQuestion ? { sendAnswers: { action: sendable, onSend: sendAnswers } } : {})}
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
