/**
 * What an approve-on-phone card draws, decided from the daemon's approval and nothing else (docs/input-requests.md,
 * "Approve on your phone"). Every sentence comes from `phoneApprovalWords`, and the number is the daemon's own
 * reading: this module takes no text from a ferret, has no way to be handed a number, and gives the owner no "I
 * approved" answer, because only the daemon seeing the sign-in move on settles a card.
 */

import {
  type PhoneApproval,
  type PhoneApprovalState,
  phoneApprovalWords,
  type PhoneApprovalWords,
} from '@ferretry/protocol';

/** The card's one answer: the owner did not ask for this sign-in. */
export const PHONE_APPROVAL_REFUSE_WORDS = 'Not me — stop';

/** The page link under a card with no number: where the owner can look for it themselves. */
export const PHONE_APPROVAL_VIEW_PAGE_WORDS = 'View the page';

/** What the card says once the daemon has settled it. `waiting` is not settled and has no line. */
const SETTLED_WORDS: Readonly<Record<Exclude<PhoneApprovalState, 'waiting'>, string>> = {
  'moved-on': 'The sign-in moved on.',
  'timed-out': 'No one approved in time.',
  refused: 'You stopped this sign-in.',
  gone: 'The page or terminal closed.',
};

export interface PhoneApprovalCardModel {
  readonly words: PhoneApprovalWords;
  /** "Asked 14:02 by lizzette", from the daemon's own raise time and the session's name. */
  readonly asked: string;
  /** The number, large, only when the daemon read one. */
  readonly number?: string;
  /** "steered" gets a line of its own; a plain no-number card does not. */
  readonly steered: boolean;
  readonly terminal: boolean;
  /** A page to look at, only when there is a page and no number to show. */
  readonly canViewPage: boolean;
  /** The settled line; absent while the approval waits (the card then offers "Not me — stop"). */
  readonly settled?: string;
  readonly canRefuse: boolean;
}

const askedWords = (approval: PhoneApproval): string =>
  `Asked ${new Date(approval.raisedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} by ${approval.agentName}`;

/**
 * A number is drawn only while the approval waits, has not expired and was read by the daemon itself: one a ferret
 * pointed at (`from: 'pointed'`, which no daemon of today sends) is treated as no number at all.
 */
const readNumber = (approval: PhoneApproval, now: number): PhoneApproval['number'] =>
  approval.state === 'waiting' && now < Date.parse(approval.expiresAt) && approval.number?.from !== 'pointed'
    ? approval.number
    : undefined;

export function phoneApprovalCardModel(approval: PhoneApproval, now: number = Date.now()): PhoneApprovalCardModel {
  const number = readNumber(approval, now);
  const { number: _wire, ...rest } = approval;
  const words = phoneApprovalWords(number === undefined ? rest : approval);
  const waiting = approval.state === 'waiting';
  const terminal = approval.surface === 'terminal';
  const settled = approval.state === 'waiting' ? undefined : SETTLED_WORDS[approval.state];
  return {
    words,
    asked: askedWords(approval),
    ...(number === undefined ? {} : { number: number.value }),
    steered: approval.numberMissing === 'steered',
    terminal,
    canViewPage: waiting && !terminal && number === undefined,
    ...(settled === undefined ? {} : { settled }),
    canRefuse: waiting,
  };
}
