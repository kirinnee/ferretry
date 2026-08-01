import { describe, expect, it } from 'bun:test';
import type { BrowserAction, BrowserActionResult, BrowserStatus } from '@ferretry/protocol';
import { useMemo } from 'react';
import {
  REMOTE_BROWSER_POLL_MS,
  type RemoteBrowserModel,
  type RemoteBrowserScheduler,
  type RemoteBrowserTransport,
  useRemoteBrowser,
} from '../../src/hooks/use-remote-browser.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { render, run, runAsync } from '../support/react.ts';

const daemonA = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});
const daemonB = daemonConnection({
  daemonId: 'daemon-b',
  baseUrl: 'https://b.example.test',
  deviceToken: 'token-b',
});

const statusFor = (sessionId: string, state: 'stopped' | 'running' = 'stopped'): BrowserStatus =>
  ({
    sessionId,
    state,
    pages: [],
    viewport: { width: 320, height: 240 },
    viewers: 0,
    persistentProfile: true,
    idleTimeoutSeconds: 60,
    capacity: { running: 0, maximum: 3 },
  }) as BrowserStatus;

/** A scheduler whose tick the test fires by hand, so no wall clock is involved. */
const manualScheduler = () => {
  const ticks: (() => void)[] = [];
  let cancelled = 0;
  const schedule: RemoteBrowserScheduler = callback => {
    ticks.push(callback);
    return () => {
      cancelled += 1;
    };
  };
  return {
    schedule,
    tick: () => ticks.at(-1)?.(),
    get cancelled() {
      return cancelled;
    },
  };
};

