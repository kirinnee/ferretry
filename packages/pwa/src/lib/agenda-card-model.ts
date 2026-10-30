/**
 * WHAT ONE ITEM ASKS AND OFFERS, decided once for every surface that answers it (the card, the agenda row, the
 * full card): the heading, the answers as buttons, the recommendation and its one reason line, and the hint
 * for an item answered in the message box. Pure; the surfaces only draw it.
 */

import type { AgendaAskOption, AgendaCardAnswer, AgendaItem } from '@ferretry/protocol';
import {
  agendaCardKind,
  agendaTitle,
  hasOwnTitle,
  recommendedAgendaOption,
  singleAgendaQuestion,
  unswipedChoices,
} from '@ferretry/protocol';
import { cardAnswers, isTextOnlyAsk, needsReplyText } from './agenda-answers.ts';
import { answersPerQuestion, visibleWhy } from './agenda-inbox.ts';

/** The longest ask that is still drawn as the card's heading. */
const QUESTION_HEADING_MAX = 160;

export interface CardModel {
  /** A plain notification: no answers, no turn; the owner reads it and clears it. */
  readonly notice: boolean;
  /** The card's answers as buttons (left · up · right), without one that needs the owner's words. */
  readonly answers: readonly AgendaCardAnswer[];
  /** An old choice's options past the third: plain buttons, never a swipe. */
  readonly extras: readonly AgendaAskOption[];
  /** One answer per question, sent together. */
  readonly perQuestion: boolean;
  /** A review that wants changes written: the words are the message box's. */
  readonly asksForWords: boolean;
  readonly textOnly: boolean;
  /** The heading: the question when it is short enough to read as one, else the title. */
  readonly heading: string;
  /** The ask is NOT the heading, so it is the first line of the body. */
  readonly showAsk: boolean;
  /** The item asks something (a note or a to-do keeps its title and shows its ask under its own label). */
  readonly asking: boolean;
  readonly why: string | null;
  readonly recommendation: AgendaItem['recommendation'];
  readonly recommended: string | undefined;
  /** The one line under the buttons: why the recommendation. */
  readonly recommendationLine: string | undefined;
  /** "Not needed…" lives in the ⋯ menu: no answer of the card's own already dismisses. */
  readonly dismissInMenu: boolean;
  /** Says the answer is the message box's text. */
  readonly composerHint: string | undefined;
}

export const cardModel = (item: AgendaItem): CardModel => {
  const notice = item.notice === true;
  const allAnswers = notice ? [] : cardAnswers(item);
  const answers = allAnswers.filter(answer => !needsReplyText(answer));
  const asksForWords = answers.length < allAnswers.length;
  const extras = notice ? [] : unswipedChoices(item);
  const perQuestion = !notice && answersPerQuestion(item);
  const textOnly = !notice && isTextOnlyAsk(item);
  // An item from before titles is headed by its whole ask, said once: a title cut from the ask would only
  // repeat its first words above it. (A push still cuts one, to fit a lock screen: `agendaTitle`.)
  const title = hasOwnTitle(item) ? agendaTitle(item) : item.subject.trim();
  const subject = item.subject.trim();
  const asking = !notice && !['info', 'task'].includes(agendaCardKind(item));
  const asksInHeading = asking && subject !== '' && subject.length <= QUESTION_HEADING_MAX;
  // `fy agenda add --recommend` puts a lone question's pick ON the question: the card says it in its
  // Recommendation all the same, so it never depends on where the ferret wrote it.
  const lone = singleAgendaQuestion(item);
  const recommendation =
    item.recommendation ??
    (lone?.recommended === undefined
      ? undefined
      : { decision: lone.recommended, ...(lone.why === undefined ? {} : { why: lone.why }) });
  const recommended = notice ? undefined : recommendedAgendaOption(item);
  const offered = [...answers.map(answer => answer.label), ...extras.map(option => option.label)];
  const recommendationLine =
    recommendation === undefined || notice
      ? undefined
      : recommended !== undefined && offered.some(label => label.trim().toLowerCase() === recommended.toLowerCase())
        ? recommendation.why
        : `Recommended: ${recommendation.decision}${recommendation.why === undefined ? '' : ` — ${recommendation.why}`}`;
  return {
    notice,
    answers,
    extras,
    perQuestion,
    asksForWords,
    textOnly,
    heading: asksInHeading ? subject : title,
    showAsk: !asksInHeading && subject !== title,
    asking,
    why: visibleWhy(item),
    recommendation,
    recommended,
    recommendationLine,
    dismissInMenu: !answers.some(answer => answer.does === 'dismiss'),
    composerHint: perQuestion
      ? undefined
      : textOnly
        ? 'Reply in the message box below.'
        : asksForWords
          ? 'To ask for changes, reply in the message box below.'
          : undefined,
  };
};
