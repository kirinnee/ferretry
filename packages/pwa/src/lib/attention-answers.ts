/**
 * WHAT ANSWERING A CARD MEANS, as pure decisions: a card's answers (left · up · right) become the
 * actions the daemon is asked to take, and the optional reply typed on the card travels with whichever
 * answer is given — by swipe, tap or arrow key — as that action's `note`.
 *
 * The answers themselves come from the protocol (`attentionCardAnswers`), so an item raised before
 * cards had them reads exactly as it did. This module only decides how each one is SENT:
 *
 * | does       | sent as                                         |
 * | ---------- | ----------------------------------------------- |
 * | choose     | respond multiple-choice `{ choice: label }`     |
 * | approve    | respond permission approve                      |
 * | reject     | respond permission reject                       |
 * | good       | respond answer-review good                      |
 * | clarify    | respond answer-review clarify (the reply text)  |
 * | done       | resolve                                         |
 * | needs-info | needs-info                                      |
 * | dismiss    | dismiss                                         |
 *
 * AN ANSWER THE FERRET WORDED ITSELF says so: "Always allow" is `approve`, but the ferret must be told
 * the owner said "Always allow", so a label that differs from its effect's default leads the note
 * (`Always allow — <reply>`). A `clarify` is the one answer that cannot be sent empty: it IS the text.
 */

import {
  type AttentionAskOption,
  type AttentionCardAnswer,
  type AttentionCardSource,
  type AttentionDirection,
  type AttentionItem,
  type AttentionKind,
  type AttentionResponse,
  attentionCardAnswers,
  attentionCardKind,
  DEFAULT_ANSWER_LABELS,
  GOT_IT_LABEL,
  unswipedChoices,
} from '@ferretry/protocol';

/** What answering a card does, as the daemon is asked to do it. */
export type InboxAction =
  | {
      readonly kind: 'respond';
      readonly label: string;
      readonly response: AttentionResponse;
      readonly note?: string;
    }
  | { readonly kind: 'resolve'; readonly label: string; readonly note?: string }
  | { readonly kind: 'dismiss'; readonly label: string; readonly note?: string }
  | { readonly kind: 'needs-info'; readonly label: string; readonly note?: string };

/** The item fields the answers are read from. */
export type AnswerSource = AttentionCardSource & Pick<AttentionItem, 'waitingOn'>;

/** The three ways a card can be swiped, which are also the three arrows of its answer bar. */
export type AnswerDirection = AttentionDirection;

const withNote = (note: string | undefined): { readonly note?: string } => (note === undefined ? {} : { note });

/** Whether the ferret worded this answer itself, rather than leaving its effect's default word. */
export const hasCustomLabel = (answer: Pick<AttentionCardAnswer, 'does' | 'label'>): boolean => {
  if (answer.does === 'choose') return false;
  const label = answer.label.trim().toLowerCase();
  const defaults = [DEFAULT_ANSWER_LABELS[answer.does], answer.does === 'done' ? GOT_IT_LABEL : undefined];
  return !defaults.some(word => word?.toLowerCase() === label);
};

/** The note an answer carries: its own wording when that is not the default, then the reply. */
export const answerNote = (answer: Pick<AttentionCardAnswer, 'does' | 'label'>, reply: string): string | undefined => {
  const text = reply.trim();
  const head = hasCustomLabel(answer) ? answer.label.trim() : '';
  const note = head !== '' && text !== '' ? `${head} — ${text}` : head !== '' ? head : text;
  return note === '' ? undefined : note;
};

/** Whether the answer needs the reply box to hold text before it can be sent. */
export const needsReplyText = (answer: Pick<AttentionCardAnswer, 'does'>): boolean => answer.does === 'clarify';

/**
 * One answer as an action carrying `reply`, or `null` when it cannot be sent yet — a `clarify` with an
 * empty box. The caller opens the box instead.
 */
