import type { QueueAuthor, QueuedMessage, SendResult } from '../../../contract/index.ts';
import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../contract/index.ts';
import { Senders } from '../../../daemon/lib/queue/senders.ts';
import { at } from '../../support/instant.ts';

const ID = parseSessionId('session-1');

/** Which chip and sender a message from each producer is queued under. */
async function queuedFrom(flags: Parameters<Senders['pick']>[0]): Promise<{ by?: QueueAuthor; sender: string }> {
  const seen: { by?: QueueAuthor; sender: string }[] = [];
  const senders = new Senders({
    queue: {
      enqueue: async (_id, request) => {
        seen.push({ ...(request.by === undefined ? {} : { by: request.by }), sender: request.sender });
        const message: QueuedMessage = {
          v: 1,
          id: request.id,
          sender: request.sender,
          text: request.text,
          attachmentIds: [],
          enqueuedAt: at('2026-11-16T18:00:00.000Z'),
          state: 'queued',
          stateAt: at('2026-11-16T18:00:00.000Z'),
          revision: 1,
        };
        return { message, created: true };
      },
    },
    deliverer: { enqueued: async () => undefined },
    direct: { send: async () => ({}) as SendResult, authorize: async () => undefined },
    target: async () => ({ mode: 'auto' }),
    timer: () => ({ done: Promise.resolve(), cancel: () => undefined }),
  });
  await senders
    .pick(flags)
    .send({ id: ID, sendId: 's', message: 'hello', ...(flags.unnamedAgent ? { origin: 'daemon' as const } : {}) });
  return seen[0] as { by?: QueueAuthor; sender: string };
}

describe('the producers that put a message in the queue', () => {
  it.each([
    ['the Warden', { warden: true as const, unnamedAgent: false }, { kind: 'ferretry', feature: 'Warden' }],
    ['Agenda', { agenda: true as const, unnamedAgent: false }, { kind: 'ferretry', feature: 'Agenda' }],
    ['the session monitor', { monitor: true as const, unnamedAgent: false }, { kind: 'ferretry', feature: 'Monitor' }],
    ['the daemon’s notices', { notice: true as const, unnamedAgent: false }, { kind: 'ferretry', feature: 'Delivery' }],
    ['an agent that names no ferret', { unnamedAgent: true }, { kind: 'ferretry' }],
  ])('should chip %s as the daemon’s own', async (_name, flags, by) => {
    const queued = await queuedFrom(flags);

    should(queued.by).eql(by);
    should(queued.sender).equal('daemon');
  });

  it('should leave the owner’s own words the owner’s', async () => {
    const queued = await queuedFrom({ unnamedAgent: false });

    should(queued).eql({ by: { kind: 'owner' }, sender: 'human' });
  });
});
