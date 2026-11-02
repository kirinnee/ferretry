import { describe, expect, it } from 'bun:test';
import {
  isComponentReference,
  itemFromHash,
  itemHref,
} from '../../../../../src/features/fleet/components/machine-links.ts';

describe('machine links', () => {
  it('reads the page a link names on its own tab only', () => {
    expect(itemFromHash('#machines/studio-mac/profiles/Default', 'profiles')).toBe('Default');
    expect(itemFromHash('machines/studio-mac/profiles/mcp%2Fgithub', 'profiles')).toBe('mcp/github');
    expect(itemFromHash('#machines/studio-mac/profiles/Default', 'sign-ins')).toBeUndefined();
    expect(itemFromHash('#machines/studio-mac/profiles', 'profiles')).toBeUndefined();
    expect(itemFromHash('#machines/studio-mac/profiles/', 'profiles')).toBeUndefined();
    expect(itemFromHash('#daemons/x/profiles/Default', 'profiles')).toBeUndefined();
    expect(itemFromHash('#machines/studio-mac/profiles/%E0%A4%A', 'profiles')).toBeUndefined();
  });

  it('writes the address of one page', () => {
    expect(itemHref('studio mac', 'profiles', 'mcp/github')).toBe('#machines/studio%20mac/profiles/mcp%2Fgithub');
  });
});

describe('isComponentReference', () => {
  it('tells a component (kind/name) from a profile (no slash) on the shared Profiles tab', () => {
    expect(isComponentReference('mcp/github')).toBe(true);
    expect(isComponentReference('Default')).toBe(false);
  });
});
