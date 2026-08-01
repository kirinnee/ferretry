import { describe, expect, it } from 'bun:test';
import type { SessionView, UsageFeedView } from '@ferretry/protocol';

import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import { type DaemonUsagePort, DaemonUsageStore, daemonUsagePort, USAGE_POLL_MS } from '../../src/lib/usage-store.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

const feed = (percent: number, agent = 'claude'): UsageFeedView => ({
  at: '2026-08-01T09:00:00.000Z',
  stale: false,
  accounts: [{ agent, fiveHourPercent: percent, weeklyPercent: 10, atLimit: false, authOk: true }],
});

const session = (agent: string): SessionView =>
  ({
    config: { id: 'sess-1', agent, harness: 'claude', cwd: '/repo', mode: 'auto' },
    state: {},
  }) as unknown as SessionView;

const portFor = (answers: Map<string, () => Promise<unknown>>): DaemonUsagePort => ({
  usage: async daemon => {
    const answer = answers.get(daemon.daemonId);
    if (answer === undefined) throw new Error(`no answer for ${daemon.daemonId}`);
    return await answer();
  },
});

const settled = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('DaemonUsageStore', () => {
  it('publishes one slice per daemon and never serves one daemon’s feed under another', async () => {
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => feed(42)],
          [workstation.daemonId, async () => feed(91)],
        ]),
      ),
    );
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().daemons.size));

    expect(await store.refresh(laptop)).toBe(true);
    expect(await store.refresh(workstation)).toBe(true);

    expect(store.usage(laptop.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(42);
    expect(store.usage(workstation.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(91);
    expect(store.quotaFor(laptop.daemonId, session('claude'))?.fiveHourPercent).toBe(42);
    expect(store.quotaFor(workstation.daemonId, session('claude'))?.fiveHourPercent).toBe(91);
    // An agent the other daemon knows is still unknown here.
    expect(store.quotaFor(laptop.daemonId, session('codex'))).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
  });

  it('answers idle before any read and reports the loading pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              await gate;
              return feed(5);
            },
          ],
        ]),
      ),
    );

    expect(store.usage(laptop.daemonId)).toEqual({ feed: null, status: 'idle', error: null });
    const pending = store.refresh(laptop);
    expect(store.usage(laptop.daemonId).status).toBe('loading');
    release();
    expect(await pending).toBe(true);
    expect(store.usage(laptop.daemonId).status).toBe('ready');
  });

  it('keeps the last good feed when a poll fails, and reports the failure', async () => {
    let attempt = 0;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              attempt += 1;
              if (attempt === 1) return feed(20);
              throw new DaemonResponseError(503, 'the fleet feed is unavailable');
            },
          ],
        ]),
      ),
    );

    await store.refresh(laptop);
    expect(await store.refresh(laptop)).toBe(false);

    const slice = store.usage(laptop.daemonId);
    expect(slice.status).toBe('error');
    expect(slice.error).toBe('the fleet feed is unavailable');
    expect(slice.feed?.accounts[0]?.fiveHourPercent).toBe(20);
  });

  it('stringifies a rejection that is not an Error', async () => {
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              throw 'socket closed';
            },
          ],
        ]),
      ),
    );
    await store.refresh(laptop);
    expect(store.usage(laptop.daemonId).error).toBe('socket closed');
  });

  it('treats a malformed feed as a failed read rather than an empty one', async () => {
    let attempt = 0;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              attempt += 1;
              return attempt === 1 ? feed(20) : { stale: 'yes', accounts: 'none' };
            },
          ],
        ]),
      ),
    );

    await store.refresh(laptop);
    expect(await store.refresh(laptop)).toBe(false);
    expect(store.usage(laptop.daemonId).error).toBe('the daemon returned an account feed this client cannot read');
    expect(store.usage(laptop.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(20);
  });

  it('resets the slice on a re-pair and discards the read issued under the old credential', async () => {
    let release!: (value: UsageFeedView) => void;
    const first = new Promise<UsageFeedView>(resolve => {
      release = resolve;
    });
    let call = 0;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              call += 1;
              return call === 1 ? await first : feed(77);
            },
          ],
        ]),
      ),
    );

    const stale = store.refresh(laptop);
    const repaired = { ...laptop, deviceToken: 'token-rotated' };
    expect(await store.refresh(repaired)).toBe(true);
    expect(store.usage(laptop.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(77);

    release(feed(1));
    expect(await stale).toBe(false);
    // The rotated connection's answer stands; the pre-rotation read published nothing.
    expect(store.usage(laptop.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(77);
  });

  it('discards a failure that lands after a re-pair', async () => {
    let reject!: (reason: unknown) => void;
    const first = new Promise<UsageFeedView>((_resolve, onReject) => {
      reject = onReject;
    });
    let call = 0;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              call += 1;
              return call === 1 ? await first : feed(8);
            },
          ],
        ]),
      ),
    );

    const stale = store.refresh(laptop);
    await store.refresh({ ...laptop, baseUrl: 'https://laptop-2.example.test' });
    reject(new Error('the old token was revoked'));
    expect(await stale).toBe(false);
    expect(store.usage(laptop.daemonId).status).toBe('ready');
    expect(store.usage(laptop.daemonId).error).toBeNull();
  });

  it('drops one daemon and leaves the other, and says whether it held anything', async () => {
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [laptop.daemonId, async () => feed(42)],
          [workstation.daemonId, async () => feed(91)],
        ]),
      ),
    );
    await store.refresh(laptop);
    await store.refresh(workstation);

    expect(store.clearDaemon(laptop.daemonId)).toBe(true);
    expect(store.clearDaemon(laptop.daemonId)).toBe(false);
    expect(store.usage(laptop.daemonId)).toEqual({ feed: null, status: 'idle', error: null });
    expect(store.quotaFor(laptop.daemonId, session('claude'))).toBeNull();
    expect(store.usage(workstation.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(91);
  });

  it('unsubscribes a listener', async () => {
    const store = new DaemonUsageStore(portFor(new Map([[laptop.daemonId, async () => feed(42)]])));
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });
    await store.refresh(laptop);
    const afterFirst = calls;
    stop();
    await store.refresh(laptop);
    expect(calls).toBe(afterFirst);
  });
});