interface Harness {
  readonly model: () => RemoteBrowserModel;
  readonly setDaemon: (daemon: DaemonConnection) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

const mount = (
  transport: RemoteBrowserTransport,
  schedule: RemoteBrowserScheduler,
  initial: DaemonConnection = daemonA,
  sessionId = 'session-1',
): Harness => {
  let latest: RemoteBrowserModel | undefined;
  function Probe({ daemon }: { readonly daemon: DaemonConnection }) {
    const scope = useMemo(() => daemonSessionScope(daemon, sessionId), [daemon]);
    latest = useRemoteBrowser({ daemon, scope, transport, schedule });
    return null;
  }
  const renderer = render(<Probe daemon={initial} />);
  return {
    model: () => {
      if (latest === undefined) throw new Error('the hook did not run');
      return latest;
    },
    setDaemon: async daemon => {
      await runAsync(async () => {
        renderer.update(<Probe daemon={daemon} />);
      });
    },
    unmount: async () => {
      await runAsync(async () => {
        renderer.unmount();
      });
    },
  };
};

const settle = () =>
  runAsync(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('useRemoteBrowser', () => {
  it('reads the paired daemon on mount and again on every scheduled tick', async () => {
    const reads: string[] = [];
    const clock = manualScheduler();
    const harness = mount(
      {
        readStatus: async (daemon, scope) => {
          reads.push(`${daemon.daemonId}/${scope.sessionId}`);
          return statusFor(scope.sessionId);
        },
        runAction: async () => ({ status: statusFor('session-1') }) as BrowserActionResult,
      },
      clock.schedule,
    );
    await settle();
    expect(reads).toEqual(['daemon-a/session-1']);
    expect(harness.model().status?.sessionId).toBe('session-1');
    run(() => clock.tick());
    await settle();
    expect(reads).toHaveLength(2);
  });

  it('drops a daemon-a response that lands after the pane re-scopes to daemon b', async () => {
    const pending: ((status: BrowserStatus) => void)[] = [];
    const clock = manualScheduler();
    const harness = mount(
      {
        readStatus: (daemon, scope) =>
          new Promise<BrowserStatus>(resolve =>
            pending.push(() => resolve({ ...statusFor(scope.sessionId, 'running'), sessionId: daemon.daemonId })),
          ),
        runAction: async () => ({ status: statusFor('session-1') }) as BrowserActionResult,
      },
      clock.schedule,
    );
    await settle();
    await harness.setDaemon(daemonB);
    // Re-scoping blanks the snapshot before daemon B has answered anything.
    expect(harness.model().status).toBeNull();
    // Daemon A finally answers. It must not land on daemon B's screen.
    run(() => pending[0]?.(statusFor('session-1')));
    await settle();
    expect(harness.model().status).toBeNull();
    run(() => pending[1]?.(statusFor('session-1')));
    await settle();
    expect(harness.model().status?.sessionId).toBe('daemon-b');
  });

  it('lets a mutation result win over the poll that is already in flight', async () => {
    const clock = manualScheduler();
    const actions: BrowserAction[] = [];
    let readCount = 0;
    const harness = mount(
      {
        readStatus: async () => {
          readCount += 1;
          return statusFor('polled');
        },
        runAction: async (_daemon, _scope, action) => {
          actions.push(action);
          return { status: statusFor('mutated', 'running') } as BrowserActionResult;
        },
      },
      clock.schedule,
    );
    await settle();
    let busySeen = false;
    run(() => {
      harness.model().runAction({ action: 'start' });
      busySeen = true;
    });
    // A poll firing mid-mutation is skipped rather than racing the newer answer.
    const before = readCount;
    run(() => clock.tick());
    expect(readCount).toBe(before);
    await settle();
    expect(busySeen).toBe(true);
    expect(actions).toEqual([{ action: 'start' }]);
    expect(harness.model().status?.sessionId).toBe('mutated');
    expect(harness.model().busy).toBe(false);
    // Polling resumes once the mutation has settled.
    run(() => clock.tick());
    await settle();
    expect(readCount).toBe(before + 1);
  });

  it('surfaces a transport failure and a daemon-reported error state', async () => {
    const clock = manualScheduler();
    const harness = mount(
      {
        readStatus: async () => {
          throw new Error('daemon unreachable');
        },
        runAction: async () =>
          ({ status: { ...statusFor('s'), state: 'error', error: 'chrome would not launch' } }) as BrowserActionResult,
      },
      clock.schedule,
    );
    await settle();
    expect(harness.model().error).toBe('daemon unreachable');
    run(() => harness.model().runAction({ action: 'start' }));
    await settle();
    expect(harness.model().error).toBe('chrome would not launch');
    run(() => harness.model().clearError());
    expect(harness.model().error).toBeNull();
    run(() => harness.model().reportError('clipboard was blocked'));
    expect(harness.model().error).toBe('clipboard was blocked');
  });

  it('reports a non-Error rejection rather than swallowing it', async () => {
    const clock = manualScheduler();
    const harness = mount(
      {
        readStatus: () => Promise.reject('offline'),
        runAction: async () => ({ status: statusFor('s') }) as BrowserActionResult,
      },
      clock.schedule,
    );
    await settle();
    expect(harness.model().error).toBe('offline');
  });

  it('keeps a rejected mutation from stranding the busy flag', async () => {
    const clock = manualScheduler();
    const harness = mount(
      {
        readStatus: async () => statusFor('s'),
        runAction: async () => {
          throw new Error('capacity');
        },
      },
      clock.schedule,
    );
    await settle();
    run(() => harness.model().runAction({ action: 'start' }));
    await settle();
    expect(harness.model().busy).toBe(false);
    expect(harness.model().error).toBe('capacity');
  });

  it('stays busy until the last of several concurrent mutations settles', async () => {
    const clock = manualScheduler();
    const resolvers: (() => void)[] = [];
    const harness = mount(
      {
        readStatus: async () => statusFor('s'),
        runAction: () =>
          new Promise<BrowserActionResult>(resolve =>
            resolvers.push(() => resolve({ status: statusFor('s') } as BrowserActionResult)),
          ),
      },
      clock.schedule,
    );
    await settle();
    run(() => harness.model().runAction({ action: 'start' }));
    run(() => harness.model().runAction({ action: 'reload' }));
    expect(harness.model().busy).toBe(true);
    run(() => resolvers[0]?.());
    await settle();
    expect(harness.model().busy).toBe(true);
    run(() => resolvers[1]?.());
    await settle();
    expect(harness.model().busy).toBe(false);
  });

  it('does not let a stale daemon-a mutation finally clear daemon-b busy', async () => {
    const clock = manualScheduler();
    // Each runAction hands back a promise the test resolves by hand, in order.
    const pending: Array<{
      readonly resolve: (result: BrowserActionResult) => void;
      readonly reject: (error: unknown) => void;
    }> = [];
    const harness = mount(
      {
        readStatus: async () => statusFor('s'),
        runAction: () =>
          new Promise<BrowserActionResult>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      },
      clock.schedule,
    );
    await settle();
    // Daemon A mutation goes in flight.
    run(() => harness.model().runAction({ action: 'start' }));
    expect(harness.model().busy).toBe(true);
    // Pane re-scopes to daemon B while A is still pending.
    await harness.setDaemon(daemonB);
    expect(harness.model().busy).toBe(false);
    // Daemon B mutation goes in flight.
    run(() => harness.model().runAction({ action: 'reload' }));
    expect(harness.model().busy).toBe(true);
    // A resolves late. Its finally must not touch B's mutation accounting.
    run(() => pending[0]?.resolve({ status: statusFor('daemon-a', 'running') } as BrowserActionResult));
    await settle();
    expect(harness.model().busy).toBe(true);
    // A's late result is fenced off B's screen as well.
    expect(harness.model().status?.sessionId).not.toBe('daemon-a');
    // B resolves. Only now does busy clear, and B's result wins.
    run(() => pending[1]?.resolve({ status: statusFor('daemon-b', 'running') } as BrowserActionResult));
    await settle();
    expect(harness.model().busy).toBe(false);
    expect(harness.model().status?.sessionId).toBe('daemon-b');
  });

  it('does not let a stale daemon-a mutation rejection clear daemon-b busy', async () => {
    const clock = manualScheduler();
    const pending: Array<{
      readonly resolve: (result: BrowserActionResult) => void;
      readonly reject: (error: unknown) => void;
    }> = [];
    const harness = mount(
      {
        readStatus: async () => statusFor('s'),
        runAction: () =>
          new Promise<BrowserActionResult>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      },
      clock.schedule,
    );
    await settle();
    run(() => harness.model().runAction({ action: 'start' }));
    await harness.setDaemon(daemonB);
    run(() => harness.model().runAction({ action: 'reload' }));
    expect(harness.model().busy).toBe(true);
    // A rejects late. The shared finally path must stay scope-safe here too,
    // and the fenced fail() must not surface A's error on B's screen.
    run(() => pending[0]?.reject(new Error('daemon-a gone')));
    await settle();
    expect(harness.model().busy).toBe(true);
    expect(harness.model().error).toBeNull();
    run(() => pending[1]?.resolve({ status: statusFor('daemon-b', 'running') } as BrowserActionResult));
    await settle();
    expect(harness.model().busy).toBe(false);
  });

  it('does not confuse a stale mutation with the same daemon after an a-b-a rescope', async () => {
    const clock = manualScheduler();
    const pending: Array<(result: BrowserActionResult) => void> = [];
    const harness = mount(
      {
        readStatus: async () => statusFor('s'),
        runAction: () =>
          new Promise<BrowserActionResult>(resolve => {
            pending.push(resolve);
          }),
      },
      clock.schedule,
    );
    await settle();
    run(() => harness.model().runAction({ action: 'start' }));
    await harness.setDaemon(daemonB);
    await harness.setDaemon(daemonA);
    run(() => harness.model().runAction({ action: 'reload' }));
    expect(harness.model().busy).toBe(true);

    // String identity alone would call both launches "daemon-a/session-1" and
    // let the first finalizer settle the second. The scope epoch distinguishes
    // the two visits even though their public identity is deliberately equal.
    run(() => pending[0]?.({ status: statusFor('old-daemon-a', 'running') } as BrowserActionResult));
    await settle();
    expect(harness.model().busy).toBe(true);
    expect(harness.model().status?.sessionId).not.toBe('old-daemon-a');
    run(() => pending[1]?.({ status: statusFor('new-daemon-a', 'running') } as BrowserActionResult));
    await settle();
    expect(harness.model().busy).toBe(false);
    expect(harness.model().status?.sessionId).toBe('new-daemon-a');
  });

  it('detaches while inactive and cancels the poll on unmount', async () => {
    const clock = manualScheduler();
    let readCount = 0;
    const transport: RemoteBrowserTransport = {
      readStatus: async () => {
        readCount += 1;
        return statusFor('s');
      },
      runAction: async () => ({ status: statusFor('s') }) as BrowserActionResult,
    };
    const scope = daemonSessionScope(daemonA, 's');
    let latest: RemoteBrowserModel | undefined;
    function Probe({ isActive }: { readonly isActive: boolean }) {
      latest = useRemoteBrowser({ daemon: daemonA, scope, isActive, transport, schedule: clock.schedule });
      return null;
    }
    const renderer = render(<Probe isActive={false} />);
    await settle();
    expect(readCount).toBe(0);
    expect(latest?.status).toBeNull();
    await runAsync(async () => {
      renderer.update(<Probe isActive />);
    });
    await settle();
    expect(readCount).toBe(1);
    await runAsync(async () => {
      renderer.unmount();
    });
    expect(clock.cancelled).toBe(1);
    // The default poll interval is the one kteam's pane used.
    expect(REMOTE_BROWSER_POLL_MS).toBe(2_500);
  });

  it('arms and cancels a real interval when no scheduler is injected', async () => {
    const transport: RemoteBrowserTransport = {
      readStatus: async () => statusFor('s'),
      runAction: async () => ({ status: statusFor('s') }) as BrowserActionResult,
    };
    const scope = daemonSessionScope(daemonA, 's');
    function Probe() {
      useRemoteBrowser({
        daemon: daemonA,
        scope,
        // Far longer than the test: the point is that it is armed and cancelled,
        // never that it fires. A test that waits on a real clock is a flake.
        pollIntervalMs: 600_000,
        transport,
      });
      return null;
    }
    const renderer = render(<Probe />);
    await settle();
    await runAsync(async () => {
      renderer.unmount();
    });
  });

  it('refreshes on demand without a scheduler tick', async () => {
    const clock = manualScheduler();
    let readCount = 0;
    const harness = mount(
      {
        readStatus: async () => {
          readCount += 1;
          return statusFor('s');
        },
        runAction: async () => ({ status: statusFor('s') }) as BrowserActionResult,
      },
      clock.schedule,
    );
    await settle();
    run(() => harness.model().refresh());
    await settle();
    expect(readCount).toBe(2);
    await harness.unmount();
  });
});
