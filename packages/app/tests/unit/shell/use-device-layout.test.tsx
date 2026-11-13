import { describe, expect, test } from 'bun:test';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { DEFAULT_LAYOUT } from '../../../src/layout/layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { ShellProvider, type ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { type DeviceLayout, useDeviceLayout } from '../../../src/shell/use-device-layout.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE } from '../client/fixtures.ts';

/**
 * THE DEVICE'S OWN LAYOUT, for a plugin's Settings tab: what this browser changed on top of the owner's layout, the
 * layout in force, and the two edits the command bar also makes. A device's choice is the app's saved data and has
 * no route, so this hook is the one place a half can reach it.
 */

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};

function Probe({ into }: { readonly into: { current: DeviceLayout | undefined } }) {
  into.current = useDeviceLayout();
  return <p data-testid="probe">{into.current?.inForce.nav.side ?? 'outside'}</p>;
}

const shell = (storage: ReturnType<typeof memoryStore>) => {
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces: [...CORE],
    daemons: new DaemonList({ storage, now: () => 1 }),
    connect: async () => {
      throw new Error('no daemon');
    },
  });
  return { runtime, layouts: new DeviceLayoutStore(storage), themes: new ThemePreferenceStore(storage) };
};

describe('useDeviceLayout', () => {
  test('outside a shell there is no device choice to edit', async () => {
    const seen: { current: DeviceLayout | undefined } = { current: undefined };
    const view = await mount(<Probe into={seen} />);
    expect(seen.current).toBeUndefined();
    expect(view.container.textContent).toBe('outside');
    await view.unmount();
  });

  test('a change is laid over the built-in default, saved in the app, and drawn at once; reset follows the owner again', async () => {
    const storage = memoryStore();
    const parts = shell(storage);
    const seen: { current: DeviceLayout | undefined } = { current: undefined };
    const view = await mount(
      <ShellProvider
        runtime={parts.runtime}
        themes={parts.themes}
        layouts={parts.layouts}
        browser={browser}
        scroll={new ScrollMemory(null)}
      >
        <Probe into={seen} />
      </ShellProvider>,
    );
    expect(seen.current?.base).toEqual(DEFAULT_LAYOUT);
    expect(seen.current?.overrides).toEqual({});
    expect(seen.current?.refused).toBeUndefined();

    let refusal: string | undefined = 'untouched';
    await interact(() => {
      refusal = seen.current?.set('nav.side', 'right');
    });
    expect(refusal).toBeUndefined();
    expect(seen.current?.overrides).toEqual({ nav: { side: 'right' } });
    expect(new DeviceLayoutStore(storage).snapshot()).toEqual({ nav: { side: 'right' } });

    await interact(() => {
      refusal = seen.current?.set('nav.side', 'sideways');
    });
    expect(refusal).toBeString();
    expect(seen.current?.overrides).toEqual({ nav: { side: 'right' } });

    await interact(() => seen.current?.reset());
    expect(seen.current?.overrides).toEqual({});
    expect(new DeviceLayoutStore(storage).snapshot()).toEqual({});
    await view.unmount();
  });
});
