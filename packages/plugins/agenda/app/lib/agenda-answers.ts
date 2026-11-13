/**
 * WHAT ANSWERING A CARD MEANS, as pure decisions: a card's answers (left · up · right) become the
 * actions the daemon is asked to take, and the optional reply typed on the card travels with whichever
 * answer is given — by swipe, tap or arrow key — as that action's `note`.
 *
 * The answers themselves come from the protocol (`agendaCardAnswers`), so an item raised before
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
  type AgendaAskOption,
  type AgendaCardAnswer,
  agendaCardAnswers,
  type AgendaCardSource,
  type AgendaDirection,
  type AgendaGate,
  agendaInDiscussion,
  type AgendaItem,
  agendaKindLabel,
  type AgendaResponse,
  agendaShape,
  type AgendaUndeliveredReply,
  type BoardReopenAttachments,
  isDefaultAnswerLabel,
  unswipedChoices,
} from '@ferretry/core-asks/contract';

/** What answering a card does, as the daemon is asked to do it. */
export type InboxAction =
  | {
      readonly kind: 'respond';
      readonly label: string;
      readonly response: AgendaResponse;
      readonly note?: string;
      /** The answer is to the gate attached to this thread (`gateAttached`), not to the thread: the daemon moves the card. */
      readonly gate?: true;
      /** WHICH card ask the gate answer is to (its reference), so a retry or a second tap is never spent on the next ask. */
      readonly cardAsk?: string;
      /** The ask the owner was shown (`AgendaItem.askVersion`, 1 when absent), so the daemon refuses it once the ferret replaced the ask. */
      readonly askVersion?: number;
      /** Files already uploaded to the item's session, sent with a Not good: the daemon carries them to the card's ferret. */
      readonly attachments?: BoardReopenAttachments;
    }
  | { readonly kind: 'resolve'; readonly label: string; readonly note?: string; readonly askVersion?: number }
  | { readonly kind: 'dismiss'; readonly label: string; readonly note?: string; readonly askVersion?: number }
  | { readonly kind: 'needs-info'; readonly label: string; readonly note?: string }
  | { readonly kind: 'discuss'; readonly label: string; readonly note?: string }
  | { readonly kind: 'snooze'; readonly label: string; readonly until: string }
  | { readonly kind: 'unsnooze'; readonly label: string };

/** The item fields the answers are read from. */
export type AnswerSource = AgendaCardSource &
  Pick<AgendaItem, 'waitingOn' | 'waitingFor'> & {
    readonly raisedBy?: AgendaItem['raisedBy'];
    readonly gate?: AgendaGate;
  };

/** The three ways a card can be swiped, which are also the three arrows of its answer bar. */
export type AnswerDirection = AgendaDirection;

/** The ways a card can be swiped: its three answers' directions. */
export type SwipeDirection = AnswerDirection;

const withNote = (note: string | undefined): { readonly note?: string } => (note === undefined ? {} : { note });

/** Whether the ferret worded this answer itself, rather than leaving its effect's default word. */
export const hasCustomLabel = (answer: Pick<AgendaCardAnswer, 'does' | 'label'>): boolean =>
  answer.does !== 'choose' && !isDefaultAnswerLabel(answer.does, answer.label);

/** The note an answer carries: its own wording when that is not the default, then the reply. */
export const answerNote = (answer: Pick<AgendaCardAnswer, 'does' | 'label'>, reply: string): string | undefined => {
  const text = reply.trim();
  const head = hasCustomLabel(answer) ? answer.label.trim() : '';
  const note = head !== '' && text !== '' ? `${head} — ${text}` : head !== '' ? head : text;
  return note === '' ? undefined : note;
};

/** Whether the answer needs the reply box to hold text before it can be sent. */
export const needsReplyText = (answer: Pick<AgendaCardAnswer, 'does'>): boolean => answer.does === 'clarify';

/**
 * One answer as an action carrying `reply`, or `null` when it cannot be sent yet — a `clarify` with an
 * empty box. The caller opens the box instead.
 */
