/**
 * WHAT THE SESSIONS BAR LISTS, as pure decisions.
 *
 * The left bar replaces the Sessions tab (the approved session-view redesign): every session on this
 * machine, grouped by project, with a status dot, a "needs you" badge and the fleet filters kteam's
 * sidebar has — Interactive · All · Agents, and "Show stopped". It is a navigator, not the dashboard, so
 * it answers a narrower question than the dashboard does: "which of my agents is doing what right
 * now, and which one wants me?"
 *
 * WHICH SESSIONS. A session that is over — completed, failed, stalled or stopped, which is to say its
 * terminal is gone — is HIDDEN until the reader ticks "Show stopped". An earlier cut hid anything
 * finished more than a day ago, and the reader read that as the bar losing sessions; a stopped agent is
 * still one you go back to for its transcript, which is why the tick exists and says how many it is
 * hiding. The ONE exception is the session on screen: it stays listed, because a bar that drops the page
 * you are looking at reads as broken.
 *
 * COUNTS ARE THE LIST'S OWN PREDICATE. A segment's number is the length of the list that choosing that
 * segment would draw, under the same stopped rule — never a fleet-wide total that stops matching the
 * rows underneath it. "Show stopped (3)" is likewise the stopped sessions that tick would add under the
 * mode chosen.
 *
 * WHAT A ROW SAYS: the status mark, its task as the title with the ferret's name beneath, and its project DIRECTORY — the folder
 * it runs in, which tells two agents on one project apart (a worktree each).
 *
 * NEEDS YOU is the session's own say-so: it is parked on a person (`awaiting_user`,
 * `awaiting_question`), it has a pending structured question, or the daemon flagged `needsHuman`. It is
 * deliberately not "has unread Attention": that is a per-session board read, and one per row would be
 * a request storm on a fleet of fifty.
 */

import { PACK_CLEAN_UP_LABEL, type SessionView } from '@ferretry/protocol';
import { displayCallsign } from '../lib/callsign.ts';
import type { Density, ModeFilter } from '../lib/controls.ts';
import { type FleetProject, groupByProject, type ModeCounts, type SessionGroup } from '../lib/fleet-grouping.ts';
import { TERMINAL_STATUSES } from './status-mark.tsx';

/**
 * Whether the bar draws one-line rows. Compact is the bar's default: only a reader who chose Full (Settings ›
 * Appearance › Density, or the bar's own options menu) gets the three-line rows; Minimal reads as compact here.
 */
export const sidebarCompact = (density: Density | null | undefined): boolean => density !== 'full';

/** The two controls the bar owns: which kind of session, and whether the stopped ones are listed. */
export interface SessionsListFilter {
  readonly mode: ModeFilter;
  readonly showStopped: boolean;
}

/** Stopped sessions hidden, only the sessions a person drives: what a new device's bar opens with. */
export const DEFAULT_LIST_FILTER: SessionsListFilter = { mode: 'interactive', showStopped: false };

/** The session is waiting on a person, by its own account. */
export const needsYou = (view: SessionView): boolean => {
  const { state } = view;
  if (TERMINAL_STATUSES.has(state.status)) return false;
  return (
    state.status === 'awaiting_user' ||
    state.status === 'awaiting_question' ||
    state.turnState === 'needs-input' ||
    (state.pendingQuestion ?? null) !== null ||
    (state.needsHuman ?? '') !== ''
  );
};

/** The longest question the list echoes; the row truncates visually, this just keeps the DOM small. */
const QUESTION_PREVIEW_MAX = 160;

/**
 * The one line a list shows for a ferret waiting on a question: the first question, whitespace
 * collapsed and capped, with how many more follow. `undefined` when nothing is pending.
 */
