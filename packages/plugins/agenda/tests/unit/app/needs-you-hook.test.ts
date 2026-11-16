/**
 * `ferrets.needs-you`, PROVIDED by Agenda (S-0486): the ferrets of one machine that have open items waiting on the owner,
 * from the roll-up (`GET /v1/agenda/open`), live while watched, and the same answer as the Inbox's own count (a parked
 * item and a notice wait on nobody).
 */
import { describe, expect, it } from 'bun:test';
import { AsksChanged } from '@ferretry/core-asks/contract';
import { isFerretsNeedsYou } from '@ferretry/core-ferrets/contract';
import { createNeedsYou } from '../../../app/lib/needs-you-hook.ts';
import { callFromFetch } from '../../support/app/call-from-fetch.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const reply = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};
const immediate = {
  now: () => Date.now(),
  schedule: (run: () => void) => {
    setTimeout(run, 0);
    return () => undefined;
  },
};

const scripted = (sessions: () => unknown) => {
  const listeners = new Set<(payload: unknown) => void>();
  let reads = 0;
  const base = callFromFetch(async () => {
    reads += 1;
    return reply({ sessions: sessions() });
  });
  return {
    client: {
      ...base,
      subscribe: ((_event: unknown, listener: (payload: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }) as never,
    },
    announce: () => {
      for (const listener of listeners) listener({});
    },
    reads: () => reads,
    listeners,
  };
};

describe('the ferrets.needs-you provider', () => {
  it('builds a value Ferrets accepts, and reads nothing until something watches', () => {
    const daemon = scripted(() => []);
    const hook = createNeedsYou(daemon.client, immediate);
    expect(isFerretsNeedsYou(hook)).toBe(true);
    expect(hook.needing().size).toBe(0);
    expect(daemon.reads()).toBe(0);
  });

  it('S-0486 says which ferrets wait on the owner, with the count, the ask and when the newest began', async () => {
    const daemon = scripted(() => [
      {
        sessionId: 'asking',
        items: [
          agendaItem('A1', { subject: 'Which branch?', waitingSince: '2026-08-01T10:00:00.000Z' }),
          agendaItem('A2', { waitingSince: '2026-08-01T12:00:00.000Z' }),
        ],
      },
      { sessionId: 'noted', items: [agendaItem('A3', { notice: true })] },
    ]);
    const hook = createNeedsYou(daemon.client, immediate);
    const release = hook.watch();
    await settle();
    expect([...hook.needing().keys()]).toEqual(['asking']);
    expect(hook.needing().get('asking')).toEqual({
      count: 2,
      latestAt: '2026-08-01T12:00:00.000Z',
      ask: 'Which branch?',
    });
    release();
  });

  it('S-0486 tells its listeners when the answer changes, and reads again when an ask changes', async () => {
    let held = [{ sessionId: 'one', items: [agendaItem('A1')] }];
    const daemon = scripted(() => held);
    const hook = createNeedsYou(daemon.client, immediate);
    let heard = 0;
    hook.subscribe(() => {
      heard += 1;
    });
    const release = hook.watch();
    await settle();
    expect([...hook.needing().keys()]).toEqual(['one']);
    const first = hook.needing();
    held = [{ sessionId: 'two', items: [agendaItem('A9')] }];
    daemon.announce();
    await settle();
    expect([...hook.needing().keys()]).toEqual(['two']);
    expect(hook.needing()).not.toBe(first);
    expect(heard).toBeGreaterThanOrEqual(2);
    release();
  });

  it('stops listening for asks when the last watcher lets go', async () => {
    const daemon = scripted(() => []);
    const hook = createNeedsYou(daemon.client, immediate);
    const a = hook.watch();
    const b = hook.watch();
    expect(daemon.listeners.size).toBe(1);
    a();
    a();
    expect(daemon.listeners.size).toBe(1);
    b();
    expect(daemon.listeners.size).toBe(0);
    expect(AsksChanged.name).toBeTruthy();
  });
});
