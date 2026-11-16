import { describe, expect, it } from 'bun:test';
import { deviceViewHarness } from '@ferretry/app/testing';
import half from '../../../app/index.ts';
import { machineDetailFromHash, machineDetailHash } from '../../../app/features/fleet/runtimes/machine-data.ts';

/**
 * Runtimes claims `#machines/…` with `strip: false` (shell contract S3, m9): the shell's real fragment taker leaves the
 * machine-detail link in the address, at boot and on every arrival, so the tabs' own router reads it there.
 */

const declared = half.shell.fragments ?? [];

describe('the #machines fragment', () => {
  it('is declared as a key the shell claims but never strips', () => {
    expect(declared).toEqual([{ form: 'keyed', key: 'machines', strip: false }]);
  });

  it('survives boot and a second arrival exactly, and round-trips its tabs', () => {
    const first = machineDetailHash('desk', 'runtimes', 'claude');
    const harness = deviceViewHarness({ plugin: 'runtimes', fragments: declared, href: `/d/d1/settings${first}` });
    expect(harness.address()).toBe(`/d/d1/settings${first}`);
    expect(machineDetailFromHash(first, 'runtimes')).toBe('claude');
    const second = machineDetailHash('desk', 'profiles');
    harness.arrive(`/d/d1/settings${second}`);
    expect(harness.address()).toBe(`/d/d1/settings${second}`);
  });
});
