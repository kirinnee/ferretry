import { expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { QueueChanged } from '@ferretry/core-mailbox/contract';
import mailboxDaemon from '@ferretry/core-mailbox/daemon';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { StateQueueStore } from '../../../daemon/queue/adapters/index.ts';
import { memoryStatePort } from '../../support/state.ts';

/**
 * THE TWO REAL HALVES BOOTED TOGETHER, as the daemon boots them: the Mailbox (the queue's one writer) over the files
 * Conversation keeps. A change through the port and a change through the route are each announced once, and what they
 * wrote reads back through a fresh store over the same files — so the Mailbox writes where Conversation reads.
 */
const F1 = ferretId('f1');
const AT = '2026-11-08T09:00:00.000Z' as Instant;

test('an edit through the port and a PATCH through the route each publish one queue-changed, and a fresh store reads both back', async () => {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1, state: 'idle' });
  const files = memoryStatePort(CONVERSATION_STATE);
  const conversation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state: files } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [mailboxDaemon, conversation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-08T09:00:00Z'),
  });
  const queued = (id: string) => ({
    v: 1 as const,
    kind: 'enqueued' as const,
    at: AT,
    message: {
      v: 1 as const,
      id,
      sender: 'human' as const,
      text: 'wait',
      attachmentIds: [],
      enqueuedAt: AT,
      state: 'queued' as const,
      stateAt: AT,
      revision: 1,
    },
  });
  await new StateQueueStore(files).append(F1, queued('q-1'));
  await new StateQueueStore(files).append(F1, queued('q-2'));
  const announced = () => host.published.filter(entry => entry.event === QueueChanged.name);

  const edited = await host.provided(ConversationPort).editQueued(F1, 'q-1', { text: 'by the port' });
  expect(edited).toMatchObject({ ok: true, value: { id: 'q-1', text: 'by the port' } });
  expect(announced()).toHaveLength(1);

  const patched = await host.request('PATCH', '/v1/ferrets/f1/queue/q-2', {
    as: owner(),
    body: { text: 'by the route' },
  });
  expect(patched.status).toBe(200);
  expect(announced()).toHaveLength(2);

  const fresh = await new StateQueueStore(files).messages(F1);
  expect(fresh.map(message => [message.id, message.text])).toEqual([
    ['q-1', 'by the port'],
    ['q-2', 'by the route'],
  ]);
  await host.stop();
});
