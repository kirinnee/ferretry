import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { type FleetViewResult, useFleetView } from '../../src/hooks/use-fleet-view.ts';
import { type ControlsStorage, DaemonControlsStore, type UiControls } from '../../src/lib/controls.ts';
import { type DaemonConnection, type DaemonId, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../src/lib/fleet-grouping.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { render, runAsync } from '../support/react.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonId('alpha');
const beta = daemonId('beta');

const connection = (id: DaemonId): DaemonConnection =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceToken: `token-${id}` });

/** A port that answers each daemon with its own fixed fleet. */
const port = (fleets: Readonly<Record<string, readonly SessionView[]>>): DaemonFleetPort => ({
  list: daemon => Promise.resolve(fleets[daemon.daemonId] ?? []),
  get: (daemon, sessionId) => {
    const found = (fleets[daemon.daemonId] ?? []).find(view => view.config.id === sessionId);
    return found ? Promise.resolve(found) : Promise.reject(new Error('no such session'));
  },
});

/** A real read/write store, so the persisted scope clear is actually observable. */
const memoryStorage = (seed: Record<string, string> = {}): ControlsStorage => ({
  getItem: key => seed[key] ?? null,
  setItem: (key, value) => {
    seed[key] = value;
  },
});

interface ProbeProps {
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly daemonId: DaemonId;
  readonly projects?: readonly FleetProject[];
  readonly sortRows?: boolean;
  readonly onView: (view: FleetViewResult) => void;
}

const Probe = ({ onView, ...options }: ProbeProps): null => {
  onView(useFleetView(options));
  return null;
};

/** Mounts the hook and hands back the most recent value it produced. */
const mountHook = async (
  options: Omit<ProbeProps, 'onView'>,
): Promise<{ latest: () => FleetViewResult; rerender: (next: Omit<ProbeProps, 'onView'>) => Promise<void> }> => {
  let latest: FleetViewResult | undefined;
  const capture = (view: FleetViewResult): void => {
    latest = view;
  };
  let renderer: ReturnType<typeof render> | undefined;
  await runAsync(async () => {
    renderer = render(<Probe {...options} onView={capture} />);
  });
  return {
    latest: () => {
      if (!latest) throw new Error('the hook produced no value');
      return latest;
    },
    rerender: async next => {
      await runAsync(async () => {
        renderer?.update(<Probe {...next} onView={capture} />);
      });
    },
  };
};

const ids = (views: readonly SessionView[]): string[] => views.map(view => view.config.id);

const alphaSessions = [
  sessionView('a1', { config: { cwd: '/work/repo/src', mode: 'auto' } }),
  sessionView('a2', { config: { cwd: '/scratch/spike', mode: 'interactive' } }),
];
const betaSessions = [sessionView('b1', { config: { cwd: '/elsewhere/thing', mode: 'auto' } })];

