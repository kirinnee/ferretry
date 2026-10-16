/**
 * WHAT THE SESSIONS BAR LISTS, as pure decisions.
 *
 * The left bar replaces the Sessions tab (the approved session-view redesign): every session on this
 * machine, grouped by project, with a status dot, a "needs you" badge and three filters — All, Needs
 * you, Running. It is a navigator, not the dashboard, so it answers a narrower question than the
 * dashboard does: "which of my agents is doing what right now, and which one wants me?"
 *
 * WHICH SESSIONS. Everything still alive, plus anything that finished within the last day — a session
 * that just said "done" is the one a reader is about to open — plus the session on screen, whatever its
 * age, so the bar never loses the reader's own place. Older finished sessions stay on the dashboard and
 * in the finder; listing every one ever run would bury the live ones under history.
 *
 * NEEDS YOU is the session's own say-so: it is parked on a person (`awaiting_user`,
 * `awaiting_question`), it has a pending structured question, or the daemon flagged `needsHuman`. It is
 * deliberately not "has unread Attention": that is a per-session board read, and one per row would be
 * a request storm on a fleet of fifty.
 */

import type { SessionView } from '@ferretry/protocol';
import { type FleetProject, groupByProject, type SessionGroup } from '../lib/fleet-grouping.ts';
import { statusMark, TERMINAL_STATUSES } from './status-mark.tsx';

export type SessionsBarFilter = 'all' | 'needs-you' | 'running';

/** How long a finished session stays in the bar after its last sign of life. */
export const RECENTLY_FINISHED_MS = 24 * 60 * 60 * 1000;

/** The session is waiting on a person, by its own account. */
export const needsYou = (view: SessionView): boolean => {
  const { state } = view;
  if (TERMINAL_STATUSES.has(state.status)) return false;
  return (
    state.status === 'awaiting_user' ||
    state.status === 'awaiting_question' ||
    (state.pendingQuestion ?? null) !== null ||
    (state.needsHuman ?? '') !== ''
  );
};

/** Doing something right now: the status dot's own "active" class. */
export const isRunning = (view: SessionView): boolean => statusMark(view).klass === 'active';

const lastSignOfLife = (view: SessionView): number => {
  const parsed = Date.parse(view.state.lastActivityAt ?? view.config.updatedAt ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** Alive, recently finished, or the one on screen. */
export const inSessionsBar = (view: SessionView, now: number, activeId: string | null): boolean =>
  view.config.id === activeId ||
  !TERMINAL_STATUSES.has(view.state.status) ||
  now - lastSignOfLife(view) <= RECENTLY_FINISHED_MS;

const FILTERS: Readonly<Record<SessionsBarFilter, (view: SessionView) => boolean>> = {
  all: () => true,
  'needs-you': needsYou,
  running: isRunning,
};

export interface SessionsBarView {
  readonly groups: readonly SessionGroup[];
  readonly counts: Readonly<Record<SessionsBarFilter, number>>;
}

/**
 * The bar's whole content in one pass. Counts are taken over the same pool the list draws from, so
 * the number on a filter is always what choosing it would show.
 */
export const sessionsBarView = (
  sessions: readonly SessionView[],
  projects: readonly FleetProject[],
  filter: SessionsBarFilter,
  now: number,
  activeId: string | null,
): SessionsBarView => {
  const pool = sessions.filter(view => inSessionsBar(view, now, activeId));
  return {
    groups: groupByProject(pool.filter(FILTERS[filter]), projects, true),
    counts: {
      all: pool.length,
      'needs-you': pool.filter(needsYou).length,
      running: pool.filter(isRunning).length,
    },
  };
};

/** The second line under a session's name: what it is working on, else where. */
export const sessionsBarSubline = (view: SessionView): string =>
  view.config.label ?? view.config.name ?? view.config.cwd;
