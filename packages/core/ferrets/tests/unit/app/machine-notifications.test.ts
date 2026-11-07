import { describe, expect, it } from 'bun:test';
import type { PushDeviceView } from '@ferretry/protocol';

import {
  MACHINE_STATUS_TEXT,
  type MachineNotificationFact,
  machineNotificationRows,
  machinesOffEverywhere,
  offEverywhereSentence,
  readingFromFailure,
  turnOnAllTargets,
} from '../../src/lib/machine-notifications.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const device = (id: string): PushDeviceView => ({
  id,
  deviceName: id,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  expirationTime: null,
});

const fact = (over: Partial<MachineNotificationFact> & { daemonId: string }): MachineNotificationFact => ({
  label: over.daemonId,
  reading: { kind: 'devices', devices: [] },
  thisDeviceId: null,
  muted: false,
  ...over,
});

const facts: readonly MachineNotificationFact[] = [
  fact({
    daemonId: 'active',
    label: 'Workstation',
    reading: { kind: 'devices', devices: [device('mine')] },
    thisDeviceId: 'mine',
  }),
  fact({
    daemonId: 'other-phone',
    label: 'Laptop',
    reading: { kind: 'devices', devices: [device('theirs')] },
    muted: true,
  }),
  fact({ daemonId: 'empty', label: 'Liftoff EC2' }),
  fact({ daemonId: 'gone', label: 'Old box', reading: { kind: 'offline' } }),
  fact({ daemonId: 'old', label: 'Ancient', reading: { kind: 'needs-update' } }),
  fact({ daemonId: 'loading', label: 'Slow', reading: null }),
];

describe('machineNotificationRows', () => {
  const rows = machineNotificationRows(facts);

  it('keeps every machine, the active one included, in the order given', () => {
    expect(rows.map(row => row.daemonId)).toEqual(['active', 'other-phone', 'empty', 'gone', 'old', 'loading']);
  });

  it('names each status in the reader’s words', () => {
    expect(rows.map(row => row.statusText)).toEqual([
      'On · this device',
      'Off',
      'Off',
      'Machine offline',
      'Needs an update',
      'Checking…',
    ]);
    expect(MACHINE_STATUS_TEXT.on).toBe('On · this device');
  });

  it('is on only when THIS browser’s device is in the machine’s list, not when another device is', () => {
    expect(rows.find(row => row.daemonId === 'other-phone')?.status).toBe('off');
    expect(rows.find(row => row.daemonId === 'active')?.status).toBe('on');
  });

  it('folds the local mute into the row', () => {
    expect(rows.map(row => row.shown)).toEqual([true, false, true, true, true, true]);
  });

  it('counts enrolled devices across every browser, and null where the machine could not be asked', () => {
    expect(rows.map(row => row.enrolledDevices)).toEqual([1, 1, 0, null, null, null]);
  });
});

describe('turnOnAllTargets', () => {
  it('reaches only a machine that is answering and is off here', () => {
    const rows = machineNotificationRows(facts);
    expect(turnOnAllTargets(rows).map(row => row.daemonId)).toEqual(['other-phone', 'empty']);
  });
});

describe('machinesOffEverywhere', () => {
  it('lists a machine with no enrolled device on any browser, and never an unreachable one', () => {
    expect(machinesOffEverywhere(machineNotificationRows(facts)).map(row => row.daemonId)).toEqual(['empty']);
  });

  it('says so with the machine’s name', () => {
    expect(offEverywhereSentence('Liftoff EC2')).toBe(
      'Notifications are off for Liftoff EC2 on every device — turn them on',
    );
  });
});

describe('readingFromFailure', () => {
  it('reads a missing push route as an old daemon', () => {
    for (const status of [404, 405, 501])
      expect(readingFromFailure(new DaemonResponseError(status, 'nope'))).toEqual({ kind: 'needs-update' });
  });

  it('reads any other failure as an absent machine', () => {
    expect(readingFromFailure(new DaemonResponseError(500, 'boom'))).toEqual({ kind: 'offline' });
    expect(readingFromFailure(new Error('network down'))).toEqual({ kind: 'offline' });
  });
});
