/**
 * "Retry now" on ANOTHER machine's row.
 *
 * The page is open on one machine and lists a second, asleep one. Retry on the second must skip THAT
 * machine's backoff and read THAT machine again, through its own pairing — never the page's machine.
 */
import '@ferretry/app/testing';

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '../../../contract/index.ts';
import { SessionsPage } from '../../../app/components/sessions-page.tsx';
import { type ListedMachine, useMachineSources } from '../../../app/hooks/use-machine-sources.ts';
import type { ScopeNavigation } from '../../../../../plugins/projects/app/hooks/use-project-scope.ts';
import type { ConnectionHealth, ConnectionHealthState } from '../../../../../plugins/connections/app/lib/connection-health.ts';
import { type ControlsStorage, DaemonControlsStore } from '@ferretry/app';
import { type DaemonId, daemonConnection } from '../../../app/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../../app/lib/fleet-store.ts';
import { DaemonProjectsStore } from '../../../../../plugins/projects/app/lib/projects-store.ts';
import { DaemonUsageStore } from '../../../../../plugins/usage/app/lib/usage-store.ts';
import { interact, mount, must } from '@ferretry/app/testing';
import { sessionView } from '@ferretry/app/testing';

const here = daemonConnection({ daemonId: 'liftoff-mbp', baseUrl: 'http://127.0.0.1:7431', deviceId: 'mbp' });
const there = daemonConnection({ daemonId: 'liftoff-ec2', baseUrl: 'https://ec2.invalid', deviceId: 'ec2' });
const MACHINES: readonly ListedMachine[] = [
  { connection: here, name: 'Liftoff MBP' },
  { connection: there, name: 'Liftoff EC2' },
];
const UNKNOWN: ConnectionHealthState = { kind: 'unknown' };
const NOW = Date.parse('2026-10-22T23:21:00.000Z');

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

const asleep = (): ConnectionHealthState => ({
  kind: 'reconnecting',
  since: NOW - 60_000,
  attempt: 6,
  nextAttemptAt: NOW + 5_000,
  failures: [{ label: 'Hosted relay', detail: 'no daemon holds this rendezvous (4404)' }],
  cause: 'daemon-unreachable',
  stalled: true,
});

describe('retrying another machine from the Sessions page', () => {
  it('skips that machine’s backoff and reads that machine again, not the page’s own', async () => {
    const reads: DaemonId[] = [];
    const rows: readonly SessionView[] = [sessionView('mbp-1')];
    const fleet = new DaemonFleetStore(
      {
        list: daemon => {
          reads.push(daemon.daemonId);
          return daemon.daemonId === there.daemonId ? Promise.reject(new Error('asleep')) : Promise.resolve(rows);
        },
        get: () => Promise.reject(new Error('unused')),
      },
      () => NOW,
      { refreshMinMs: 0 },
    );
    const projects = new DaemonProjectsStore({ projects: () => Promise.resolve([]) });
    const usage = new DaemonUsageStore({ usage: () => Promise.resolve({ accounts: [] }) }, { isHidden: () => true });
    const controls = new DaemonControlsStore(storage());
    const states = new Map<DaemonId, ConnectionHealthState>([[there.daemonId, asleep()]]);
    const retried: DaemonId[] = [];
    const health: ConnectionHealth = {
      state: daemon => states.get(daemon) ?? UNKNOWN,
      subscribe: () => () => {},
      retryNow: daemon => void retried.push(daemon),
      onRecovered: () => () => {},
    };

    function Page() {
      const sources = useMachineSources({ fleet, projects, connectionHealth: health }, MACHINES);
      return (
        <SessionsPage
          connection={here}
          connectionHealth={health}
          machineName="Liftoff MBP"
          fleet={fleet}
          controls={controls}
          projects={projects}
          usage={usage}
          wardenStatus={() => new Promise(() => {})}
          onOpenWardenReport={() => {}}
          scopeNavigation={navigation()}
          clock={{ now: () => NOW, intervalMs: 60_000, hold: true }}
          narrow={true}
          machineSources={sources}
          machineConnections={MACHINES.map(machine => machine.connection)}
        />
      );
    }

    const page = await mount(<Page />);
    try {
      await interact(async () => {
        for (const { connection } of MACHINES) void fleet.hydrate(connection).catch(() => undefined);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      const section = must(
        page.container.querySelector<HTMLElement>(`[data-machine-section="${there.daemonId}"]`),
        'the asleep machine’s section',
      );
      const before = reads.filter(id => id === there.daemonId).length;

      await interact(async () => {
        must(section.querySelector<HTMLButtonElement>('[data-machine-retry]'), 'Retry').click();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });

      expect(retried).toEqual([there.daemonId]);
      expect(reads.filter(id => id === there.daemonId).length).toBe(before + 1);
    } finally {
      await page.unmount();
    }
  });
});
