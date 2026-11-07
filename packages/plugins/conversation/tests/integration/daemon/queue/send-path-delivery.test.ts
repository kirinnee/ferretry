import { describe, it } from 'bun:test';
import type { QueuedMessage, SendDisposition } from '../../../../daemon/seams/protocol.ts';
import should from 'should';
import { SendPathDeliveryView, SendPathQueueTransport } from '../../../../daemon/queue/adapters/index.ts';
import type { QueueDelivery } from '../../../../daemon/queue/lib/deliverer.ts';
import type { SessionSendService } from '../../../../daemon/delivery/lib/service.ts';
import {
  SendDraftRefused,
  SendNotReady,
  SendPending,
  type SendRecord,
  SendRefused,
  SendScreenUnreadable,
  type SendTarget,
  SendUnavailable,
  SendUnconfirmed,
} from '../../../../daemon/delivery/lib/types.ts';
import { parseSessionId } from '../../../../daemon/seams/ferret-id.ts';
import { at } from '../../../support/instant.ts';

/**
 * The queue's deliverer over the send path: what each answer of the send service means for a queued
 * message, and the view it reads before typing. The send service and the pane are fakes; nothing here
 * reaches tmux.
 */

const ID = parseSessionId('session-1');
const AT = at('2026-10-30T13:05:37.000Z');

const message = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id: 'q-1',
  sender: 'human',
  text: 'ship it',
  attachmentIds: [],
  enqueuedAt: AT,
  state: 'typing',
  stateAt: AT,
  revision: 1,
  ...overrides,
});

const one = (member: QueuedMessage): QueueDelivery => ({ sendId: member.id, members: [member] });

type SendRequest = Parameters<SessionSendService['send']>[0];

function transport(answer: SendDisposition | Error, records: readonly SendRecord[] = [], untyped = false) {
  const requests: SendRequest[] = [];
  const checked: string[] = [];
  const subject = new SendPathQueueTransport(
    {
      send: async request => {
        requests.push(request);
        if (answer instanceof Error) throw answer;
        return { disposition: answer, record: { untyped } } as unknown as Awaited<
          ReturnType<SessionSendService['send']>
        >;
      },
      finishOwnDraft: async () => ({ kind: 'clear' as const }),
    },
    { list: async () => records },
    { check: async id => void checked.push(id) },
  );
  return { subject, requests, checked };
}

