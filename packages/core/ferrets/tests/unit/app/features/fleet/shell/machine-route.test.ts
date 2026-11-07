import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MACHINE_TAB,
  isMachineTabId,
  MACHINE_TABS,
  machineHash,
  parseMachineHash,
  redirectLegacyMachineHash,
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

describe('redirectLegacyMachineHash', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['the old Credentials tab', '#machines/studio/credentials', '#machines/studio/sign-ins'],
    ['a login page on it', '#machines/studio/credentials/claude-work', '#machines/studio/sign-ins/claude-work'],
    ['the old Components tab', '#machines/studio/components', '#machines/studio/profiles'],
    ['a component page on it', '#machines/studio/components/mcp%2Fgithub', '#machines/studio/profiles/mcp%2Fgithub'],
    ['the Warden panel', '#machines/studio/machine/warden', '#machines/studio/agents/warden'],
    ['Learning', '#machines/studio/machine/learning', '#machines/studio/agents/learning'],
    ['Pack mode', '#machines/studio/machine/pack', '#machines/studio/agents/pack'],
    ['Site accounts', '#machines/studio/machine/accounts', '#machines/studio/sign-ins/accounts'],
    ['Secrets', '#machines/studio/machine/secrets', '#machines/studio/sign-ins/secrets'],
    ['Secure copy', '#machines/studio/machine/secure-copy', '#machines/studio/sign-ins/secure-copy'],
    ['no leading hash', 'machines/studio/credentials', '#machines/studio/sign-ins'],
  ];

  for (const [name, from, to] of cases)
    it(`sends ${name} to its new home`, () => {
      expect(redirectLegacyMachineHash(from)).toBe(to);
    });

  it('leaves an address that is already current alone', () => {
    for (const hash of [
      '#machines/studio/runtimes',
      '#machines/studio/sign-ins',
      '#machines/studio/sign-ins/claude-work',
      '#machines/studio/profiles/mcp%2Fgithub',
      '#machines/studio/machine',
      '#machines/studio/machine/security',
      '#machines/studio/machine/setup',
      '#machines/studio/agents/warden',
      '#machines/studio/machine/unknown-word',
      '#machines/studio',
      '#machines',
      '#daemons/credentials',
      '#profiles/credentials',
    ])
      expect(redirectLegacyMachineHash(hash)).toBeNull();
  });

  it('lands a parsed legacy address on the new tab', () => {
    expect(parseMachineHash('#machines/studio/credentials/claude-work')).toEqual({
      machine: 'studio',
      tab: 'sign-ins',
    });
    expect(parseMachineHash('#machines/studio/components')).toEqual({ machine: 'studio', tab: 'profiles' });
    expect(parseMachineHash('#machines/studio/machine/warden')).toEqual({ machine: 'studio', tab: 'agents' });
  });
});
