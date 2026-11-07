import { describe, expect, it } from 'bun:test';
import { healthOf } from '@ferretry/app/testing';
import { type DaemonHealthRead, diskPressureOf, diskPressureSentence } from '../../../app/lib/daemon-health.ts';


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
