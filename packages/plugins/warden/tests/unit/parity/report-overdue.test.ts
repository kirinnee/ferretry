import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import type { ConversationApi, SendRecord } from '@ferretry/plugin-conversation/contract';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import daemon from '../../../daemon/index.ts';

const ASKED_AT = '2026-11-07T11:30:00.000Z' as Instant;

/** The lead's one send to its helper, half an hour ago, wanting an answer. */
const asked: SendRecord = {
  v: 1,
  sendId: 'send-asked',
  acceptedAt: ASKED_AT,
  acceptedTurn: 3,
  path: 'direct',
  message: 'review the branch and report back',
  attachmentIds: [],
  from: 'lead',
  replyExpected: true,
  fate: 'delivered',
};

/** Conversation with the helper's ledger seeded, recording every message typed to anyone. */
function conversationWithAsk(): { readonly conversation: ConversationApi; readonly typed: string[] } {
  const base = fakeConversation();
  const typed: string[] = [];
  const conversation: ConversationApi = {
    ...base,
    sends: async ferret => ({ sends: ferret === ferretId('child') ? [asked] : [] }),
    send: async (ferret, caller, request) => {
      typed.push(`${ferret}: ${request.message}`);
      return await base.send(ferret, caller, request);
    },
  };
  return { conversation, typed };
}

describe('a sub-ferret overdue on a report, in the running daemon half', () => {
  test('is flagged report_overdue, and nothing is typed to it or its parent (no unattended act until Ferrets exposes waiting/done)', async () => {
    // Arrange: Warden defaults (on, nudge allowed alone); an auto lead and its auto helper, both idle since the ask
    const ferrets = new FakeFerrets();
    const { conversation, typed } = conversationWithAsk();
    const clock = fixedClock('2026-11-07T12:00:00.000Z');
    const host = await testHost({ plugins: [daemon], fakes: { ferrets, asks: new FakeAsks(), conversation }, clock });
    ferrets.add({ id: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: ASKED_AT });
    ferrets.add({ id: ferretId('child'), mode: 'auto', parent: ferretId('lead'), state: 'idle', stateAt: ASKED_AT });

    // Act
    const ran = await host.request('POST', '/v1/warden/run', { body: { spawn: false }, as: owner() });

    // Assert
    expect(ran.status).toBe(200);
    const flags = ran.json<{ flags: { kind: string; ferret: string }[] }>().flags;
    expect(flags.map(flag => [flag.kind, flag.ferret])).toContainEqual(['report_overdue', 'child']);
    expect(typed).toEqual([]);
    expect(ferrets.resumes).toEqual([]);
    expect(ferrets.starts).toEqual([]);
  });
});
