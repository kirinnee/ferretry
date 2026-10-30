/**
 * AN AGENDA ITEM AS A CARD: its title, its kind and its answers by swipe direction.
 *
 * The one place those are decided, so the CLI that raises an item, the daemon that pushes it and the
 * app that draws it agree. An item raised before cards had titles carries none of these fields; every
 * reader goes through the functions here, which derive them from the item's ask and summary, so an old
 * item reads exactly as it did — never a parse failure, never a second migration.
 *
 * The defaults (docs/agenda.md, "Answering a card"):
 *
 * | kind       | ←              | ↑ (optional)      | →             |
 * | ---------- | -------------- | ----------------- | ------------- |
 * | task       | Need more info | e.g. Skip         | Done          |
 * | yesno      | No             |                   | Yes           |
 * | permission | Deny           | e.g. Always allow | Allow         |
 * | choice (2) | the other      |                   | recommended   |
 * | choice (3) | the third      | the second        | recommended   |
 * | review     | Needs changes  |                   | Looks good    |
 * | info       |                |                   | Got it        |
 * | reply      |                |                   |               |
 * | input      |                |                   |               |
 *
 * The recommended answer is always on the right; a choice with no recommendation recommends its first
 * option.
 */
import {
  AGENDA_PUSH_TITLE_LENGTH,
  type AgendaAnswerEffect,
  type AgendaAsk,
  type AgendaAskOption,
  type AgendaBrief,
  type AgendaCardAnswer,
  type AgendaDirection,
  type AgendaKind,
  MAX_AGENDA_CARD_ANSWERS,
  recommendedAgendaOption,
} from './agenda.ts';

/** The words a yes-or-no card's two options are. */
export const YES_LABEL = 'Yes';
export const NO_LABEL = 'No';

/** The default label of each answer a card can give, when the ferret did not word it. */
export const DEFAULT_ANSWER_LABELS: Readonly<Record<Exclude<AgendaAnswerEffect, 'choose'>, string>> = {
  approve: 'Allow',
  reject: 'Deny',
  good: 'Looks good',
  clarify: 'Needs changes',
  done: 'Done',
  'needs-info': 'Need more info',
  dismiss: 'Skip',
};

/**
 * The fixed answer EVERY card a ferret raised carries besides its own (at most three): talk it through
 * before answering. It never takes one of the three direction slots — the app gives it the downward swipe
 * and its own button (docs/agenda.md, "Discuss").
 */
export const DISCUSS_LABEL = 'Discuss';

/** Whether the owner can ask to discuss an item: only one a ferret raised has a ferret to talk to. */
export const agendaCanDiscuss = (item: { readonly raisedBy: 'human' | 'agent' | 'daemon' }): boolean =>
  item.raisedBy === 'agent';

/** Whether an open item is in discussion: still being talked through in chat, not yet surfaced to the owner's queue. */
export const agendaInDiscussion = (item: {
  readonly waitingOn?: 'ferret' | undefined;
  readonly waitingFor?: 'info' | 'discussion' | undefined;
}): boolean => item.waitingOn === 'ferret' && item.waitingFor === 'discussion';

/** The label `info`'s one answer carries: it resolves the item, acknowledged. */
export const GOT_IT_LABEL = 'Got it';

/** The order the answer bar lays answers out in: the same order the swipes point. */
export const ANSWER_DIRECTIONS: readonly AgendaDirection[] = ['left', 'up', 'right'];

/** What the card fields are read from: an item, or a request to raise one. */
export interface AgendaCardSource extends AgendaBrief {
  readonly subject: string;
  readonly ask?: AgendaAsk | undefined;
  readonly title?: string | undefined;
  readonly kind?: AgendaKind | undefined;
  readonly answers?: readonly AgendaCardAnswer[] | undefined;
}

/** Whether a choice ask is exactly Yes and No, in either order and case. */
export const isYesNoAsk = (ask: AgendaAsk | undefined): boolean => {
  if (ask?.kind !== 'multiple-choice' || ask.options.length !== 2) return false;
  const labels = ask.options.map(option => option.label.trim().toLowerCase()).sort();
  return labels[0] === NO_LABEL.toLowerCase() && labels[1] === YES_LABEL.toLowerCase();
};

