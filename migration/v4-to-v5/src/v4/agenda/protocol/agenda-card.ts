// VENDORED from v4.291.5 (64fd8cbcc811e2341f1ab18be170d76106a44852) packages/protocol/src/lib/agenda-card.ts, verbatim.
// The converter's own frozen v4 reader: never imported by the product. Do not edit; re-vendor instead.
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
 * | kind       | ←               | ↑ (optional)      | →             |
 * | ---------- | --------------- | ----------------- | ------------- |
 * | task       |                 | e.g. Skip         | Mark as done  |
 * | yesno      | No              |                   | Yes           |
 * | permission | Deny            | e.g. Always allow | Approve       |
 * | choice (2) | the first       |                   | the second    |
 * | choice (3) | the first       | the second        | the third     |
 * | review     | Request changes |                   | Approve       |
 * | info       |                 |                   | Got it        |
 * | reply      |                 |                   |               |
 * | form       |                 |                   |               |
 * | input      |                 |                   |               |
 *
 * WHAT A CARD SHOWS IS ITS SHAPE (`agendaShape`), and the buttons follow it for every item, old or new: a card
 * asked in words — one open question, several questions, or a question mixed with steps — has NO buttons (the
 * reply box is the answer); a to-do has only Mark as done (and a Skip its ferret added); a notice or an info card
 * only Got it. An item stored with more answers than its shape takes keeps them in its record, never on its card.
 *
 * ONE MEANING FOR EVERY SWIPE: a row of options reads in the options list's order — the first ←, the second ↑,
 * the third → (two: ← and →; one: ↑) — wherever the recommendation sits, so a swipe means the same in the Inbox
 * deck, on the card, in the item view and in what the CLI prints. The recommended option is the one kept on the
 * row when there are more than three, and is tagged where it lands. Swipe ↓ is never an answer.
 *
 * YES AND NO HAVE ONE FIXED PLACE: a row of exactly Yes and No is always No ← · Yes →, whatever order the ferret
 * listed them in (`yesNoOrder`) — as a gate is Not good ← · Done →, the forward answer on the right.
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
  singleAgendaQuestion,
} from './agenda.ts';
import { plainLabel } from './plain-label.ts';

/** The words a yes-or-no card's two options are. */
export const YES_LABEL = 'Yes';
export const NO_LABEL = 'No';

/** Where Yes and No sit, left to right, on every surface: No ←, Yes →. */
export const YES_NO_ORDER: readonly [typeof NO_LABEL, typeof YES_LABEL] = [NO_LABEL, YES_LABEL];

/** Whether these labels are exactly Yes and No, in either order and case. */
const isYesNoPair = (labels: readonly string[]): boolean => {
  if (labels.length !== 2) return false;
  const sorted = labels.map(label => label.trim().toLowerCase()).sort();
  return sorted[0] === NO_LABEL.toLowerCase() && sorted[1] === YES_LABEL.toLowerCase();
};

/**
 * Yes and No in their one fixed order (`YES_NO_ORDER`: No first), whatever order they came in; anything that is not
 * exactly Yes and No is returned as it is. The swipe row, the buttons and a form's yes/no field all read it.
 */
export const yesNoOrder = <T>(items: readonly T[], labelOf: (item: T) => string): T[] => {
  if (!isYesNoPair(items.map(labelOf))) return [...items];
  const no = (item: T): boolean => labelOf(item).trim().toLowerCase() === NO_LABEL.toLowerCase();
  return [...items].sort((a, b) => Number(no(b)) - Number(no(a)));
};

/** The default label of each answer a card can give, when the ferret did not word it. */
export const DEFAULT_ANSWER_LABELS: Readonly<Record<Exclude<AgendaAnswerEffect, 'choose'>, string>> = {
  approve: 'Approve',
  reject: 'Deny',
  good: 'Approve',
  clarify: 'Request changes',
  done: 'Done',
  'needs-info': 'Need more info',
  dismiss: 'Skip',
};

/** The one answer a to-do offers: the owner did the steps. */
export const MARK_DONE_LABEL = 'Mark as done';

/**
 * The words each effect was given by default before (and the to-do's and info's own words): an item stored with
 * one of them still reads as worded by default, so its answer is never mistaken for one its ferret wrote.
 */
const OTHER_DEFAULT_LABELS: Readonly<Partial<Record<AgendaAnswerEffect, readonly string[]>>> = {
  approve: ['Allow'],
  good: ['Looks good'],
  clarify: ['Needs changes'],
  done: ['Got it', MARK_DONE_LABEL],
};

/** Whether an answer carries its effect's default words (now or before), rather than its ferret's own. */
export const isDefaultAnswerLabel = (does: AgendaAnswerEffect, label: string): boolean => {
  if (does === 'choose') return false;
  const wanted = label.trim().toLowerCase();
  return [DEFAULT_ANSWER_LABELS[does], ...(OTHER_DEFAULT_LABELS[does] ?? [])].some(
    word => word.toLowerCase() === wanted,
  );
};

