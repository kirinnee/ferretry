import { describe, expect, it } from 'bun:test';
import type { SessionView, UsageFeedView } from '@ferretry/protocol';

import { useSessionQuota, useUsage, useUsageSlice } from '../../src/hooks/use-usage.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type DaemonUsagePort, DaemonUsageStore } from '../../src/lib/usage-store.ts';
import { interact, mount } from '../support/dom.ts';

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

const feed = (percent: number): UsageFeedView => ({
  at: '2026-08-01T09:00:00.000Z',
  stale: false,
  accounts: [{ agent: 'claude', fiveHourPercent: percent, weeklyPercent: 4, atLimit: false, authOk: true }],
});

const session = (): SessionView =>
  ({
    config: { id: 'sess-1', agent: 'claude', harness: 'claude', cwd: '/repo', mode: 'auto' },
    state: {},
  }) as unknown as SessionView;

const port = (reads: string[]): DaemonUsagePort => ({
  usage: async daemon => {
    reads.push(daemon.daemonId);
    return feed(daemon.daemonId === laptop.daemonId ? 42 : 91);
  },
});

function Percent({ store, daemon }: { readonly store: DaemonUsageStore; readonly daemon: typeof laptop }) {
  const slice = useUsage(store, daemon);
  return <output>{`${slice.status}:${slice.feed?.accounts[0]?.fiveHourPercent ?? '—'}`}</output>;
}

function Passive({ store, daemon }: { readonly store: DaemonUsageStore; readonly daemon: typeof laptop }) {
  const slice = useUsageSlice(store, daemon.daemonId);
  return <output>{`${slice.status}:${slice.feed?.accounts[0]?.fiveHourPercent ?? '—'}`}</output>;
}

function Quota({ store, daemon }: { readonly store: DaemonUsageStore; readonly daemon: typeof laptop }) {
  useUsage(store, daemon);
  const quota = useSessionQuota(store, daemon.daemonId, session());
  return <output>{quota === null ? 'unknown' : `5h ${quota.fiveHourPercent}%`}</output>;
}

describe('useUsage', () => {
  it('joins the store’s poll and renders the daemon’s own feed', async () => {
    const reads: string[] = [];
    const store = new DaemonUsageStore(port(reads), { pollMs: 60_000, isHidden: () => true });
    const { container, unmount } = await mount(<Percent store={store} daemon={laptop} />);

    expect(container.textContent).toBe('ready:42');
    expect(reads).toEqual([laptop.daemonId]);
    await unmount();
  });

  it('re-reads for the other daemon and never shows the first one’s percentage', async () => {
    const reads: string[] = [];
    const store = new DaemonUsageStore(port(reads), { pollMs: 60_000, isHidden: () => true });
    const { container, render, unmount } = await mount(<Percent store={store} daemon={laptop} />);
    expect(container.textContent).toBe('ready:42');

    await render(<Percent store={store} daemon={workstation} />);
    expect(container.textContent).toBe('ready:91');
    expect(reads).toEqual([laptop.daemonId, workstation.daemonId]);
    await unmount();
  });

  it('shares one poll across several mounted consumers', async () => {
    const reads: string[] = [];
    /**
     * Mounting runs inside `act`, which yields to the event loop, so a live 5ms
     * poll can slip a tick between the two mounts and make "one read each" a
     * race the machine's load decides. The store's own gate settles it: the
     * read after `watch()` is unconditional, every TICK waits for a visible tab.
     */
    let hidden = true;
    const store = new DaemonUsageStore(port(reads), { pollMs: 5, isHidden: () => hidden });
    const first = await mount(<Percent store={store} daemon={laptop} />);
    const second = await mount(<Percent store={store} daemon={laptop} />);

    expect(reads).toHaveLength(2);
    hidden = false;
    await interact(async () => await new Promise(resolve => setTimeout(resolve, 26)));
    const polled = reads.length;
    expect(polled).toBeGreaterThan(2);

    await first.unmount();
    await second.unmount();
    const stopped = reads.length;
    await interact(async () => await new Promise(resolve => setTimeout(resolve, 16)));
    expect(reads).toHaveLength(stopped);
  });
});

describe('useUsageSlice', () => {
  it('reads what is already known without asking the daemon for anything', async () => {
    const reads: string[] = [];
    const store = new DaemonUsageStore(port(reads), { pollMs: 60_000, isHidden: () => true });
    const passive = await mount(<Passive store={store} daemon={laptop} />);
    expect(passive.container.textContent).toBe('idle:—');
    expect(reads).toEqual([]);

    const active = await mount(<Percent store={store} daemon={laptop} />);
    expect(passive.container.textContent).toBe('ready:42');
    await active.unmount();
    await passive.unmount();
  });
});

describe('useSessionQuota', () => {
  it('renders unknown before the feed lands and the resolved percentage after', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = new DaemonUsageStore(
      {
        usage: async () => {
          await gate;
          return feed(42);
        },
      },
      { pollMs: 60_000, isHidden: () => true },
    );

    const { container, unmount } = await mount(<Quota store={store} daemon={laptop} />);
    expect(container.textContent).toBe('unknown');

    await interact(async () => {
      release();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('5h 42%');
    await unmount();
  });
});
