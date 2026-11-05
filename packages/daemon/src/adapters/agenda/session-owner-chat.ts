import { parseAgendaMessage, type QueuedMessage } from '@ferretry/protocol';
import type { OwnerChat, OwnerChatLookup, OwnerChatMessage } from '../../lib/agenda/index.ts';
import type { SendRecord } from '../../lib/session/send/types.ts';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import { queuedByOwner, sentByOwner } from '../board/session-owner-words.ts';

/** Restore boundary whitespace stripped by the legacy author detector, without changing its author decision. */
const exactWords = (source: string, owner: string | null): string | null => {
  if (owner === source) return source;
  // Legacy author detection can remove paragraph whitespace. Restore the original, never its normalized copy.
  // A mixed delivery with daemon notices has no exact owner-only source span: refuse rather than rewrite it.
  return owner !== null && source.replace(/\s/gu, '') === owner.replace(/\s/gu, '') ? source : null;
};

interface MessagesOf {
  list(id: SessionId): Promise<readonly QueuedMessage[]>;
}

interface SendsOf {
  list(id: SessionId): Promise<readonly SendRecord[]>;
}

/** A chat reply's `[re !A5 «title»]` heading is the daemon's wrapper, not the owner's words: what they typed follows it. */
export function typedWords(text: string): string {
  // Daemon reply headings start at column zero; an indented example belongs to the owner.
  if (!text.startsWith('[re ')) return text;
  const forms = parseAgendaMessage(text);
  const [only] = forms?.parts ?? [];
  if (forms?.parts.length !== 1 || only?.kind !== 're') return text;
  const boundary = only.raw.length - only.text.length;
  return text.slice(boundary);
}

/** One message of a session as far as it is known: its id and time, and the owner's part of it (`null` when it is not theirs). */
interface Known {
  readonly messageId: string;
  readonly at: string;
  readonly owner: string | null;
}

/**
 * THE OWNER'S CHAT, READ FROM THE SESSION'S OWN MESSAGE STORE: its queue and its send ledger (the same two records
 * `SessionOwnerWords` reads), each message under the id it was sent with. Nothing of another session is ever
 * visible: the stores are the session's. A message is the owner's by the record of who sent it, as everywhere else.
 * Total: a store that cannot be read says nothing.
 */
export class SessionOwnerChat implements OwnerChat {
  constructor(
    private readonly queue: MessagesOf,
    private readonly sends: SendsOf,
  ) {}

  async find(sessionId: string, messageId?: string): Promise<OwnerChatLookup> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return { ok: false, reason: messageId === undefined ? 'none' : 'unknown' };
    const known = new Map<string, Known>();
    try {
      for (const message of await this.queue.list(id)) {
        known.set(message.id, {
          messageId: message.id,
          at: message.enqueuedAt,
          owner: exactWords(message.text, queuedByOwner(message)),
        });
      }
    } catch {
      // an unreadable queue says nothing; the ledger below may still
    }
    try {
      for (const record of await this.sends.list(id)) {
        if (known.has(record.sendId)) continue;
        known.set(record.sendId, {
          messageId: record.sendId,
          at: record.acceptedAt,
          owner: exactWords(record.message, sentByOwner(record)),
        });
      }
    } catch {
      // an unreadable ledger says nothing
    }
    const owned = (each: Known): OwnerChatMessage | undefined => {
      const text = each.owner === null ? '' : typedWords(each.owner);
      return text.trim() === '' ? undefined : { messageId: each.messageId, at: each.at, text };
    };
    if (messageId !== undefined) {
      const wanted = known.get(messageId);
      if (wanted === undefined) return { ok: false, reason: 'unknown' };
      const message = owned(wanted);
      return message === undefined ? { ok: false, reason: 'not-owner' } : { ok: true, message };
    }
    const latest = [...known.values()]
      .map(owned)
      .filter((message): message is OwnerChatMessage => message !== undefined)
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
    return latest === undefined ? { ok: false, reason: 'none' } : { ok: true, message: latest };
  }
}
