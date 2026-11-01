import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type QueueAuthor, QueueAuthorSchema, type QueuedMessage } from '@ferretry/protocol';
import type { OwnerWords, SessionParents } from '../../lib/board/index.ts';
import type { SendRecord } from '../../lib/session/send/types.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';

/** The queue, as far as this reads it. */
interface MessagesOf {
  list(id: SessionId): Promise<readonly QueuedMessage[]>;
}

/** The send ledger, as far as this reads it: every send to the session, with who sent it and the turn it started. */
interface SendsOf {
  list(id: SessionId): Promise<readonly SendRecord[]>;
}

/** The files a session's turn documents are read through. */
export interface TurnFiles {
  /** The modification time of a file or directory in milliseconds, or `undefined` when it is not there. */
  modified(path: string): Promise<number | undefined>;
  /** The names in a directory; throws when it cannot be listed. */
  list(directory: string): Promise<readonly string[]>;
  read(file: string): Promise<string>;
}

const NODE_TURN_FILES: TurnFiles = {
  modified: async path => {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }
  },
  list: async directory => await readdir(directory),
  read: async file => await readFile(file, 'utf8'),
};

/** How many sessions' turn documents are kept read; the one read longest ago is let go first. */
export const OWNER_TURNS_KEPT = 256;

const TURN_FILE = /^turn-(\d+)\.md$/u;

