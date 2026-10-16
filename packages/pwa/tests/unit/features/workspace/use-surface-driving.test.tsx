import { describe, expect, test } from 'bun:test';
import type { FyEvent, IFyApiClient, SurfaceControlView } from '@ferretry/protocol';
import type { z } from 'zod';
import {
  NO_SURFACE_DRIVING,
  type SurfaceDriving,
  type SurfaceDrivingDependencies,
  surfaceControlPath,
  useSurfaceDriving,
} from '../../../../src/features/workspace/use-surface-driving.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import { createSurfaceEventHub } from '../../../../src/lib/surface-control.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-token' });
const scope = daemonSessionScope(alpha, 'sess-1');
const other = daemonSessionScope(alpha, 'sess-2');
const NOW = Date.parse('2026-10-16T10:00:00.000Z');
const UNTIL = '2026-10-16T10:00:15.000Z';

const terminalView = (overrides: Partial<SurfaceControlView> = {}): SurfaceControlView => ({
  sessionId: 'sess-1',
  driving: [
    {
      surface: 'terminal',
      id: 'a1b2c3d4e5f6',
      name: 'dev',
      agentSessionId: 'sess-1',
      agentName: 'Hadi',
      since: '2026-10-16T09:59:00.000Z',
      until: UNTIL,
    },
  ],
  takeovers: [],
  handed: [],
  ...overrides,
});
const browserView = (overrides: Partial<SurfaceControlView> = {}): SurfaceControlView => ({
  sessionId: 'sess-1',
  driving: [
    {
      surface: 'browser',
      id: 'PAGE1',
      agentSessionId: 'sess-1',
      since: '2026-10-16T09:59:00.000Z',
      until: UNTIL,
    },
  ],
  takeovers: [],
  handed: [],
  ...overrides,
});

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
}

/** A scripted daemon client: answers a path with a value, a refusal, or a promise the test settles. */
const fakeClient = (answer: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const client: SurfaceDrivingDependencies['client'] = async () =>
    ({
      request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
        const call: Call = {
          path,
          method: init?.method ?? 'GET',
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        };
        calls.push(call);
        const value = await answer(call);
        if (value instanceof Error) throw value;
        return schema.parse(value);
      },
    }) satisfies Pick<IFyApiClient, 'request'>;
  return { client, calls };
};

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

function mount(dependencies: SurfaceDrivingDependencies | undefined, at: DaemonSessionScope = scope) {
  const seen: { current: SurfaceDriving } = { current: NO_SURFACE_DRIVING };
  function Probe({ value }: { readonly value: DaemonSessionScope }) {
    seen.current = useSurfaceDriving(value, alpha, dependencies);
    return null;
  }
  const renderer = render(<Probe value={at} />);
  return { seen, renderer, rescope: (next: DaemonSessionScope) => run(() => renderer.update(<Probe value={next} />)) };
}

const standing = (call: Call): unknown =>
  call.path === surfaceControlPath(scope, 'terminal') ? terminalView() : browserView();