describe('useFleetView', () => {
  it('reads a daemon that has not been loaded as not-yet-read, not as an empty fleet', async () => {
    const hook = await mountHook({
      fleet: new DaemonFleetStore(port({})),
      controls: new DaemonControlsStore(memoryStorage()),
      daemonId: alpha,
    });

    expect(hook.latest().slice.status).toBe('idle');
    expect(hook.latest().slice.sessions).toBeNull();
    expect(hook.latest().sessions).toEqual([]);
    expect(hook.latest().counts).toEqual({ all: 0, interactive: 0, auto: 0 });
  });

  it('renders one daemon’s sessions, grouped and counted, once the read settles', async () => {
    const fleet = new DaemonFleetStore(port({ alpha: alphaSessions }));
    const hook = await mountHook({
      fleet,
      controls: new DaemonControlsStore(memoryStorage()),
      daemonId: alpha,
    });

    await runAsync(async () => {
      await fleet.hydrate(connection(alpha));
    });

    expect(ids(hook.latest().sessions)).toEqual(['a1', 'a2']);
    // No daemon serves a project list yet, so each cwd names its own group.
    expect(
      hook
        .latest()
        .groups.map(group => group.name)
        .sort(),
    ).toEqual(['spike', 'src']);
    expect(hook.latest().counts).toEqual({ all: 2, interactive: 1, auto: 1 });
  });

  it('never serves one daemon’s sessions to another', async () => {
    const fleet = new DaemonFleetStore(port({ alpha: alphaSessions, beta: betaSessions }));
    const controls = new DaemonControlsStore(memoryStorage());
    const hook = await mountHook({ fleet, controls, daemonId: alpha });

    await runAsync(async () => {
      await fleet.hydrate(connection(alpha));
      await fleet.hydrate(connection(beta));
    });
    expect(ids(hook.latest().sessions)).toEqual(['a1', 'a2']);

    await hook.rerender({ fleet, controls, daemonId: beta });
    expect(ids(hook.latest().sessions)).toEqual(['b1']);
  });

  it('applies this daemon’s folder scope and leaves another daemon’s alone', async () => {
    const fleet = new DaemonFleetStore(port({ alpha: alphaSessions, beta: betaSessions }));
    const controls = new DaemonControlsStore(memoryStorage());
    controls.setControls(alpha, { projectScope: '/scratch/spike' });
    controls.setControls(beta, { projectScope: '/elsewhere/thing' });

    const hook = await mountHook({ fleet, controls, daemonId: alpha });
    await runAsync(async () => {
      await fleet.hydrate(connection(alpha));
      await fleet.hydrate(connection(beta));
    });

    expect(ids(hook.latest().sessions)).toEqual(['a2']);
    expect(hook.latest().scope).toBe('/scratch/spike');

    await hook.rerender({ fleet, controls, daemonId: beta });
    expect(hook.latest().scope).toBe('/elsewhere/thing');
    expect(ids(hook.latest().sessions)).toEqual(['b1']);
  });

  it('recovers from a scope this daemon has never reported, and persists the clear', async () => {
    const fleet = new DaemonFleetStore(port({ alpha: alphaSessions }));
    const controls = new DaemonControlsStore(memoryStorage());
    controls.setControls(alpha, { projectScope: '/from/another/daemon' });

    const hook = await mountHook({ fleet, controls, daemonId: alpha });
    await runAsync(async () => {
      await fleet.hydrate(connection(alpha));
    });

    expect(hook.latest().scope).toBeNull();
    expect(ids(hook.latest().sessions)).toEqual(['a1', 'a2']);
    expect(controls.controls(alpha).projectScope).toBeNull();
  });

  it('does not clear a scope on the strength of a list that has not arrived', async () => {
    const controls = new DaemonControlsStore(memoryStorage());
    controls.setControls(alpha, { projectScope: '/work/repo' });

    const hook = await mountHook({
      fleet: new DaemonFleetStore(port({})),
      controls,
      daemonId: alpha,
    });

    expect(hook.latest().scopeRecovered).toBe(false);
    expect(controls.controls(alpha).projectScope).toBe('/work/repo');
  });

  it('follows a controls change without a new fleet read', async () => {
    const fleet = new DaemonFleetStore(port({ alpha: alphaSessions }));
    const controls = new DaemonControlsStore(memoryStorage());
    const hook = await mountHook({ fleet, controls, daemonId: alpha });
    await runAsync(async () => {
      await fleet.hydrate(connection(alpha));
    });

    await runAsync(async () => {
      controls.setControls(alpha, { mode: 'interactive' });
    });

    expect(ids(hook.latest().sessions)).toEqual(['a2']);
    expect(hook.latest().counts.all).toBe(2);
  });

  it('files sessions under a registered project when one is known', async () => {
    const fleet = new DaemonFleetStore(port({ alpha: alphaSessions }));
    const projects: readonly FleetProject[] = [{ name: 'ferretry', path: '/work/repo' }];
    const hook = await mountHook({
      fleet,
      controls: new DaemonControlsStore(memoryStorage()),
      daemonId: alpha,
      projects,
    });
    await runAsync(async () => {
      await fleet.hydrate(connection(alpha));
    });

    expect(hook.latest().groups.map(group => group.name)).toContain('ferretry');
  });

  it('sorts rows inside a group only when the caller asks', async () => {
    const busy = [
      sessionView('old', { config: { cwd: '/g' }, state: { lastActivityAt: '2026-01-01T00:00:01.000Z' } }),
      sessionView('new', { config: { cwd: '/g' }, state: { lastActivityAt: '2026-01-01T00:00:09.000Z' } }),
    ];
    const fleet = new DaemonFleetStore(port({ alpha: busy }));
    const controls = new DaemonControlsStore(memoryStorage());
    const hook = await mountHook({ fleet, controls, daemonId: alpha });
    await runAsync(async () => {
      await fleet.hydrate(connection(alpha));
    });
    expect(ids(hook.latest().groups[0]?.rows ?? [])).toEqual(['old', 'new']);

    await hook.rerender({ fleet, controls, daemonId: alpha, sortRows: true });
    expect(ids(hook.latest().groups[0]?.rows ?? [])).toEqual(['new', 'old']);
  });

  it('hands back this daemon’s merged controls so a screen need not read the store twice', async () => {
    const controls = new DaemonControlsStore(memoryStorage());
    controls.setControls(alpha, { density: 'compact' });
    const hook = await mountHook({
      fleet: new DaemonFleetStore(port({})),
      controls,
      daemonId: alpha,
    });

    const merged: UiControls = hook.latest().controls;
    expect(merged.density).toBe('compact');
    expect(merged.projectScope).toBeNull();
  });
});
