/**
 * ONE AGENDA ITEM, AS A MINIMAL CARD THAT STANDS ALONE. Answering is replying, so the card has no text box:
 * the owner types in the ferret's normal message box, and a picked option carries that text as its note.
 *
 * What it holds, top to bottom: a header (what kind of card, which ferret and machine, how long it has
 * waited), the HEADING — the question itself when the item asks one in a sentence, else its title — and one
 * plain "why it matters" line. Then the options as buttons (three at most; the recommended one tagged, its
 * reason said once in a line under them) and a quiet second row: Skip, "Details ›" (only when the item has
 * more to read, which opens `AgendaDetail` in the host's side panel or full view) and a ⋯ menu holding
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

import type { AgendaItem, AgendaRevisableField } from '@ferretry/protocol';
import { ArrowRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { answerAction, CLEAR_ACTION, kindWord, optionAction } from '../../lib/agenda-answers.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import {
  DISMISS_ACTION,
  historyLine,
  type InboxAction,
  questionAnswersAction,
  updatedSinceAsked,
} from '../../lib/agenda-inbox.ts';
import { decidedSummary, type RevisionHighlight, revisionHighlight } from '../../lib/agenda-revisions.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { AgendaActions } from './agenda-actions.tsx';
import { agendaAge, agendaKindMeta } from './agenda-board.tsx';
import { AgendaBriefSections, cardLede } from './agenda-brief.tsx';
import { AgendaDelivery } from './agenda-delivery.tsx';
import { agendaHasDetail } from './agenda-detail.tsx';
import { AgendaSnoozeMenu } from './agenda-snooze-menu.tsx';
import { AgendaBody } from './agenda-steps.tsx';
import { AgendaDecidedSummary, AgendaUpdated } from './agenda-updated.tsx';

/** Where the card came from, in the inbox. Inside its own conversation there is nothing to say. */
export interface AgendaCardOrigin {
  /** The ferret's name, as the sidebar shows it. */
  readonly ferret: string;
  /** The conversation's name — what it is working on — when that is not just the ferret's name. */
  readonly task?: string;
  readonly machine: string;
  /** The conversation, opened at this item. */
  readonly href: string;
  readonly onNavigate: (to: string) => void;
}

export interface AgendaCardProps {
  readonly item: AgendaItem;
  readonly origin?: AgendaCardOrigin;
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
   * @deprecated The steps are read in `AgendaDetail`, which ticks them. Accepted only so a host that has
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
  /** Snooze the item until this instant; absent: the clock button is not drawn. */
  readonly onSnooze?: (until: string) => void;
  /** Opens what the item knows beyond its question (`AgendaDetail`): the side panel, or the phone's full view. */
  readonly onOpenDetail?: () => void;
  /** The form an `input` item is answered with (`InputCardHost`): drawn in the answer bar's place. */
  readonly inputForm?: ReactNode;
  /** A ferret's paste plan (`CopyPlanHost`): drawn in the answer bar's place, its Allow and Decline are the answer. */
  readonly planForm?: ReactNode;
}

const markdownProse = (text: string): ReactNode => <ChatProse text={text} />;

