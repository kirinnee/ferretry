import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import { SessionOwnerChat, typedWords } from '../../src/adapters/agenda/session-owner-chat.ts';
import type { SendRecord } from '../../src/lib/session/send/types.ts';

const SESSION = 'mvuc7tsf-0c3d50df';

const queued = (id: string, text: string, at: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id,
  sender: 'human',
  text,
  attachmentIds: [],
  enqueuedAt: at,
  state: 'read',
  stateAt: at,
  revision: 1,
  ...extra,
});

const sent = (sendId: string, text: string, at: string, extra: Partial<SendRecord> = {}): SendRecord => ({
  sendId,
  acceptedAt: at,
  acceptedTurn: 1,
  path: 'turn-file',
  message: text,
  fate: 'delivered',
  ...extra,
});

const chat = (messages: readonly QueuedMessage[], sends: readonly SendRecord[] = []) =>
  new SessionOwnerChat({ list: async () => messages }, { list: async () => sends });

/** Shared behavior contract: unit regressions and the IO tier both prove these storage boundaries. */
export function ownerChatContract() {
  describe('SessionOwnerChat', () => {
    it('should answer the latest owner message by default, and the one named by id', async () => {
      // Arrange
      const owner = chat([
        queued('m1', 'first words', '2026-11-03T10:00:00.000Z'),
        queued('m2', 'second words', '2026-11-03T10:05:00.000Z'),
      ]);

      // Act
      const latest = await owner.find(SESSION);
      const named = await owner.find(SESSION, 'm1');

      // Assert
      should(latest).deepEqual({
        ok: true,
        message: { messageId: 'm2', at: '2026-11-03T10:05:00.000Z', text: 'second words' },
      });
      should(named.ok && named.message.text).equal('first words');
    });

    it('should read a message from the send ledger when the queue no longer holds it', async () => {
      // Arrange
      const owner = chat([], [sent('s1', 'from the ledger', '2026-11-03T10:00:00.000Z')]);

      // Act
      const found = await owner.find(SESSION);

      // Assert
      should(found.ok && found.message.messageId).equal('s1');
    });

    it('should refuse a message that is not the owner’s, one that is not in this session, and a chat with none', async () => {
      // Arrange
      const owner = chat([queued('f1', 'a ferret talking', '2026-11-03T10:00:00.000Z', { sender: 'agent' })]);

      // Act
      const results = [await owner.find(SESSION, 'f1'), await owner.find(SESSION, 'other'), await owner.find(SESSION)];

      // Assert
      should(results).deepEqual([
        { ok: false, reason: 'not-owner' },
        { ok: false, reason: 'unknown' },
        { ok: false, reason: 'none' },
      ]);
    });

    it('should be total on a store that cannot be read, and on an id that is not a session', async () => {
      // Arrange
      const broken = new SessionOwnerChat(
        {
          list: async () => {
            throw new Error('unreadable');
          },
        },
        {
          list: async () => {
            throw new Error('unreadable');
          },
        },
      );

      // Act
      const results = [await broken.find(SESSION), await broken.find('not a session!', 'm1')];

      // Assert
      should(results).deepEqual([
        { ok: false, reason: 'none' },
        { ok: false, reason: 'unknown' },
      ]);
    });

    it('should drop the daemon’s [re …] heading and keep what the owner typed', () => {
      // Arrange
      const wrapped = '[re !A5 «Which region?»] use eu';

      // Act
      const words = typedWords(wrapped);

      // Assert
      should(words).equal('use eu');
    });
  });

  it('preserves indentation, trailing newlines and oversized source words from both stores', async () => {
    const text = `    const answer = 42;\n${'x'.repeat(200_000)}Z\n`;
    const at = '2026-11-03T10:00:00.000Z';
    for (const owner of [chat([queued('m', text, at)]), chat([], [sent('m', text, at)])]) {
      const result = await owner.find(SESSION, 'm');
      should(result.ok && result.message.text).equal(text);
    }
    should(typedWords(`[re !A5 «Which region?»] ${text}`)).equal(text);
  });

  it('preserves indented reply-heading examples as owner text', () => {
    const text = '    [re !A5 «Which region?»] example code\n';
    should(typedWords(text)).equal(text);
  });
}
