/**
 * THE ARCHIVED FOOTER, as pure decisions.
 *
 * A daemon takes finished autonomous sessions older than a day out of its live list
 * (docs/session-archive.md), so the bar stops listing ferrets that are over — but their transcripts
 * still open. The footer is the bar's one line about them: how many left, and the control that lists
 * them again. It names the sessions FINISHED and ARCHIVED because that is what happened to them: a
 * reader whose ferret vanished from the list finds it named here rather than wondering.
 *
 * The rows the footer lists are the archive's OWN read (`GET /v1/archived-sessions?limit=100`), never
 * part of the live list: the filters' counts, "Needs you", the bulk stop and the hidden-stopped tally
 * all stay answers about the live set, because that is what they ask.
 */

import type { SessionView } from '../../contract/index.ts';
import { instant } from '../../../../plugins/agenda/app/lib/agenda-inbox.ts';

/** The footer's one sentence: "1 older finished session archived", "3 older finished sessions archived". */
export const archivedFooterWords = (count: number): string =>
  `${count} older finished ${count === 1 ? 'session' : 'sessions'} archived`;

/**
 * Whether the footer is drawn at all — and, because that is the same question, the count a drawn footer
 * may word. Absent (`null`) covers both a count that has not been read and a daemon too old to serve
 * one — the reader never waited on it, so they never miss it — and a count of zero says there is
 * nothing to show.
 */
export const archivedFooterShown = (count: number | null): count is number => count !== null && count > 0;

/** When a finished session is "newest" by: when it ended, else when it began. */
const endedAt = (view: SessionView): number => instant(view.state.finishedAt ?? view.state.startedAt ?? '');

/**
 * Newest finished first — the order the live list taught the reader, with the freshest work on top.
 * The session id breaks a tie so the order never shuffles between reads. The daemon already answers
 * newest first; sorting here keeps the footer's order the model's own decision, not the wire's.
 */
export const byNewestFinished = (left: SessionView, right: SessionView): number =>
  endedAt(right) - endedAt(left) || left.config.id.localeCompare(right.config.id);

/** The rows the footer lists under it: the archive read, newest first. */
export const archivedRows = (sessions: readonly SessionView[]): readonly SessionView[] =>
  [...sessions].sort(byNewestFinished);