/** The kind an ask means, for an item that does not say (raised before cards had kinds). */
export const kindOfAsk = (ask: AgendaAsk | undefined): AgendaKind => {
  switch (ask?.kind) {
    case undefined:
      return 'info';
    case 'permission':
      return 'permission';
    case 'multiple-choice':
      return isYesNoAsk(ask) ? 'yesno' : 'choice';
    case 'answer-review':
      return 'review';
    case 'open-question':
      return 'reply';
    case 'task':
      return 'task';
  }
};

/** The card's kind: the one it was raised with, else the one its ask means. */
export const agendaCardKind = (item: Pick<AgendaCardSource, 'kind' | 'ask'>): AgendaKind =>
  item.kind ?? kindOfAsk(item.ask);

/** The ask each kind is raised with; `choice` and `yesno` need their options, `info` asks nothing. */
export const askForKind = (kind: AgendaKind, options: readonly AgendaAskOption[] = []): AgendaAsk | undefined => {
  switch (kind) {
    case 'task':
      return { kind: 'task' };
    case 'yesno':
      return { kind: 'multiple-choice', options: [{ label: YES_LABEL }, { label: NO_LABEL }] };
    case 'permission':
      return { kind: 'permission' };
    case 'choice':
      return { kind: 'multiple-choice', options: [...options] };
    case 'review':
      return { kind: 'answer-review' };
    case 'info':
      return undefined;
    case 'reply':
      return { kind: 'open-question' };
    case 'input':
      return undefined;
  }
};

const answer = (
  direction: AgendaDirection,
  does: AgendaCardAnswer['does'],
  label: string,
  description?: string,
): AgendaCardAnswer => ({ direction, does, label, ...(description === undefined ? {} : { description }) });

/** The label a choice option is answered with, as the ask spells it. */
const optionLabel = (options: readonly AgendaAskOption[], wanted: string): AgendaAskOption | undefined =>
  options.find(option => option.label.trim().toLowerCase() === wanted.trim().toLowerCase());

/**
 * A choice's answers: the recommended option (or the first) on the right, then the rest in the order
 * the ferret listed them — the next one up, the one after left. With two options there is no up.
 * Options past the third have no direction; the card still offers them as buttons.
 */
const choiceAnswers = (options: readonly AgendaAskOption[], recommended: string | undefined): AgendaCardAnswer[] => {
  const right = (recommended === undefined ? undefined : optionLabel(options, recommended)) ?? options[0];
  if (right === undefined) return [];
  const rest = options.filter(option => option !== right);
  const directions: readonly AgendaDirection[] = rest.length === 1 ? ['left'] : ['up', 'left'];
  return [
    answer('right', 'choose', right.label, right.description),
    ...rest
      .slice(0, MAX_AGENDA_CARD_ANSWERS - 1)
      .map((option, index) => answer(directions[index] ?? 'left', 'choose', option.label, option.description)),
  ];
};

/** The extra answer a ferret may put on the up swipe of a task or a permission card. */
export interface UpAnswer {
  readonly label: string;
  readonly description?: string;
}

/**
 * The answers a card of `kind` offers by default, given its ask (for a choice's options), the option it
 * recommends, and the optional up answer a task or a permission takes. Laid out left · up · right.
 */
export const defaultAgendaAnswers = (
  kind: AgendaKind,
  ask: AgendaAsk | undefined,
  recommended?: string,
  up?: UpAnswer,
): AgendaCardAnswer[] => {
  const labels = DEFAULT_ANSWER_LABELS;
  const answers = ((): AgendaCardAnswer[] => {
    switch (kind) {
      case 'task':
        return [
          answer('left', 'needs-info', labels['needs-info']),
          ...(up === undefined ? [] : [answer('up', 'dismiss', up.label, up.description)]),
          answer('right', 'done', labels.done),
        ];
      case 'yesno': {
        const options = ask?.kind === 'multiple-choice' ? ask.options : [];
        return [
          answer('left', 'choose', optionLabel(options, NO_LABEL)?.label ?? NO_LABEL),
          answer('right', 'choose', optionLabel(options, YES_LABEL)?.label ?? YES_LABEL),
        ];
      }
      case 'permission':
        return [
          answer('left', 'reject', labels.reject),
          ...(up === undefined ? [] : [answer('up', 'approve', up.label, up.description)]),
          answer('right', 'approve', labels.approve),
        ];
      case 'choice':
        return ask?.kind === 'multiple-choice' ? choiceAnswers(ask.options, recommended) : [];
      case 'review':
        return [answer('left', 'clarify', labels.clarify), answer('right', 'good', labels.good)];
      case 'info':
        return [answer('right', 'done', GOT_IT_LABEL)];
      case 'reply':
      case 'input':
        return [];
    }
  })();
  return byDirection(answers);
};

