import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MACHINE_TAB,
  isMachineTabId,
  MACHINE_TABS,
  machineHash,
  parseMachineHash,
} from '../../../../../../app/features/fleet/shell/machine-route.ts';

describe('machine route', () => {
  it('names the six tabs by what a person looks for, Browser before Machine', () => {
    expect(MACHINE_TABS.map(tab => tab.label)).toEqual([
      'Runtimes',
      'Agents',
      'Sign-ins',
      'Profiles',
      'Browser',
      'Machine',
    ]);
    expect(DEFAULT_MACHINE_TAB).toBe('runtimes');
    expect(isMachineTabId('profiles')).toBe(true);
    expect(isMachineTabId('sign-ins')).toBe(true);
    expect(isMachineTabId('browser')).toBe(true);
    expect(isMachineTabId('accounts')).toBe(false);
    expect(isMachineTabId('credentials')).toBe(false);
    expect(isMachineTabId('components')).toBe(false);
  });

  it('round-trips a machine name and a tab, including names a link must escape', () => {
    const hash = machineHash('studio mac/2', 'sign-ins');
    expect(hash).toBe('#machines/studio%20mac%2F2/sign-ins');
    expect(parseMachineHash(hash)).toEqual({ machine: 'studio mac/2', tab: 'sign-ins' });
  });

  it('opens the surface on its default tab for a bare, stale or damaged link', () => {
    expect(parseMachineHash('#machines')).toEqual({ tab: 'runtimes' });
    expect(parseMachineHash('machines/studio')).toEqual({ machine: 'studio', tab: 'runtimes' });
    expect(parseMachineHash('#machines/studio/accounts')).toEqual({ machine: 'studio', tab: 'runtimes' });
    expect(parseMachineHash('#machines/%E0%A4%A/profiles')).toEqual({ tab: 'profiles' });
  });

  it('is not this surface for any other hash', () => {
    expect(parseMachineHash('')).toBeNull();
    expect(parseMachineHash('#daemons')).toBeNull();
    expect(parseMachineHash('#machinesx/a/runtimes')).toBeNull();
  });
});
