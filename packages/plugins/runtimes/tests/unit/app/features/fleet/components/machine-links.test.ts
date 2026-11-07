import { describe, expect, it } from 'bun:test';
import {
  isComponentReference,
  itemFromHash,
  itemHref,
} from '../../../../../../app/features/fleet/components/machine-links.ts';
import '../../../../support/dom.ts';

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

  it('writes the address of one page: its tab’s Settings path, then the page in the hash', () => {
    expect(itemHref('studio mac', 'profiles', 'mcp/github', 'd1')).toBe(
      '/d/d1/settings/runtimes/profiles#machines/studio%20mac/profiles/mcp%2Fgithub',
    );
  });

  it('reads the daemon from the page it is drawn on', () => {
    window.history.pushState({}, '', '/d/d7/settings/runtimes/model-sets');
    try {
      expect(itemHref('studio-mac', 'runtimes', 'claude-default')).toBe(
        '/d/d7/settings/runtimes/runtimes#machines/studio-mac/runtimes/claude-default',
      );
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('the address it writes is the address it reads back', () => {
    const href = itemHref('studio-mac', 'profiles', 'mcp/github', 'd1');
    expect(itemFromHash(href.slice(href.indexOf('#')), 'profiles')).toBe('mcp/github');
  });
});

describe('isComponentReference', () => {
  it('tells a component (kind/name) from a profile (no slash) on the shared Profiles tab', () => {
    expect(isComponentReference('mcp/github')).toBe(true);
    expect(isComponentReference('Default')).toBe(false);
  });
});
