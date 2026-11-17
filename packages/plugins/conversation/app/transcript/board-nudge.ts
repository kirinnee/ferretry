import type { LedgerSendRecord, LedgerSender } from '../chat/send-ledger.ts';

/** The part of Ferretry that sends the board's nudges. */
const FEATURE = 'Board';

/** Who a send is from: the queue's word when it travelled through the queue, else the record's own. */
const senderOfSend = (record: LedgerSendRecord): LedgerSender | undefined => record.queue?.by ?? record.by;

/** Is this send the board's own automatic message to a ferret — never the owner's words? */
export const isBoardNudge = (record: LedgerSendRecord): boolean => {
  const by = senderOfSend(record);
  return by?.kind === 'ferretry' && by.feature === FEATURE;
};

/** The pull requests of the tasks a nudge can name. */
export interface TaskPullRequests {
  readonly id: string;
  readonly prs?: readonly { readonly number: number; readonly url: string }[];
}

const TASK = /&([A-Za-z]+\d+)/u;
const PR = /\bPR #(\d+)\b/gu;

/**
 * The nudge's one line with each `PR #n` it names turned into a link to that pull request, when the task it
 * is about links one. The task reference itself is the reader's to prove and open (docs/reference-standard.md);
 * a PR the task does not link stays plain words.
 */
export function linkNudgePullRequests(text: string, tasks: readonly TaskPullRequests[] | undefined): string {
  const written = TASK.exec(text)?.[1]?.toUpperCase();
  const prs = written === undefined ? undefined : tasks?.find(task => task.id.toUpperCase() === written)?.prs;
  if (prs === undefined) return text;
  return text.replace(PR, (named, number: string) => {
    const pr = prs.find(candidate => candidate.number === Number(number));
    return pr === undefined ? named : `[${named}](${pr.url})`;
  });
}