export const answerAction = (answer: AgendaCardAnswer, reply: string): InboxAction | null => {
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

/**
 * The action with the ask version the owner was SHOWN: stamped when the answer is given (and so kept through the undo
 * window and any retry), never read again at send time, when the ferret may have replaced the ask. An answer to the
 * item's own ask carries it, and so do the Done and Skip given from that ask; a gate answer, a version already on the
 * action and every other kind pass through.
 */
export const withAskVersion = (action: InboxAction, item: Pick<AgendaItem, 'askVersion'>): InboxAction =>
  (action.kind !== 'respond' && action.kind !== 'resolve' && action.kind !== 'dismiss') ||
  (action.kind === 'respond' && action.gate !== undefined) ||
  action.askVersion !== undefined
    ? action
    : { ...action, askVersion: item.askVersion ?? 1 };

/** Clearing a plain notification: reading it was the whole of it, so it resolves with no note. */
export const CLEAR_ACTION: InboxAction = { kind: 'resolve', label: 'Clear' };

/** The label a retried answer carries (the undo toast says "Marked !A3 done"; the button said "Retry"). */
export const RETRY_LABEL = 'Retry';

/**
 * The owner's own answer that never reached the ferret, as the action that sends it again. Each variant of
 * `undelivered.reply` is the action request without its id, and each `InboxAction` kind is sent as
 * exactly that request — so Retry is the same POST the answer was, through the same client.
 */
export const undeliveredAction = (reply: AgendaUndeliveredReply): InboxAction => {
  const note = withNote(reply.note);
  switch (reply.action) {
    case 'resolve':
      return reply.response === undefined
        ? { kind: 'resolve', label: RETRY_LABEL, ...note }
        : { kind: 'respond', label: RETRY_LABEL, response: reply.response, ...note };
    case 'dismiss':
      return { kind: 'dismiss', label: RETRY_LABEL, ...note };
    case 'needs-info':
      return { kind: 'needs-info', label: RETRY_LABEL, ...note };
    case 'discuss':
      return { kind: 'discuss', label: RETRY_LABEL, ...note };
  }
};

/** An old choice's option past the third, as an action: a button only, never a swipe. */
export const optionAction = (option: AgendaAskOption, reply: string): InboxAction =>
  answerAction({ direction: 'left', does: 'choose', label: option.label }, reply) as InboxAction;

/**
 * The answers this card offers, left · up · right — a row of options in the options list's order, as the protocol
 * lays it out (`agendaCardAnswers`). A to-do waiting on its ferret cannot be done yet and asking again is the same
 * request, so it keeps only an answer the ferret added (a Skip).
 */
export const cardAnswers = (item: AnswerSource): readonly AgendaCardAnswer[] => {
  const answers = agendaCardAnswers(item);
  // A card in discussion stays fully answerable: only a plain "need more info" wait takes Done away.
  const waiting = item.ask?.kind === 'task' && item.waitingOn === 'ferret' && !agendaInDiscussion(item);
  return waiting ? answers.filter(answer => answer.does !== 'done' && answer.does !== 'needs-info') : answers;
};

/** What one swipe (or arrow) gives: its label for the stamp, and the action — `null` until a clarify has text. */
export interface SwipeTarget {
  readonly label: string;
  readonly description?: string;
  readonly answer?: AgendaCardAnswer;
  readonly action: InboxAction | null;
}

export type SwipeTargets = Readonly<Partial<Record<SwipeDirection, SwipeTarget>>>;

/** Each direction the card answers, with what it would send carrying `reply`. */
export const swipeTargets = (item: AnswerSource, reply = ''): SwipeTargets => ({
  ...Object.fromEntries(
    cardAnswers(item).map(answer => [
      answer.direction,
      {
        label: answer.label,
        ...(answer.description === undefined ? {} : { description: answer.description }),
        answer,
        action: answerAction(answer, reply),
      } satisfies SwipeTarget,
    ]),
  ),
});

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

/** The card's kind in the word its header says. */
export const kindWord = (item: Pick<AnswerSource, 'kind' | 'ask'> & { readonly notice?: true | undefined }): string =>
  item.notice === true ? 'Notification' : agendaKindLabel(item);

/**
 * Whether the card is answered in words alone: an open question, several questions, or a question mixed with steps
 * (`agendaShape` reply or answers). It has no buttons; the owner answers in the message box below.
 */
export const isTextOnlyAsk = (item: AnswerSource & { readonly notice?: true | undefined }): boolean => {
  const shape = agendaShape(item);
  return shape === 'reply' || shape === 'answers';
};
