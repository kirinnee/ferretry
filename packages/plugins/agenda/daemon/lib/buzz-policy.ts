import type { AskSummary } from '@ferretry/core-asks/contract';
import { agendaAskBuzzTag, agendaAskPath, agendaStopBuzzTag, type BuzzKind } from '../../contract/index.ts';
import { buzzBody, buzzTitle, clipAtWord, oneLine, STOPPED_NAME_LENGTH } from './words.ts';

/** An ask as the buzz policy reads it: the summary Asks gives, plus the one flag a notice may carry (`--buzz`). */
export type BuzzableAsk = AskSummary & { readonly blocking?: boolean };

/** What a buzz says and where a tap opens: words only, never a secret. */
export interface BuzzWords {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

/** The ledger key of an ask's own buzz: at most one per ask (a notice's `--buzz`, a card's ask). */
export const askBuzzKey = (ferret: string, ask: string): string => `ask:${ferret}:${ask}`;
/** The ledger key of a stop's buzz, named by the instant the idle period began: one per stop. */
export const stopBuzzKey = (ferret: string, stoppedAt: string): string => `stop:${ferret}:${stoppedAt}`;

/** The asks the owner is the next to move on: open, not a notice and not a card's ask (that made its own buzz). */
export const waitingOnOwner = (asks: readonly BuzzableAsk[]): readonly BuzzableAsk[] =>
  asks
    .filter(ask => ask.state === 'open' && ask.kind !== 'notice' && ask.source !== 'card')
    .sort((a, b) => Number(b.blocking === true) - Number(a.blocking === true) || a.raisedAt.localeCompare(b.raisedAt));

/** Which moment an ask's own buzz is, or `undefined` when the ask makes none (everything else waits for the stop). */
export function askBuzzKind(ask: BuzzableAsk): BuzzKind | undefined {
  if (ask.state !== 'open') return undefined;
  if (ask.source === 'card') return 'card-ask';
  if (ask.kind === 'notice' && ask.blocking === true) return 'notice';
  return undefined;
}

/** What the one buzz for an ask says: its subject as title and body, a tap opens the ask. */
export function askBuzzWords(ask: BuzzableAsk): BuzzWords {
  const ferret = ask.ferret ?? '';
  return {
    tag: agendaAskBuzzTag(ferret, ask.id),
    title: buzzTitle(ask.subject),
    body: buzzBody(ask.subject),
    url: agendaAskPath(ferret, ask.id),
  };
}

/**
 * What the ONE buzz a stop makes says: "<ferret> is stopped · 3 need you". The count is in the title, never clipped away
 * by a long ferret name; the body is the ask the owner most likely wants first (the one blocking now, else the oldest),
 * and a tap opens it.
 */
export function stopBuzzWords(
  ferret: string,
  name: string,
  waiting: readonly [BuzzableAsk, ...BuzzableAsk[]],
): BuzzWords {
  const [first] = waiting;
  const count = waiting.length;
  const shown = buzzTitle(clipAtWord(oneLine(name), STOPPED_NAME_LENGTH));
  return {
    tag: agendaStopBuzzTag(ferret),
    title: `${shown} is stopped · ${count === 1 ? '1 needs you' : `${count} need you`}`,
    body: buzzBody(first.subject),
    url: agendaAskPath(ferret, first.id),
  };
}
