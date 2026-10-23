/**
 * WHAT THE SESSIONS BAR LISTS, as pure decisions.
 *
 * The left bar replaces the Sessions tab (the approved session-view redesign): every session on this
 * machine, grouped by project, with a status dot, an unread Attention badge and the fleet filters kteam's
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
 * TWO SIGNALS THAT A SESSION WANTS YOU, ONE LOUD AND ONE QUIET.
 *
 *   ATTENTION is the primary one. The daemon puts `state.attention` on a session while it has open
 *   Attention items and removes it when none are left, so the summary rides the session list: reading it
 *   costs no request per row (the old reason this list refused to know about Attention). An unread row
 *   gets a bold name and an accent count badge, opens the conversation AT the first item, and is
 *   gathered into "Needs you" at the top, newest `latestAt` first. It clears only when the items
 *   resolve — never because the reader looked.
 *
 *   WAITING is the status-based signal (`needsYou` below): parked on a person (`awaiting_user`,
 *   `awaiting_question`), a pending structured question, or the daemon's `needsHuman` flag. It is a
 *   fact about the conversation's state, not an item the ferret filed, so it is demoted rather than
 *   removed: a muted "waiting" word with no accent and no count, shown only on a row that has no
 *   Attention (when both are true the badge already says it louder). It does not move a row into
 *   "Needs you" on the single-machine list; across machines it follows the Attention rows there, as it
 *   always pinned. Keeping it quiet is what lets the accent badge mean exactly one thing: "a ferret
 *   filed something for you to answer".
 */

import { PACK_GUIDE_BUILDER_LABEL, type SessionView } from '@ferretry/protocol';
import { attentionConversationPath, attentionFirst, sessionAttention } from '../lib/attention-inbox.ts';
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

/** The session is waiting on a person, by its own account: the QUIET signal (see above); Attention is the loud one. */
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

/** The session has open Attention: the daemon's summary is on it. Clears only when the items resolve. */
export const hasAttention = (view: SessionView): boolean => sessionAttention(view) !== undefined;

/** Where a session's row opens: its conversation, AT the first open item when it has Attention. */
export const sessionRowPath = (daemonId: DaemonId, view: SessionView): string => {
  const attention = sessionAttention(view);
  return attention === undefined
    ? daemonSessionPath(daemonId, view.config.id)
    : attentionConversationPath(daemonId, view.config.id, attention.first);
};

/** What a badge or a link says aloud: "3 open Attention items". */
export const attentionWords = (count: number): string => `${count} open Attention ${count === 1 ? 'item' : 'items'}`;

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
 * The one line a row echoes under its name: the ask of the newest open Attention item (the chat-preview
 * of a Telegram row), else the question a parked ferret is waiting on. Whitespace collapsed and capped.
 */
export const rowPreview = (
  view: SessionView,
): { readonly text: string; readonly kind: 'attention' | 'question' } | undefined => {
  const ask = sessionAttention(view)?.ask.replace(/\s+/gu, ' ').trim() ?? '';
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
): { readonly waiting: readonly T[]; readonly rest: readonly T[] } => {
  const count = rows.filter(row => hasAttention(viewOf(row))).length;
  const ordered = attentionFirst(rows, viewOf);
  return { waiting: ordered.slice(0, count), rest: ordered.slice(count) };
};

/** The session is over: its terminal is gone and nothing will move it again. */
export const isStopped = (view: SessionView): boolean => TERMINAL_STATUSES.has(view.state.status);

/** Whether the session is the kind a mode segment asks for. */
export const matchesMode = (view: SessionView, mode: ModeFilter): boolean =>
  mode === 'all' || view.config.mode === mode;

/** A guide-builder ferret: started by Settings › Pack, shown there rather than among the owner's ferrets. */
export const isGuideBuilder = (view: SessionView): boolean => view.config.label === PACK_GUIDE_BUILDER_LABEL;

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
): boolean =>
  keep?.(view) === true || (!isGuideBuilder(view) && (showStopped || !isStopped(view) || hasAttention(view)));

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
): SessionsBarView => {
  const { waiting, rest } = pullNeedsYou(
    sessions.filter(view => listedBeforeMode(view, filter, keep) && matchesMode(view, filter.mode)),
    view => view,
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
