import { describe, it } from 'bun:test';
import type { QueuedMessage, SendDisposition } from '@ferretry/protocol';
import should from 'should';
import { SendPathDeliveryView, SendPathQueueTransport } from '../../../../src/adapters/session/queue/index.ts';
import type { SessionSendService } from '../../../../src/lib/session/send/service.ts';
import {
  SendDraftRefused,
  SendPending,
  type SendRecord,
  SendRefused,
  SendScreenUnreadable,
  type SendTarget,
  SendUnavailable,
  SendUnconfirmed,
} from '../../../../src/lib/session/send/types.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

/**
 * The queue's deliverer over the send path: what each answer of the send service means for a queued
 * message, and the view it reads before typing. The send service and the pane are fakes; nothing here
 * reaches tmux.
 */

const ID = parseSessionId('session-1');
const AT = '2026-10-30T13:05:37.000Z';

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

type SendRequest = Parameters<SessionSendService['send']>[0];

function transport(answer: SendDisposition | Error, records: readonly SendRecord[] = [], untyped = false) {
  const requests: SendRequest[] = [];
  const subject = new SendPathQueueTransport(
    {
      send: async request => {
        requests.push(request);
        if (answer instanceof Error) throw answer;
        return { disposition: answer, record: { untyped } } as unknown as Awaited<
          ReturnType<SessionSendService['send']>
        >;
      },
    },
    { list: async () => records },
  );
  return { subject, requests };
}

describe('SendPathQueueTransport', () => {
  it('should hand a person’s message over under its own id, as a person’s', async () => {
    const { subject, requests } = transport('delivered');

    should(await subject.handOver(ID, message())).deepEqual({ kind: 'landed' });
    should(requests).deepEqual([{ id: ID, sendId: 'q-1', message: 'ship it' }]);
  });

  it('should hand a ferret’s message over as from that ferret, and the daemon’s as the daemon’s', async () => {
    const peer = transport('queued');
    const daemon = transport('revived');

    await peer.subject.handOver(ID, message({ sender: 'agent', from: 'session-2' }));
    await daemon.subject.handOver(ID, message({ sender: 'daemon' }));

    should(peer.requests[0]).containEql({ senderReference: 'session-2' });
    should(daemon.requests[0]).containEql({ origin: 'daemon' });
    should(peer.requests[0]).not.have.property('origin');
  });

  it('should hand an interrupt over as the send path’s own stop-then-type', async () => {
    const { subject, requests } = transport('delivered');

    await subject.handOver(ID, message({ interrupt: true }));
    await subject.handOver(ID, message({ id: 'q-2' }));

    should(requests[0]).containEql({ now: true });
    should(requests[1]).not.have.property('now');
  });

  it('should leave a ferret’s message with no sender session unattributed', async () => {
    const { subject, requests } = transport('delivered');

    await subject.handOver(ID, message({ sender: 'agent' }));

    should(requests[0]).not.have.property('senderReference');
  });

  it('should call a hand-over the pane has not proven unproven', async () => {
    for (const answer of ['sent', 'queued-for-revive'] as const)
      should(await transport(answer).subject.handOver(ID, message())).deepEqual({ kind: 'unproven' });
    should(await transport(new SendUnconfirmed('typed, not shown', 'q-1')).subject.handOver(ID, message())).deepEqual({
      kind: 'unproven',
    });
  });

  it('should call a send the send path kept open, untyped, unproven — whatever its disposition says', async () => {
    // An idle pane's kept send still answers `delivered`: nothing was typed, and the ledger will say when.
    should(await transport('delivered', [], true).subject.handOver(ID, message())).deepEqual({ kind: 'unproven' });
  });

  it('should turn each refusal that typed nothing into the reason the message waits', async () => {
    const cases: Array<[Error, string]> = [
      [new SendDraftRefused('a draft', 'half a question'), 'draft'],
      [new SendScreenUnreadable('could not read'), 'unreadable'],
      [new SendPending('still launching'), 'launching'],
      [new SendUnavailable('a question is open'), 'dialog'],
    ];
    for (const [error, reason] of cases)
      should(await transport(error).subject.handOver(ID, message())).deepEqual({ kind: 'refused', reason });
  });

  it('should fail a plain refusal, and pass on what it cannot read', async () => {
    should(await transport(new SendRefused('a send requires a message')).subject.handOver(ID, message())).deepEqual({
      kind: 'failed',
      failure: 'a send requires a message',
    });
    const thrown = await transport(new Error('tmux went away'))
      .subject.handOver(ID, message())
      .catch((error: unknown) => (error as Error).message);
    should(thrown).equal('tmux went away');
  });

  it('should read a message’s fate from the send ledger by its id', async () => {
    const record = { sendId: 'q-1', fate: 'queued' } as SendRecord;
    const { subject } = transport('delivered', [{ sendId: 'other', fate: 'delivered' } as SendRecord, record]);

    should(await subject.fate(ID, 'q-1')).equal('queued');
    should(await subject.fate(ID, 'q-9')).be.undefined();
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
