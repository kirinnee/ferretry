/**
 * The PURE half of New session › "Continue a conversation", which has two sources:
 *
 *   Ferretry sessions   every STOPPED ferret on this machine, resumed in place with its conversation
 *   All conversations   every Claude Code and Codex conversation in Ferretry's own history (the shared
 *                       pool its runtimes read, which holds what was imported at setup) — never the
 *                       computer's own `~/.claude` / `~/.codex`, which only importing reads
 *
 * A stopped ferret says what it is about through the conversation it keeps: the listing names the
 * session that keeps each conversation (`adoptedBy`), so the two are joined here at no cost.
 *
 * Nothing here reads a clock: every rule that depends on "now" is handed it.
 */

import type { ConversationImportQuery, ImportableConversation, SessionView } from '@ferretry/protocol';
import { displayCallsign } from '../../../lib/callsign.ts';
import { isTerminalSessionStatus } from '../../../lib/session-screens.ts';
import { type DateFilter, type HarnessFilter, listingQuery, sinceInstant } from './conversation-picker-model.ts';

export type ContinueSource = 'sessions' | 'conversations';

export const CONTINUE_SOURCES: readonly { readonly id: ContinueSource; readonly label: string }[] = [
  { id: 'sessions', label: 'Ferretry sessions' },
  { id: 'conversations', label: 'All conversations' },
];

export interface ContinueSearch {
  readonly text: string;
  readonly harness: HarnessFilter;
  readonly date: DateFilter;
}

/** The listing the "All conversations" source asks for: Ferretry's own history only. */
export const conversationsQuery = (search: ContinueSearch, now: number, limit: number): ConversationImportQuery => ({
  source: 'ferretry',
  ...listingQuery(search, now, limit),
});

/** The listing a stopped ferret's description is joined from: every kept conversation, newest first. */
export const keptConversationsQuery = (limit: number): ConversationImportQuery => ({ source: 'ferretry', limit });

/** A stopped ferret as the "Ferretry sessions" source shows it. */
export interface StoppedSessionRow {
  readonly view: SessionView;
  /** The name a person calls it by: its callsign, else its label or name. */
  readonly name: string;
  readonly lastActivityAt: string;
  /** The conversation it keeps, which says what it is about, when the listing has it. */
  readonly conversation?: ImportableConversation;
}

/** When a ferret last moved, as every session surface reads it. */
export const sessionActivityAt = (view: SessionView): string => view.state.lastActivityAt ?? view.config.updatedAt;

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');

/** Every stopped ferret that matches the search, newest first, each with the conversation it keeps. */
export const stoppedSessionRows = (
  sessions: readonly SessionView[],
  kept: readonly ImportableConversation[],
  search: ContinueSearch,
  now: number,
): readonly StoppedSessionRow[] => {
  const byOwner = new Map(kept.flatMap(row => (row.adoptedBy === undefined ? [] : [[row.adoptedBy, row] as const])));
  const since = sinceInstant(search.date, now);
  const wanted = words(search.text);
  return sessions
    .filter(view => isTerminalSessionStatus(view.state.status))
    .map((view): StoppedSessionRow => {
      const conversation = byOwner.get(view.config.id);
      const { config } = view;
      return {
        view,
        name: displayCallsign(config.teammate) || config.label || config.name,
        lastActivityAt: sessionActivityAt(view),
        ...(conversation === undefined ? {} : { conversation }),
      };
    })
    .filter(row => {
      if (search.harness !== 'all' && row.view.config.harness !== search.harness) return false;
      if (since !== undefined && Date.parse(row.lastActivityAt) < Date.parse(since)) return false;
      const haystack =
        `${row.name}\n${row.conversation?.name ?? ''}\n${row.conversation?.preview ?? ''}\n${row.conversation?.latest ?? ''}\n${row.view.config.cwd}`.toLowerCase();
      return wanted.every(word => haystack.includes(word));
    })
    .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
};

/**
 * What continuing a conversation a ferret already keeps does: a STOPPED ferret is resumed in place,
 * with its conversation intact; one still running is simply opened. A ferret this browser has not read
 * is opened, and its own page offers whatever it can do.
 */
export const keptConversationAction = (
  row: ImportableConversation,
  sessions: readonly SessionView[],
): 'resume' | 'open' => {
  const owner = sessions.find(view => view.config.id === row.adoptedBy);
  return owner !== undefined && isTerminalSessionStatus(owner.state.status) ? 'resume' : 'open';
};
