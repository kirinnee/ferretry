import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import {
  type QueueRequest,
  QueueingSends,
  type SendMessageRequest,
  type SendOutcome,
  type SendRecord,
  SendRefused,
  type SendTarget,
  SendUnavailable,
} from '../../../../src/lib/index.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const AT = '2026-10-30T16:30:00.000Z';

function world(
  target: SendTarget | undefined,
  kind: 'human' | 'daemon' = 'daemon',
  options: { readonly refuse?: Error; readonly ledger?: readonly SendRecord[] } = {},
) {
  const enqueued: QueueRequest[] = [];
  const woken: SessionId[] = [];
  const direct: SendMessageRequest[] = [];
  const sends = new QueueingSends(
    {
      queue: {
        enqueue: async (_id, request) => {
          enqueued.push(request);
          const message: QueuedMessage = {
            v: 1,
            id: request.id,
            sender: request.sender,
            text: request.text,
            attachmentIds: [...(request.attachmentIds ?? [])],
            enqueuedAt: AT,
            state: 'queued',
            stateAt: AT,
            revision: 1,
          };
          return { message, created: true };
        },
      },
      deliverer: {
        enqueued: async id => {
          woken.push(id);
        },
      },
      direct: {
        send: async request => {
          direct.push(request);
          return { disposition: 'delivered' } as SendOutcome;
        },
        authorize: async () => {
          if (options.refuse !== undefined) throw options.refuse;
        },
      },
      target: async () => target,
      ledger: { list: async () => options.ledger ?? [] },
      clock: { now: () => AT },
      sleep: async () => undefined,
    },
    kind,
  );
  return { sends, enqueued, woken, direct };
}

const auto: SendTarget = { id: ID, status: 'running', mode: 'auto', turn: 7 };
const chat: SendTarget = { ...auto, mode: 'interactive' };

describe('a producer sending through the queue', () => {
  it('should enqueue under the request’s own id, wake the deliverer, and answer queued at once', async () => {
    const { sends, enqueued, woken, direct } = world(auto);

    const outcome = await sends.send({ id: ID, sendId: 's-1', message: 'your card is stale', attachmentIds: ['a'] });

    should(enqueued).deepEqual([{ id: 's-1', sender: 'daemon', text: 'your card is stale', attachmentIds: ['a'] }]);
    should(woken).eql([ID]);
    should(direct).be.empty();
    should(outcome.disposition).equal('queued');
    should(outcome.record).containEql({ sendId: 's-1', fate: 'accepted', acceptedTurn: 7, senderKind: 'daemon' });
  });

  it('should place each message by who sent it: the daemon, a ferret, or this producer’s own kind', async () => {
    const owner = world(auto, 'human');

    await owner.sends.send({ id: ID, sendId: 'a', message: 'yes, ship it' });
    await owner.sends.send({ id: ID, sendId: 'b', message: 'note', origin: 'daemon' });
    await owner.sends.send({
      id: ID,
      sendId: 'c',
      message: 'done?',
      senderReference: 'session-2',
      replyExpected: true,
    });

    should(owner.enqueued.map(request => request.sender)).eql(['human', 'daemon', 'agent']);
    should(owner.enqueued[2]).containEql({ from: 'session-2', replyExpected: true });
    should(owner.enqueued[0]).not.have.property('from');
  });

  it('should never queue a daemon message into the owner’s own chat, nor a send that stops the turn first', async () => {
    const inChat = world(chat);
    const urgent = world(auto, 'human');

    await inChat.sends.send({ id: ID, sendId: 'w', message: 'Warden notice' });
    await urgent.sends.send({ id: ID, sendId: 'n', message: 'stop and do this', now: true });

    should(inChat.direct.map(request => request.sendId)).eql(['w']);
    should(urgent.direct.map(request => request.sendId)).eql(['n']);
    should([...inChat.enqueued, ...urgent.enqueued]).be.empty();
  });

  it('should queue a person’s and a ferret’s message to the owner’s chat as usual', async () => {
    const { sends, enqueued } = world(chat, 'human');

    await sends.send({ id: ID, sendId: 'p', message: 'hello' });

    should(enqueued.map(request => request.id)).eql(['p']);
  });

  it('should refuse a session that does not exist, queueing nothing', async () => {
    const { sends, enqueued } = world(undefined);

    const refused = await sends.send({ id: ID, sendId: 'x', message: 'hi' }).catch((error: unknown) => error);

    should(refused).be.instanceof(SendRefused);
    should(enqueued).be.empty();
  });

  it('should not fail the send when waking the deliverer fails: it is on disk, and the next look finds it', async () => {
    const message: QueuedMessage = {
      v: 1,
      id: 'z',
      sender: 'daemon',
      text: 'm',
      attachmentIds: [],
      enqueuedAt: AT,
      state: 'queued',
      stateAt: AT,
      revision: 1,
    };
    const sends = new QueueingSends(
      {
        queue: { enqueue: async () => ({ message, created: true }) },
        deliverer: { enqueued: async () => Promise.reject(new Error('busy')) },
        direct: { send: async () => ({ disposition: 'delivered' }) as SendOutcome, authorize: async () => undefined },
        target: async () => auto,
        ledger: { list: async () => [] },
        clock: { now: () => AT },
        sleep: async () => undefined,
      },
      'daemon',
    );

    should((await sends.send({ id: ID, sendId: 'z', message: 'm' })).disposition).equal('queued');
  });

  it('should refuse up front what only a person can lift, queueing nothing', async () => {
    // Prose held behind a question the pane may never release would be a message that never arrives.
    const { sends, enqueued } = world(auto, 'human', { refuse: new SendUnavailable('a question is open') });

    const refused = await sends.send({ id: ID, sendId: 'p', message: 'hi' }).catch((error: unknown) => error);

    should(refused).be.instanceof(SendUnavailable);
    should(enqueued).be.empty();
  });

  it('should answer what the hand-over did once the first look typed it, as the direct path did', async () => {
    const handed = {
      sendId: 's-1',
      acceptedAt: AT,
      acceptedTurn: 7,
      path: 'turn-file',
      message: 'ship it',
      fate: 'accepted',
    } satisfies SendRecord;
    const { sends } = world(auto, 'human', { ledger: [handed] });

    const outcome = await sends.send({ id: ID, sendId: 's-1', message: 'ship it' });

    should(outcome.disposition).equal('delivered');
    should(outcome.record).equal(handed);
  });
});
