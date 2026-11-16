import { describe, expect, it } from 'bun:test';
import type { UsageFeedView } from '../../../contract/index.ts';

import { fakeClient, refusingClient } from './support/client.ts';
import { DaemonResponseError } from './support/shell.ts';
import { daemonConnection } from './support/shell.ts';
import {
  type DaemonUsagePort,
  DaemonUsageStore,
  daemonUsagePort,
  USAGE_POLL_MS,
} from '../../../app/lib/usage-store.ts';
import type { QuotaSubject } from '../../../app/lib/usage.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceId: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceId: 'token-workstation',
});

const feed = (percent: number, agent = 'claude'): UsageFeedView => ({
  at: '2026-08-01T09:00:00.000Z',
  stale: false,
  accounts: [{ agent, fiveHourPercent: percent, weeklyPercent: 10, atLimit: false, authOk: true }],
});

/** A session carrying only the identity the quota join reads. */
const session = (agent: string): QuotaSubject =>
  ({ config: { id: 'sess-1', agent }, state: {} }) as unknown as QuotaSubject;

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

  it('drops the slice when the daemon is cleared and discards the read issued before', async () => {
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
    store.clearDaemon(laptop.daemonId);
    expect(await store.refresh(laptop)).toBe(true);
    expect(store.usage(laptop.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(77);

    release(feed(1));
    expect(await stale).toBe(false);
    // The newer answer stands; the read issued before the clear published nothing.
    expect(store.usage(laptop.daemonId).feed?.accounts[0]?.fiveHourPercent).toBe(77);
  });

  it('discards a failure that lands after the daemon was cleared', async () => {
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
    store.clearDaemon(laptop.daemonId);
    await store.refresh(laptop);
    reject(new Error('the old read failed'));
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
    // Two consumers share ONE immediate read — and only one interval behind it.
    expect(reads).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 26));
    const polled = reads;
    expect(polled).toBeGreaterThan(1);

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

  it('reads once for a whole list of rows watching one daemon, not once per row', async () => {
    let reads = 0;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              reads += 1;
              return feed(40);
            },
          ],
        ]),
      ),
      { isHidden: () => false },
    );
    // Every row builds its OWN `{ daemonId }` (`useDaemonConnection` memoises per component): distinct objects.
    const releases = Array.from({ length: 25 }, () => store.watch({ daemonId: 'daemon/laptop' }));
    await settled();
    expect(reads).toBe(1);
    expect(store.usage(laptop.daemonId).status).toBe('ready');
    // A row that mounts later joins the answer already held: no new read.
    releases.push(store.watch({ daemonId: 'daemon/laptop' }));
    await settled();
    expect(reads).toBe(1);
    for (const release of releases) release();
  });

  it('reads once per daemon: two daemons watched by distinct objects make two reads', async () => {
    const reads: string[] = [];
    const answer = (id: string) => async () => {
      reads.push(id);
      return feed(40);
    };
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [laptop.daemonId, answer(laptop.daemonId)],
          [workstation.daemonId, answer(workstation.daemonId)],
        ]),
      ),
      { isHidden: () => false },
    );
    const releases = [
      ...Array.from({ length: 5 }, () => store.watch({ daemonId: laptop.daemonId })),
      ...Array.from({ length: 5 }, () => store.watch({ daemonId: workstation.daemonId })),
    ];
    await settled();
    expect([...reads].sort()).toEqual([laptop.daemonId, workstation.daemonId]);
    for (const release of releases) release();
  });

  it('reads again for the next joiner after the daemon is cleared, and not before', async () => {
    let reads = 0;
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              reads += 1;
              return feed(40);
            },
          ],
        ]),
      ),
      { isHidden: () => false },
    );
    const held = store.watch({ daemonId: laptop.daemonId });
    await settled();
    expect(reads).toBe(1);
    store.clearDaemon(laptop.daemonId); // the shell dropped this daemon's feed (unpair / reconnect)
    const joined = store.watch({ daemonId: laptop.daemonId });
    await settled();
    expect(reads).toBe(2);
    expect(store.usage(laptop.daemonId).status).toBe('ready');
    held();
    joined();
  });

  it('a rebuilt half is a new store and reads again', async () => {
    let reads = 0;
    const port = portFor(
      new Map([
        [
          laptop.daemonId,
          async () => {
            reads += 1;
            return feed(40);
          },
        ],
      ]),
    );
    const first = new DaemonUsageStore(port, { isHidden: () => false });
    const stopFirst = first.watch({ daemonId: laptop.daemonId });
    await settled();
    const rebuilt = new DaemonUsageStore(port, { isHidden: () => false });
    const stopRebuilt = rebuilt.watch({ daemonId: laptop.daemonId });
    await settled();
    expect(reads).toBe(2);
    stopFirst();
    stopRebuilt();
  });

  it('joins a read still in flight when the rows remount, and a newer connection object for the same daemon is not a reconnect', async () => {
    let reads = 0;
    const finishers: (() => void)[] = [];
    const store = new DaemonUsageStore(
      portFor(
        new Map([
          [
            laptop.daemonId,
            async () => {
              reads += 1;
              await new Promise<void>(done => {
                finishers.push(done);
              });
              return feed(40);
            },
          ],
        ]),
      ),
      { isHidden: () => false },
    );
    store.watch(laptop)(); // the rows unmount mid-read ...
    store.watch(laptop)(); // ... and mount again: the same read
    expect(reads).toBe(1);
    const held = store.watch(laptop);
    const repaired = daemonConnection({ daemonId: laptop.daemonId, baseUrl: 'https://laptop-2.example.test' });
    const next = store.watch(repaired); // a new object with the same daemonId joins the read in flight
    expect(reads).toBe(1);
    expect(finishers).toHaveLength(1);
    finishers[0]?.();
    await settled();
    expect(store.usage(laptop.daemonId).status).toBe('ready');
    expect(reads).toBe(1);
    held();
    next();
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

  it('releasing a daemon that was never watched is a no-op', () => {
    const store = new DaemonUsageStore(portFor(new Map()));
    const stop = store.watch(laptop);
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('defaults to its two-minute cadence and the document’s own visibility', () => {
    expect(USAGE_POLL_MS).toBe(120_000);
    const store = new DaemonUsageStore(portFor(new Map([[laptop.daemonId, async () => feed(1)]])));
    const stop = store.watch(laptop);
    stop();
  });
});

describe('daemonUsagePort', () => {
  it('reads GET /v1/usage through the daemon client', async () => {
    const client = fakeClient({ 'GET /v1/usage': feed(12) });
    const value = await daemonUsagePort(client).usage(laptop);

    expect(client.calls.map(call => call.route)).toEqual(['GET /v1/usage']);
    expect(value).toMatchObject({ stale: false });
  });

  it('raises the daemon refusal as the client threw it', async () => {
    const refused = daemonUsagePort(refusingClient(403, 'forbidden', 'usage is admin-only'));
    await expect(refused.usage(laptop)).rejects.toMatchObject({
      status: 403,
      message: 'usage is admin-only',
      code: 'forbidden',
    });
  });
});