export const answerAction = (answer: AttentionCardAnswer, reply: string): InboxAction | null => {
  const note = answerNote(answer, reply);
  const label = answer.label;
  switch (answer.does) {
    case 'choose':
      return { kind: 'respond', label, response: { kind: 'multiple-choice', choice: label }, ...withNote(note) };
    case 'approve':
      return { kind: 'respond', label, response: { kind: 'permission', decision: 'approve' }, ...withNote(note) };
    case 'reject':
      return { kind: 'respond', label, response: { kind: 'permission', decision: 'reject' }, ...withNote(note) };
    case 'good':
      return { kind: 'respond', label, response: { kind: 'answer-review', verdict: 'good' }, ...withNote(note) };
    case 'clarify':
      return reply.trim() === '' || note === undefined
        ? null
        : {
            kind: 'respond',
            label,
            response: { kind: 'answer-review', verdict: 'clarify', clarification: note },
          };
    case 'done':
      return { kind: 'resolve', label, ...withNote(note) };
    case 'needs-info':
      return { kind: 'needs-info', label, ...withNote(note) };
    case 'dismiss':
      return { kind: 'dismiss', label, ...withNote(note) };
  }
};

/** An old choice's option past the third, as an action: a button only, never a swipe. */
export const optionAction = (option: AttentionAskOption, reply: string): InboxAction =>
  answerAction({ direction: 'left', does: 'choose', label: option.label }, reply) as InboxAction;

/**
 * The answers this card offers, left · up · right. A to-do waiting on its ferret cannot be done yet and
 * asking again is the same request, so it keeps only an answer the ferret added (a Skip).
 */
export const cardAnswers = (item: AnswerSource): readonly AttentionCardAnswer[] => {
  const answers = attentionCardAnswers(item);
  const waiting = item.ask?.kind === 'task' && item.waitingOn === 'ferret';
  return waiting ? answers.filter(answer => answer.does !== 'done' && answer.does !== 'needs-info') : answers;
};

/** What one swipe (or arrow) gives: its label for the stamp, and the action — `null` until a clarify has text. */
export interface SwipeTarget {
  readonly label: string;
  readonly description?: string;
  readonly answer: AttentionCardAnswer;
  readonly action: InboxAction | null;
}

export type SwipeTargets = Readonly<Partial<Record<AnswerDirection, SwipeTarget>>>;

/** Each direction the card answers, with what it would send carrying `reply`. */
export const swipeTargets = (item: AnswerSource, reply = ''): SwipeTargets =>
  Object.fromEntries(
    cardAnswers(item).map(answer => [
      answer.direction,
      {
        label: answer.label,
        ...(answer.description === undefined ? {} : { description: answer.description }),
        answer,
        action: answerAction(answer, reply),
      } satisfies SwipeTarget,
    ]),
  );

/** The answers in the order a button list takes them: the recommended (right) first, then up, then left. */
const BUTTON_ORDER: readonly AnswerDirection[] = ['right', 'up', 'left'];

/**
 * Every answer the card can send as an action, recommended first: the swiped answers, then an old
 * choice's options past the third. An answer that needs text it has not got is not in the list.
 */
export const answerActions = (item: AnswerSource, reply = ''): readonly InboxAction[] => {
  const targets = swipeTargets(item, reply);
  const swiped = BUTTON_ORDER.flatMap(direction => {
    const action = targets[direction]?.action;
    return action === undefined || action === null ? [] : [action];
  });
  return [...swiped, ...unswipedChoices(item).map(option => optionAction(option, reply))];
};

const KIND_WORDS: Readonly<Record<AttentionKind, string>> = {
  task: 'Task',
  yesno: 'Yes / no',
  permission: 'Permission',
  choice: 'Choice',
  review: 'Review',
  info: 'Info',
  reply: 'Reply',
};

/** The card's kind in the word its header says. */
export const kindWord = (item: Pick<AnswerSource, 'kind' | 'ask'>): string => KIND_WORDS[attentionCardKind(item)];

/**
 * Whether the card is a text-only ask: it has no answers to give, the reply box IS the answer, and
 * Send sends it. A reply card the ferret gave answers to is an ordinary card with an optional box.
 */
export const isTextOnlyAsk = (item: AnswerSource): boolean =>
  item.ask?.kind === 'open-question' && cardAnswers(item).length === 0;
