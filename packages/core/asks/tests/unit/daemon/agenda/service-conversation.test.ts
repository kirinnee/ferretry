import { describe, it } from 'bun:test';
import type { AgendaItem } from '../../../../daemon/lib/protocol/agenda.ts';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  type AgendaSeenStore,
  AgendaService,
  type AgendaVersionStore,
  type OwnerChat,
} from '../../../../daemon/lib/agenda/index.ts';
import type { AgendaVersionDraft } from '../../../../daemon/lib/agenda/versions.ts';

const SESSION = 'session-1';
const NOW = '2026-07-31T10:00:00Z';
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const chatOf = (messages: Record<string, { at: string; text: string; owner: boolean }>): OwnerChat => ({
  find: async (_session, messageId) => {
    const entries = Object.entries(messages);
    const picked = messageId === undefined ? entries.at(-1) : entries.find(([id]) => id === messageId);
    if (picked === undefined) return { ok: false, reason: messageId === undefined ? 'none' : 'unknown' };
    const [id, message] = picked;
    return message.owner
      ? { ok: true, message: { messageId: id, at: message.at, text: message.text } }
      : { ok: false, reason: 'not-owner' };
  },
});

const request = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Which region do we deploy to?',
  why: 'The release waits on the region.',
  premise: 'A release is ready to go out.',
  context: 'It changes the public service.',
  howToResolve: 'Answer in words.',
  ask: { kind: 'open-question' as const },
};

