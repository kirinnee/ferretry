/**
 * The PURE half of "Continue a conversation" (today New session › Continue; now on the Conversations screen): ONE list, narrowed by where a row comes from.
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

import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { LinkableConversation, LinkQuery } from '../../contract/index.ts';
import { displayCallsign } from './callsign.ts';
import type { HarnessKey } from './link-words.ts';
import {
  type DateFilter,
  type FerretMark,
  listingQuery,
  matchesDate,
  matchesSearch,
  sinceInstant,
} from './conversation-picker-model.ts';

export type ContinueSource = 'all' | 'ferretry' | 'computer' | HarnessKey;

export const CONTINUE_SOURCES: readonly { readonly id: ContinueSource; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ferretry', label: 'Ferretry' },
  { id: 'computer', label: 'On this computer' },
  { id: 'claude-code', label: 'Claude' },
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
): LinkQuery => ({
  source: 'synced',
  ...listingQuery(
    { ...search, harness: source === 'claude-code' || source === 'codex' ? source : 'all' },
    now,
    // The computer's rows are picked out of the answer here, so read enough of it for them to be in it.
    source === 'computer' ? limit * COMPUTER_LIMIT_FACTOR : limit,
  ),
});

/** The listing the ferrets' rows are joined from: every kept conversation, newest first. */
export const keptConversationsQuery = (limit: number): LinkQuery => ({ source: 'ferretry', limit });

/** When a ferret last moved: the instant its state last changed (Ferrets' summary). */
export const ferretActivityAt = (ferret: FerretSummary): string => ferret.stateAt;

/**
 * Whether a ferret can be resumed in place: nothing is working it (today's `reviveOffer`, whose rule is "stopped,
 * finished, failed or stalled"; Ferrets' summary says all of those as `stopped`).
 */
export const ferretResumable = (ferret: FerretSummary): boolean => ferret.state === 'stopped';

/** A ferret as its marks name it: its callsign, else its label or name, and its state. */
export const ferretMark = (ferret: FerretSummary): FerretMark => ({
  id: ferret.id,
  name: displayCallsign(ferret.name) || ferret.label || ferret.name,
  status: ferret.state,
});

/** One row of the Continue list. */
export type ContinueEntry =
  | {
      readonly kind: 'conversation';
      readonly conversation: LinkableConversation;
      /** The ferret that keeps it; a ferret this browser has not read is named by its id. */
      readonly ferret?: FerretMark;
    }
  | {
      /** A stopped ferret whose conversation the listing does not have. */
      readonly kind: 'ferret';
      readonly view: FerretSummary;
      readonly ferret: FerretMark;
    };

const entryActivityAt = (entry: ContinueEntry): string =>
  entry.kind === 'conversation' ? entry.conversation.lastActivityAt : ferretActivityAt(entry.view);

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');

export interface ContinueListing {
  readonly source: ContinueSource;
  /** What the daemon answered for the source's search (unused for Ferretry, which reads `kept`). */
  readonly searched: readonly LinkableConversation[];
  /** Every kept conversation, which joins a stopped ferret to what it is about. */
  readonly kept: readonly LinkableConversation[];
  readonly ferrets: readonly FerretSummary[];
  readonly search: ContinueSearch;
}

/** The rows a source shows, newest first: its conversations, each marked by its ferret, and the bare stopped ferrets. */
export const continueEntries = (
  { source, searched, kept, ferrets, search }: ContinueListing,
  now: number,
): readonly ContinueEntry[] => {
  const byId = new Map<string, FerretSummary>(ferrets.map(view => [view.id, view]));
  const marked = (conversation: LinkableConversation): ContinueEntry => {
    if (conversation.keptBy === undefined) return { kind: 'conversation', conversation };
    const owner = byId.get(conversation.keptBy);
    const ferret = owner === undefined ? { id: conversation.keptBy, name: conversation.keptBy } : ferretMark(owner);
    return { kind: 'conversation', conversation, ferret };
  };
  // Ferretry is narrowed here, so its search also finds a conversation by the name of the ferret keeping it.
  const entries: ContinueEntry[] =
    source === 'ferretry'
      ? kept
          .filter(row => row.keptBy !== undefined && matchesDate(row, search.date, now))
          .map(marked)
          .filter(
            entry =>
              entry.kind === 'conversation' && matchesSearch(entry.conversation, search.text, entry.ferret?.name),
          )
      : searched
          .filter(row => source !== 'computer' || (row.keptIn === 'computer' && row.keptBy === undefined))
          .map(marked);
  const described = new Set([...kept, ...searched].flatMap(row => (row.keptBy === undefined ? [] : [row.keptBy])));
  const since = sinceInstant(search.date, now);
  const wanted = words(search.text);
  for (const view of ferrets) {
    if (!ferretResumable(view) || described.has(view.id)) continue;
    if (source !== 'all' && source !== 'ferretry' && view.harness !== source) continue;
    const ferret = ferretMark(view);
    if (since !== undefined && Date.parse(ferretActivityAt(view)) < Date.parse(since)) continue;
    const haystack = `${ferret.name}\n${view.folder}`.toLowerCase();
    if (wanted.every(word => haystack.includes(word))) entries.push({ kind: 'ferret', view, ferret });
  }
  return entries.sort((left, right) => Date.parse(entryActivityAt(right)) - Date.parse(entryActivityAt(left)));
};

/**
 * What continuing a conversation a ferret already keeps does: a STOPPED ferret is resumed in place,
 * with its conversation intact; one still running is simply opened. A ferret this browser has not read
 * is opened, and its own page offers whatever it can do.
 */
export const keptConversationAction = (
  row: LinkableConversation,
  ferrets: readonly FerretSummary[],
): 'resume' | 'open' => {
  const owner = ferrets.find(view => view.id === row.keptBy);
  return owner !== undefined && ferretResumable(owner) ? 'resume' : 'open';
};
