import { describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import { healthOf } from '../support/health.ts';
import { type DaemonHealthRead, machineLacks, machineOffers } from '../../src/lib/daemon-health.ts';

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