describe('useSurfaceDriving', () => {
  test('should drive nothing and do nothing without a daemon client', () => {
    expect(mount(undefined).seen.current).toBe(NO_SURFACE_DRIVING);
    expect(NO_SURFACE_DRIVING.takeOver('terminal:x')).toBeUndefined();
    expect(NO_SURFACE_DRIVING.handBack('terminal:x')).toBeUndefined();
    expect(NO_SURFACE_DRIVING.failure).toBeNull();
  });

  test('should read both kinds through the daemon client and mark the tabs an agent drives, by id or name', async () => {
    // Arrange
    const { client, calls } = fakeClient(standing);

    // Act
    const { seen, renderer } = mount({ client, now: () => NOW });
    await settle();

    // Assert
    expect(calls.map(call => call.path).sort()).toEqual([
      '/v1/sessions/sess-1/surfaces/browser/control',
      '/v1/sessions/sess-1/surfaces/terminals/control',
    ]);
    const driving = seen.current;
    expect([...driving.drivenTabIds].sort()).toEqual(['browser:PAGE1', 'terminal:a1b2c3d4e5f6', 'terminal:dev']);
    expect(driving.driverFor('terminal:dev')).toEqual({ name: 'Hadi' });
    expect(driving.driverFor('terminal:a1b2c3d4e5f6')).toEqual({ name: 'Hadi' });
    expect(driving.driverFor('browser:PAGE1')).toEqual({ name: 'The agent' });
    expect(driving.driverFor('file:README.md')).toBeNull();
    expect(driving.driverFor('chat')).toBeNull();
    expect(driving.takenOver('terminal:dev')).toBe(false);
    expect(driving.takenOver('file:README.md')).toBe(false);
    renderer.unmount();
  });

  test('should leave a kind it cannot read unread: no marker, no control', async () => {
    const { client } = fakeClient(call =>
      call.path.includes('terminals') ? new Error('403 terminal grant') : browserView({ driving: [] }),
    );
    const { seen, renderer } = mount({ client, now: () => NOW });
    await settle();
    expect(seen.current.drivenTabIds.size).toBe(0);
    expect(seen.current.driverFor('terminal:dev')).toBeNull();
    renderer.unmount();
  });

  test('should fold the session feed in as it arrives, and stop listening when unmounted', async () => {
    // Arrange
    const hub = createSurfaceEventHub();
    const { client } = fakeClient(standing);
    const { seen, renderer } = mount({ client, events: hub, now: () => NOW });
    await settle();
    const takeover: FyEvent = {
      sequence: 9,
      time: '2026-10-16T10:00:00.000Z',
      sessionId: 'sess-1',
      type: 'surface.takeover',
      source: 'daemon',
      data: {
        surface: 'terminal',
        id: 'a1b2c3d4e5f6',
        name: 'dev',
        by: { by: 'local' },
        since: '2026-10-16T10:00:00.000Z',
      },
    };

    // Act
    run(() => hub.publish({ ...takeover, type: 'turn.started', data: {} }));
    expect(seen.current.takenOver('terminal:dev')).toBe(false);
    run(() => hub.publish(takeover));

    // Assert
    expect(seen.current.takenOver('terminal:dev')).toBe(true);
    expect(seen.current.driverFor('terminal:dev')).toBeNull();
    renderer.unmount();
    hub.publish(takeover);
  });

  test('should take over and hand back through the control route, showing the answer it gets', async () => {
    // Arrange
    let held = false;
    const { client, calls } = fakeClient(call => {
      if (call.method === 'POST') held = (call.body as { action: string }).action === 'takeover';
      if (call.path.includes('browser')) return browserView({ driving: [] });
      return held
        ? terminalView({
            driving: [],
            takeovers: [
              {
                surface: 'terminal',
                id: 'a1b2c3d4e5f6',
                name: 'dev',
                by: { by: 'human', deviceId: 'phone' },
                since: '2026-10-16T10:00:00.000Z',
              },
            ],
          })
        : terminalView();
    });
    const { seen, renderer } = mount({ client, now: () => NOW });
    await settle();

    // Act
    run(() => seen.current.takeOver('terminal:a1b2c3d4e5f6'));
    await settle();

    // Assert
    expect(calls.at(-1)).toEqual({
      path: '/v1/sessions/sess-1/surfaces/terminals/control',
      method: 'POST',
      body: { action: 'takeover', key: 'a1b2c3d4e5f6' },
    });
    expect(seen.current.takenOver('terminal:dev')).toBe(true);

    // Act — hand it back.
    run(() => seen.current.handBack('terminal:dev'));
    await settle();
    expect(calls.at(-1)?.body).toEqual({ action: 'handback', key: 'dev' });
    expect(seen.current.takenOver('terminal:dev')).toBe(false);
    expect(seen.current.driverFor('terminal:dev')).toEqual({ name: 'Hadi' });

    // A tab that is no surface asks nothing.
    const before = calls.length;
    run(() => seen.current.takeOver('file:README.md'));
    await settle();
    expect(calls.length).toBe(before);
    renderer.unmount();
  });

  test('should say a refused control out loud, and clear it on the next try', async () => {
    // Arrange
    let refuse = true;
    const { client } = fakeClient(call =>
      call.method === 'POST' && refuse ? new Error('A person has already taken over %browser:app') : browserView(),
    );
    const { seen, renderer } = mount({ client, now: () => NOW });
    await settle();

    // Act
    run(() => seen.current.takeOver('browser:PAGE1'));
    await settle();
    expect(seen.current.failure).toBe('Could not take over PAGE1: A person has already taken over %browser:app');
    run(() => seen.current.handBack('browser:PAGE1'));
    await settle();
    expect(seen.current.failure).toBe('Could not hand back PAGE1: A person has already taken over %browser:app');
    refuse = false;
    run(() => seen.current.takeOver('browser:PAGE1'));
    await settle();

    // Assert
    expect(seen.current.failure).toBeNull();
    renderer.unmount();
  });

  test('should report a non-Error refusal as its text', async () => {
    const client: SurfaceDrivingDependencies['client'] = async () =>
      ({
        request: async (_path: string, _schema: unknown, init?: RequestInit) => {
          if (init?.method === 'POST') throw 'offline';
          return terminalView();
        },
      }) as never;
    const { seen, renderer } = mount({ client, now: () => NOW });
    await settle();
    run(() => seen.current.takeOver('terminal:dev'));
    await settle();
    expect(seen.current.failure).toBe('Could not take over dev: offline');
    renderer.unmount();
  });

  test('should drop every answer that arrives after the page moved to another session', async () => {
    // Arrange — every request waits for the test to release it.
    const pending: ((value: unknown) => void)[] = [];
    const { client } = fakeClient(() => new Promise(resolve => pending.push(resolve)));
    const { seen, renderer, rescope } = mount({ client, now: () => NOW });
    await settle();
    run(() => seen.current.takeOver('terminal:dev'));
    await settle();
    const stale = pending.splice(0);

    // Act — move on, then let the first session's answers land: reads, and a refused control.
    rescope(other);
    expect(stale).toHaveLength(3);
    stale[0]?.(terminalView());
    stale[1]?.(browserView());
    stale[2]?.(new Error('late'));
    await settle();

    // Assert
    expect(seen.current.drivenTabIds.size).toBe(0);
    expect(seen.current.failure).toBeNull();
    renderer.unmount();
  });

  test('should drop a late control answer after the page moved on', async () => {
    let releaseControl: ((value: unknown) => void) | undefined;
    const { client } = fakeClient(call =>
      call.method === 'POST' ? new Promise(resolve => (releaseControl = resolve)) : terminalView({ driving: [] }),
    );
    const { seen, renderer, rescope } = mount({ client, now: () => NOW });
    await settle();
    run(() => seen.current.takeOver('terminal:dev'));
    await settle();
    rescope(other);
    releaseControl?.(terminalView());
    await settle();
    expect(seen.current.drivenTabIds.size).toBe(0);
    renderer.unmount();
  });

  test('should re-render when the standing marker lapses, with no event to say so', async () => {
    // Arrange — a timer the test fires, and a clock it moves.
    let clock = NOW;
    const timers: { readonly fire: () => void; readonly delay: number; cancelled: boolean }[] = [];
    const { client } = fakeClient(standing);
    const { seen, renderer } = mount({
      client,
      now: () => clock,
      timer: (fire, delay) => {
        const entry = { fire, delay, cancelled: false };
        timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    });
    await settle();
    const armed = timers.findLast(entry => !entry.cancelled);
    expect(armed?.delay).toBe(Date.parse(UNTIL) - NOW + 1);

    // Act
    clock = Date.parse(UNTIL) + 1;
    run(() => armed?.fire());

    // Assert
    expect(seen.current.driverFor('terminal:dev')).toBeNull();
    expect(seen.current.drivenTabIds.size).toBe(0);
    renderer.unmount();
  });

  test('should keep reading on its poll and stop when unmounted', async () => {
    const { client, calls } = fakeClient(standing);
    const { renderer } = mount({ client, pollMs: 5, now: () => NOW });
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    renderer.unmount();
    // A read the last tick started still lands; nothing after it does.
    await settle();
    const after = calls.length;
    expect(after).toBeGreaterThan(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls.length).toBe(after);
  });

  test('should lapse on the real clock and timer when none are injected', async () => {
    const { client } = fakeClient(() =>
      terminalView({
        driving: [
          {
            surface: 'terminal',
            id: 'a1b2c3d4e5f6',
            agentSessionId: 'sess-1',
            since: new Date(Date.now() - 1_000).toISOString(),
            until: new Date(Date.now() + 15).toISOString(),
          },
        ],
      }),
    );
    const { seen, renderer } = mount({ client });
    await settle();
    expect(seen.current.driverFor('terminal:a1b2c3d4e5f6')).toEqual({ name: 'The agent' });
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(seen.current.driverFor('terminal:a1b2c3d4e5f6')).toBeNull();
    renderer.unmount();
  });
});
