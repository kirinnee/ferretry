import { describe, expect, it } from 'bun:test';
import {
  currentDaemon,
  followInApp,
  harnessHref,
  machineHash,
  MACHINES_SECTION,
  tabHref,
} from '../../../../../../app/features/fleet/shell/machine-route.ts';

/** A click on an anchor, as the React handler sees it. */
const click = (href: string, init: Partial<{ metaKey: boolean; button: number; defaultPrevented: boolean }> = {}) => {
  let prevented = false;
  const event = {
    metaKey: init.metaKey ?? false,
    ctrlKey: false,
    shiftKey: false,
    button: init.button ?? 0,
    defaultPrevented: init.defaultPrevented ?? false,
    currentTarget: { getAttribute: (name: string) => (name === 'href' ? href : null) },
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as Parameters<typeof followInApp>[0];
  return { event, prevented: () => prevented };
};

describe('machine route', () => {
  it('writes the hash of a tab inside a page, escaping a machine name a link must escape', () => {
    expect(MACHINES_SECTION).toBe('machines');
    expect(machineHash('studio mac/2', 'sign-ins')).toBe('#machines/studio%20mac%2F2/sign-ins');
    expect(machineHash('studio', 'model-sets')).toBe('#machines/studio/model-sets');
  });

  it('addresses another tab by its Settings path, with the item in the hash', () => {
    expect(tabHref('d1', 'studio-mac', 'profiles', 'Default')).toBe(
      '/d/d1/settings/runtimes/profiles#machines/studio-mac/profiles/Default',
    );
    expect(tabHref('d1', 'studio-mac', 'runtimes')).toBe(
      '/d/d1/settings/runtimes/runtimes#machines/studio-mac/runtimes',
    );
    expect(tabHref('d1', 'studio-mac', 'model-sets', 'Claude models')).toBe(
      '/d/d1/settings/runtimes/model-sets#machines/studio-mac/model-sets/Claude%20models',
    );
    // Sign-ins is Logins' tab, not Runtimes'.
    expect(tabHref('d 1', 'studio-mac', 'sign-ins', 'claude-work')).toBe(
      '/d/d%201/settings/logins/logins#machines/studio-mac/sign-ins/claude-work',
    );
    // A component reference keeps its slash inside one encoded segment.
    expect(tabHref('d1', 'studio-mac', 'profiles', 'mcp/github')).toBe(
      '/d/d1/settings/runtimes/profiles#machines/studio-mac/profiles/mcp%2Fgithub',
    );
  });

  it('is the hash alone outside the daemon pages, where there is no Settings page to name', () => {
    expect(tabHref(null, 'studio-mac', 'profiles', 'Default')).toBe('#machines/studio-mac/profiles/Default');
  });

  it('sends an Install link to the Settings tab of the harness plugin', () => {
    expect(harnessHref('d1', 'codex')).toBe('/d/d1/settings/codex');
    expect(harnessHref('d1', 'claude-code')).toBe('/d/d1/settings/claude-code');
  });

  it('reads the daemon from the page path, and none from any other page', () => {
    const at = (pathname: string) => ({ location: { pathname } }) as unknown as Window;
    expect(currentDaemon(at('/d/d1/settings/runtimes/runtimes'))).toBe('d1');
    expect(currentDaemon(at('/d/d%201/settings'))).toBe('d 1');
    expect(currentDaemon(at('/settings'))).toBeNull();
    expect(currentDaemon(at('/d/%E0%A4%A/settings'))).toBeNull();
  });

  it('follows an app path in place, and leaves a hash link, a new-tab click and a handled click alone', () => {
    const pushed: string[] = [];
    const events: string[] = [];
    const browser = {
      history: { pushState: (_: unknown, __: string, url: string) => pushed.push(url) },
      dispatchEvent: (event: Event) => {
        events.push(event.type);
        return true;
      },
    } as unknown as Window;

    const followed = click('/d/d1/settings/runtimes/profiles#machines/m/profiles/Default');
    followInApp(followed.event, browser);
    expect(followed.prevented()).toBe(true);
    expect(pushed).toEqual(['/d/d1/settings/runtimes/profiles#machines/m/profiles/Default']);
    expect(events).toEqual(['popstate']);

    for (const left of [
      click('#machines/m/runtimes/a'),
      click('/d/d1/settings', { metaKey: true }),
      click('/d/d1/settings', { button: 1 }),
      click('/d/d1/settings', { defaultPrevented: true }),
    ]) {
      followInApp(left.event, browser);
      expect(left.prevented()).toBe(false);
    }
    expect(pushed).toHaveLength(1);
  });
});
