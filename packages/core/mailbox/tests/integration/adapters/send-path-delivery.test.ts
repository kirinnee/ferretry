import { describe, it } from 'bun:test';
import { AGENT_ORIGIN, PERSON_ORIGIN } from '@ferretry/core-ferrets/contract';
import { ApiError } from '@ferretry/kernel/contract';
import should from 'should';
import {
  type QueuedSend,
  SendPathDeliveryView,
  SendPathQueueTransport,
  typedRequestOf,
} from '../../../daemon/adapters/send-path-delivery.ts';
import type { QueueDelivery } from '../../../daemon/lib/queue/deliverer.ts';
import { SessionSendError } from '../../../daemon/lib/delivery/mounts/session-send.ts';
import type { LedgerRecord, QueuedMessage, SendResult, SendTarget } from '../../../contract/index.ts';
import { NOT_READY_SENTENCES, UnreadableComposer } from '../../../contract/lib/send/harness-seam.ts';
import { parseSessionId } from '../../../contract/index.ts';
import { at } from '../../support/instant.ts';

/**
 * The queue's deliverer over the typing send: what each answer of `typeMessage` means for a queued message, the request a
 * delivery makes of it, and the view the deliverer reads before typing. The typing send and the pane are fakes; nothing
 * here reaches tmux.
 */

const ID = parseSessionId('session-1');
const PEER = parseSessionId('session-2');
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

const sent = (overrides: Partial<SendResult> = {}): SendResult => ({
  ferret: ID,
  disposition: 'sent',
  sendId: 'q-1',
  fate: 'accepted',
  ...overrides,
});

