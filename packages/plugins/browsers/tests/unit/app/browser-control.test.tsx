import { describe, expect, it } from 'bun:test';
import { render, run, runAsync } from '@ferretry/app/testing';
import { PageChanged } from '../../../contract/index.ts';
import {
  type BrowserControl,
  type ControlPoll,
  type ControlTimer,
  useBrowserControl,
} from '../../../app/hooks/use-browser-control.ts';
import {
  askedFor,
  drivingAgentName,
  drivingFor,
  nextDrivingLapse,
  takeoverFor,
  withControlView,
} from '../../../app/lib/browser-control.ts';
import type { SurfaceControlView } from '../../../app/lib/wire/control.ts';
import { browserDaemon, recordingClient } from '../../support/app/client.ts';
import { daemonSessionScope } from '../../support/app/scope.ts';

const READ = 'GET /v1/sessions/:sessionId/surfaces/browser/control';
const ACT = 'POST /v1/sessions/:sessionId/surfaces/browser/control';

const T0 = Date.parse('2026-07-31T00:00:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString() as never;

const view = (patch: Partial<SurfaceControlView> = {}): SurfaceControlView => ({
  sessionId: 'session-a',
  driving: [],
  takeovers: [],
  handed: [],
  opened: [],
  asked: [],
  ...patch,
});

const driving = (id: string, until: number, extra: Record<string, unknown> = {}) =>
  ({ surface: 'browser', id, agentSessionId: 'agent-1', since: at(0), until: at(until), ...extra }) as never;

describe('who is driving a browser page', () => {
  it('shows an agent’s marker only while it has not lapsed', () => {
    const current = view({ driving: [driving('p1', 5_000, { agentName: 'Hadi' })] });
    expect(drivingFor(current, 'p1', T0 + 1_000)?.agentName).toBe('Hadi');
    expect(drivingFor(current, 'p1', T0 + 5_000)).toBeUndefined();
    expect(drivingFor(null, 'p1', T0)).toBeUndefined();
  });

  it('addresses a page by its id or by its name', () => {
    const current = view({ driving: [driving('p1', 5_000, { name: 'app' })] });
    expect(drivingFor(current, 'app', T0)).toBeDefined();
    expect(drivingFor(current, 'p1', T0)).toBeDefined();
    expect(drivingFor(current, 'other', T0)).toBeUndefined();
  });

  it('shows nobody driving a page a person holds', () => {
    const current = view({
      driving: [driving('p1', 5_000)],
      takeovers: [{ surface: 'browser', id: 'p1', by: { by: 'local' }, since: at(0) }],
    });
    expect(takeoverFor(current, 'p1')).toBeDefined();
    expect(drivingFor(current, 'p1', T0)).toBeUndefined();
  });

  it('reports the next lapse, and none when nothing stands', () => {
    const current = view({ driving: [driving('p1', 9_000), driving('p2', 4_000)] });
    expect(nextDrivingLapse(current, T0)).toBe(T0 + 4_000);
    expect(nextDrivingLapse(current, T0 + 10_000)).toBeUndefined();
    expect(nextDrivingLapse(null, T0)).toBeUndefined();
  });

  it('names an unnamed agent plainly, and drops a view for another session', () => {
    expect(drivingAgentName(driving('p1', 1))).toBe('The agent');
    const mine = view();
    expect(withControlView(mine, 'session-a', view({ sessionId: 'session-b' }))).toBe(mine);
    const next = view({ driving: [driving('p1', 1)] });
    expect(withControlView(mine, 'session-a', next)).toBe(next);
  });

  it('does not offer a hand-over ask once a person holds the page', () => {
    const asked = { surface: 'browser', id: 'p1', agentSessionId: 'agent-1', at: at(0) } as never;
    expect(askedFor(view({ asked: [asked] }), 'p1')).toBeDefined();
    const held = view({
      asked: [asked],
      takeovers: [{ surface: 'browser', id: 'p1', by: { by: 'local' }, since: at(0) }],
    });
    expect(askedFor(held, 'p1')).toBeUndefined();
  });
});

interface Harness {
  control: () => BrowserControl;
  readonly calls: ReturnType<typeof recordingClient>['calls'];
  readonly heard: ReturnType<typeof recordingClient>['heard'];
  readonly polls: (() => void)[];
  readonly timers: { callback: () => void; delayMs: number }[];
  readonly unmount: () => void;
}

const harness = async (answer: (route: string) => unknown, clock = { now: T0 }): Promise<Harness> => {
  const recorded = recordingClient(route => answer(route));
  const daemon = browserDaemon(recorded.client);
  const polls: (() => void)[] = [];
  const timers: { callback: () => void; delayMs: number }[] = [];
  const poll: ControlPoll = callback => {
    polls.push(callback);
    return () => undefined;
  };
  const timer: ControlTimer = (callback, delayMs) => {
    timers.push({ callback, delayMs });
    return () => undefined;
  };
  let latest: BrowserControl | undefined;
  const Probe = () => {
    latest = useBrowserControl(daemonSessionScope(daemon, 'session-a'), daemon, { poll, timer, now: () => clock.now });
    return null;
  };
  let renderer!: ReturnType<typeof render>;
  await runAsync(async () => {
    renderer = render(<Probe />);
  });
  await runAsync(async () => await Promise.resolve());
  return {
    control: () => latest as BrowserControl,
    calls: recorded.calls,
    heard: recorded.heard,
    polls,
    timers,
    unmount: () => run(() => renderer.unmount()),
  };
};

describe('the browser control hook', () => {
  it('reads the session’s control view by route key and shows who is driving', async () => {
    const h = await harness(() => view({ driving: [driving('p1', 5_000, { agentName: 'Hadi' })] }));
    expect(h.calls[0]).toEqual({ route: READ, init: { params: { sessionId: 'session-a' } } });
    expect(h.control().driverFor('p1')).toEqual({ name: 'Hadi' });
    expect(h.control().takenOver('p1')).toBe(false);
    // A re-render is scheduled for the instant the marker lapses.
    expect(h.timers.at(-1)?.delayMs).toBe(5_001);
    h.unmount();
  });

  it('reads again on this session’s page change and on the safety-net poll, not on another ferret’s', async () => {
    const h = await harness(() => view());
    const reads = () => h.calls.filter(call => call.route === READ).length;
    expect(reads()).toBe(1);
    await runAsync(async () =>
      h.heard.emit(PageChanged, { ferret: 'session-b', page: 'p1', change: 'opened' } as never),
    );
    expect(reads()).toBe(1);
    await runAsync(async () =>
      h.heard.emit(PageChanged, { ferret: 'session-a', page: 'p1', change: 'opened' } as never),
    );
    expect(reads()).toBe(2);
    await runAsync(async () => h.polls.at(-1)?.());
    expect(reads()).toBe(3);
    h.unmount();
  });

  it('takes a page over by posting the action, and the answer replaces the view', async () => {
    const h = await harness(route =>
      route === ACT
        ? view({ takeovers: [{ surface: 'browser', id: 'p1', by: { by: 'local' }, since: at(0) }] })
        : view(),
    );
    await runAsync(async () => h.control().takeOver('p1'));
    await runAsync(async () => await Promise.resolve());
    expect(h.calls.at(-1)).toEqual({
      route: ACT,
      init: { params: { sessionId: 'session-a' }, body: { action: 'takeover', key: 'p1' } },
    });
    expect(h.control().takenOver('p1')).toBe(true);
    h.unmount();
  });

  it('says why the daemon refused a hand back, and shows no marker for a view it could not read', async () => {
    const h = await harness(route =>
      route === ACT ? new Error('the browser grant was withdrawn') : new Error('refused'),
    );
    expect(h.control().driverFor('p1')).toBeNull();
    await runAsync(async () => h.control().handBack('p1'));
    await runAsync(async () => await Promise.resolve());
    expect(h.control().failure).toBe('Could not hand back p1: the browser grant was withdrawn');
    h.unmount();
  });
});
