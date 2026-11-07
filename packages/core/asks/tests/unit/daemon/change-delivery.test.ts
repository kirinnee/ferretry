import { expect, it } from 'bun:test';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import { AskNotTypedError } from '../../../contract/index.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';
import { AgendaRepliesFiles } from '../../../manifest.ts';

const POST = 'POST /v1/ferrets/:ferretId/agenda';
const GET = 'GET /v1/ferrets/:ferretId/agenda';
const params = { ferretId: 'f1' };
const raise = {
  action: 'add',
  title: 'Release unblock',
  subject: 'Which base branch?',
  why: 'The ticket names two.',
  premise: 'A ferret needs the owner.',
  context: 'The work waits.',
  howToResolve: 'Name the branch.',
  ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
};

it('queues an owner answer durably and publishes asks changes after commit', async () => {
  const sent: string[] = [];
  const half = await asksHalf({
    'ask.delivery:ferret': {
      send: async (_ferret: string, message: string) => {
        sent.push(message);
      },
    },
  });
  try {
    expect((await half.call(POST, params, raise, ferretStanding('f1' as never))).status).toBe(200);
    expect(
      (
        await half.call(POST, params, {
          action: 'resolve',
          id: 'A1',
          response: { kind: 'multiple-choice', choice: 'main' },
        })
      ).status,
    ).toBe(200);
    expect((await half.call(GET, params)).json<{ replies?: unknown }>().replies).toBeDefined();
    expect(half.events.filter(event => event.name === 'asks.changed')).toHaveLength(2);
    expect(half.events.filter(event => event.name === 'asks.answered')).toHaveLength(1);
    await half.call('POST /v1/ferrets/:ferretId/agenda/replies', params, {});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('main');
  } finally {
    await half.close();
  }
});

it('retries a committed change whose reply outbox write failed on startup', async () => {
  const half = await asksHalf(
    {},
    {
      wrapState: state => ({
        ...state,
        write: async (file, value, name) => {
          if (file.name === AgendaRepliesFiles.name) throw new Error('synthetic outbox failure');
          return state.write(file, value, name);
        },
      }),
    },
  );
  try {
    await half.call(POST, params, raise, ferretStanding('f1' as never));
    await half.call(POST, params, {
      action: 'resolve',
      id: 'A1',
      response: { kind: 'multiple-choice', choice: 'main' },
    });
    expect((await half.call(GET, params)).json<{ replies?: unknown }>().replies).toBeUndefined();
    const restarted = await half.restart();
    await restarted.clock.advance(2_000);
    await restarted.start();
    expect((await restarted.call(GET, params)).json<{ replies?: unknown }>().replies).toBeDefined();
    expect(restarted.events.some(event => event.name === 'asks.answered')).toBe(true);
    await restarted.close();
  } finally {
    await half.close();
  }
});

it('resumes a held reply outbox after restart without another owner action', async () => {
  const sent: string[] = [];
  let hold = true;
  const half = await asksHalf({
    'ask.delivery:ferret': {
      send: async (_ferret: string, message: string) => {
        if (hold) throw new AskNotTypedError('the ferret is starting');
        sent.push(message);
      },
    },
  });
  try {
    await half.call(POST, params, raise, ferretStanding('f1' as never));
    await half.call(POST, params, {
      action: 'resolve',
      id: 'A1',
      response: { kind: 'multiple-choice', choice: 'main' },
    });
    hold = false;
    const restarted = await half.restart();
    await restarted.clock.advance(60_000);
    await restarted.start();
    await restarted.clock.advance(0);
    for (let attempt = 0; attempt < 100 && sent.length === 0; attempt++) await Bun.sleep(5);
    expect(sent).toHaveLength(1);
    await restarted.close();
  } finally {
    await half.close();
  }
});
