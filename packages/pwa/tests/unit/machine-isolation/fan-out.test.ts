/**
 * Every multi-machine surface keeps working with a machine down: "+ New" picks a reachable machine,
 * Find lists the reachable machines and names the missing one, analytics answers without the hung
 * machine, and each machine's section carries its own outage and "Updating…".
 */
import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';
import { readEveryMachine } from '../../../src/features/analytics/analytics-fanout.ts';
import { offlineLabel } from '../../../src/features/connection/connection-copy.ts';
import { allMachinesView, type MachineSource } from '../../../src/lib/all-machines.ts';
import { type DaemonId, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { DaemonFleetSlice } from '../../../src/lib/fleet-store.ts';
import type { DeadlineSchedule } from '../../../src/lib/machine-deadline.ts';
import { defaultNewSessionMachine, newSessionMenuItems, withReach } from '../../../src/shell/new-session-menu.tsx';
import { machinePaletteSessions, paletteResultId } from '../../../src/shell/palette-model.ts';
import { sessionView } from '../../support/sessions.ts';

const MBP = 'liftoff-mbp' as DaemonId;
const EC2 = 'liftoff-ec2' as DaemonId;
const STUDIO = 'studio' as DaemonId;

const slice = (ids: readonly string[] | null, patch: Partial<DaemonFleetSlice> = {}): DaemonFleetSlice => ({
  sessions: ids === null ? null : ids.map(id => sessionView(id, { config: { cwd: '/work/ferretry' } })),
  byId: new Map(),
  status: 'ready',
  error: null,
  ...patch,
});

const source = (daemonId: DaemonId, name: string, reach: MachineSource['reach'], s: DaemonFleetSlice) => ({
  daemonId,
  name,
  reach,
  slice: s,
  projects: [],
});

describe('"+ New" with a machine down', () => {
  const machines = [
    { daemonId: MBP, name: 'Liftoff MBP' },
    { daemonId: EC2, name: 'Liftoff EC2' },
  ];
  const reach = [
    { daemonId: MBP, reach: 'offline' as const },
    { daemonId: EC2, reach: 'online' as const },
  ];

  it('marks only an offline machine unavailable, never one whose reach is unknown', () => {
    expect(withReach(machines, reach).map(machine => machine.unavailable ?? null)).toEqual([
      'Liftoff MBP isn’t reachable right now',
      null,
    ]);
    expect(withReach(machines, undefined)).toBe(machines);
    expect(withReach(machines, [{ daemonId: MBP, reach: 'reading' }])[0]?.unavailable).toBeUndefined();
  });

  it('defaults to the machine on screen while it is reachable, else the first one that is', () => {
    expect(defaultNewSessionMachine(withReach(machines, []), MBP)).toBe(MBP);
    expect(defaultNewSessionMachine(withReach(machines, reach), MBP)).toBe(EC2);
    expect(
      defaultNewSessionMachine(
        withReach(machines, [
          { daemonId: MBP, reach: 'offline' },
          { daemonId: EC2, reach: 'offline' },
        ]),
        MBP,
      ),
    ).toBeNull();
  });

  it('lists the reachable default first and the down machine disabled with its reason', () => {
    const items = newSessionMenuItems(withReach(machines, reach), MBP, () => {});
    expect(items.map(item => [item.label, item.disabled ?? false, item.hint ?? null])).toEqual([
      ['Liftoff EC2', false, null],
      ['Liftoff MBP', true, 'Liftoff MBP isn’t reachable right now'],
    ]);
    expect(items[1]?.detail).toBe('this one');
  });
});

describe('Find across machines with one down', () => {
  it('lists every reachable machine’s sessions, each naming its machine, and notes the missing one', () => {
    const search = machinePaletteSessions([
      source(MBP, 'Liftoff MBP', 'offline', slice(['shared', 'mbp-only'])),
      source(EC2, 'Liftoff EC2', 'online', slice(['shared'])),
      source(STUDIO, 'Studio', 'reading', slice(null)),
    ]);
    expect(search.sessions.map(entry => [entry.daemonId, entry.machine, entry.id])).toEqual([
      [EC2, 'Liftoff EC2', 'shared'],
    ]);
    expect(search.note).toBe('Liftoff MBP isn’t reachable right now, so its sessions aren’t listed.');
  });

  it('names every machine that is down, and says nothing when none is', () => {
    expect(
      machinePaletteSessions([
        source(MBP, 'Liftoff MBP', 'offline', slice([])),
        source(EC2, 'Liftoff EC2', 'offline', slice([])),
        source(STUDIO, 'Studio', 'offline', slice([])),
      ]).note,
    ).toBe('Liftoff MBP, Liftoff EC2 and Studio aren’t reachable right now, so their sessions aren’t listed.');
    expect(machinePaletteSessions([source(EC2, 'Liftoff EC2', 'online', slice(['a']))]).note).toBeNull();
  });

  it('keeps two machines’ identical session ids apart in the option ids', () => {
    const search = machinePaletteSessions([
      source(MBP, 'Liftoff MBP', 'online', slice(['shared'])),
      source(EC2, 'Liftoff EC2', 'online', slice(['shared'])),
    ]);
    const ids = search.sessions.map(entry => paletteResultId({ kind: 'session', entry }));
    expect(new Set(ids).size).toBe(2);
  });
});

describe('each machine’s section speaks only for itself', () => {
  it('gives the down machine its outage and nobody else’s; "Updating…" only on the machine being refreshed', () => {
    const view = allMachinesView([
      {
        ...source(MBP, 'Liftoff MBP', 'offline', slice(['a'], { status: 'error', error: 'raw', cachedAt: 5 })),
        health: { kind: 'unknown' },
      },
      source(EC2, 'Liftoff EC2', 'online', slice(['b'], { cachedAt: 7 })),
      source(STUDIO, 'Studio', 'online', slice(['c'])),
    ]);
    expect(view.machines.map(machine => [machine.daemonId, machine.outage?.chip ?? null, machine.cachedAt])).toEqual([
      [MBP, 'Refresh failed', null],
      [EC2, null, 7],
      [STUDIO, null, null],
    ]);
  });
});

describe('analytics with a machine that never answers', () => {
  it('answers with the machines that did, and reports the hung one as not answering', async () => {
    const timers = new Set<() => void>();
    const schedule: DeadlineSchedule = run => {
      timers.add(run);
      return () => timers.delete(run);
    };
    const mbp = {
      connection: daemonConnection({ daemonId: MBP, baseUrl: 'https://mbp.invalid', deviceId: 'a' }),
      name: 'Liftoff MBP',
    };
    const ec2 = {
      connection: daemonConnection({ daemonId: EC2, baseUrl: 'https://ec2.invalid', deviceId: 'b' }),
      name: 'Liftoff EC2',
    };
    const heard: string[] = [];
    const answer = {} as AnalyticsResponse;
    const all = readEveryMachine(
      [mbp, ec2],
      connection => (connection.daemonId === MBP ? new Promise<AnalyticsResponse>(() => {}) : Promise.resolve(answer)),
      outcome => heard.push(`${outcome.machine.name}:${outcome.status}`),
      { deadlineMs: 20_000, schedule },
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    // EC2 is heard before MBP's deadline: the page can show it while MBP is still out.
    expect(heard).toEqual(['Liftoff EC2:answered']);
    for (const run of [...timers]) run();
    const outcomes = await all;
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'answered']);
    const failed = outcomes[0];
    expect(failed?.status === 'failed' ? failed.error : '').toContain('did not answer within 20s');
  });
});

describe('the connection pill', () => {
  it('names one offline machine and counts more', () => {
    expect(offlineLabel(['Liftoff MBP'])).toBe('Liftoff MBP offline');
    expect(offlineLabel(['Liftoff MBP', 'Studio'])).toBe('2 machines offline');
  });
});