/**
 * The fixed answer EVERY card a ferret raised carries besides its own (at most three): talk it through
 * before answering. It never takes one of the three direction slots — the app gives it its own button (docs/agenda.md, "Discuss").
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
export const isYesNoAsk = (ask: AgendaAsk | undefined): boolean =>
  ask?.kind === 'multiple-choice' && isYesNoPair(ask.options.map(option => option.label));

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

/**
 * The chip each kind wears, in plain words for what the OWNER does with the card (docs/agenda.md, "The kind chip").
 * The one map every surface reads — the card's pill, the Inbox chip, the header and the row's meta line.
 */
export const AGENDA_KIND_LABELS: Readonly<Record<AgendaKind, string>> = {
  reply: 'Question',
  choice: 'Decision',
  yesno: 'Decision',
  task: 'To do',
  permission: 'Approve',
  info: 'FYI',
  review: 'Review',
  form: 'Fill in',
  input: 'Type in',
};

/** The chip of a card waiting for the owner to try the work (a gate in a verify lane): it is a choice, but it asks for a test. */
export const TEST_KIND_LABEL = 'Test';

/** The chip word of an item or a request: the kind's plain word. */
export const agendaKindLabel = (item: Pick<AgendaCardSource, 'kind' | 'ask'>): string =>
  AGENDA_KIND_LABELS[agendaCardKind(item)];

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
    case 'form':
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
 * A choice's answers: which options sit on the row — the recommended one (or the first) and the first others, three
 * at most. Their directions are then the options list's order (`inOptionOrder`). Options past the third have no
 * direction; the card offers them in its options list.
 */
