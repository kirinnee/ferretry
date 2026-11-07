/**
 * THE MACHINE HOME PAGE, as pure data: the five numbers of the overview and the few interactive ferrets
 * worth opening first. The page names what is happening here and where to go; it does not repeat the
 * Inbox's cards, the board's lanes or the sessions table — each number is a way into the place that owns it.
 */

import type { AnalyticsRawSession, SessionView, WardenStatusView } from '@ferretry/protocol';
import { wardenNeedsYouCount } from '../features/warden/warden-status-model.ts';
import { relativeTime } from '../lib/session-screens.ts';
import { agendaFirst, unreadCount } from '../lib/agenda-inbox.ts';
import { isGuideBuilder, isStopped } from '../shell/sessions-bar-model.ts';
import { statusMark } from '../shell/status-mark.tsx';

/** How many ferrets the home lists before "All sessions" takes over. */
export const TOP_FERRETS = 6;

/** The ferrets the page is about: the owner's interactive sessions, still alive, not a Pack clean-up helper. */
export const interactiveFerrets = (sessions: readonly SessionView[]): readonly SessionView[] =>
  sessions.filter(view => view.config.mode === 'interactive' && !isStopped(view) && !isGuideBuilder(view));

export interface MachineCounts {
  /** Interactive ferrets doing something right now. */
  readonly running: number;
  /** Interactive ferrets with an open Inbox item for the owner. */
  readonly waitingOnYou: number;
  /** Every live interactive ferret, running or not. */
  readonly interactive: number;
  /** Every session of any kind, the figure "All sessions" opens. */
  readonly total: number;
}

export const machineCounts = (sessions: readonly SessionView[]): MachineCounts => {
  const live = interactiveFerrets(sessions);
  return {
    running: live.filter(view => statusMark(view).klass === 'active').length,
    waitingOnYou: live.filter(view => unreadCount(view) > 0).length,
    interactive: live.length,
    total: sessions.length,
  };
};

const activityOf = (view: SessionView): number => {
  const at = Date.parse(view.state.lastActivityAt ?? '');
  return Number.isFinite(at) ? at : 0;
};

/** Needing you first (newest ask first, the Inbox's own order), then the rest by most recent activity. */
export const topFerrets = (sessions: readonly SessionView[], limit: number = TOP_FERRETS): readonly SessionView[] => {
  const live = interactiveFerrets(sessions);
  const ordered = agendaFirst(live, view => view);
  const waiting = ordered.filter(view => unreadCount(view) > 0);
  const rest = ordered
    .filter(view => unreadCount(view) === 0)
    .toSorted((left, right) => activityOf(right) - activityOf(left));
  return [...waiting, ...rest].slice(0, limit);
};

/** Dollars the priced sessions of one day cost; an unpriced-only day is unknown, an empty day is a true zero. */
export const spendToday = (rows: readonly AnalyticsRawSession[]): number | null => {
  if (rows.length === 0) return 0;
  const priced = rows.flatMap(row => (row.equivalentApiCostUsdMicros === null ? [] : [row.equivalentApiCostUsdMicros]));
  return priced.length === 0 ? null : priced.reduce((sum, micros) => sum + micros, 0) / 1_000_000;
};

export interface MachineHealth {
  readonly tone: 'ok' | 'warn' | 'err';
  /** One word: "Healthy", "2 to look at". */
  readonly word: string;
  /** What the word rests on, one short line: "Fleet checks · swept now". */
  readonly detail: string;
}

/** The Fleet checks strip's verdict, folded to one word and one line; null while the Warden has not answered. */
export const machineHealth = (status: WardenStatusView | null, now: number): MachineHealth | null => {
  if (status === null) return null;
  if (status.lastSweepAt === undefined)
    return { tone: 'warn', word: 'Not swept', detail: 'Fleet checks · no evidence yet' };
  const needs = wardenNeedsYouCount(status);
  return needs > 0
    ? { tone: 'warn', word: `${needs} to look at`, detail: 'Fleet checks · open the Warden' }
    : { tone: 'ok', word: 'Healthy', detail: `Fleet checks · swept ${relativeTime(status.lastSweepAt, now)}` };
};
