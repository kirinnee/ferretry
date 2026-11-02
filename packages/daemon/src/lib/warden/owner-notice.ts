import { clipAtWord, MAX_AGENDA_DETAIL_LENGTH, MAX_AGENDA_SUBJECT_LENGTH } from '@ferretry/protocol';

/** The words of a notice the Warden sends the owner: the one line the card shows, and why it was sent. */
export interface OwnerNoticeText {
  readonly subject: string;
  readonly why: string;
}

/**
 * A Warden notice fitted to the agenda's limits, so the board it lands on can still be read.
 *
 * The subject is built from what the Warden saw — every login it tried, every job still running — and has no
 * length of its own. An agenda item's subject is one line of at most {@link MAX_AGENDA_SUBJECT_LENGTH}, and a
 * board holding a longer one could not be read at all: every item on it, not just the notice, was gone from
 * the Inbox. So a long subject is cut at a word, and the whole of it follows the reason, which has room.
 */
export function fitOwnerNotice(notice: OwnerNoticeText): OwnerNoticeText {
  const line = notice.subject.replaceAll(/\s+/gu, ' ').trim();
  const subject = clipAtWord(line, MAX_AGENDA_SUBJECT_LENGTH);
  const why = subject === line ? notice.why : `${notice.why}\n\nIn full: ${line}`;
  return { subject, why: why.length <= MAX_AGENDA_DETAIL_LENGTH ? why : clipAtWord(why, MAX_AGENDA_DETAIL_LENGTH) };
}
