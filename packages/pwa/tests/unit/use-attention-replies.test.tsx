import { afterEach, describe, expect, test } from 'bun:test';
import { AttentionRepliesNotice } from '../../src/features/attention/attention-replies-notice.tsx';
import { type RepliesClock, secondsUntil, useAttentionReplies } from '../../src/hooks/use-attention-replies.ts';
import { DaemonAttentionClient } from '../../src/lib/attention-client.ts';
import { DaemonAttentionStore } from '../../src/lib/attention-store.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-1' });
const scope = daemonSessionScope(daemon, 's-1');
const T0 = Date.parse('2026-10-28T12:00:00.000Z');

const board = (replies?: { pending: string[]; dueAt: string }) => ({
  v: 1,
  sessionId: 's-1',
  items: [],
  resolved: [],
  count: 0,
  parseErrors: 0,
  updatedAt: '2026-10-28T12:00:00.000Z',
  ...(replies === undefined ? {} : { replies }),
});

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const fakeClock = () => {
  let now = T0;
  const ticks: Array<() => void> = [];
  const clock: RepliesClock = {
    now: () => now,
    every: tick => {
      ticks.push(tick);
      return () => ticks.splice(ticks.indexOf(tick), 1);
    },
  };
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
      for (const tick of [...ticks]) tick();
    },
  };
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const setup = async (initial: ReturnType<typeof board>) => {
  const calls: Array<{ url: string; method: string }> = [];
  let next = board();
  const client = new DaemonAttentionClient(
    new DaemonAttentionStore(),
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return json(next);
    },
  );
  client.store.applySnapshot(scope, initial);
  const time = fakeClock();
  function Probe() {
    const replies = useAttentionReplies(client, daemon, scope, time.clock);
    return (
      <AttentionRepliesNotice
        ferret="zoe"
        onSendNow={replies.sendNow}
        secondsLeft={replies.secondsLeft}
        sending={replies.sending}
      />
    );
  }
  view = await mount(<Probe />);
  return { calls, time, root: view.container, setNext: (value: ReturnType<typeof board>) => (next = value) };
};

describe('secondsUntil', () => {
  test('rounds up, never goes negative, and tolerates a bad instant', () => {
    expect(secondsUntil('2026-10-28T12:00:07.200Z', T0)).toBe(8);
    expect(secondsUntil('2026-10-28T11:59:00.000Z', T0)).toBe(0);
    expect(secondsUntil('nope', T0)).toBeNull();
  });
});

describe('batched answers notice', () => {
  test('shows nothing when the board carries no replies', async () => {
    const { root } = await setup(board());
    expect(root.querySelector('[data-attention-replies]')).toBeNull();
  });

  test('counts down from dueAt and disappears, re-reading the board once', async () => {
    const { root, time, calls } = await setup(board({ pending: ['A1'], dueAt: '2026-10-28T12:00:08.000Z' }));
    expect(root.textContent).toContain('Sending to zoe in 8 s…');
    await interact(() => time.advance(3000));
    expect(root.textContent).toContain('in 5 s…');
    await interact(() => time.advance(6000));
    expect(root.querySelector('[data-attention-replies]')).toBeNull();
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1);
    await interact(() => time.advance(1000));
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1);
  });

  test('Send now posts to the replies route once and hides the notice', async () => {
    const { root, calls, setNext } = await setup(board({ pending: ['A1'], dueAt: '2026-10-28T12:00:08.000Z' }));
    setNext(board());
    const button = must(root.querySelector<HTMLButtonElement>('[data-attention-send-now]'), 'send now');
    await interact(() => button.click());
    const posts = calls.filter(call => call.method === 'POST');
    expect(posts).toEqual([{ url: 'https://studio.example.test/v1/sessions/s-1/attention/replies', method: 'POST' }]);
    expect(root.querySelector('[data-attention-replies]')).toBeNull();
  });
});

describe('browserRepliesClock', () => {
  test('reads the wall clock and ticks until cancelled', async () => {
    const { browserRepliesClock } = await import('../../src/hooks/use-attention-replies.ts');
    expect(Math.abs(browserRepliesClock.now() - Date.now())).toBeLessThan(1_000);
    let ticks = 0;
    const stop = browserRepliesClock.every(() => (ticks += 1), 5);
    await new Promise(done => setTimeout(done, 40));
    stop();
    const seen = ticks;
    expect(seen).toBeGreaterThan(0);
    await new Promise(done => setTimeout(done, 30));
    expect(ticks).toBe(seen);
  });
});
