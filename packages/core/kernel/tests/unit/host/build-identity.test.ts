import { describe, expect, it } from 'bun:test';
import { bootBuild } from '../../../host/build-identity.ts';

describe('bootBuild', () => {
  it('names the version, and is new on every boot', () => {
    const first = bootBuild('5.0.0');
    const second = bootBuild('5.0.0');
    expect(first.startsWith('5.0.0+')).toBe(true);
    expect(first).not.toBe(second);
  });

  it('is what it was given, so one boot answers the same tag on every poll', () => {
    expect(bootBuild('5.0.0', 'abc')).toBe('5.0.0+abc');
    expect(bootBuild('5.0.0', 'abc')).toBe(bootBuild('5.0.0', 'abc'));
  });
});