export const pendingQuestionPreview = (view: SessionView): string | undefined => {
  const pending = view.state.pendingQuestion;
  if (pending === null || pending === undefined || TERMINAL_STATUSES.has(view.state.status)) return undefined;
  const [first] = pending.questions;
  const text = (first?.question ?? '').replace(/\s+/gu, ' ').trim();
  if (text === '') return undefined;
  const clipped = text.length > QUESTION_PREVIEW_MAX ? `${text.slice(0, QUESTION_PREVIEW_MAX - 1)}…` : text;
  const more = pending.questions.length - 1;
  return more > 0 ? `${clipped} (+${more} more)` : clipped;
};

/** The session is over: its terminal is gone and nothing will move it again. */
export const isStopped = (view: SessionView): boolean => TERMINAL_STATUSES.has(view.state.status);

/** Whether the session is the kind a mode segment asks for. */
export const matchesMode = (view: SessionView, mode: ModeFilter): boolean =>
  mode === 'all' || view.config.mode === mode;

/** A clean-up ferret: started by Settings › Pack (Clean up), shown there rather than among the owner’s ferrets. */
export const isGuideBuilder = (view: SessionView): boolean => view.config.label === PACK_CLEAN_UP_LABEL;

/**
 * Which sessions the bar draws before the kind is chosen: everything live, the stopped ones only when
 * ticked, and the open session always. `keep` names the open one — a caller that has none passes nothing.
 * A guide builder is not listed unless it is the open one; its link still opens it.
 */
export const listedBeforeMode = (
  view: SessionView,
  { showStopped }: SessionsListFilter,
  keep?: (view: SessionView) => boolean,
): boolean => keep?.(view) === true || (!isGuideBuilder(view) && (showStopped || !isStopped(view)));

/** The tallies the filter controls print, from the sessions already past the stopped rule. */
export interface ListTallies {
  readonly counts: ModeCounts;
  /** How many stopped sessions ticking "Show stopped" would add under the mode chosen. */
  readonly hiddenStopped: number;
}

/**
 * Tallies over `sessions`, one machine's or all machines' alike. `keep` is as in `listedBeforeMode`.
 */
export const listTallies = (
  sessions: readonly SessionView[],
  filter: SessionsListFilter,
  keep?: (view: SessionView) => boolean,
): ListTallies => {
  const listed = sessions.filter(view => listedBeforeMode(view, filter, keep));
  return {
    counts: {
      all: listed.length,
      auto: listed.filter(view => view.config.mode === 'auto').length,
      interactive: listed.filter(view => view.config.mode === 'interactive').length,
    },
    hiddenStopped: sessions.filter(
      view => !isGuideBuilder(view) && !listedBeforeMode(view, filter, keep) && matchesMode(view, filter.mode),
    ).length,
  };
};

export interface SessionsBarView extends ListTallies {
  readonly groups: readonly SessionGroup[];
}

/**
 * The bar's whole content in one pass. The groups and the tallies come from the same pool, so the
 * number on a segment is always what choosing it would show.
 */
export const sessionsBarView = (
  sessions: readonly SessionView[],
  projects: readonly FleetProject[],
  filter: SessionsListFilter,
  keep?: (view: SessionView) => boolean,
): SessionsBarView => ({
  groups: groupByProject(
    sessions.filter(view => listedBeforeMode(view, filter, keep) && matchesMode(view, filter.mode)),
    projects,
    true,
  ),
  ...listTallies(sessions, filter, keep),
});

/**
 * A row's two names. The TITLE is the task — what the session is for ("Home Manager", "Diene Work") — because
 * that is what a person scans a list by; the ferret that is doing it is the secondary line. With no task the
 * ferret's name is the title and there is no second name to show. A task that only repeats the ferret's name
 * is no task.
 */
export const sessionsBarNames = (view: SessionView): { readonly title: string; readonly ferret: string | null } => {
  const callsign = displayCallsign(view.config.teammate);
  const task = (view.config.label ?? view.config.name ?? '').trim();
  const ferret = callsign || view.config.id;
  if (task === '' || task === callsign) return { title: ferret, ferret: null };
  return { title: task, ferret: callsign === '' ? null : callsign };
};

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
