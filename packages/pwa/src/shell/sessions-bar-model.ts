/**
 * WHAT THE SESSIONS BAR LISTS, as pure decisions.
 *
 * The left bar replaces the Sessions tab (the approved session-view redesign): every session on this
 * machine, grouped by project, with a status dot, an unread Agenda badge and the fleet filters kteam's
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
 * ONE SIGNAL THAT A SESSION NEEDS YOU: OPEN ATTENTION.
 *
 *   The daemon puts `state.attention` on a session while it has open Agenda items and removes it when
 *   none are left, so the summary rides the session list: reading it costs no request per row. An unread
 *   row gets a bold name and an accent count badge, opens the conversation AT the first item, and — while
 *   the device setting "Group Needs you at the top" is on — is gathered into "Needs you" at the top, newest
 *   `latestAt` first. It clears only when the items resolve, never because the reader looked.
 *
 *   Nothing else puts a row there. A ferret parked on a person (`awaiting_user`, "Your turn") is a status,
 *   drawn by the status mark; it is not Needs you, so the group, its count, the Agenda badge and the
 *   rollup chip can never disagree. A pending question or permission arrives as a real Agenda item.
 */

import { PACK_CLEAN_UP_LABEL, type SessionView } from '@ferretry/protocol';
import { agendaConversationPath, agendaFirst, sessionAgenda } from '../lib/agenda-inbox.ts';
import { displayCallsign } from '../lib/callsign.ts';
import type { Density, ModeFilter } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { type FleetProject, groupByProject, type ModeCounts, type SessionGroup } from '../lib/fleet-grouping.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
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

/** The session has open Attention: the daemon's summary is on it. Clears only when the items resolve. */
export const hasAgenda = (view: SessionView): boolean => sessionAgenda(view) !== undefined;

/** Where a session's row opens: its conversation, AT the first open item when it has Attention. */
export const sessionRowPath = (daemonId: DaemonId, view: SessionView): string => {
  const agenda = sessionAgenda(view);
  return agenda === undefined
    ? daemonSessionPath(daemonId, view.config.id)
    : agendaConversationPath(daemonId, view.config.id, agenda.first);
};

/** What a badge or a link says aloud: "3 open Agenda items". */
export const agendaWords = (count: number): string => `${count} open Inbox ${count === 1 ? 'item' : 'items'}`;

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

/**
 * The one line a row echoes under its name: the ask of the newest open Agenda item (the chat-preview
 * of a Telegram row), else the question a parked ferret is waiting on. Whitespace collapsed and capped.
 */
export const rowPreview = (
  view: SessionView,
): { readonly text: string; readonly kind: 'attention' | 'question' } | undefined => {
  const ask = sessionAgenda(view)?.ask.replace(/\s+/gu, ' ').trim() ?? '';
  if (ask !== '')
    return {
      kind: 'attention',
      text: ask.length > QUESTION_PREVIEW_MAX ? `${ask.slice(0, QUESTION_PREVIEW_MAX - 1)}…` : ask,
    };
  const question = pendingQuestionPreview(view);
  return question === undefined ? undefined : { kind: 'question', text: question };
};

/**
 * Pulls the sessions with open Attention out of `rows`, newest `latestAt` first (ties keep the order
 * they arrived in), leaving the rest in their order. This is "Needs you" at the top of a list.
 */
export const pullNeedsYou = <T>(
  rows: readonly T[],
  viewOf: (row: T) => SessionView,
  group = true,
): { readonly waiting: readonly T[]; readonly rest: readonly T[] } => {
  if (!group) return { waiting: [], rest: rows };
  const count = rows.filter(row => hasAgenda(viewOf(row))).length;
  const ordered = agendaFirst(rows, viewOf);
  return { waiting: ordered.slice(0, count), rest: ordered.slice(count) };
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
 * A guide builder is not listed unless it is the open one; its link still opens it. A session with open
 * Attention is listed though it is stopped: an unread row that vanished would be an unanswered ferret.
 */
export const listedBeforeMode = (
  view: SessionView,
  { showStopped }: SessionsListFilter,
  keep?: (view: SessionView) => boolean,
): boolean => keep?.(view) === true || (!isGuideBuilder(view) && (showStopped || !isStopped(view) || hasAgenda(view)));

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
  /** Sessions with open Attention, newest first: the "Needs you" group at the top. Not repeated in `groups`. */
  readonly needsYou: readonly SessionView[];
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
  groupNeedsYou = true,
): SessionsBarView => {
  const { waiting, rest } = pullNeedsYou(
    sessions.filter(view => listedBeforeMode(view, filter, keep) && matchesMode(view, filter.mode)),
    view => view,
    groupNeedsYou,
  );
  return { needsYou: waiting, groups: groupByProject(rest, projects, true), ...listTallies(sessions, filter, keep) };
};

/**
 * A row's two names. The TITLE is the task — what the session is for ("Home Manager", "Diene Work") — because
 * that is what a person scans a list by; the ferret that is doing it is the secondary line. With no task the
 * ferret's name is the title and there is no second name to show. A task that only repeats the ferret's name
 * is no task.
 */
export const sessionsBarNames = (view: SessionView): { readonly title: string; readonly ferret: string | null } => {
  const callsign = displayCallsign(view.config.teammate);
  const task = (view.config.name ?? '').trim();
  const ferret = callsign || view.config.id;
  if (task === '' || task === callsign) return { title: ferret, ferret: null };
  return { title: task, ferret: callsign === '' ? null : callsign };
};

/** The second line under a session's name: what it is working on, else where. */
export const sessionsBarSubline = (view: SessionView): string => view.config.name ?? view.config.cwd;

/** A home directory, written the way a shell prompt writes it. */
const HOME_PREFIX = /^\/(?:home|Users)\/[^/]+(?=\/|$)/u;

/**
 * The row's directory line: the folder the agent runs in, with a home directory shortened to `~`.
 * The bar truncates it from the LEFT, so the worktree's own name — the part that differs — stays.
 */
export const sessionsBarDirectory = (view: SessionView): string => view.config.cwd.replace(HOME_PREFIX, '~');