function transport(answer: SendResult | Error, records: readonly LedgerRecord[] = []) {
  const requests: QueuedSend[] = [];
  const checked: string[] = [];
  const subject = new SendPathQueueTransport(
    {
      type: async (_id, request) => {
        requests.push(request);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      finishOwnDraft: async () => ({ kind: 'clear' as const }),
    },
    { list: async () => records },
    { check: async id => void checked.push(id) },
  );
  return { subject, requests, checked };
}

describe('SendPathQueueTransport', () => {
  it('should hand a person’s message over under its own id, as a person’s, with the queue’s entry named as the thing delivered', async () => {
    const { subject, requests } = transport(sent());

    should(await subject.handOver(ID, one(message()))).deepEqual({ kind: 'landed' });
    should(requests).deepEqual([{ sendId: 'q-1', message: 'ship it', origin: PERSON_ORIGIN, queued: true }]);
  });

  it('should hand a ferret’s message over as from that ferret, and the daemon’s as the daemon’s', async () => {
    const peer = transport(sent());
    const daemon = transport(sent());

    await peer.subject.handOver(ID, one(message({ sender: 'agent', from: PEER })));
    await daemon.subject.handOver(ID, one(message({ sender: 'daemon', by: { kind: 'ferretry', feature: 'Board' } })));

    should(peer.requests[0]).containEql({ senderSessionId: PEER, origin: { kind: 'agent', ferret: PEER } });
    should(peer.requests[0]).not.have.property('notice');
    should(daemon.requests[0]).containEql({
      origin: AGENT_ORIGIN,
      notice: true,
      by: { kind: 'ferretry', feature: 'Board' },
    });
    should(daemon.requests[0]).not.have.property('senderSessionId');
  });

  it('should hand the Warden’s and Agenda’s words over as theirs, which the typing send meets differently', async () => {
    const warden = transport(sent());
    const agenda = transport(sent());

    await warden.subject.handOver(ID, one(message({ sender: 'daemon', by: { kind: 'ferretry', feature: 'Warden' } })));
    await agenda.subject.handOver(ID, one(message({ sender: 'daemon', by: { kind: 'ferretry', feature: 'Agenda' } })));

    should(warden.requests[0]).containEql({ warden: true });
    should(warden.requests[0]).not.have.property('notice');
    should(agenda.requests[0]).containEql({ agenda: true });
    should(agenda.requests[0]).not.have.property('notice');
  });

  it('should hand a daemon message with no author over as a plain notice', async () => {
    const { subject, requests } = transport(sent());

    await subject.handOver(ID, one(message({ sender: 'daemon' })));

    should(requests[0]).containEql({ notice: true });
    should(requests[0]).not.have.property('by');
  });

  it('should hand an interrupt over as the send path’s own stop-then-type', async () => {
    const { subject, requests } = transport(sent());

    await subject.handOver(ID, one(message({ interrupt: true })));
    await subject.handOver(ID, one(message({ id: 'q-2' })));

    should(requests[0]).containEql({ now: true });
    should(requests[1]).not.have.property('now');
  });

  it('should hand a ferret’s label over with its message, and a question as one that expects a reply', async () => {
    const { subject, requests } = transport(sent());

    await subject.handOver(ID, one(message({ sender: 'agent', from: PEER, label: 'blocker', replyExpected: true })));

    should(requests[0]).containEql({ label: 'blocker', replyExpected: true, senderSessionId: PEER });
  });

  it('should hand several ferret messages over as ONE send under the lead id, each member as a part', async () => {
    const { subject, requests } = transport(sent());
    const first = message({ id: 'q-1', sender: 'agent', from: PEER, text: 'one', label: 'action' });
    const second = message({ id: 'q-2', sender: 'agent', from: 'session-3', text: 'two', label: 'fyi' });
    const third = message({
      id: 'q-3',
      sender: 'agent',
      from: PEER,
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
      senderSessionId: PEER,
      queued: true,
    });
    should(requests[0]?.parts).deepEqual([
      { queueId: 'q-1', senderReference: PEER, text: 'one', replyExpected: false, label: 'action' },
      { queueId: 'q-2', senderReference: 'session-3', text: 'two', replyExpected: false, label: 'fyi' },
      { queueId: 'q-3', senderReference: PEER, text: 'three', replyExpected: true },
    ]);
  });

  it('should leave a ferret’s message with no sender session unattributed, as a ferret’s still', async () => {
    const { subject, requests } = transport(sent());

    await subject.handOver(ID, one(message({ sender: 'agent' })));

    should(requests[0]).not.have.property('senderSessionId');
    should(requests[0]?.origin).equal(AGENT_ORIGIN);
  });

  it('should refuse a delivery that carries no message at all', async () => {
    const { subject } = transport(sent());

    await subject.handOver(ID, { sendId: 'q-1', members: [] }).then(
      () => should.fail('a delivery with no message was handed over', undefined, undefined),
      (error: unknown) => should((error as Error).message).containEql('at least one message'),
    );
  });

  it('should call a typed, submitted message landed, and one the send path kept open untyped unproven', async () => {
    should(await transport(sent()).subject.handOver(ID, one(message()))).deepEqual({ kind: 'landed' });
    should(
      await transport(sent({ disposition: 'queued', fate: 'queued' })).subject.handOver(ID, one(message())),
    ).deepEqual({ kind: 'landed' });
    // An unreadable box: nothing was typed, the send is kept for the tracker, and the ledger will say when.
    should(
      await transport(sent({ disposition: 'queued', waitReason: 'unreadable' })).subject.handOver(ID, one(message())),
    ).deepEqual({ kind: 'unproven' });
  });

  it('should call a typed send nothing proved unproven, never a failure that would let it be typed again', async () => {
    const unconfirmed = new SessionSendError('unconfirmed', 'typed, not shown', undefined, 'q-1');

    should(await transport(unconfirmed).subject.handOver(ID, one(message()))).deepEqual({ kind: 'unproven' });
  });

  it('should turn each refusal that typed nothing into the reason the message waits', async () => {
    const cases: Array<[Error, string]> = [
      [new SessionSendError('refused', 'a draft', 'half a question'), 'draft'],
      [new UnreadableComposer(), 'unreadable'],
      [new SessionSendError('pending', 'still launching'), 'launching'],
    ];
    for (const [error, reason] of cases)
      should(await transport(error).subject.handOver(ID, one(message()))).deepEqual({ kind: 'refused', reason });
  });

  it('should wait on a pane that never came to a prompt until one shows (&B153)', async () => {
    const cases = [
      ['busy', 'busy'],
      ['dialog', 'dialog'],
      ['exited', 'stopped'],
    ] as const;
    for (const [why, reason] of cases)
      should(
        await transport(new SessionSendError('refused', NOT_READY_SENTENCES[why])).subject.handOver(ID, one(message())),
      ).deepEqual({ kind: 'refused', reason, untilPrompt: true });
  });

  it('should put a re-look to the send tracker, for the session it names', async () => {
    const { subject, checked } = transport(sent());

    await subject.recheck(ID);

    should(checked).deepEqual([ID]);
  });

  it('should fail a plain refusal, and pass on what it cannot read', async () => {
    should(
      await transport(new SessionSendError('refused', 'a send requires a message')).subject.handOver(
        ID,
        one(message()),
      ),
    ).deepEqual({ kind: 'failed', failure: 'a send requires a message' });
    // A runner that is off is no reason to wait: the message fails, and the sender is told which.
    const off = new ApiError(503, 'the runner is off', 'plugin_unavailable');
    for (const error of [new Error('tmux went away'), new SessionSendError('failed', 'could not be written'), off]) {
      const thrown = await transport(error)
        .subject.handOver(ID, one(message()))
        .catch((caught: unknown) => (caught as Error).message);
      should(thrown).equal(error.message);
    }
  });

  it('should read a message’s fate from the send ledger by its id', async () => {
    const record = { sendId: 'q-1', fate: 'queued' } as LedgerRecord;
    const { subject } = transport(sent(), [{ sendId: 'other', fate: 'delivered' } as LedgerRecord, record]);

    should(await subject.fate(ID, 'q-1')).equal('queued');
    should(await subject.fate(ID, 'q-9')).be.undefined();
  });

  it('should ask the send path to finish a draft of the session’s own, and pass on what it says (B144)', async () => {
    const { subject } = transport(sent());

    should(await subject.clearOwnDraft(ID)).deepEqual({ kind: 'clear' });
  });
});

describe('typedRequestOf', () => {
  it('should not carry attachments to the typing send: they were handed to the agent when the message was accepted', () => {
    const request = typedRequestOf(one(message({ attachmentIds: ['a-1'] })));

    should(request).not.have.property('attachmentIds');
  });

  it('should mark a Monitor wake as a notice that never revives, and no other daemon sender as one', () => {
    const wake = typedRequestOf(one(message({ sender: 'daemon', by: { kind: 'ferretry', feature: 'Monitor' } })));
    const board = typedRequestOf(one(message({ sender: 'daemon', by: { kind: 'ferretry', feature: 'Board' } })));

    should(wake).containEql({ notice: true, monitor: true });
    should(board).containEql({ notice: true });
    should(board).not.have.property('monitor');
  });

  it('should leave a combined delivery’s sender to its first part, and an unnamed first part to none', () => {
    const unnamed = typedRequestOf({
      sendId: 'q-1',
      members: [message({ id: 'q-1', sender: 'agent' }), message({ id: 'q-2', sender: 'agent', from: 'session-3' })],
    });

    should(unnamed.senderSessionId).equal('session-3');
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
