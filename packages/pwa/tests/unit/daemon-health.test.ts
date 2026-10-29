import { describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import { healthOf } from '../support/health.ts';
import {
  type DaemonHealthRead,
  diskPressureOf,
  diskPressureSentence,
  machineLacks,
  machineOffers,
} from '../../src/lib/daemon-health.ts';

const read = (features?: string[]): DaemonHealthRead => ({
  kind: 'read',
  health: healthOf('4.84.0', features),
});
const FEATURE = DAEMON_FEATURES.packIdea4000;

describe('what a machine’s health says it can do', () => {
  it('offers a feature only when the machine answered and listed it', () => {
    expect(machineOffers(read([FEATURE]), FEATURE)).toBe(true);
    expect(machineLacks(read([FEATURE]), FEATURE)).toBe(false);
  });

  it('lacks it when the machine answered without the list or without the name', () => {
    for (const machine of [read(), read([]), read(['something.else'])]) {
      expect(machineOffers(machine, FEATURE)).toBe(false);
      expect(machineLacks(machine, FEATURE)).toBe(true);
    }
  });

  it('claims neither while the read is going or after it failed', () => {
    for (const machine of [{ kind: 'loading' }, { kind: 'failed' }] as const) {
      expect(machineOffers(machine, FEATURE)).toBe(false);
      expect(machineLacks(machine, FEATURE)).toBe(false);
    }
  });
});

describe('what a machine’s health says about its disk', () => {
  const saturated = { someAvg10: 52, fullAvg10: 46, saturated: true };
  const calm = { someAvg10: 1, saturated: false };
  const withIo = (io: typeof saturated | typeof calm): DaemonHealthRead => ({
    kind: 'read',
    health: { ...healthOf('4.101.0'), io },
  });

  it('keeps a saturated reading and drops a calm one or an absent one', () => {
    expect(diskPressureOf(withIo(saturated), undefined)).toEqual(saturated);
    expect(diskPressureOf(withIo(calm), saturated)).toBeUndefined();
    expect(diskPressureOf({ kind: 'read', health: healthOf('4.84.0') }, saturated)).toBeUndefined();
  });

  it('keeps the last report while a read is going or has failed, because the failing read is the symptom', () => {
    expect(diskPressureOf({ kind: 'loading' }, saturated)).toEqual(saturated);
    expect(diskPressureOf({ kind: 'failed' }, saturated)).toEqual(saturated);
    expect(diskPressureOf({ kind: 'failed' }, undefined)).toBeUndefined();
  });

  it('says slow, not dead, capitalised for a line', () => {
    expect(diskPressureSentence(saturated)).toBe(
      'Disk is saturated (io pressure 46% full) — the daemon is slow, not dead',
    );
  });
});