/** The first line of a ferret's message, as it is wrapped for the agent: everything under it is the ferret's. */
const FROM_FERRET = /^\[(?:message|reply|question) from ferret\b/u;

/**
 * The first lines that mark a paragraph as Ferretry's own notice when nothing recorded who sent it: the board's,
 * the Warden's, the turn-end checks', a restart's. An agenda answer the owner gave (`[answer to !A…`,
 * `[re !A…`) is the owner's and is not here.
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
 * Ferretry's notices, which a busy session is handed in the same delivery as the owner's next message.
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

/** A person's send (no sending session; a ferret's or Ferretry's says so), as far as it is the owner's. */
const sentByOwner = (record: SendRecord): string | null =>
  (record.senderKind ?? 'human') === 'human' && record.from === undefined ? ownerPart(record.by, record.message) : null;

/** One turn document as read, or nothing worth keeping when it is plainly somebody else's. */
interface ReadTurn {
  readonly modifiedMs: number;
  /** The words, or `null` when the document's own author file or first line says it is not the owner's. */
  readonly text: string | null;
}

/** One session's turn documents as read, and the directory time they were read at. */
interface ReadTurns {
  readonly directoryMs: number;
  readonly turns: ReadonlyMap<number, ReadTurn>;
}

/**
 * WHAT THE OWNER SAID TO A SESSION, for deciding whether a card's ask is theirs, from three records:
 *
 * - the session's queue (any state), whose messages say who sent them;
 * - the send ledger, which records every send's sender (`senderKind`, `by`) and the turn it started — the
 *   daemon's own record, reaching back before the queue existed;
 * - every turn document (`turns/turn-NNN.md`) no send accounts for: a revive's, or one from before the ledger.
 *   One with an author file beside it (`turn-NNN.by.json`) is the owner's only when that file says so.
 *
 * A message with no recorded author is the owner's unless it is wrapped as a ferret's, less any paragraph that is
 * Ferretry's own notice ({@link ownerPartOf}). The first turn of a session a ferret started is the ferret's brief, so it is left out.
 *
 * COST IS BOUNDED. A lead's session holds thousands of turn documents, and this is asked on every card a ferret
 * makes and for every card at boot. What was read is kept per session and read again only when the turns
 * directory changed, and then only the documents whose time changed; at most {@link OWNER_TURNS_KEPT} sessions
 * are kept, and a document plainly someone else's keeps no words. The ledger keeps its own incremental read.
 *
 * Total: a session it cannot read, an id it does not know and a missing record are an empty list, because
 * "unknown" must read as "the agent's" and never stop a card from being made.
 */
export class SessionOwnerWords implements OwnerWords {
  private readonly read = new Map<SessionId, ReadTurns>();

  constructor(
    private readonly queue: MessagesOf,
    private readonly sends: SendsOf,
    private readonly parents: SessionParents,
    private readonly turnsDirectory: (id: SessionId) => string,
    private readonly files: TurnFiles = NODE_TURN_FILES,
  ) {}

  async said(sessionId: string): Promise<readonly string[]> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return [];
    const words: string[] = [];
    try {
      for (const message of await this.queue.list(id)) {
        const part = queuedByOwner(message);
        if (part !== null) words.push(part);
      }
    } catch {
      // an unreadable queue says nothing; the ledger and the turns below may still
    }
    /** The turns a send started: the ledger says who sent those, so their documents are not read for it. */
    const accounted = new Set<number>();
    try {
      for (const record of await this.sends.list(id)) {
        if (record.turn !== undefined) accounted.add(record.turn);
        const part = sentByOwner(record);
        if (part !== null) words.push(part);
      }
    } catch {
      // an unreadable ledger says nothing; every turn document below is then read on its own
    }
    try {
      const fromFerret = await this.startedByFerret(sessionId);
      for (const [turn, { text }] of [...(await this.turns(id))].sort(([a], [b]) => a - b)) {
        if (text === null || accounted.has(turn) || (turn === 1 && fromFerret)) continue;
        words.push(text);
      }
    } catch {
      // no turns on disk
    }
    return [...new Set(words)];
  }

  /** Whether a ferret started the session; a lineage that cannot be read cannot prove the owner wrote the first turn. */
  private async startedByFerret(sessionId: string): Promise<boolean> {
    try {
      return (await this.parents.parentOf(sessionId)) !== undefined;
    } catch {
      return true;
    }
  }

  private async turns(id: SessionId): Promise<ReadonlyMap<number, ReadTurn>> {
    const directory = this.turnsDirectory(id);
    const directoryMs = await this.files.modified(directory);
    if (directoryMs === undefined) return new Map();
    const kept = this.read.get(id);
    if (kept !== undefined && kept.directoryMs === directoryMs) {
      this.keep(id, kept);
      return kept.turns;
    }
    const names = new Set(await this.files.list(directory));
    const turns = new Map<number, ReadTurn>();
    for (const name of names) {
      const number = TURN_FILE.exec(name)?.[1];
      if (number === undefined) continue;
      const turn = Number(number);
      const file = join(directory, name);
      const modifiedMs = await this.files.modified(file);
      if (modifiedMs === undefined) continue;
      const before = kept?.turns.get(turn);
      if (before !== undefined && before.modifiedMs === modifiedMs) {
        turns.set(turn, before);
        continue;
      }
      const authorName = name.replace(/\.md$/u, '.by.json');
      const by = names.has(authorName) ? await this.author(join(directory, authorName)) : undefined;
      try {
        const text = (await this.files.read(file)).trimEnd();
        turns.set(turn, { modifiedMs, text: ownerPart(by, text) });
      } catch {
        // gone between the listing and the read; the next change of the directory reads it again
      }
    }
    this.keep(id, { directoryMs, turns });
    return turns;
  }

  /** Who a turn document is from, by the file Ferretry wrote beside it; one it cannot read names nobody. */
  private async author(file: string): Promise<QueueAuthor | undefined> {
    try {
      const parsed = QueueAuthorSchema.safeParse(JSON.parse(await this.files.read(file)));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private keep(id: SessionId, turns: ReadTurns): void {
    this.read.delete(id);
    this.read.set(id, turns);
    while (this.read.size > OWNER_TURNS_KEPT) {
      const oldest = this.read.keys().next().value;
      if (oldest === undefined) break;
      this.read.delete(oldest);
    }
  }
}
