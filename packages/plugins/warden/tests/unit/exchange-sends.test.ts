import { describe, it } from 'bun:test';
import should from 'should';
import { ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import type { SendRecord } from '@ferretry/plugin-conversation/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { exchangeSends } from '../../daemon/fleet.ts';

const record = (sendId: string, from: string, replyExpected?: boolean): SendRecord => ({
  v: 1,
  sendId,
  acceptedAt: T0,
  acceptedTurn: 3,
  path: 'direct',
  message: 'hello',
  attachmentIds: [],
  from,
  ...(replyExpected === undefined ? {} : { replyExpected }),
  fate: 'delivered',
});

describe('the send ledger as the overdue-report check reads it', () => {
  it('should read every page of the ledger and split a batch turn into its members', async () => {
    // Arrange: two pages; s1 was one turn that carried two queued messages from different senders
    const conversation = {
      ...fakeConversation(),
      sends: async (_ferret: unknown, cursor?: string) =>
        cursor === undefined
          ? { sends: [record('s1', 'lead', false)], nextCursor: 'page-2' }
          : { sends: [record('s2', 'owner', true)], nextCursor: null },
      queue: async () => ({
        messages: [
          { id: 'q1', from: 'lead', replyExpected: false, deliveredAs: 's1' },
          { id: 'q2', from: 'peer', replyExpected: true, deliveredAs: 's1' },
        ],
      }),
    } as unknown as Parameters<typeof exchangeSends>[0];

    // Act
    const sends = await exchangeSends(conversation, ferretId('f1'));

    // Assert
    should(sends.map(send => [send.sendId, send.from, send.replyExpected])).eql([
      ['s1', 'lead', false],
      ['s1', 'peer', true],
      ['s2', 'owner', true],
    ]);
  });
});
