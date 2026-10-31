/**
 * The PURE half of New session › "Continue a conversation": ONE list, narrowed by where a row comes from.
 *
 *   All        everything below, newest first
 *   Ferretry   every conversation a ferret keeps (running or stopped), and every STOPPED ferret whose
 *              conversation the listing does not have
 *   On this computer  the conversations that live only in the CLIs' own homes here (`~/.claude`,
 *              `~/.codex`): none a ferret keeps, none already in Ferretry's history
 *   Claude     every Claude Code conversation, from either place
 *   Codex      the same for Codex
 *
 * The listing is `source=synced`: Ferretry's own history plus, while "Keep in sync" is on, the CLIs' homes
 * on this computer — read-only, and adopted only when the owner continues one. A row a ferret keeps
 * carries BOTH marks: the ferret and its CLI; a row only the computer holds says so.
 *
 * Nothing here reads a clock: every rule that depends on "now" is handed it.
 */

import type { ConversationImportQuery, Harness, ImportableConversation, SessionView } from '@ferretry/protocol';
import { displayCallsign } from '../../../lib/callsign.ts';
import { reviveOffer } from '../../../shell/revive-offer.ts';
import {
  type DateFilter,
  type FerretMark,
  listingQuery,
  matchesDate,
  matchesSearch,
  sinceInstant,
} from './conversation-picker-model.ts';

export type ContinueSource = 'all' | 'ferretry' | 'computer' | Harness;

export const CONTINUE_SOURCES: readonly { readonly id: ContinueSource; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ferretry', label: 'Ferretry' },
  { id: 'computer', label: 'On this computer' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

/** How many times `limit` the "On this computer" chip reads, since it keeps only some of what comes back. */
export const COMPUTER_LIMIT_FACTOR = 4;

export interface ContinueSearch {
  readonly text: string;
  readonly date: DateFilter;
}

/** The daemon search a source sends: Ferretry's history and the computer's, narrowed to a CLI when the source is one. */
export const conversationsQuery = (
  source: ContinueSource,
  search: ContinueSearch,
  now: number,
  limit: number,
): ConversationImportQuery => ({
  source: 'synced',
  ...listingQuery(
    { ...search, harness: source === 'claude' || source === 'codex' ? source : 'all' },
    now,
    // The computer's rows are picked out of the answer here, so read enough of it for them to be in it.
    source === 'computer' ? limit * COMPUTER_LIMIT_FACTOR : limit,
  ),
});

/** The listing the ferrets' rows are joined from: every kept conversation, newest first. */
export const keptConversationsQuery = (limit: number): ConversationImportQuery => ({ source: 'ferretry', limit });

/** When a ferret last moved, as every session surface reads it. */
export const sessionActivityAt = (view: SessionView): string => view.state.lastActivityAt ?? view.config.updatedAt;

/** A ferret as its marks name it: its callsign, else its label or name, and its status. */
export const ferretMark = (view: SessionView): FerretMark => ({
  id: view.config.id,
  name: displayCallsign(view.config.teammate) || view.config.label || view.config.name,
  status: view.state.status,
});

/** One row of the Continue list. */
export type ContinueEntry =
  | {
      readonly kind: 'conversation';
      readonly conversation: ImportableConversation;
      /** The ferret that keeps it; a ferret this browser has not read is named by its id. */
      readonly ferret?: FerretMark;
    }
  | {
      /** A stopped ferret whose conversation the listing does not have. */
      readonly kind: 'session';
      readonly view: SessionView;
      readonly ferret: FerretMark;
    };

export const entryActivityAt = (entry: ContinueEntry): string =>
  entry.kind === 'conversation' ? entry.conversation.lastActivityAt : sessionActivityAt(entry.view);

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');

export interface ContinueListing {
  readonly source: ContinueSource;
  /** What the daemon answered for the source's search (unused for Ferretry, which reads `kept`). */
  readonly searched: readonly ImportableConversation[];
  /** Every kept conversation, which joins a stopped ferret to what it is about. */
  readonly kept: readonly ImportableConversation[];
  readonly sessions: readonly SessionView[];
  readonly search: ContinueSearch;
}

/** The rows a source shows, newest first: its conversations, each marked by its ferret, and the bare stopped ferrets. */
export const continueEntries = (
  { source, searched, kept, sessions, search }: ContinueListing,
  now: number,
): readonly ContinueEntry[] => {
  const byId = new Map(sessions.map(view => [view.config.id, view]));
  const marked = (conversation: ImportableConversation): ContinueEntry => {
    if (conversation.adoptedBy === undefined) return { kind: 'conversation', conversation };
    const owner = byId.get(conversation.adoptedBy);
    const ferret =
      owner === undefined ? { id: conversation.adoptedBy, name: conversation.adoptedBy } : ferretMark(owner);
    return { kind: 'conversation', conversation, ferret };
  };
  // Ferretry is narrowed here, so its search also finds a conversation by the name of the ferret keeping it.
  const entries: ContinueEntry[] =
    source === 'ferretry'
      ? kept
          .filter(row => row.adoptedBy !== undefined && matchesDate(row, search.date, now))
          .map(marked)
          .filter(
            entry =>
              entry.kind === 'conversation' && matchesSearch(entry.conversation, search.text, entry.ferret?.name),
          )
      : searched
          .filter(row => source !== 'computer' || (row.keptIn === 'computer' && row.adoptedBy === undefined))
          .map(marked);
  const described = new Set(
    [...kept, ...searched].flatMap(row => (row.adoptedBy === undefined ? [] : [row.adoptedBy])),
  );
  const since = sinceInstant(search.date, now);
  const wanted = words(search.text);
  for (const view of sessions) {
    if (!reviveOffer(view, true).offered || described.has(view.config.id)) continue;
    if (source !== 'all' && source !== 'ferretry' && view.config.harness !== source) continue;
    const ferret = ferretMark(view);
    if (since !== undefined && Date.parse(sessionActivityAt(view)) < Date.parse(since)) continue;
    const haystack = `${ferret.name}\n${view.config.cwd}`.toLowerCase();
    if (wanted.every(word => haystack.includes(word))) entries.push({ kind: 'session', view, ferret });
  }
  return entries.sort((left, right) => Date.parse(entryActivityAt(right)) - Date.parse(entryActivityAt(left)));
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
  return owner !== undefined && reviveOffer(owner, true).offered ? 'resume' : 'open';
};
