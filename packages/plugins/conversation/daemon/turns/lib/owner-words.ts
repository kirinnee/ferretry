import type { QueueAuthor, QueuedMessage } from '../../seams/protocol.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import type { SendRecord } from '../../delivery/lib/types.ts';

/** One turn document of a ferret (`turn-NNN.md`) and, when Ferretry wrote one beside it, who the document is from. */
export interface TurnDocument {
  readonly turn: number;
  readonly text: string;
  /** The author record beside the document (`turn-NNN.by.json`); absent when there is none. */
  readonly by?: QueueAuthor | undefined;
}

/**
 * A ferret's turn documents, as the store that wrote them reads them back. Strict reads throw on anything unreadable
 * (a document that vanished mid-read, an author record that does not parse); a best-effort read skips what it cannot
 * read.
 */
export interface TurnDocuments {
  list(id: SessionId, options: { readonly strict: boolean }): Promise<readonly TurnDocument[]>;
}

/**
 * No turn documents: what this daemon has until the terminal seam lands. Nothing types a turn into a ferret yet, so no
 * turn document is ever written and there is nothing to read; the owner's words come from the queue and the send ledger
 * alone. The store that writes turn documents brings the `TurnDocuments` that reads them back.
 */
export const NO_TURN_DOCUMENTS: TurnDocuments = { list: async () => [] };

/** The first line of a ferret's message, as it is wrapped for the agent: everything under it is the ferret's. */
const FROM_FERRET = /^\[(?:message|reply|question) from ferret\b/u;

/**
 * The first lines that mark a paragraph as Ferretry's own notice when nothing recorded who sent it: the board's, the
 * Warden's, the turn-end checks', a restart's. An agenda answer the owner gave (`[answer to !A…`, `[re !A…`) is the
 * owner's and is not here.
 */
const NOTICES: readonly RegExp[] = [
  /^\[(?:ferretry|board|attention check|instructions updated)\]/u,
  /^&[A-Z]+\d+ (?:PR #\d+ CI is red|has had no activity|was reopened by|can go ahead)\b/u,
  /^&[A-Z]+\d+ → /u,
  /^Your card &[A-Z]+\d+\b/u,
  /^The owner marked &[A-Z]+\d+/u,
  /^The wait you declared\b/u,
  /^The Warden\b/u,
  /^Ferretry (?:restarted|could not|changed)\b/u,
  /^You changed code this turn without a card\b/u,
  /^You were (?:stopped|killed|migrated|revived)\b/u,
  /^Continue the assigned task\b/u,
  /^!?A\d+ (?:was answered|ended without a value)\b/u,
];

const firstLine = (text: string): string => text.trimStart().split('\n', 1)[0] ?? '';

/**
 * The owner's part of a message with no recorded sender: `null` for a ferret's, and otherwise every paragraph but
 * Ferretry's notices, which a busy ferret is handed in the same delivery as the owner's next message.
 */
export const ownerPartOf = (text: string): string | null => {
  if (FROM_FERRET.test(firstLine(text))) return null;
  const kept = text
    .split(/\n[ \t]*\n/u)
    .filter(paragraph => paragraph.trim() !== '' && !NOTICES.some(pattern => pattern.test(firstLine(paragraph))));
  return kept.length === 0 ? null : kept.join('\n\n').trim();
};

/** What of a message is the owner's: all of it when the record says they sent it, else {@link ownerPartOf}. */
const ownerPart = (by: QueueAuthor | undefined, text: string): string | null =>
  by === undefined ? ownerPartOf(text) : by.kind === 'owner' ? text : null;

/** A person's message in the queue (one a ferret or Ferretry sent says so), as far as it is the owner's. */
const queuedByOwner = (message: QueuedMessage): string | null =>
  message.sender === 'human' ? ownerPart(message.by, message.text) : null;

/** A person's send (no sending ferret; a ferret's or Ferretry's says so), as far as it is the owner's. */
const sentByOwner = (record: Pick<SendRecord, 'senderKind' | 'from' | 'by' | 'message'>): string | null =>
  (record.senderKind ?? 'human') === 'human' && record.from === undefined ? ownerPart(record.by, record.message) : null;

export interface OwnerWordsSources {
  readonly queue: { list(id: SessionId): Promise<readonly QueuedMessage[]> };
  /** Every send to the ferret, with who sent it and the turn it started. */
  readonly sends: {
    list(id: SessionId): Promise<readonly Pick<SendRecord, 'senderKind' | 'from' | 'by' | 'message' | 'turn'>[]>;
  };
  readonly turns: TurnDocuments;
  /** Whether a ferret started this one: a lineage that cannot be read cannot prove the owner wrote the first turn. */
  readonly startedByFerret: (id: SessionId) => Promise<boolean>;
}

/**
 * WHAT THE OWNER SAID TO A FERRET, for deciding whether a card's ask is theirs (Board's private choice), from three
 * records (today's `SessionOwnerWords`, the file reads moved behind {@link TurnDocuments}):
 *
 * - the queue (any state), whose messages say who sent them;
 * - the send ledger, which records every send's sender (`senderKind`, `by`) and the turn it started: the daemon's own
 *   record, reaching back before the queue existed;
 * - every turn document no send accounts for: a revive's, or one from before the ledger. One with an author record
 *   beside it (`turn-NNN.by.json`) is the owner's only when that record says so.
 *
 * A message with no recorded author is the owner's unless it is wrapped as a ferret's, less any paragraph that is
 * Ferretry's own notice ({@link ownerPartOf}). The first turn of a ferret another ferret started is that ferret's
 * brief, so it is left out.
 *
 * Best effort by default, so an ordinary create can use whatever is readable. A STRICT read rejects any failed lookup,
 * never taking "nobody spoke" for "nothing could be read".
 */
export class OwnerWordsReader {
  constructor(private readonly sources: OwnerWordsSources) {}

  async said(id: SessionId, { strict = false }: { readonly strict?: boolean } = {}): Promise<readonly string[]> {
    const words: string[] = [];
    try {
      for (const message of await this.sources.queue.list(id)) {
        const part = queuedByOwner(message);
        if (part !== null) words.push(part);
      }
    } catch (error) {
      if (strict) throw error;
      // an unreadable queue says nothing; the ledger and the turns below may still
    }
    /** The turns a send started: the ledger says who sent those, so their documents are not read for it. */
    const accounted = new Set<number>();
    try {
      for (const record of await this.sources.sends.list(id)) {
        if (record.turn !== undefined) accounted.add(record.turn);
        const part = sentByOwner(record);
        if (part !== null) words.push(part);
      }
    } catch (error) {
      if (strict) throw error;
      // an unreadable ledger says nothing; every turn document below is then read on its own
    }
    try {
      const fromFerret = await this.startedByFerret(id, strict);
      const documents = [...(await this.sources.turns.list(id, { strict }))].sort((a, b) => a.turn - b.turn);
      for (const document of documents) {
        if (accounted.has(document.turn) || (document.turn === 1 && fromFerret)) continue;
        const part = ownerPart(document.by, document.text.trimEnd());
        if (part !== null) words.push(part);
      }
    } catch (error) {
      if (strict) throw error;
      // no turns on disk
    }
    return [...new Set(words)];
  }

  private async startedByFerret(id: SessionId, strict: boolean): Promise<boolean> {
    try {
      return await this.sources.startedByFerret(id);
    } catch (error) {
      if (strict) throw error;
      return true;
    }
  }
}
