import { describe, it } from 'bun:test';
import type { QueuedMessage, SendResult } from '../../../contract/index.ts';
import should from 'should';
import type { QueueRequest } from '../../../contract/index.ts';
import { QueueingSends } from '../../../daemon/lib/queue/queueing-sends.ts';
import type { SendMessageRequest } from '../../../daemon/lib/delivery/service.ts';
import { SendRefused, SendUnavailable } from '../../../contract/index.ts';
import { parseSessionId, type SessionId } from '../../../contract/index.ts';
import { at } from '../../support/instant.ts';

const ID = parseSessionId('session-1');
const AT = at('2026-10-30T16:30:00.000Z');

const DIRECT: SendResult = { ferret: ID, disposition: 'delivered', sendId: 'n', fate: 'accepted' };

type Mode = 'auto' | 'interactive';

function world(
  mode: Mode | undefined,
  kind: 'human' | 'daemon' = 'daemon',
  options: { readonly refuse?: Error; readonly feature?: string; readonly wakeFails?: boolean } = {},
) {
  const enqueued: QueueRequest[] = [];
  const woken: SessionId[] = [];
  const direct: SendMessageRequest[] = [];
  const timers: { readonly milliseconds: number; cancelled: boolean }[] = [];
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
          if (options.wakeFails === true) throw new Error('busy');
        },
      },
      direct: {
        send: async request => {
          direct.push(request);
          return DIRECT;
        },
        authorize: async () => {
          if (options.refuse !== undefined) throw options.refuse;
        },
      },
      target: async () => (mode === undefined ? undefined : { mode }),
      timer: milliseconds => {
        const timer = { milliseconds, cancelled: false };
        timers.push(timer);
        return {
          done: new Promise<void>(() => undefined),
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
    kind,
    options.feature,
  );
  return { sends, enqueued, woken, direct, timers };
}

describe('a producer sending through the queue', () => {
  it('should enqueue under the request’s own id, wake the deliverer, and leave the answer to the Mailbox', async () => {
    const { sends, enqueued, woken, direct } = world('auto');

    const answered = await sends.send({ id: ID, sendId: 's-1', message: 'your card is stale', attachmentIds: ['a'] });

    should(enqueued).deepEqual([
      { id: 's-1', sender: 'daemon', by: { kind: 'ferretry' }, text: 'your card is stale', attachmentIds: ['a'] },
    ]);
    should(woken).eql([ID]);
    should(direct).be.empty();
    should(answered).be.undefined();
  });

  it('should carry the sender’s label into the queue, which batches and holds by it', async () => {
    const { sends, enqueued } = world('auto', 'human');

    await sends.send({ id: ID, sendId: 'f', message: 'merged', senderReference: 'session-2', label: 'fyi' });

    should(enqueued[0]).containEql({ sender: 'agent', label: 'fyi' });
  });

  it('should place each message by who sent it: the daemon, a ferret, or this producer’s own kind', async () => {
    const owner = world('auto', 'human');

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

  it('should never queue a daemon message into the owner’s own chat', async () => {
    const inChat = world('interactive');

    const answered = await inChat.sends.send({ id: ID, sendId: 'w', message: 'Warden notice' });

    should(inChat.direct.map(request => request.sendId)).eql(['w']);
    should(inChat.enqueued).be.empty();
    should(answered).equal(DIRECT);
  });

  it('should send a board nudge to the owner’s chat as the daemon’s, naming its feature as data', async () => {
    const inChat = world('interactive', 'daemon', { feature: 'Board' });

    await inChat.sends.send({
      id: ID,
      sendId: 'n',
      message: '&F209 PR #1087 CI is red. Fix it, or note on the card why it can stay red.',
    });

    should(inChat.direct).have.length(1);
    should(inChat.direct[0]).containEql({
      sendId: 'n',
      origin: 'daemon',
      by: { kind: 'ferretry', feature: 'Board' },
      message: '&F209 PR #1087 CI is red. Fix it, or note on the card why it can stay red.',
    });
  });

  it('should queue a send that stops the turn first as an interrupt, keeping its place', async () => {
    // `fy send --now` is a flag on a queued message, not a separate path (owner, 2026-10-30).
    const urgent = world('auto', 'human');

    await urgent.sends.send({ id: ID, sendId: 'n', message: 'stop and do this', now: true });

    should(urgent.direct).be.empty();
    should(urgent.enqueued).containDeep([{ id: 'n', interrupt: true }]);
  });

  it('should queue a person’s and a ferret’s message to the owner’s chat as usual', async () => {
    const { sends, enqueued } = world('interactive', 'human');

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
    const { sends, woken } = world('auto', 'daemon', { wakeFails: true });

    // The wake rejects at once, the race is won by it, and the send is still answered.
    should(await sends.send({ id: ID, sendId: 'z', message: 'm' })).be.undefined();
    should(woken).eql([ID]);
  });

  it('should refuse up front what only a person can lift, queueing nothing', async () => {
    // Prose held behind a question the pane may never release would be a message that never arrives.
    const { sends, enqueued } = world('auto', 'human', { refuse: new SendUnavailable('a question is open') });

    const refused = await sends.send({ id: ID, sendId: 'p', message: 'hi' }).catch((error: unknown) => error);

    should(refused).be.instanceof(SendUnavailable);
    should(enqueued).be.empty();
  });

  it('should wait at most 20 s for the first look, and give the timer up the moment the look is back', async () => {
    const { sends, timers } = world('auto', 'human');

    await sends.send({ id: ID, sendId: 's-1', message: 'ship it' });

    should(timers).eql([{ milliseconds: 20_000, cancelled: true }]);
  });

  it('should say who each message is from as data, with the producer’s feature, never as text', async () => {
    // The owner: "there should not be any append or prepend on any feature".
    const requests: QueueRequest[] = [];
    const sends = (kind: 'human' | 'daemon', feature?: string) =>
      new QueueingSends(
        {
          queue: {
            enqueue: async (_id, request) => {
              requests.push(request);
              return {
                message: {
                  v: 1,
                  id: request.id,
                  sender: request.sender,
                  text: request.text,
                  attachmentIds: [],
                  enqueuedAt: AT,
                  state: 'queued',
                  stateAt: AT,
                  revision: 1,
                },
                created: true,
              };
            },
          },
          deliverer: { enqueued: async () => undefined },
          direct: { send: async () => DIRECT, authorize: async () => undefined },
          target: async () => ({ mode: 'auto' }),
          timer: () => ({ done: new Promise<void>(() => undefined), cancel: () => undefined }),
        },
        kind,
        feature,
      );

    await sends('daemon', 'Board').send({ id: ID, sendId: 'b', message: 'your card is stale' });
    await sends('human', 'Agenda').send({ id: ID, sendId: 'a', message: 'yes' });
    await sends('daemon').send({ id: ID, sendId: 'p', message: 'hi', senderReference: 'session-2' });
    await sends('daemon').send({ id: ID, sendId: 'd', message: 'note' });

    should(requests.map(request => request.by)).eql([
      { kind: 'ferretry', feature: 'Board' },
      { kind: 'owner', feature: 'Agenda' },
      { kind: 'ferret' },
      { kind: 'ferretry' },
    ]);
    should(requests.map(request => request.text)).eql(['your card is stale', 'yes', 'hi', 'note']);
  });
});
