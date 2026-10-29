/**
 * ONE ATTENTION ITEM, AS A MINIMAL CARD THAT STANDS ALONE. Answering is replying, so the card has no text box:
 * the owner types in the ferret's normal message box, and a picked option carries that text as its note.
 *
 * What it holds, top to bottom: a header (what kind of card, which ferret and machine, how long it has
 * waited), the HEADING — the question itself when the item asks one in a sentence, else its title — and one
 * plain "why it matters" line. Then the options as buttons (three at most; the recommended one tagged, its
 * reason said once in a line under them) and a quiet second row: Skip, "Details ›" (only when the item has
 * more to read, which opens `AttentionDetail` in the host's side panel or full view) and a ⋯ menu holding
 * "Not needed…", which dismisses. A text-only ask has no options and says to reply in the message box.
 * An item with several questions keeps one picker per question and a single "Send answers".
 *
 * It is the one card every place draws — the Attention inbox's deck, where it also swipes, and the pinned
 * card over the ferret's conversation — so an answer reads, and is sent, the same in both. It holds no
 * transport: every answer leaves through `onAct` as an {@link InboxAction}, and the host decides whether
 * it waits out an undo window (the inbox) or goes at once, and attaches the message box's text
 * (`withComposerNote`).
 *
 * `flat` draws the same card with no frame, shadow or swipe arrows, held to a readable column of 720px at
 * most, for a pane that is the card's whole page; the answer bar stays pinned at the bottom of that pane.
 */

import type { AttentionItem, AttentionRevisableField } from '@ferretry/protocol';
import {
  attentionCardKind,
  attentionTitle,
  hasOwnTitle,
  recommendedAttentionOption,
  singleAttentionQuestion,
  unswipedChoices,
} from '@ferretry/protocol';
import { ArrowRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import {
  answerAction,
  cardAnswers,
  isTextOnlyAsk,
  kindWord,
  needsReplyText,
  optionAction,
} from '../../lib/attention-answers.ts';
import {
  answersPerQuestion,
  DISMISS_ACTION,
  historyLine,
  type InboxAction,
  isWaitingOnFerret,
  questionAnswersAction,
  updatedSinceAsked,
  visibleWhy,
  waitingSentence,
} from '../../lib/attention-inbox.ts';
import { decidedSummary, type RevisionHighlight, revisionHighlight } from '../../lib/attention-revisions.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { AttentionActions } from './attention-actions.tsx';
import { attentionAge, attentionKindMeta } from './attention-board.tsx';
import { AttentionBriefSections, cardLede } from './attention-brief.tsx';
import { AttentionDelivery } from './attention-delivery.tsx';
import { attentionHasDetail } from './attention-detail.tsx';
import { AttentionDecidedSummary, AttentionUpdated } from './attention-updated.tsx';

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
  /**
   * @deprecated The steps are read in `AttentionDetail`, which ticks them. Accepted only so a host that has
   * not moved over yet still compiles; the card draws no steps and ignores it.
   */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  /** Pinned above the composer: no origin. */
  readonly pinned?: boolean;
  /** A control at the end of the header, after the age — the pinned card's fold button. */
  readonly headerSlot?: ReactNode;
  /** Extra DOM id for scroll targets. */
  readonly id?: string;
  /** Drawn last under the question — the Attention page's "Last messages" toggle. */
  readonly detailEnd?: ReactNode;
  /** Skips the card without answering it; draws a quiet "Skip" in the answer bar's second row. Absent: no Skip. */
  readonly onSkip?: () => void;
  /**
   * Drawn FLAT, not as a card: no frame, shadow or rounded surface, no swipe arrows, the text held to a
   * readable width and left-aligned, the answer bar pinned at the bottom of the pane. A wide pointer screen,
   * where nothing swipes, draws the item this way; the phone, the deck and the pinned card keep the card.
   */
  readonly flat?: boolean;
  /** Opens what the item knows beyond its question (`AttentionDetail`): the side panel, or the phone's full view. */
  readonly onOpenDetail?: () => void;
}

/** The longest ask that is still drawn as the card's heading. */
const QUESTION_HEADING_MAX = 160;

const markdownProse = (text: string): ReactNode => <ChatProse text={text} />;

