import { readFile } from 'node:fs/promises';
import type { QueuedMessage } from '@ferretry/protocol';
import type { OwnerWords, SessionParents } from '../../lib/board/index.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';

/** The queue, as far as this reads it. */
interface MessagesOf {
  list(id: SessionId): Promise<readonly QueuedMessage[]>;
}

/** A message the owner sent: from a person, and not on a ferret's or Ferretry's behalf. */
const fromOwner = (message: QueuedMessage): boolean =>
  message.sender === 'human' && (message.by === undefined || message.by.kind === 'owner');

/**
 * WHAT THE OWNER SAID TO A SESSION, for deciding whether a card's ask is theirs: every message the owner sent
 * through the session's queue (any state), and the first turn's document when the owner started the session.
 * A session a ferret started has a first turn the ferret wrote, so that document is not the owner's and is left out.
 *
 * Total: a session it cannot read, an id it does not know and a missing first turn are an empty list, because
 * "unknown" must read as "the agent's" and never stop a card from being made.
 */
export class QueueOwnerWords implements OwnerWords {
  constructor(
    private readonly queue: MessagesOf,
    private readonly parents: SessionParents,
    private readonly firstTurn: (id: SessionId) => string,
    private readonly read: (file: string) => Promise<string> = async file => await readFile(file, 'utf8'),
  ) {}

  async said(sessionId: string): Promise<readonly string[]> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return [];
    const words: string[] = [];
    try {
      words.push(...(await this.queue.list(id)).filter(fromOwner).map(message => message.text));
    } catch {
      // an unreadable queue says nothing; the first turn below may still
    }
    try {
      if ((await this.parents.parentOf(sessionId)) === undefined) words.push(await this.read(this.firstTurn(id)));
    } catch {
      // no first turn on disk, or no lineage to prove the owner wrote it
    }
    return words;
  }
}
