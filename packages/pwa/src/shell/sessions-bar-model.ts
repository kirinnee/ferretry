/**
 * WHAT THE SESSIONS BAR LISTS, as pure decisions.
 *
 * The left bar replaces the Sessions tab (the approved session-view redesign): every session on this
 * machine, grouped by project, with a status dot, a "needs you" badge and three filters — All, Needs
 * you, Running. It is a navigator, not the dashboard, so it answers a narrower question than the
 * dashboard does: "which of my agents is doing what right now, and which one wants me?"
 *
 * WHICH SESSIONS. EVERY session the machine reports, as kteam's sidebar lists them. An earlier cut hid
 * anything finished more than a day ago, and the reader read that as the bar losing sessions: a finished
 * agent is still one you go back to for its transcript. The project groups and the filters, not a
 * silent age cut, are what keep the live ones findable.
 *
 * WHAT A ROW SAYS: the status mark, the agent's name, its task, and its project DIRECTORY — the folder
 * it runs in, which tells two agents on one project apart (a worktree each).
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
): SessionsBarView => ({
  groups: groupByProject(sessions.filter(FILTERS[filter]), projects, true),
  counts: {
    all: sessions.length,
    'needs-you': sessions.filter(needsYou).length,
    running: sessions.filter(isRunning).length,
  },
});

/** The second line under a session's name: what it is working on, else where. */
export const sessionsBarSubline = (view: SessionView): string =>
  view.config.label ?? view.config.name ?? view.config.cwd;

/** A home directory, written the way a shell prompt writes it. */
const HOME_PREFIX = /^\/(?:home|Users)\/[^/]+(?=\/|$)/u;

/**
 * The row's directory line: the folder the agent runs in, with a home directory shortened to `~`.
 * The bar truncates it from the LEFT, so the worktree's own name — the part that differs — stays.
 */
export const sessionsBarDirectory = (view: SessionView): string => view.config.cwd.replace(HOME_PREFIX, '~');
