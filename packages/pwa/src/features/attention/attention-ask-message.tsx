/**
 * AN ASK, AS A MESSAGE IN THE FERRET'S CONVERSATION. Every ask starts in discussion: it is drawn in the chat
 * where it was raised, marked as an ask, with its question and its options as chips. Picking a chip answers it
 * (the composer's text rides along as the note); "Reply" makes it the composer's reply target. Nothing about it
 * overlays the conversation, and it reads like a message — a small "Ask · !A5" label, the question, the chips —
 * never a card.
 *
 * ITS STATES, by what the item says:
 * - in discussion: live chips, Reply, Details, ⋯ Not needed.
 * - surfaced (the ferret moved it to the Attention queue): the same, with a muted "Moved to your Attention
 *   queue" line. The chips stay live — the owner may still answer it here.
 * - answered (a resolved item): the chips are disabled and the answer that was picked is said.
 * - dismissed (a resolved item): no chips; "Not needed", with the reason when there was one.
 */

import {
  type AttentionItem,
  attentionInDiscussion,
  attentionTitle,
  hasOwnTitle,
  type ResolvedAttentionItem,
  recommendedAttentionOption,
  unswipedChoices,
} from '@ferretry/protocol';
import { ChevronRight, CornerUpLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import {
  answerAction,
  cardAnswers,
  type InboxAction,
  needsReplyText,
  optionAction,
} from '../../lib/attention-answers.ts';
import { DISMISS_ACTION } from '../../lib/attention-inbox.ts';
import { decidedSummary } from '../../lib/attention-revisions.ts';
import { ActionMenu, RecommendedTag } from './attention-actions.tsx';
import { attentionReference } from './attention-board.tsx';
import { AttentionDecidedSummary, AttentionUpdated } from './attention-updated.tsx';

export interface AttentionAskMessageProps {
  /** An open item, or a resolved one (an answered or dismissed ask keeps its place in the conversation). */
  readonly item: AttentionItem | ResolvedAttentionItem;
  /** An answer for it is on its way. */
  readonly busy?: boolean;
  /** This ask is what the composer is replying to. */
  readonly replying: boolean;
  /** Picks an option (or dismisses): the host attaches the composer's text (`withComposerNote`) and sends it. */
  readonly onAct: (action: InboxAction) => void;
  /** Makes this ask the composer's reply target. */
  readonly onReplyTo: () => void;
  /** Opens what the item knows beyond its question (`AttentionDetail`). Absent when there is nothing more. */
  readonly onOpenDetail?: () => void;
  readonly renderProse?: (text: string) => ReactNode;
  readonly now?: number;
}

/** The longest ask that is still read as the message's question. */
const QUESTION_MAX = 160;

const markdownProse = (text: string): ReactNode => <ChatProse text={text} />;

const sameLabel = (a: string, b: string | undefined): boolean =>
  b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** What the owner picked, in words: the answer line of a resolved ask. */
const answerLine = (item: ResolvedAttentionItem): string => {
  const { response } = item;
  const note = item.resolutionNote?.trim();
  const said = (picked: string): string => (note ? `${picked} · note: ${note}` : picked);
  switch (response?.kind) {
    case 'multiple-choice':
      return said(response.choice);
    case 'permission':
      return said(response.decision === 'approve' ? 'Approved' : 'Rejected');
    case 'other':
      return `Other answer: ${response.answer}`;
    case 'open-question':
      return response.answer;
    case 'answer-review':
      return said(response.verdict === 'good' ? 'Good' : 'Needs changes');
    case undefined:
      return said('Done');
  }
};

export function AttentionAskMessage({
  item,
  busy = false,
  replying,
  onAct,
  onReplyTo,
  onOpenDetail,
  renderProse = markdownProse,
}: AttentionAskMessageProps) {
  const resolved = 'disposition' in item ? item : null;
  const dismissed = resolved?.disposition === 'dismissed';
  const answered = resolved !== null && !dismissed;
  const surfaced = resolved === null && !attentionInDiscussion(item);
  const subject = item.subject.trim();
  const question =
    subject !== '' && subject.length <= QUESTION_MAX ? subject : hasOwnTitle(item) ? attentionTitle(item) : subject;
  const answers = cardAnswers(item).filter(answer => !needsReplyText(answer));
  const extras = unswipedChoices(item);
  const recommended = recommendedAttentionOption(item);
  const live = resolved === null;
  const give = (action: InboxAction): void => {
    if (!busy) onAct(action);
  };

  return (
    <article
      aria-label={`Ask ${attentionReference(item.id)}: ${question}`}
      className="fy-ask"
      data-attention-ask={item.id}
      data-replying={replying || undefined}
      data-state={dismissed ? 'dismissed' : answered ? 'answered' : surfaced ? 'surfaced' : 'discussion'}
    >
      <p className="fy-ask__label m-0" data-attention-ask-label="">
        Ask · {attentionReference(item.id)}
      </p>
      <div className="fy-ask__question" data-attention-ask-question="">
        {renderProse(question)}
      </div>
      {item.revisions === undefined && decidedSummary(item) === null ? null : (
        <p className="fy-ask__living m-0">
          <AttentionDecidedSummary item={item} />
          <AttentionUpdated compact item={item} />
        </p>
      )}
      {dismissed ? (
        <p className="fy-ask__result m-0" data-attention-ask-result="">
          Not needed{resolved?.resolutionNote ? `: ${resolved.resolutionNote}` : ''}
        </p>
      ) : (
        <>
          {answers.length + extras.length === 0 ? null : (
            <fieldset aria-label="Answers" className="fy-ask__chips">
              {answers.map(answer => (
                <button
                  className="kt-btn kt-btn--sm fy-ask__chip"
                  data-attention-ask-chip={answer.label}
                  data-recommended={sameLabel(answer.label, recommended) || undefined}
                  disabled={busy || !live}
                  key={answer.direction}
                  onClick={() => {
                    const action = answerAction(answer, '');
                    if (action !== null) give(action);
                  }}
                  title={answer.description}
                  type="button"
                >
                  {answer.label}
                  {sameLabel(answer.label, recommended) ? <RecommendedTag /> : null}
                </button>
              ))}
              {extras.map(option => (
                <button
                  className="kt-btn kt-btn--sm fy-ask__chip"
                  data-attention-ask-chip={option.label}
                  data-recommended={sameLabel(option.label, recommended) || undefined}
                  disabled={busy || !live}
                  key={option.label}
                  onClick={() => give(optionAction(option, ''))}
                  title={option.description}
                  type="button"
                >
                  {option.label}
                  {sameLabel(option.label, recommended) ? <RecommendedTag /> : null}
                </button>
              ))}
            </fieldset>
          )}
          {resolved === null ? null : (
            <p className="fy-ask__result m-0" data-attention-ask-result="">
              Answered: {answerLine(resolved)}
            </p>
          )}
        </>
      )}
      {surfaced ? (
        <p className="fy-ask__note m-0" data-attention-ask-surfaced="">
          Moved to your Attention queue
        </p>
      ) : null}
      <div className="fy-ask__row">
        {live ? (
          <button
            aria-pressed={replying}
            className="kt-btn kt-btn--sm fy-ask__link"
            data-attention-ask-reply=""
            onClick={onReplyTo}
            type="button"
          >
            <CornerUpLeft aria-hidden="true" size={13} />
            {replying ? 'Replying' : 'Reply'}
          </button>
        ) : null}
        {onOpenDetail === undefined ? null : (
          <button
            className="kt-btn kt-btn--sm fy-ask__link"
            data-attention-ask-details=""
            onClick={onOpenDetail}
            type="button"
          >
            Details
            <ChevronRight aria-hidden="true" size={13} />
          </button>
        )}
        {live ? <ActionMenu busy={busy} onDismiss={() => give(DISMISS_ACTION)} /> : null}
      </div>
    </article>
  );
}