/** Answers in the order the answer bar draws them: left, up, right. */
export const byDirection = (answers: readonly AgendaCardAnswer[]): AgendaCardAnswer[] =>
  [...answers].sort(
    (left, right) => ANSWER_DIRECTIONS.indexOf(left.direction) - ANSWER_DIRECTIONS.indexOf(right.direction),
  );

/**
 * The card's answers, left · up · right: the ones it was raised with, else its kind's defaults — which
 * is how an item from before cards reads (its choice recommends what its brief recommends).
 */
export const agendaCardAnswers = (item: AgendaCardSource): AgendaCardAnswer[] =>
  item.answers !== undefined
    ? byDirection(item.answers)
    : defaultAgendaAnswers(agendaCardKind(item), item.ask, recommendedAgendaOption(item));

/** The answer a direction gives on this card, if any. */
export const answerInDirection = (
  answers: readonly AgendaCardAnswer[],
  direction: AgendaDirection,
): AgendaCardAnswer | undefined => answers.find(each => each.direction === direction);

/**
 * The choice options a card offers as buttons but NOT as swipes: an old item's options past the third.
 * New items cannot have any (the CLI refuses more than three).
 */
export const unswipedChoices = (item: AgendaCardSource): AgendaAskOption[] => {
  if (item.ask?.kind !== 'multiple-choice') return [];
  const swiped = new Set(
    agendaCardAnswers(item)
      .filter(each => each.does === 'choose')
      .map(each => each.label.trim()),
  );
  return item.ask.options.filter(option => !swiped.has(option.label.trim()));
};

/**
 * One line of at most `limit` characters, cut at the last word that fits and ending in an ellipsis; a
 * single word longer than the limit is cut where it stands.
 */
export const clipAtWord = (text: string, limit: number): string => {
  const line = text.replaceAll(/\s+/gu, ' ').trim();
  if (line.length <= limit) return line;
  const room = line.slice(0, limit - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor(limit / 2) ? room.slice(0, space) : room;
  return `${cut.trimEnd().replace(/[\s,;:.\-–—]+$/u, '')}…`;
};

/**
 * The card's title: the one it was raised with, else — an item from before titles — the start of its
 * ask, cut at a word to fit a lock screen's heading.
 */
export const agendaTitle = (item: Pick<AgendaCardSource, 'title' | 'subject'>): string => {
  const title = item.title?.trim() ?? '';
  return title !== '' ? title : clipAtWord(item.subject, AGENDA_PUSH_TITLE_LENGTH);
};

/** Whether the card has a title of its own, rather than one cut from its ask. */
export const hasOwnTitle = (item: Pick<AgendaCardSource, 'title' | 'subject'>): boolean =>
  (item.title?.trim() ?? '') !== '';

/**
 * WHOSE TURN an item is on the ferret's agenda: the OWNER's (it waits on them — the only turn that can stop a
 * ferret on the owner), the FERRET's (the owner replied, asked for more, or wants to talk it through, and the
 * ferret has not updated it yet), or DONE (resolved or dismissed). The internal discussion state is the ferret's
 * turn; the app shows no separate "in discussion" mode. A NOTICE (`fy notify`) is nobody's turn: it is read,
 * not answered, so it reads as `done` and never counts toward what waits on the owner.
 */
export type AgendaTurn = 'owner' | 'ferret' | 'done';

export const agendaTurn = (item: {
  readonly waitingOn?: 'ferret' | undefined;
  readonly resolvedAt?: string | undefined;
  readonly notice?: true | undefined;
}): AgendaTurn =>
  item.resolvedAt !== undefined || item.notice === true ? 'done' : item.waitingOn === 'ferret' ? 'ferret' : 'owner';
