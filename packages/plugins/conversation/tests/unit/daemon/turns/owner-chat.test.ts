import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { QueuedMessage } from '../../../../contract/index.ts';
import { SessionOwnerChat, typedWords } from '../../../../daemon/turns/lib/owner-chat.ts';

const AT = '2026-11-07T09:00:00.000Z' as Instant;
const LATER = '2026-11-07T10:00:00.000Z' as Instant;

const queued = (overrides: Partial<QueuedMessage>): QueuedMessage => ({
  v: 1,
  id: 'q1',
  sender: 'human',
  text: 'use eu-west',
  attachmentIds: [],
  enqueuedAt: AT,
  state: 'read',
  stateAt: AT,
  revision: 1,
  ...overrides,
});

const sent = (overrides: Record<string, unknown>) => ({
  sendId: 's1',
  acceptedAt: AT,
  message: 'sent by the owner',
  senderKind: 'human',
  ...overrides,
});

const chat = (queue: readonly QueuedMessage[] | Error, sends: readonly object[] | Error = []) =>
  new SessionOwnerChat(
    {
      list: async () => {
        if (queue instanceof Error) throw queue;
        return queue;
      },
    },
    {
      list: async () => {
        if (sends instanceof Error) throw sends;
        return sends as never;
      },
    },
  );

describe('the owner’s chat as `fy agenda log` reads it', () => {
  test('finds the latest message the owner sent, across the queue and the send ledger', async () => {
    const found = await chat([queued({})], [sent({ acceptedAt: LATER, message: 'later, by send' })]).find('lead');
    expect(found).toEqual({ ok: true, message: { messageId: 's1', at: LATER, text: 'later, by send' } });
  });

  test('finds one message by its id, and says unknown for an id this ferret never had', async () => {
    const c = chat([queued({})]);
    expect(await c.find('lead', 'q1')).toEqual({ ok: true, message: { messageId: 'q1', at: AT, text: 'use eu-west' } });
    expect(await c.find('lead', 'nope')).toEqual({ ok: false, reason: 'unknown' });
  });

  test('never takes a ferret’s message, or a daemon notice, for the owner’s', async () => {
    const c = chat(
      [queued({ id: 'q2', sender: 'agent', from: 'other' })],
      [sent({ sendId: 's2', senderKind: 'agent', from: 'other' })],
    );
    expect(await c.find('lead')).toEqual({ ok: false, reason: 'none' });
    expect(await c.find('lead', 'q2')).toEqual({ ok: false, reason: 'not-owner' });
  });

  test('says nothing, rather than throwing, when a store cannot be read', async () => {
    expect(await chat(new Error('gone'), new Error('gone')).find('lead')).toEqual({ ok: false, reason: 'none' });
    expect(await chat([queued({})], new Error('gone')).find('lead')).toMatchObject({ ok: true });
  });

  test('copies what the owner typed after a chat reply heading, not the heading', () => {
    expect(typedWords('plain words')).toBe('plain words');
  });
});
