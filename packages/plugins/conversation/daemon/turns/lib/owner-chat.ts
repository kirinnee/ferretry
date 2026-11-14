import {
  type AskOwnerChat,
  type AskOwnerChatLookup,
  type AskOwnerChatMessage,
  parseAgendaMessage,
} from '@ferretry/core-asks/contract';
import type { SendRecord } from '../../delivery/lib/types.ts';
import { tryParseSessionId, type SessionId } from '../../seams/ferret-id.ts';
import type { QueuedMessage } from '../../seams/protocol.ts';
import { queuedByOwner, sentByOwner } from './owner-words.ts';

/** Restore boundary whitespace the author detector strips, without changing its author decision. */
const exactWords = (source: string, owner: string | null): string | null => {
  if (owner === source) return source;
  // A mixed delivery with daemon notices has no exact owner-only span: refuse rather than rewrite it.
  return owner !== null && source.replace(/\s/gu, '') === owner.replace(/\s/gu, '') ? source : null;
};

/** A chat reply's `[re !A5 «title»]` heading is the daemon's wrapper, not the owner's words: what they typed follows it. */
export function typedWords(text: string): string {
  // Daemon reply headings start at column zero; an indented example belongs to the owner.
  if (!text.startsWith('[re ')) return text;
  const forms = parseAgendaMessage(text);
  const [only] = forms?.parts ?? [];
  if (forms?.parts.length !== 1 || only?.kind !== 're') return text;
  return text.slice(only.raw.length - only.text.length);
}

/** One message of a ferret as far as it is known: its id and time, and the owner's part of it (`null` when it is not theirs). */
interface Known {
  readonly messageId: string;
  readonly at: string;
  readonly owner: string | null;
}

/**
 * THE OWNER'S CHAT, READ FROM THE FERRET'S OWN MESSAGE STORE: its queue and its send ledger, each message under the id it
 * was sent with. Nothing of another ferret is ever visible: the stores are the ferret's. A message is the owner's by the
 * record of who sent it, as everywhere else. Total: a store that cannot be read says nothing.
 */
export class SessionOwnerChat implements AskOwnerChat {
  constructor(
    private readonly queue: { list(id: SessionId): Promise<readonly QueuedMessage[]> },
    private readonly sends: {
      list(
        id: SessionId,
      ): Promise<readonly Pick<SendRecord, 'sendId' | 'acceptedAt' | 'message' | 'senderKind' | 'from' | 'by'>[]>;
    },
  ) {}

  async find(ferret: string, messageId?: string): Promise<AskOwnerChatLookup> {
    const id = tryParseSessionId(ferret);
    if (id === undefined) return { ok: false, reason: messageId === undefined ? 'none' : 'unknown' };
    const known = new Map<string, Known>();
    try {
      for (const message of await this.queue.list(id))
        known.set(message.id, {
          messageId: message.id,
          at: message.enqueuedAt,
          owner: exactWords(message.text, queuedByOwner(message)),
        });
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
    const owned = (each: Known): AskOwnerChatMessage | undefined => {
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
      .filter((message): message is AskOwnerChatMessage => message !== undefined)
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
    return latest === undefined ? { ok: false, reason: 'none' } : { ok: true, message: latest };
  }
}
