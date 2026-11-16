import { describe, expect, test } from 'bun:test';
import {
  MAILBOX_HOST_KEY,
  MailboxHosts,
  MailboxPort,
  QueueChanged,
  QueueEventSchema,
  SendLineSchema,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';

describe('the Mailbox package', () => {
  test('is a core piece that offers one slot and serves the send path: twelve routes, no screen of its own', () => {
    expect(manifest.id).toBe('mailbox');
    expect(manifest.core).toBe(true);
    expect(manifest.hooks?.offers?.map(offer => offer.hook)).toEqual([MailboxHosts]);
    expect(manifest.actions.routes).toHaveLength(12);
    expect(MailboxPort.name).toBe('mailbox');
  });

  test('mailbox.host is a security-path provide hook: only Conversation may fill it, under one key', () => {
    expect(MailboxHosts.mode).toBe('provide');
    expect(MailboxHosts.takers).toEqual(['conversation']);
    expect(MailboxHosts.key.safeParse(MAILBOX_HOST_KEY).success).toBe(true);
    expect(MailboxHosts.key.safeParse('machine').success).toBe(false);
  });

  test('keeps the wire names the app and CLI listen for', () => {
    expect(QueueChanged.name).toBe('conversation.queue-changed');
  });

  test('parses a queue line and a send line exactly as the files hold them', () => {
    expect(
      QueueEventSchema.safeParse({ v: 1, kind: 'moved', at: '2026-11-16T00:00:00.000Z', id: 'q1', state: 'typing' })
        .success,
    ).toBe(true);
    expect(QueueEventSchema.safeParse({ v: 1, kind: 'bogus' }).success).toBe(false);
    expect(
      SendLineSchema.safeParse({
        sendId: 's1',
        acceptedAt: '2026-11-16T00:00:00.000Z',
        acceptedTurn: 0,
        path: 'direct',
        message: 'hello',
        fate: 'accepted',
        at: '2026-11-16T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