async function world(chat: OwnerChat, versions?: AgendaVersionStore, seen?: AgendaSeenStore) {
  const repository = new MemoryRepository();
  const service = new AgendaService(
    repository,
    { now: () => NOW },
    { has: async id => id === SESSION },
    { raised: async () => undefined },
    { changed: async () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    chat,
    versions,
    seen,
  );
  await service.raise(SESSION, request, AGENT);
  return { service, repository };
}

const itemOf = (repository: MemoryRepository): AgendaItem => {
  const entry = repository.ledgers.get(SESSION)?.entries[0];
  if (entry === undefined) throw new Error('no item');
  return entry.item as AgendaItem;
};

describe('Agenda service: log', () => {
  it('should copy the owner’s latest words verbatim, tagged from chat, and be idempotent per message (DoD 16)', async () => {
    // Arrange
    const { service, repository } = await world(
      chatOf({ m1: { at: '2026-07-31T09:59:00Z', text: 'use eu-west, not us', owner: true } }),
    );

    // Act
    const first = await service.log(SESSION, 'A1', 'reply', 'I will use eu-west', AGENT);
    const again = await service.log(SESSION, 'A1', 'reply', 'I will use eu-west', AGENT);
    const conversation = itemOf(repository).conversation ?? [];

    // Assert
    should(first.ok).be.true();
    should(again.ok).be.false();
    should(conversation.find(entry => entry.fromChat !== undefined)).containEql({
      by: 'owner',
      text: 'use eu-west, not us',
      fromChat: { messageId: 'm1', at: '2026-07-31T09:59:00Z' },
    });
    should(conversation.filter(entry => entry.fromChat?.messageId === 'm1')).have.length(1);
  });

  it('should refuse a message that is not the owner’s or is not in this session, and write nothing', async () => {
    // Arrange
    const { service, repository } = await world(
      chatOf({ f1: { at: '2026-07-31T09:59:00Z', text: 'a ferret', owner: false } }),
    );
    const before = itemOf(repository);

    // Act
    const notOwner = await service.log(SESSION, 'A1', 'rest', 'working on it', AGENT, 'f1');
    const unknown = await service.log(SESSION, 'A1', 'rest', 'working on it', AGENT, 'elsewhere');

    // Assert
    should(!notOwner.ok && notOwner.error.code).equal('forbidden');
    should(!unknown.ok && unknown.error.code).equal('not-found');
    should(itemOf(repository)).equal(before);
  });

  it('should refuse a ferret that did not raise the item', async () => {
    // Arrange
    const { service } = await world(chatOf({ m1: { at: '2026-07-31T09:59:00Z', text: 'hello', owner: true } }));

    // Act
    const result = await service.log(SESSION, 'A1', 'reply', 'ok', { kind: 'agent', sessionId: 'other', name: 'Bo' });

    // Assert
    should(result.ok).be.false();
  });
});

describe('Agenda service: versions', () => {
  it('should refuse to mark a version the item does not have, and answer one it does', async () => {
    // Arrange
    const kept: AgendaVersionDraft[] = [];
    const versions: AgendaVersionStore = {
      record: async (_session, drafts) => {
        kept.push(...drafts);
      },
      list: async () => [{ version: 1, at: NOW, by: 'ferret', change: 'created', lifecycle: 'active' }],
      get: async () => undefined,
    };
    const { service } = await world(chatOf({}), versions);

    // Act
    const tooNew = await service.markSeen(SESSION, 'A1', 9, 'phone');
    const fine = await service.markSeen(SESSION, 'A1', 1, 'phone');
    const missing = await service.versionOf(SESSION, 'A1', 7);

    // Assert
    should(tooNew.ok).be.false();
    should(fine.ok).be.true();
    should(missing.ok).be.false();
  });
});

it('paginates every byte of an oversized conversation without sending an oversized item', async () => {
  const { AgendaConversationPageSchema } = await import('@ferretry/protocol');
  const text = `    ${'😀\n'.repeat(90_000)}END\n`;
  const { service } = await world(chatOf({ large: { at: NOW, text, owner: true } }));
  should((await service.log(SESSION, 'A1', 'reply', 'OK', AGENT, 'large')).ok).be.true();
  let cursor = { index: 0, offset: 0 };
  let copied = '';
  while (true) {
    const result = await service.conversationOf(SESSION, 'A1', cursor.index, cursor.offset);
    if (!result.ok) throw new Error(result.error.message);
    const page = AgendaConversationPageSchema.parse(result.value);
    should(Buffer.byteLength(JSON.stringify(page))).be.below(120_000);
    if (page.index === 0) copied += page.entry?.text ?? '';
    if (page.next === undefined) break;
    cursor = page.next;
  }
  should(copied).equal(text);
  should((await service.conversationOf(SESSION, 'A1', -1)).ok).be.false();
  should((await service.conversationOf(SESSION, 'A1', 100)).ok).be.false();
});

it('reads a frozen version thread rather than the current thread when paging a historical version', async () => {
  // Arrange
  const { AgendaVersionSchema } = await import('@ferretry/protocol');
  const entry = { at: NOW, by: 'owner' as const, via: 'chat-log' as const, text: 'Historical owner words' };
  const versions: AgendaVersionStore = {
    record: async () => undefined,
    list: async () => [],
    get: async () =>
      AgendaVersionSchema.parse({
        version: 1,
        at: NOW,
        by: 'owner',
        change: 'logged',
        lifecycle: 'active',
        item: {
          ...request,
          id: 'A1',
          raisedBy: 'agent',
          raisedBySession: SESSION,
          raisedByName: 'Ada',
          waitingSince: NOW,
        },
      }),
    conversation: async () => [entry],
  };
  const { service } = await world(chatOf({}), versions);

  // Act
  const result = await service.conversationOf(SESSION, 'A1', 0, 0, 1);

  // Assert
  should(result.ok && result.value.entry?.text).equal(entry.text);
});

it('merges and splits through the service while preserving the original thread', async () => {
  const { service, repository } = await world(chatOf({}));
  await service.raise(SESSION, { ...request, subject: 'Which quota?' }, AGENT);
  const merged = await service.merge(SESSION, 'A1', 'A2', AGENT);
  const split = await service.split(SESSION, 'A1', { ...request, subject: 'Which cache?' }, AGENT, []);
  should(merged.ok && merged.change).equal('merged');
  should(split.ok && split.item?.splitFrom).equal('A1');
  should(repository.ledgers.get(SESSION)?.entries.find(entry => entry.item.id === 'A1')?.item.splitInto).deepEqual([
    'A3',
  ]);
});

it('lists versions and seen marks, handles absent sessions and disk failures, and pages an empty thread', async () => {
  const versions: AgendaVersionStore = {
    record: async () => undefined,
    list: async () => [{ version: 1, at: NOW, by: 'ferret', change: 'created', lifecycle: 'active' }],
    get: async () => undefined,
  };
  const seen = {
    seen: async () => 1,
    mark: async () => {
      throw new Error('disk full');
    },
  };
  const { service } = await world(chatOf({}), versions, seen);
  const listed = await service.versionsOf(SESSION, 'A1', 'phone');
  should(listed.ok && listed.value.seen).equal(1);
  should((await service.versionsOf(SESSION, 'A1')).ok).be.true();
  should((await service.markSeen(SESSION, 'A1', 1, 'phone')).ok).be.false();
  const empty = await service.conversationOf(SESSION, 'A1');
  should(empty.ok && empty.value).deepEqual({ total: 0, index: 0, offset: 0 });
  should((await service.conversationOf(SESSION, 'A99')).ok).be.false();
  should((await service.conversationOf(SESSION, 'A1', 0, 0, 99)).ok).be.false();
  for (const result of [
    await service.versionsOf('missing', 'A1'),
    await service.versionOf('missing', 'A1', 1),
    await service.markSeen('missing', 'A1', 1, 'phone'),
    await service.conversationOf('missing', 'A1'),
    await service.log('missing', 'A1', 'reply', 'OK', AGENT),
  ])
    should(result.ok).be.false();
  const broken = await world(chatOf({}), {
    ...versions,
    list: async () => {
      throw new Error('unreadable');
    },
    get: async () => {
      throw new Error('unreadable');
    },
  });
  // A store that cannot answer is unavailable — never an item with no versions, nor a version that does not exist.
  should(await broken.service.versionsOf(SESSION, 'A1', 'phone')).containDeep({
    ok: false,
    error: { code: 'corrupt' },
  });
  should(await broken.service.versionOf(SESSION, 'A1', 1)).containDeep({ ok: false, error: { code: 'corrupt' } });
  should(await broken.service.markSeen(SESSION, 'A1', 1, 'phone')).containDeep({
    ok: false,
    error: { code: 'corrupt' },
  });
  should((await service.log(SESSION, 'A1', 'reply', 'OK', AGENT)).ok).be.false();
});