describe('DaemonUsageStore.watch', () => {
  it('runs ONE shared timer however many consumers join, and stops with the last', async () => {
    let reads = 0;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              reads += 1;
              return feed(reads);
            },
          ],
        ]),
      ),
      { pollMs: 5, isHidden: () => false },
    );

    const first = store.watch(laptop);
    const second = store.watch(laptop);
    await settled();
    // Two consumers, two immediate reads — but only one interval behind them.
    expect(reads).toBe(2);

    await new Promise(resolve => setTimeout(resolve, 26));
    const polled = reads;
    expect(polled).toBeGreaterThan(2);

    first();
    // The timer belongs to the pair, so releasing one keeps it running.
    await new Promise(resolve => setTimeout(resolve, 16));
    expect(reads).toBeGreaterThan(polled);

    second();
    second(); // idempotent: a double release must not free someone else's hold
    const stopped = reads;
    await new Promise(resolve => setTimeout(resolve, 16));
    expect(reads).toBe(stopped);
  });

  it('does not poll while the tab is hidden', async () => {
    let reads = 0;
    let hidden = true;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              reads += 1;
              return feed(1);
            },
          ],
        ]),
      ),
      { pollMs: 5, isHidden: () => hidden },
    );

    const stop = store.watch(laptop);
    await settled();
    // The first read is unconditional: a consumer that just mounted needs one.
    expect(reads).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 26));
    expect(reads).toBe(1);

    hidden = false;
    await new Promise(resolve => setTimeout(resolve, 26));
    expect(reads).toBeGreaterThan(1);
    stop();
  });

  it('polls with the newest connection after a re-pair', async () => {
    const tokens: string[] = [];
    const store = new DaemonUsageStore(
      {
        usage: async daemon => {
          tokens.push(daemon.deviceToken);
          return feed(3);
        },
      },
      { pollMs: 5, isHidden: () => false },
    );

    const first = store.watch(laptop);
    const second = store.watch({ ...laptop, deviceToken: 'token-rotated' });
    await new Promise(resolve => setTimeout(resolve, 16));
    first();
    second();

    expect(tokens.slice(0, 2)).toEqual(['token-laptop', 'token-rotated']);
    expect(tokens.slice(2).every(token => token === 'token-rotated')).toBe(true);
  });

  it('releasing a daemon that was never watched is a no-op', () => {
    const store = new DaemonUsageStore(portFor(new Map()));
    const stop = store.watch(laptop);
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('defaults to the kteam cadence and the document’s own visibility', () => {
    expect(USAGE_POLL_MS).toBe(60_000);
    const store = new DaemonUsageStore(portFor(new Map([[laptop.daemonId, async () => feed(1)]])));
    const stop = store.watch(laptop);
    stop();
  });
});

describe('daemonUsagePort', () => {
  it('reads /v1/usage from the paired daemon with its device token', async () => {
    let seen = '';
    let authorization = '';
    const port = daemonUsagePort(async (url, init) => {
      seen = String(url);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify(feed(12)), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const value = await port.usage(laptop);
    expect(seen).toBe('https://laptop.example.test/v1/usage');
    expect(authorization).toBe('Bearer token-laptop');
    expect(value).toMatchObject({ stale: false });
  });

  it('raises the daemon error body, and the status when there is none', async () => {
    const withBody = daemonUsagePort(
      async () =>
        new Response(JSON.stringify({ error: 'usage is admin-only', code: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(withBody.usage(laptop)).rejects.toMatchObject({
      status: 403,
      message: 'usage is admin-only',
      code: 'forbidden',
    });

    const bare = daemonUsagePort(async () => new Response('nope', { status: 500 }));
    const failure = await bare.usage(laptop).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(DaemonResponseError);
    expect(failure).toMatchObject({ status: 500, message: 'HTTP 500', code: undefined });
  });
});
