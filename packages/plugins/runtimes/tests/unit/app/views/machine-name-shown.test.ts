import { describe, expect, it } from 'bun:test';
import { machineNameShown } from '../../../../app/views/machine-settings-host.tsx';

describe('the name a machine settings tab shows', () => {
  const paired = [
    { daemon: 'ws', machine: 'Studio box' },
    { daemon: 'other', machine: 'elsewhere' },
  ];

  it('follows the live paired name, not the name the view last read', () => {
    expect(machineNameShown(paired, 'ws', 'ip-172-27-76-90')).toBe('Studio box');
  });

  it('falls back to the name it read, then to "this machine"', () => {
    expect(machineNameShown([], 'ws', 'ip-172-27-76-90')).toBe('ip-172-27-76-90');
    expect(machineNameShown(paired, 'unknown', undefined)).toBe('this machine');
    expect(machineNameShown([{ daemon: 'ws', machine: '' }], 'ws', '')).toBe('this machine');
  });
});
