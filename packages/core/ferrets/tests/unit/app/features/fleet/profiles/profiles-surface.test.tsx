import { afterEach, describe, expect, it } from 'bun:test';
import { ProfilesSurface } from '../../../../../../app/features/fleet/profiles/profiles-surface.tsx';
import { DaemonConnectionStore } from '../../../../../src/lib/connections.ts';
import { daemonConnection } from '../../../../../../app/lib/daemon-connection.ts';
import { type AppStore, StoreProvider } from '../../../../../src/lib/store.tsx';
import { type Mounted, must } from '../../../../support/dom.ts';
import { click, followHash, mountSettled, scriptedMachine, tabProps, text } from '../components/view-support.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const open = async (): Promise<HTMLElement> => {
  mounted = await mountSettled(
    <ProfilesSurface {...tabProps(scriptedMachine())} machineNames={new Map([['studio', 'studio-mac']])} />,
  );
  return mounted.container;
};

const section = (root: HTMLElement, name: 'profiles' | 'components'): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[data-profiles-section="${name}"]`), `the ${name} section`);

describe('ProfilesSurface', () => {
  it('holds the profiles, and under them the components they are built from', async () => {
    const root = await open();
    const [first, second] = [...root.querySelectorAll('[data-profiles-section]')];
    expect(first?.getAttribute('data-profiles-section')).toBe('profiles');
    expect(second?.getAttribute('data-profiles-section')).toBe('components');
    expect(section(root, 'profiles').querySelector('[data-profile-row]')).not.toBeNull();
    expect(text(section(root, 'components'), 'h3')).toBe('Built from');
    expect(section(root, 'components').querySelector('[data-component-kind]')).not.toBeNull();
    expect(section(root, 'profiles').hidden).toBe(false);
    expect(section(root, 'components').hidden).toBe(false);
  });

  it('reads machine names from the connection list when the shell supplies none', async () => {
    const work = daemonConnection({ daemonId: 'sha256:work', baseUrl: 'https://work.example.test', deviceId: 'd' });
    const connections = new DaemonConnectionStore({
      connections: [{ ...work, label: 'Work laptop', pairedAt: 1, lastSelectedAt: 1 }],
      selectedDaemonId: work.daemonId,
    });
    mounted = await mountSettled(
      <StoreProvider store={{ connections } as unknown as AppStore}>
        <ProfilesSurface {...tabProps(scriptedMachine())} />
      </StoreProvider>,
    );
    const root = mounted.container;
    expect(text(section(root, 'components'), 'h3')).toBe('Built from');
    expect(section(root, 'components').querySelector('[data-component-kind]')).not.toBeNull();
  });

  it('gives a profile’s page the whole tab, and the components return on the list', async () => {
    const root = await open();
    await followHash('#machines/studio-mac/profiles/Default');
    expect(section(root, 'profiles').querySelector('[data-profiles-page="detail"]')).not.toBeNull();
    expect(section(root, 'profiles').hidden).toBe(false);
    expect(section(root, 'components').hidden).toBe(true);
    await click(section(root, 'profiles'), '[data-catalog-back]');
    expect(section(root, 'components').hidden).toBe(false);
    expect(section(root, 'profiles').querySelector('[data-profile-row]')).not.toBeNull();
  });

  it('gives a component’s page the whole tab, and the profiles return on the list', async () => {
    const root = await open();
    await followHash(`#machines/studio-mac/profiles/${encodeURIComponent('mcp/github')}`);
    expect(section(root, 'components').querySelector('[data-components-page="detail"]')).not.toBeNull();
    expect(section(root, 'components').hidden).toBe(false);
    expect(section(root, 'profiles').hidden).toBe(true);
    await click(section(root, 'components'), '[data-catalog-back]');
    expect(section(root, 'components').querySelector('[data-components-page="list"]')).not.toBeNull();
    expect(section(root, 'profiles').hidden).toBe(true);
    await click(section(root, 'components'), '[data-catalog-back]');
    expect(section(root, 'profiles').hidden).toBe(false);
    expect(section(root, 'components').querySelector('[data-components-page="kinds"]')).not.toBeNull();
  });

  it('keeps the profiles list when an address names a component, and the other way round', async () => {
    window.history.replaceState(null, '', `/#machines/studio-mac/profiles/${encodeURIComponent('mcp/github')}`);
    const root = await open();
    expect(section(root, 'profiles').querySelector('[data-profiles-page="list"]')).not.toBeNull();
    await followHash('#machines/studio-mac/profiles/Default');
    expect(section(root, 'components').querySelector('[data-components-page="kinds"]')).not.toBeNull();
  });
});
