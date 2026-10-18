import { afterEach, describe, expect, test } from 'bun:test';
import { type ListedMachine, useMachineSources } from '../../src/hooks/use-machine-sources.ts';
import type { MachineSource } from '../../src/lib/all-machines.ts';
import { DaemonConnectionHealth } from '../../src/lib/connection-health.ts';
import { type DaemonConnection, type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { DaemonProjectsStore } from '../../src/lib/projects-store.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'on-studio' });
const laptop = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'on-laptop' });
const MACHINES: readonly ListedMachine[] = [
  { connection: studio, name: 'studio' },
  { connection: laptop, name: 'laptop' },
];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const stores = () => {
  const projectReads: DaemonConnection[] = [];
  const fleet = new DaemonFleetStore({
    list: async daemon => [sessionView(`${daemon.daemonId}-1`)],
    get: async () => await Promise.reject(new Error('unused')),
  });
  const projects = new DaemonProjectsStore({
    projects: async daemon => {
      projectReads.push(daemon);
      if (daemon.daemonId === 'laptop') throw new Error('no registry');
      return [{ name: 'ferretry', path: '/work/ferretry' }];
    },
  });
  const connectionHealth = new DaemonConnectionHealth(
    { now: () => 0, schedule: () => () => undefined, random: () => 0.5, isOnline: () => true },
    async () => undefined,
  );
  return { fleet, projects, connectionHealth, projectReads };
};

function Probe({
  stores: given,
  machines,
  locked,
  onSources,
}: {
  readonly stores: ReturnType<typeof stores>;
  readonly machines: readonly ListedMachine[];
  readonly locked?: readonly DaemonId[];
  readonly onSources: (sources: readonly MachineSource[]) => void;
}) {
  onSources(useMachineSources(given, machines, locked));
  return null;
}

describe('useMachineSources', () => {
  test('reads every machine’s slice, registry and reach, in order, and hydrates each registry once', async () => {
    const given = stores();
    const seen: (readonly MachineSource[])[] = [];
    view = await mount(<Probe machines={MACHINES} onSources={sources => seen.push(sources)} stores={given} />);
    expect(seen.at(-1)?.map(source => [source.daemonId, source.name, source.reach])).toEqual([
      ['studio', 'studio', 'reading'],
      ['laptop', 'laptop', 'reading'],
    ]);
    expect(given.projectReads.map(read => read.deviceId)).toEqual(['on-studio', 'on-laptop']);

    await interact(async () => {
      await given.fleet.hydrate(studio);
      await given.fleet.hydrate(laptop);
    });
    expect(seen.at(-1)?.map(source => source.reach)).toEqual(['online', 'online']);
    expect(seen.at(-1)?.[0]?.projects).toEqual([{ name: 'ferretry', path: '/work/ferretry' }]);

    // One machine's health moving is one new snapshot; an unchanged fact keeps the old identity.
    const before = seen.at(-1);
    await interact(async () => {
      given.connectionHealth.outage(laptop.daemonId, { failures: [], daemonAbsent: false, relaysNeverOpened: false });
    });
    expect(seen.at(-1)).not.toBe(before);
    expect(seen.at(-1)?.map(source => source.reach)).toEqual(['online', 'offline']);
    const settled = seen.at(-1);
    await view.render(<Probe machines={MACHINES} onSources={sources => seen.push(sources)} stores={given} />);
    expect(seen.at(-1)).toBe(settled);
  });

  test('a machine waiting on an unlock reads as locked', async () => {
    const given = stores();
    let last: readonly MachineSource[] = [];
    view = await mount(
      <Probe locked={[laptop.daemonId]} machines={MACHINES} onSources={sources => (last = sources)} stores={given} />,
    );
    expect(last.map(source => source.reach)).toEqual(['reading', 'locked']);
  });

  test('no machines is an empty list and reads nothing', async () => {
    const given = stores();
    let last: readonly MachineSource[] | undefined;
    view = await mount(<Probe machines={[]} onSources={sources => (last = sources)} stores={given} />);
    expect(last).toEqual([]);
    expect(given.projectReads).toEqual([]);
  });
});