describe('SendPathQueueTransport', () => {
  it('should hand a person’s message over under its own id, as a person’s', async () => {
    const { subject, requests } = transport('delivered');

    should(await subject.handOver(ID, one(message()))).deepEqual({ kind: 'landed' });
    should(requests).deepEqual([{ id: ID, sendId: 'q-1', message: 'ship it' }]);
  });

  it('should hand a ferret’s message over as from that ferret, and the daemon’s as the daemon’s', async () => {
    const peer = transport('queued');
    const daemon = transport('revived');

    await peer.subject.handOver(ID, one(message({ sender: 'agent', from: 'session-2' })));
    await daemon.subject.handOver(ID, one(message({ sender: 'daemon' })));

    should(peer.requests[0]).containEql({ senderReference: 'session-2' });
    should(daemon.requests[0]).containEql({ origin: 'daemon' });
    should(peer.requests[0]).not.have.property('origin');
  });

  it('should hand an interrupt over as the send path’s own stop-then-type', async () => {
    const { subject, requests } = transport('delivered');

    await subject.handOver(ID, one(message({ interrupt: true })));
    await subject.handOver(ID, one(message({ id: 'q-2' })));

    should(requests[0]).containEql({ now: true });
    should(requests[1]).not.have.property('now');
  });

  it('should hand a ferret’s label over with its message, and a question as one that expects a reply', async () => {
    const { subject, requests } = transport('delivered');

    await subject.handOver(
      ID,
      one(message({ sender: 'agent', from: 'session-2', label: 'blocker', replyExpected: true })),
    );

    should(requests[0]).containEql({ label: 'blocker', replyExpected: true, senderReference: 'session-2' });
  });

  it('should hand several ferret messages over as ONE send under the lead id, each member as a part', async () => {
    const { subject, requests } = transport('delivered');
    const first = message({ id: 'q-1', sender: 'agent', from: 'session-2', text: 'one', label: 'action' });
    const second = message({
      id: 'q-2',
      sender: 'agent',
      from: 'session-3',
      text: 'two',
      label: 'fyi',
      attachmentIds: ['a-1'],
    });
    const third = message({
      id: 'q-3',
      sender: 'agent',
      from: 'session-2',
      text: 'three',
      attachmentIds: ['a-1', 'a-2'],
      replyExpected: true,
      interrupt: true,
    });

    should(await subject.handOver(ID, { sendId: 'q-1', members: [first, second, third] })).deepEqual({
      kind: 'landed',
    });

    should(requests).have.length(1);
    should(requests[0]).containEql({
      sendId: 'q-1',
      message: 'one\n\ntwo\n\nthree',
      replyExpected: true,
      now: true,
      senderReference: 'session-2',
      attachmentIds: ['a-1', 'a-2'],
    });
    should((requests[0] as { parts: unknown }).parts).deepEqual([
      { queueId: 'q-1', senderReference: 'session-2', text: 'one', replyExpected: false, label: 'action' },
      { queueId: 'q-2', senderReference: 'session-3', text: 'two', replyExpected: false, label: 'fyi' },
      { queueId: 'q-3', senderReference: 'session-2', text: 'three', replyExpected: true },
    ]);
  });

  it('should keep a combined send free of reply, interrupt and attachment flags nobody set', async () => {
    const { subject, requests } = transport('delivered');
    const first = message({ id: 'q-1', sender: 'agent', from: 'session-2' });
    const second = message({ id: 'q-2', sender: 'agent', from: 'session-3' });

    await subject.handOver(ID, { sendId: 'q-1', members: [first, second] });

    for (const key of ['replyExpected', 'now', 'attachmentIds']) should(requests[0]).not.have.property(key);
  });

  it('should leave an unattributed member out of a combined send’s parts, its text still in the turn', async () => {
    const { subject, requests } = transport('delivered');
    const first = message({ id: 'q-1', sender: 'agent', text: 'one' });
    const second = message({ id: 'q-2', sender: 'agent', from: 'session-3', text: 'two' });

    await subject.handOver(ID, { sendId: 'q-1', members: [first, second] });

    should(requests[0]).containEql({ message: 'one\n\ntwo', senderReference: 'session-3' });
    should(requests[0]?.parts?.map(part => part.queueId)).deepEqual(['q-2']);
  });

  it('should refuse a delivery that carries no message at all', async () => {
    const { subject } = transport('delivered');

    await subject.handOver(ID, { sendId: 'q-1', members: [] }).then(
      () => should.fail('a delivery with no message was handed over', undefined, undefined),
      (error: unknown) => should((error as Error).message).containEql('at least one message'),
    );
  });

  it('should leave a ferret’s message with no sender session unattributed', async () => {
    const { subject, requests } = transport('delivered');

    await subject.handOver(ID, one(message({ sender: 'agent' })));

    should(requests[0]).not.have.property('senderReference');
  });

  it('should call a hand-over the pane has not proven unproven', async () => {
    for (const answer of ['sent', 'queued-for-revive'] as const)
      should(await transport(answer).subject.handOver(ID, one(message()))).deepEqual({ kind: 'unproven' });
    should(
      await transport(new SendUnconfirmed('typed, not shown', 'q-1')).subject.handOver(ID, one(message())),
    ).deepEqual({
      kind: 'unproven',
    });
  });

  it('should call a send the send path kept open, untyped, unproven — whatever its disposition says', async () => {
    // An idle pane's kept send still answers `delivered`: nothing was typed, and the ledger will say when.
    should(await transport('delivered', [], true).subject.handOver(ID, one(message()))).deepEqual({ kind: 'unproven' });
  });

  it('should turn each refusal that typed nothing into the reason the message waits', async () => {
    const cases: Array<[Error, string]> = [
      [new SendDraftRefused('a draft', 'half a question'), 'draft'],
      [new SendScreenUnreadable('could not read'), 'unreadable'],
      [new SendPending('still launching'), 'launching'],
      [new SendUnavailable('a question is open'), 'dialog'],
    ];
    for (const [error, reason] of cases)
      should(await transport(error).subject.handOver(ID, one(message()))).deepEqual({ kind: 'refused', reason });
  });

  it('should wait on a pane that never came to a prompt until one shows (&B153)', async () => {
    for (const reason of ['busy', 'dialog', 'stopped'] as const)
      should(
        await transport(new SendNotReady('the agent never came to a prompt', reason)).subject.handOver(
          ID,
          one(message()),
        ),
      ).deepEqual({ kind: 'refused', reason, untilPrompt: true });
  });

  it('should put a re-look to the send tracker, for the session it names', async () => {
    const { subject, checked } = transport('delivered');

    await subject.recheck(ID);

    should(checked).deepEqual([ID]);
  });

  it('should fail a plain refusal, and pass on what it cannot read', async () => {
    should(
      await transport(new SendRefused('a send requires a message')).subject.handOver(ID, one(message())),
    ).deepEqual({
      kind: 'failed',
      failure: 'a send requires a message',
    });
    const thrown = await transport(new Error('tmux went away'))
      .subject.handOver(ID, one(message()))
      .catch((error: unknown) => (error as Error).message);
    should(thrown).equal('tmux went away');
  });

  it('should read a message’s fate from the send ledger by its id', async () => {
    const record = { sendId: 'q-1', fate: 'queued' } as SendRecord;
    const { subject } = transport('delivered', [{ sendId: 'other', fate: 'delivered' } as SendRecord, record]);

    should(await subject.fate(ID, 'q-1')).equal('queued');
    should(await subject.fate(ID, 'q-9')).be.undefined();
  });

  it('should ask the send path to finish a draft of the session’s own, and pass on what it says (B144)', async () => {
    const { subject } = transport('delivered');

    should(await subject.clearOwnDraft(ID)).deepEqual({ kind: 'clear' });
  });
});

describe('SendPathDeliveryView', () => {
  const target: SendTarget = { id: ID, status: 'running', mode: 'auto', turn: 3 };
  const pane = { alive: true, dead: false, promptReady: false, activeWork: true };

  it('should read the record, a fresh pane and the launch gate together', async () => {
    const view = new SendPathDeliveryView(
      { read: async () => target },
      { observe: async () => pane },
      { launching: () => true },
    );

    should(await view.view(ID)).deepEqual({ target, pane, launching: true });
  });

  it('should refuse a session with no record', async () => {
    const view = new SendPathDeliveryView(
      { read: async () => undefined },
      { observe: async () => pane },
      { launching: () => false },
    );

    const refused = await view.view(ID).catch((error: unknown) => (error as Error).message);

    should(refused).match(/has no record/u);
  });
});