export function AgendaCard({
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
  onSnooze,
  inputForm,
  planForm,
}: AgendaCardProps) {
  const titleId = useId();
  const [picks, setPicks] = useState<readonly string[]>([]);
  const kind = agendaKindMeta(item);
  const KindIcon = kind.icon;
  const model = cardModel(item);
  const { answers, extras, perQuestion, heading, showAsk, asking, recommendation, recommended } = model;
  const history = historyLine(item.history);
  const updated = updatedSinceAsked(item);
  const questions = item.questions ?? [];
  const sendable =
    perQuestion && picks.some(pick => pick.trim() !== '') ? questionAnswersAction(questions, picks) : null;
  const lede = cardLede(item, model.why);
  const highlight = revisionHighlight(item);
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
      data-agenda-card={item.id}
      data-highlighted={highlighted || undefined}
      data-flat={flat || undefined}
      data-kind={kind.tone}
      data-pinned={pinned || undefined}
      id={id}
    >
      <header className="fy-attn-card__meta">
        <span className="fy-attn-kind">
          <KindIcon size={11} aria-hidden="true" />
          <span data-agenda-kind="">{kindWord(item)}</span>
        </span>
        {origin === undefined || pinned ? null : (
          <RouteLink
            className="fy-attn-card__origin"
            data-agenda-origin=""
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
          {pinned ? agendaAge(item.waitingSince, now).replace(/^waiting /, '') : agendaAge(item.waitingSince, now)}
        </span>
        {onSnooze === undefined ? null : (
          <AgendaSnoozeMenu disabled={busy} now={now} onSnooze={onSnooze} triggerClass="fy-attn-card__snooze" />
        )}
        {headerSlot}
      </header>
      <AgendaDelivery busy={busy} ferret={origin?.ferret} item={item} onAct={onAct} />
      <h3 className="fy-attn-card__title" data-agenda-title="" id={titleId}>
        {heading}
      </h3>
      {lede.line === null ? null : (
        <div
          className="fy-attn-card__why"
          data-agenda-changed={changedCard(highlight, 'why', 'context') ? 'changed' : undefined}
          data-agenda-why=""
        >
          {renderProse(lede.line)}
        </div>
      )}
      {item.revisions === undefined && decidedSummary(item) === null ? null : (
        <p className="fy-attn-card__living m-0" data-agenda-living="">
          <AgendaDecidedSummary item={item} />
          <AgendaUpdated item={item} />
        </p>
      )}
      <div className="fy-attn-card__scroll" data-agenda-scroll="">
        {updated === null ? null : (
          <p className="fy-attn-card__updated m-0" data-agenda-resurfaced="">
            <span className="fy-attn-kind">New</span>
            Needs you again — the ferret updated this
            {updated.note === undefined ? '.' : `: ${updated.note}`}
          </p>
        )}
        {model.notice && item.body?.trim() ? <AgendaBody renderProse={renderProse} text={item.body} /> : null}
        {showAsk || picker !== undefined ? (
          <AgendaBriefSections
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
          <p className="fy-attn-card__history m-0 text-meta text-faint" data-agenda-history="">
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
      {planForm !== undefined ? (
        <div className="fy-attn-card__input" data-agenda-plan-form="">
          {planForm}
        </div>
      ) : inputForm !== undefined && item.kind === 'input' ? (
        <div className="fy-attn-card__input" data-agenda-input-form="">
          {inputForm}
        </div>
      ) : (
        <AgendaActions
          answers={answers}
          arrows={!flat && (swipeHints || pinned)}
          busy={busy}
          dismissInMenu={model.dismissInMenu && !model.notice}
          extraOptions={extras}
          onAnswer={answer => {
            const action = answerAction(answer, '');
            if (action !== null) give(action);
          }}
          onDismiss={() => give(DISMISS_ACTION)}
          onOption={option => give(optionAction(option, ''))}
          recommendationLine={model.recommendationLine}
          recommended={recommended}
          swipeHints={swipeHints && !flat}
          {...(model.composerHint === undefined ? {} : { composerHint: model.composerHint })}
          {...(model.notice ? { clear: () => give(CLEAR_ACTION) } : {})}
          {...(onSkip === undefined ? {} : { onSkip })}
          {...(onOpenDetail !== undefined && !model.notice && agendaHasDetail(item) ? { onOpenDetail } : {})}
          {...(item.waitingOn === 'ferret' && !model.notice
            ? { waiting: `With ${origin?.ferret ?? 'the ferret'} — it will update this.` }
            : {})}
          {...(perQuestion ? { sendAnswers: { ready: sendable !== null, onSend: sendAnswers } } : {})}
        />
      )}
      {origin === undefined || pinned ? null : (
        <RouteLink className="fy-attn-card__open" data-agenda-open="" onNavigate={origin.onNavigate} to={origin.href}>
          Open conversation
          <ArrowRight size={13} aria-hidden="true" />
        </RouteLink>
      )}
    </article>
  );
}

const changedCard = (highlight: RevisionHighlight, ...fields: readonly AgendaRevisableField[]): boolean =>
  fields.some(field => highlight.fields.has(field));
