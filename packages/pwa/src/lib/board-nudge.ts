import type { LedgerSendRecord, LedgerSender } from './send-ledger.ts';

/** The part of Ferretry that sends the board's nudges. */
const FEATURE = 'Board';

/** Who a send is from: the queue's word when it travelled through the queue, else the record's own. */
const senderOfSend = (record: LedgerSendRecord): LedgerSender | undefined => record.queue?.by ?? record.by;

/** Is this send the board's own automatic message to a ferret — never the owner's words? */
export const isBoardNudge = (record: LedgerSendRecord): boolean => {
  const by = senderOfSend(record);
  return by?.kind === 'ferretry' && by.feature === FEATURE;
};

/** The pull requests of the cards a nudge can name. */
export interface CardPullRequests {
  readonly id: string;
  readonly prs?: readonly { readonly number: number; readonly url: string }[];
}

const CARD = /&([A-Za-z]+\d+)/u;
const PR = /\bPR #(\d+)\b/gu;

/**
 * The nudge's one line with each `PR #n` it names turned into a link to that pull request, when the card it
 * is about links one. The card reference itself is the reader's to prove and open (docs/reference-standard.md);
 * a PR the card does not link stays plain words.
 */
export function linkNudgePullRequests(text: string, cards: readonly CardPullRequests[] | undefined): string {
  const written = CARD.exec(text)?.[1]?.toUpperCase();
  const prs = written === undefined ? undefined : cards?.find(card => card.id.toUpperCase() === written)?.prs;
  if (prs === undefined) return text;
  return text.replace(PR, (named, number: string) => {
    const pr = prs.find(candidate => candidate.number === Number(number));
    return pr === undefined ? named : `[${named}](${pr.url})`;
  });
}
