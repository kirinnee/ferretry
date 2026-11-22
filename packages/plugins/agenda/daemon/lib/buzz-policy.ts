import {
  askBuzzPath,
  type BuzzableAsk,
  type BuzzWords,
  buzzBody,
  buzzTitle,
  clipAtWord,
  oneLine,
} from '@ferretry/core-asks/contract';
import { agendaStopBuzzTag } from '../../contract/index.ts';

/** The longest ferret name a stop's title carries whole; the count after it must survive a lock screen. */
const STOPPED_NAME_LENGTH = 24;

export type { BuzzableAsk, BuzzWords };

/** The ledger key of a stop's buzz, named by the instant the idle period began: one per stop. */
export const stopBuzzKey = (ferret: string, stoppedAt: string): string => `stop:${ferret}:${stoppedAt}`;

/** The asks the owner is the next to move on: open, not a notice and not a card's ask (that made its own buzz). */
export const waitingOnOwner = (asks: readonly BuzzableAsk[]): readonly BuzzableAsk[] =>
  asks
    .filter(ask => ask.state === 'open' && ask.kind !== 'notice' && ask.source !== 'card')
    .sort((a, b) => Number(b.blocking === true) - Number(a.blocking === true) || a.raisedAt.localeCompare(b.raisedAt));

/**
 * What the ONE buzz a stop makes says: "<ferret> is stopped · 3 need you". The count is in the title, never clipped away
 * by a long ferret name; the body is the ask the owner most likely wants first (the one blocking now, else the oldest),
 * and a tap opens it. Its event key is the stop's own moment ({@link stopBuzzKey}), so a LATER stop of the same ferret
 * (same tag, another ask) is a new event on the phone and a re-delivery of this one is not.
 */
export function stopBuzzWords(
  ferret: string,
  name: string,
  waiting: readonly [BuzzableAsk, ...BuzzableAsk[]],
  stoppedAt: string,
): BuzzWords {
  const [first] = waiting;
  const count = waiting.length;
  const shown = buzzTitle(clipAtWord(oneLine(name), STOPPED_NAME_LENGTH));
  return {
    tag: agendaStopBuzzTag(ferret),
    title: `${shown} is stopped · ${count === 1 ? '1 needs you' : `${count} need you`}`,
    body: buzzBody(first.subject),
    url: askBuzzPath(ferret, first.id),
    eventKey: stopBuzzKey(ferret, stoppedAt),
  };
}
