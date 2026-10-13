import { describe, expect, it } from 'bun:test';
import { itemFromHash, itemHref } from '../../../../../src/features/fleet/components/machine-links.ts';

describe('machine links', () => {
  it('reads the page a link names on its own tab only', () => {
    expect(itemFromHash('#machines/studio-mac/profiles/Default', 'profiles')).toBe('Default');
    expect(itemFromHash('machines/studio-mac/components/mcp%2Fgithub', 'components')).toBe('mcp/github');
    expect(itemFromHash('#machines/studio-mac/profiles/Default', 'components')).toBeUndefined();
    expect(itemFromHash('#machines/studio-mac/profiles', 'profiles')).toBeUndefined();
    expect(itemFromHash('#machines/studio-mac/profiles/', 'profiles')).toBeUndefined();
    expect(itemFromHash('#daemons/x/profiles/Default', 'profiles')).toBeUndefined();
    expect(itemFromHash('#machines/studio-mac/profiles/%E0%A4%A', 'profiles')).toBeUndefined();
  });

  it('writes the address of one page', () => {
    expect(itemHref('studio mac', 'components', 'mcp/github')).toBe('#machines/studio%20mac/components/mcp%2Fgithub');
  });
});
