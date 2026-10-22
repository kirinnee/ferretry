/**
 * ONE MACHINE DOWN MUST NEVER BLOCK THE OTHER.
 *
 * The owner's phone, two machines paired: Liftoff MBP asleep, Liftoff EC2 fine, and the page open on the
 * ASLEEP one. The whole Sessions page failed — a banner over the header and "+ New", a red page-level
 * "could not reach fyd at http://127.0.0.1:7431 (…)", an "Updating…" pill waiting on the down machine.
 *
 * These drive the real fleet store, the real machine-sources hook and the real Sessions page, with one
 * machine that HANGS (never answers), one that FAILS FAST, and one that FLAPS, beside a healthy machine.
 */
import '../../support/dom.ts';

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { SessionsPage } from '../../../src/components/sessions-page.tsx';
import { type ListedMachine, useMachineSources } from '../../../src/hooks/use-machine-sources.ts';
import type { ScopeNavigation } from '../../../src/hooks/use-project-scope.ts';
import type { ConnectionHealth, ConnectionHealthState } from '../../../src/lib/connection-health.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../../src/lib/controls.ts';
import { type DaemonConnection, type DaemonId, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../../src/lib/fleet-store.ts';
import type { DeadlineSchedule } from '../../../src/lib/machine-deadline.ts';
import { DaemonProjectsStore } from '../../../src/lib/projects-store.ts';
import { DaemonUsageStore } from '../../../src/lib/usage-store.ts';
import { interact, mount, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const mbp = daemonConnection({ daemonId: 'liftoff-mbp', baseUrl: 'http://127.0.0.1:7431', deviceId: 'mbp' });
const ec2 = daemonConnection({ daemonId: 'liftoff-ec2', baseUrl: 'https://ec2.invalid', deviceId: 'ec2' });
const MACHINES: readonly ListedMachine[] = [
  { connection: mbp, name: 'Liftoff MBP' },
  { connection: ec2, name: 'Liftoff EC2' },
];
const RAW =
  'could not reach fyd at http://127.0.0.1:7431 (this machine is reconnecting, so nothing was dialled for this request; the connection retries on its own schedule)';
const NOW = Date.parse('2026-10-22T23:21:00.000Z');

const rows = (prefix: string): readonly SessionView[] => [
  sessionView(`${prefix}-1`, {
    config: { teammate: `${prefix}-lizzette`, name: `${prefix} task`, cwd: '/home/kirin/ferretry', mode: 'auto' },
    state: { status: 'running', lastActivityAt: '2026-10-22T23:00:00.000Z' },
  }),
];

const storage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

const navigation = (): ScopeNavigation => ({
  snapshot: () => ({ pathname: '/d/liftoff-mbp', search: '', state: null }),
  push: () => {},
  replace: () => {},
  announce: () => {},
  listen: () => () => {},
});

/** Health a test drives by hand, per machine. */
const fakeHealth = () => {
  const states = new Map<DaemonId, ConnectionHealthState>();
  const listeners = new Map<DaemonId, Set<() => void>>();
  const retried: DaemonId[] = [];
  const health: ConnectionHealth = {
    state: daemon => states.get(daemon) ?? UNKNOWN,
    subscribe: (daemon, listener) => {
      const set = listeners.get(daemon) ?? new Set();
      set.add(listener);
      listeners.set(daemon, set);
      return () => set.delete(listener);
    },
    retryNow: daemon => void retried.push(daemon),
    onRecovered: () => () => {},
  };
  const publish = (daemon: DaemonId, state: ConnectionHealthState): void => {
    states.set(daemon, state);
    for (const listener of listeners.get(daemon) ?? []) listener();
  };
  return { health, publish, retried };
};
const UNKNOWN: ConnectionHealthState = { kind: 'unknown' };

const asleep = (): ConnectionHealthState => ({
  kind: 'reconnecting',
  since: NOW - 60_000,
  attempt: 6,
  nextAttemptAt: NOW + 5_000,
  failures: [{ label: 'Hosted relay', detail: 'no daemon holds this rendezvous (4404)' }],
  cause: 'daemon-unreachable',
  stalled: true,
});

const manualClock = () => {
  const timers = new Set<() => void>();
  const schedule: DeadlineSchedule = run => {
    timers.add(run);
    return () => timers.delete(run);
  };
  return {
    schedule,
    fire: () => {
      for (const run of [...timers]) {
        timers.delete(run);
        run();
      }
    },
  };
};

type MbpBehaviour = 'hang' | 'fail' | ((attempt: number) => Promise<readonly SessionView[]>);

const world = (mbpBehaviour: MbpBehaviour) => {
  const clock = manualClock();
  let mbpAttempts = 0;
  const fleet = new DaemonFleetStore(
    {
      list: daemon => {
        if (daemon.daemonId === ec2.daemonId) return Promise.resolve(rows('ec2'));
        mbpAttempts += 1;
        if (mbpBehaviour === 'hang') return new Promise<readonly SessionView[]>(() => {});
        if (mbpBehaviour === 'fail') return Promise.reject(new Error(RAW));
        return mbpBehaviour(mbpAttempts);
      },
      get: () => Promise.reject(new Error('unused')),
    },
    () => NOW,
    { listTimeoutMs: 15_000, schedule: clock.schedule },
  );
  const projects = new DaemonProjectsStore({ projects: () => Promise.resolve([]) });
  const usage = new DaemonUsageStore({ usage: () => Promise.resolve({ accounts: [] }) }, { isHidden: () => true });
  const controls = new DaemonControlsStore(storage());
  const health = fakeHealth();
  const navigated: string[] = [];

  function Page() {
    const sources = useMachineSources({ fleet, projects, connectionHealth: health.health }, MACHINES);
    return (
      <SessionsPage
        connection={mbp}
        connectionHealth={health.health}
        machineName="Liftoff MBP"
        fleet={fleet}
        controls={controls}
        projects={projects}
        usage={usage}
        wardenStatus={() => new Promise(() => {})}
        onOpenWardenReport={() => {}}
        onNavigate={path => navigated.push(path)}
        scopeNavigation={navigation()}
        clock={{ now: () => NOW, intervalMs: 60_000, hold: true }}
        narrow={true}
        machineSources={sources}
        newSessionMachines={MACHINES.map(machine => ({
          daemonId: machine.connection.daemonId,
          name: machine.name,
        }))}
        machineConnections={MACHINES.map(machine => machine.connection)}
      />
    );
  }
  /** What the machines poll does in the app: every machine read on its own. */
  const poll = (): void => {
    for (const { connection } of MACHINES) void fleet.hydrate(connection).catch(() => undefined);
  };
  return { Page, clock, health, navigated, poll };
};

const section = (root: HTMLElement, daemon: DaemonConnection): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[data-machine-section="${daemon.daemonId}"]`), `${daemon.daemonId} section`);

/** Nothing about one machine is said over the whole page. */
const expectNoPageLevelTrouble = (root: HTMLElement): void => {
  expect(root.querySelector('[role="alert"]')).toBeNull();
  expect(root.querySelector('[data-machine-status-row]')).toBeNull();
  expect(root.querySelector('[data-cache-updating]')).toBeNull();
  expect(root.textContent).not.toContain('127.0.0.1');
  expect(root.textContent).not.toContain('could not reach fyd');
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
};

describe('two machines, the one on screen down', () => {
  it('HANGS: the healthy machine renders at once, New works, and only the hung machine says anything', async () => {
    const { Page, clock, health, navigated, poll } = world('hang');
    const page = await mount(<Page />);
    try {
      await interact(() => poll());
      await settle();
      // EC2's rows are on screen while MBP's read is still out — nothing waited on it.
      expect(section(page.container, ec2).querySelector('a[href="/d/liftoff-ec2/session/ec2-1"]')).not.toBeNull();
      expect(page.container.querySelector('[data-session-skeleton], .animate-pulse')).toBeNull();
      expectNoPageLevelTrouble(page.container);

      // The read never answers: past its deadline MBP says so, in its own section.
      await interact(() => clock.fire());
      await settle();
      const status = must(section(page.container, mbp).querySelector('[data-machine-status]'), 'MBP status line');
      expect(status.textContent).toContain('Not answering');
      expect(section(page.container, ec2).querySelector('[data-machine-status]')).toBeNull();
      expectNoPageLevelTrouble(page.container);

      // The health model notices too: the chip says why, and Retry now retries THAT machine.
      await interact(() => health.publish(mbp.daemonId, asleep()));
      expect(section(page.container, mbp).querySelector('[data-machine-status]')?.textContent).toContain(
        'Asleep · retrying',
      );
      await interact(() =>
        must(section(page.container, mbp).querySelector<HTMLButtonElement>('[data-machine-retry]'), 'Retry').click(),
      );
      expect(health.retried).toEqual([mbp.daemonId]);

      // "+ New" defaults to the reachable machine, though the page is the asleep one's.
      await interact(() =>
        must(page.container.querySelector<HTMLButtonElement>('[data-new-session-menu]'), '+ New').click(),
      );
      const items = [
        ...document.querySelectorAll<HTMLButtonElement>('[aria-label="New session on"] [role="menuitem"]'),
      ];
      expect(items.map(item => item.disabled)).toEqual([false, true]);
      expect(items[0]?.textContent).toContain('Liftoff EC2');
      expect(items[1]?.textContent).toContain('Liftoff MBP isn’t reachable right now');
      await interact(() => items[0]?.click());
      expect(navigated).toEqual(['/d/liftoff-ec2/new']);
    } finally {
      await page.unmount();
    }
  });

  it('FAILS FAST: the raw transport text never reaches the page, only the Details sheet', async () => {
    const { Page, health, poll } = world('fail');
    const page = await mount(<Page />);
    try {
      await interact(() => health.publish(mbp.daemonId, asleep()));
      await interact(() => poll());
      await settle();
      expect(section(page.container, ec2).querySelector('a[href="/d/liftoff-ec2/session/ec2-1"]')).not.toBeNull();
      expectNoPageLevelTrouble(page.container);
      const mbpSection = section(page.container, mbp);
      expect(mbpSection.getAttribute('data-machine-reach')).toBe('offline');
      expect(mbpSection.querySelector('[data-machine-status]')?.textContent).toContain('Asleep · retrying');

      await interact(() =>
        must(mbpSection.querySelector<HTMLButtonElement>('[data-machine-details]'), 'Details').click(),
      );
      const sheet = must(document.querySelector('[data-machine-outage-sheet]'), 'the Details sheet');
      expect(sheet.textContent).toContain('Liftoff MBP isn’t reachable right now');
      expect(sheet.textContent).toContain(RAW);
    } finally {
      await page.unmount();
    }
  });

  it('FLAPS: the healthy machine stays put through every swing, and recovery clears the chip', async () => {
    let up = false;
    const { Page, health, poll } = world(() => (up ? Promise.resolve(rows('mbp')) : Promise.reject(new Error(RAW))));
    const page = await mount(<Page />);
    try {
      for (let swing = 0; swing < 4; swing += 1) {
        const down = swing % 2 === 0;
        up = !down;
        await interact(() => health.publish(mbp.daemonId, down ? asleep() : { kind: 'connected' }));
        await interact(() => poll());
        await settle();
        expect(section(page.container, ec2).querySelector('a[href="/d/liftoff-ec2/session/ec2-1"]')).not.toBeNull();
        expect(section(page.container, ec2).querySelector('[data-machine-status]')).toBeNull();
        expect(section(page.container, mbp).querySelector('[data-machine-status]') !== null).toBe(down);
        expectNoPageLevelTrouble(page.container);
      }
      // Back up: MBP's own rows, live, no status line.
      expect(section(page.container, mbp).querySelector('a[href="/d/liftoff-mbp/session/mbp-1"]')).not.toBeNull();
    } finally {
      await page.unmount();
    }
  });
});