export function AttentionCard({
  item,
  origin,
  busy = false,
  error = null,
  swipeHints = false,
  highlighted = false,
  now = Date.now(),
  renderProse = markdownProse,
  onAct,
  id,
  pinned = false,
  headerSlot,
  detailEnd,
  onSkip,
  flat = false,
  onOpenDetail,
}: AttentionCardProps) {
  const titleId = useId();
  const [picks, setPicks] = useState<readonly string[]>([]);
  const kind = attentionKindMeta(item);
  const KindIcon = kind.icon;
  const allAnswers = cardAnswers(item);
  // A review's "Needs changes" IS the owner's words: it is the message box, not a button.
  const answers = allAnswers.filter(answer => !needsReplyText(answer));
  const asksForWords = answers.length < allAnswers.length;
  const extras = unswipedChoices(item);
  const perQuestion = answersPerQuestion(item);
  const textOnly = isTextOnlyAsk(item);
  const why = visibleWhy(item);
  const history = historyLine(item.history);
  const updated = updatedSinceAsked(item);
  const questions = item.questions ?? [];
  const sendable =
    perQuestion && picks.some(pick => pick.trim() !== '') ? questionAnswersAction(questions, picks) : null;
  // An item from before titles is headed by its whole ask, said once: a title cut from the ask would only
  // repeat its first words above it. (A push still cuts one, to fit a lock screen: `attentionTitle`.)
  const title = hasOwnTitle(item) ? attentionTitle(item) : item.subject.trim();
  const subject = item.subject.trim();
  // THE HEADING IS THE QUESTION. A card that asks is headed by its ask when it is short enough to read as a
  // heading; a longer one is headed by the title and the ask is the first line of the body. A note or a
  // to-do keeps its title, and its ask under "What happened" / "To do".
  const asking = !['info', 'task'].includes(attentionCardKind(item));
  const asksInHeading = asking && subject !== '' && subject.length <= QUESTION_HEADING_MAX;
  const heading = asksInHeading ? subject : title;
  const showAsk = !asksInHeading && subject !== title;
  const lede = cardLede(item, why);
  const highlight = revisionHighlight(item);
  // `fy attention add --recommend` puts a lone question's pick ON the question: the card says it in its
  // Recommendation all the same, so it never depends on where the ferret wrote it.
  const lone = singleAttentionQuestion(item);
  const recommendation =
    item.recommendation ??
    (lone?.recommended === undefined
      ? undefined
      : { decision: lone.recommended, ...(lone.why === undefined ? {} : { why: lone.why }) });
  const recommended = recommendedAttentionOption(item);
  const offered = [...answers.map(answer => answer.label), ...extras.map(option => option.label)];
  const recommendationLine =
    recommendation === undefined
      ? undefined
      : recommended !== undefined && offered.some(label => label.trim().toLowerCase() === recommended.toLowerCase())
        ? recommendation.why
        : `Recommended: ${recommendation.decision}${recommendation.why === undefined ? '' : ` — ${recommendation.why}`}`;
  const hasDismissAnswer = answers.some(answer => answer.does === 'dismiss');
  const composerHint = perQuestion
    ? undefined
    : textOnly
      ? 'Reply in the message box below.'
      : asksForWords
        ? 'To ask for changes, reply in the message box below.'
        : undefined;
  const give = (action: InboxAction): void => {
    if (busy) return;
    onAct(action);
  };
  const sendAnswers = (): void => {
    if (sendable === null || busy) return;
    onAct(sendable);
    setPicks([]);
  };

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
      data-flat={flat || undefined}
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
        {headerSlot}
      </header>
      <AttentionDelivery busy={busy} ferret={origin?.ferret} item={item} onAct={onAct} />
      <h3 className="fy-attn-card__title" data-attention-title="" id={titleId}>
        {heading}
      </h3>
      {lede.line === null ? null : (
        <p
          className="fy-attn-card__why m-0"
          data-attention-changed={changedCard(highlight, 'why', 'context') ? 'changed' : undefined}
          data-attention-why=""
        >
          {lede.line}
        </p>
      )}
      {item.revisions === undefined && decidedSummary(item) === null ? null : (
        <p className="fy-attn-card__living m-0" data-attention-living="">
          <AttentionDecidedSummary item={item} />
          <AttentionUpdated item={item} />
        </p>
      )}
      <div className="fy-attn-card__scroll" data-attention-scroll="">
        {updated === null ? null : (
          <p className="fy-attn-card__updated m-0" data-attention-resurfaced="">
            <span className="kt-attn-chip kt-label px-badge-x py-0.5">New</span>
            Needs you again — the ferret updated this
            {updated.note === undefined ? '.' : `: ${updated.note}`}
          </p>
        )}
        {showAsk || picker !== undefined ? (
          <AttentionBriefSections
            askShown
            {...(showAsk && asking ? { askLabel: null } : {})}
            collapsible={false}
            item={item}
            part="card"
            renderProse={renderProse}
            {...(perQuestion && recommendation !== undefined ? { recommendation } : {})}
            {...(showAsk ? { ask: item.subject } : {})}
            {...(picker === undefined ? {} : { picker })}
          />
        ) : null}
        {history === null ? null : (
          <p className="fy-attn-card__history m-0 text-meta text-faint" data-attention-history="">
            {history}
          </p>
        )}
        {detailEnd}
      </div>
      {error === null ? null : (
        <p className="m-0 text-meta text-err" role="alert">
          Not sent: {error}
        </p>
      )}
      <AttentionActions
        answers={answers}
        arrows={!flat && (swipeHints || pinned)}
        busy={busy}
        dismissInMenu={!hasDismissAnswer}
        extraOptions={extras}
        onAnswer={answer => {
          const action = answerAction(answer, '');
          if (action !== null) give(action);
        }}
        onDismiss={() => give(DISMISS_ACTION)}
        onOption={option => give(optionAction(option, ''))}
        recommendationLine={recommendationLine}
        recommended={recommended}
        swipeHints={swipeHints && !flat}
        {...(composerHint === undefined ? {} : { composerHint })}
        {...(onSkip === undefined ? {} : { onSkip })}
        {...(onOpenDetail !== undefined && attentionHasDetail(item) ? { onOpenDetail } : {})}
        {...(isWaitingOnFerret(item) ? { waiting: waitingSentence(item, origin?.ferret) } : {})}
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

const changedCard = (highlight: RevisionHighlight, ...fields: readonly AttentionRevisableField[]): boolean =>
  fields.some(field => highlight.fields.has(field));
