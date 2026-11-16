import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ProfilesTab } from '../../../../../../app/features/fleet/profiles/profiles-tab.tsx';
import { type Mounted, must } from '../../../../support/dom.ts';
import {
  click,
  followHash,
  mountSettled,
  scriptedMachine,
  TAB_PATH,
  tabProps,
  text,
} from '../components/view-support.tsx';

/**
 * Today's Profiles surface held the profiles with, under them, the components they are built from. Runtimes now draws
 * only the profiles: the components are the plugins' own tabs, so the cases about the "Built from" section are skipped
 * with the plugin that owns them, and the cases about which page the address names run on the Profiles tab alone.
 */

let mounted: Mounted | undefined;
beforeEach(() => window.history.replaceState(null, '', TAB_PATH));
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const open = async (): Promise<HTMLElement> => {
  mounted = await mountSettled(<ProfilesTab {...tabProps(scriptedMachine())} />);
  return mounted.container;
};

const page = (root: HTMLElement): string | null =>
  must(root.querySelector('[data-profiles-page]'), 'the profiles page').getAttribute('data-profiles-page');

describe('ProfilesSurface', () => {
  it.skip('holds the profiles, and under them the components they are built from … pending port: the component kinds are the other plugins’ tabs', () => {});
  it.skip('reads machine names from the connection list when the shell supplies none … pending port: the "Built from" section and the shell connection list', () => {});

  it('gives a profile’s page the whole tab, and the list returns on Back', async () => {
    const root = await open();
    expect(page(root)).toBe('list');
    expect(root.querySelector('[data-profile-row]')).not.toBeNull();
    await followHash('#machines/studio-mac/profiles/Default');
    expect(page(root)).toBe('detail');
    expect(text(root, 'h3')).toBe('Default');
    expect(root.querySelector('[data-profile-row]')).toBeNull();
    await click(root, '[data-catalog-back]');
    expect(page(root)).toBe('list');
    expect(root.querySelector('[data-profile-row]')).not.toBeNull();
  });

  it.skip('gives a component’s page the whole tab, and the profiles return on the list … pending port: the component pages are the other plugins’ tabs', () => {});

  it('keeps the profiles list when an address names a component, and opens a profile the address names after it', async () => {
    window.history.replaceState(
      null,
      '',
      `${TAB_PATH}#machines/studio-mac/profiles/${encodeURIComponent('mcp/github')}`,
    );
    const root = await open();
    expect(page(root)).toBe('list');
    await followHash('#machines/studio-mac/profiles/Default');
    expect(page(root)).toBe('detail');
    expect(text(root, 'h3')).toBe('Default');
  });
});
