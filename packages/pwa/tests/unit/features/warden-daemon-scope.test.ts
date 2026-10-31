import { describe, expect, it } from 'bun:test';

import { resolveWardenScope, type WardenMachine } from '../../../src/features/warden/warden-daemon-scope.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';

const machine = (id: string, name: string): WardenMachine => ({
  connection: daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: 'tok' }),
  name,
});
const ec2 = machine('daemon-ec2', 'Liftoff EC2');
const mbp = machine('daemon-mbp', 'Liftoff MBP');

describe('resolveWardenScope', () => {
  it('shows every paired daemon, with the filter offered, when nothing is remembered', () => {
    const scope = resolveWardenScope([ec2, mbp], null);
    expect(scope.selected).toBeNull();
    expect(scope.shown).toEqual([ec2, mbp]);
    expect(scope.offerFilter).toBe(true);
  });

  it('narrows to the remembered daemon', () => {
    const scope = resolveWardenScope([ec2, mbp], 'daemon-mbp');
    expect(scope.selected).toBe(mbp.connection.daemonId);
    expect(scope.shown).toEqual([mbp]);
  });

  it('falls back to All when the remembered daemon is no longer paired', () => {
    const scope = resolveWardenScope([ec2, mbp], 'daemon-gone');
    expect(scope.selected).toBeNull();
    expect(scope.shown).toEqual([ec2, mbp]);
  });

  it('offers no filter for a single paired daemon, and ignores a remembered choice', () => {
    const scope = resolveWardenScope([ec2], 'daemon-mbp');
    expect(scope.offerFilter).toBe(false);
    expect(scope.selected).toBeNull();
    expect(scope.shown).toEqual([ec2]);
  });

  it('shows nothing, and offers nothing, for no daemons', () => {
    const scope = resolveWardenScope([], null);
    expect(scope.shown).toEqual([]);
    expect(scope.offerFilter).toBe(false);
  });
});