const choiceAnswers = (options: readonly AgendaAskOption[], recommended: string | undefined): AgendaCardAnswer[] => {
  const middle = (recommended === undefined ? undefined : optionLabel(options, recommended)) ?? options[0];
  if (middle === undefined) return [];
  const rest = options.filter(option => option !== middle);
  const directions: readonly AgendaDirection[] = ['left', 'right'];
  return [
    answer('up', 'choose', middle.label, middle.description),
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
          ...(up === undefined ? [] : [answer('up', 'dismiss', up.label, up.description)]),
          answer('right', 'done', MARK_DONE_LABEL),
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
      case 'form':
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

/** Where a row of option answers sits, by how many there are. */
const LIST_SLOTS: Readonly<Record<number, readonly AgendaDirection[]>> = {
  1: ['up'],
  2: ['left', 'right'],
  3: ['left', 'up', 'right'],
};

const optionKey = (label: string): string => label.trim().toLowerCase();

/**
 * A row whose answers are all the item's options, pointed in the options list's order (the first ←, the second ↑,
 * the third →; two: ← →; one: ↑). Answers that are not options (Allow / Deny, Done / Need more info) keep their
 * directions: those mean something on their own. A row of exactly Yes and No is No ← · Yes →, whatever the list's
 * order (`yesNoOrder`).
 */
const inOptionOrder = (
  item: Pick<AgendaCardSource, 'ask' | 'questions'>,
  answers: readonly AgendaCardAnswer[],
): AgendaCardAnswer[] => {
  if (answers.every(each => each.does === 'choose') && isYesNoPair(answers.map(each => each.label)))
    return yesNoOrder(answers, each => each.label).map((each, at) => ({
      ...each,
      direction: at === 0 ? 'left' : 'right',
    }));
  const options = item.ask?.kind === 'multiple-choice' ? item.ask.options : (singleAgendaQuestion(item)?.options ?? []);
  const order = options.map(option => optionKey(option.label));
  const slots = LIST_SLOTS[answers.length];
  const listed =
    slots !== undefined && answers.every(each => each.does === 'choose' && order.includes(optionKey(each.label)));
  if (!listed) return [...answers];
  return [...answers]
    .sort((a, b) => order.indexOf(optionKey(a.label)) - order.indexOf(optionKey(b.label)))
    .map((each, at) => ({ ...each, direction: slots[at] ?? each.direction }));
};

/**
 * WHAT A CARD NEEDS FROM THE OWNER, AND SO HOW IT LOOKS — one shape per kind (docs/agenda.md, "What I need from
 * you"); `agenda-shape.ts` holds the words each is taught and drawn with:
 *
 * - `choice`: ONE question, each option explained, the options as buttons.
 * - `yesno`: one question, Yes and No.
 * - `approval`: what is being approved and its effect, Approve and Deny.
 * - `review`: what to look at, Approve and Request changes.
 * - `reply`: one open question, answered in the reply box: no buttons.
 * - `answers`: several questions, or a question mixed with steps: a numbered list of each answer wanted, all of
 *   them given in one reply — no buttons.
 * - `form`: structured fields on the card (pick one, pick many, yes/no) and one free-text field in the reply box,
 *   all sent together as one numbered answer — no buttons (the form's own Send).
 * - `todo`: numbered steps, then Mark as done.
 * - `info`: something to know (a notice too), Got it.
 * - `input`: a value typed into the item's own form (docs/input-requests.md).
 */
export type AgendaShape =
  | 'choice'
  | 'yesno'
  | 'approval'
  | 'review'
  | 'reply'
  | 'answers'
  | 'form'
  | 'todo'
  | 'info'
  | 'input';

/** What a card's shape is read from: its kind, ask, questions and steps, and whether it is a notice. */
export type AgendaShapeSource = Pick<AgendaCardSource, 'kind' | 'ask' | 'questions' | 'steps'> & {
  readonly notice?: true | undefined;
  readonly confirms?: unknown;
};

/** The card's shape, from its stored fields alone, so an item raised before shapes reads in one too. */
export const agendaShape = (item: AgendaShapeSource): AgendaShape => {
  if (item.notice === true) return 'info';
  const kind = agendaCardKind(item);
  if (kind === 'input') return 'input';
  // A held configuration change is one choice the daemon wrote: Allow, Deny or Discard change.
  if (item.confirms !== undefined) return 'choice';
  if (kind === 'task') return 'todo';
  if (kind === 'info') return 'info';
  if (kind === 'form') return 'form';
  // More than one answer is wanted: several questions, or a question with steps to follow as well.
  if ((item.questions?.length ?? 0) > 1 || (item.steps?.length ?? 0) > 0) return 'answers';
  switch (kind) {
    case 'choice':
      return 'choice';
    case 'yesno':
      return 'yesno';
    case 'permission':
      return 'approval';
    case 'review':
      return 'review';
    case 'reply':
      return 'reply';
  }
};

/** The answers a shape keeps on its card: none when the reply box is the answer, only Mark as done or Got it. */
const SHAPE_KEEPS: Readonly<Partial<Record<AgendaShape, (answer: AgendaCardAnswer) => boolean>>> = {
  reply: () => false,
  answers: () => false,
  form: () => false,
  input: () => false,
  todo: answer => answer.does === 'done' || answer.does === 'dismiss',
  info: answer => answer.does === 'done',
};

/**
 * The card's answers, left · up · right: the ones it was raised with, else its kind's defaults — which
 * is how an item from before cards reads (its choice keeps on its row what its brief recommends) — a row of
 * options always in the options list's order (`inOptionOrder`), and only those its shape offers (`SHAPE_KEEPS`).
 */
export const agendaCardAnswers = (item: AgendaCardSource & AgendaShapeSource): AgendaCardAnswer[] => {
  const keeps = SHAPE_KEEPS[agendaShape(item)] ?? (() => true);
  return byDirection(
    inOptionOrder(
      item,
      item.answers ?? defaultAgendaAnswers(agendaCardKind(item), item.ask, recommendedAgendaOption(item)),
    ),
  ).filter(keeps);
};

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

/** The most characters an answer's button says on a row of one or two: a longer label is cut at a word. */
export const AGENDA_ANSWER_TEXT_CHARS = 24;

/**
 * The most characters each button of a row of THREE says: a phone gives each a third of its width, where a label wraps
 * onto a second line at a word, and this many always fits in two.
 */
export const AGENDA_ANSWER_TEXT_CHARS_OF_THREE = 20;

/**
 * WHAT AN ANSWER'S BUTTON SAYS — on the item view's row, the docked row, a card ask, the deck's arrow keys and the
 * CLI's answers line alike: the option's own short label ("No", "Only blockers") as plain words (`plainLabel`, so
 * "**Ship** it" says "Ship it"), cut at a word only when it is very long — past 24 characters, or 20 on a row of three
 * (`slots`, the buttons drawn on the row). Never its description, never a bare letter, never empty. The answer it sends
 * is its label, untouched.
 */
export const agendaAnswerText = (label: string, slots = 1): string => {
  const plain = plainLabel(label);
  const text = clipAtWord(plain, slots >= 3 ? AGENDA_ANSWER_TEXT_CHARS_OF_THREE : AGENDA_ANSWER_TEXT_CHARS);
  return text.replaceAll('…', '').trim() === '' ? plain : text;
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
 * not answered, so it reads as `done` and never counts toward what waits on the owner. A PARKED item (snoozed,
 * or replied to — `AgendaParked`) is nobody's turn until it comes back: never "needs you", never a badge.
 */
export type AgendaTurn = 'owner' | 'ferret' | 'parked' | 'done';

export const agendaTurn = (item: {
  readonly waitingOn?: 'ferret' | undefined;
  readonly resolvedAt?: string | undefined;
  readonly notice?: true | undefined;
  readonly parked?: { readonly reason: string } | undefined;
}): AgendaTurn =>
  item.resolvedAt !== undefined || item.notice === true
    ? 'done'
    : item.parked !== undefined
      ? 'parked'
      : item.waitingOn === 'ferret'
        ? 'ferret'
        : 'owner';
