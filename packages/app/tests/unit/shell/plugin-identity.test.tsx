import { afterEach, describe, expect, test } from 'bun:test';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { useAppHook } from '../../../src/shell/app-hooks.ts';
import { type ShellWindow, WithoutShell } from '../../../src/shell/context.tsx';
import { type DaemonReach, useEveryDaemon } from '../../../src/shell/every-daemon.ts';
import { identityOf, type PluginPlace, WithPluginIdentity } from '../../../src/shell/plugin-identity.tsx';
import { memoryStore } from '../../../src/storage/records.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { drawn, OWN_HOOK, SEND, settle, setup } from './reach-fixtures.tsx';

/**
 * WHO IS CALLING, AND FROM WHERE (shell contract §1.1, MA4): the plugin-identity context every place sets. A daemon-less
 * screen has no reach, so `useEveryDaemon` answers `[]` there; a device view or device panel is drawn under
 * `WithoutShell` and still reaches its OWN plugin's rows; a background view's rows are background-origin entries.
 */

const seen: { rows: readonly DaemonReach[]; hook?: unknown } = { rows: [] };
function Probe() {
  seen.rows = useEveryDaemon();
  seen.hook = useAppHook('d1', OWN_HOOK);
  return <p data-testid="rows">{seen.rows.length}</p>;
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  seen.rows = [];
  delete seen.hook;
  drawn.landing = () => null;
  window.history.replaceState({}, '', '/');
});

/** Draws the probe as a place of the frame root would: under `WithoutShell`, inside the plugin's identity. */
async function drawAt(parts: ReturnType<typeof setup>, plugin: string, place: PluginPlace): Promise<Mounted> {
  view = await mount(
    <WithPluginIdentity identity={identityOf(parts.runtime, plugin, place)}>
      <WithoutShell>
        <Probe />
      </WithoutShell>
    </WithPluginIdentity>,
  );
  await interact(settle);
  return view;
}

describe('a daemon-less screen', () => {
  test('gets no machine: [] with two machines paired, no app hook, and nothing is dialled for it', async () => {
    const parts = setup();
    await parts.connectAll();
    drawn.landing = () => <Probe />;
    const browser: ShellWindow = {
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      document: { documentElement: document.documentElement },
    };
    const before = ['d1', 'd2'].map(id => parts.machine(id).transport.paths().length);
    window.history.replaceState({}, '', '/landing');
    const storage = memoryStore();
    view = await mount(
      <App
        runtime={parts.runtime}
        themes={new ThemePreferenceStore(storage)}
        layouts={new DeviceLayoutStore(storage)}
        browser={browser}
        scroll={new ScrollMemory(null)}
      />,
    );
    await interact(settle);
    expect(view.container.querySelector('[data-testid="rows"]')?.textContent).toBe('0');
    expect(seen.hook).toBeUndefined();
    // Both machines answer rows to a per-daemon place of the same plugin; the screen still has none.
    expect(parts.runtime.reach('conv', 'ordinary').rows()).toHaveLength(2);
    // The shell dials nothing for it: what it sent is only the frame's own (the selected machine's) reads.
    expect(parts.machine('d2').transport.paths().length).toBe(before[1] ?? 0);
  });

  test('its identity has no reach at all, so nothing can be read from it', () => {
    const parts = setup();
    const identity = identityOf(parts.runtime, 'conv', 'daemonless');
    expect('reach' in identity).toBe(false);
    expect(identity).toEqual({ plugin: 'conv', place: 'daemonless' });
  });
});

describe('device views and device panels, under WithoutShell', () => {
  for (const place of ['device', 'device-panel'] as const) {
    test(`a ${place} gets its own plugin's rows only, and useAppHook answers undefined there`, async () => {
      const parts = setup();
      await parts.connectAll();
      await drawAt(parts, 'conv', place);
      expect(seen.rows.map(row => row.daemon).toSorted()).toEqual(['d1', 'd2']);
      for (const row of seen.rows) expect(row.client).toBe(parts.runtime.client(row.daemon, 'conv') as never);
      for (const row of seen.rows) expect(row.client).not.toBe(parts.runtime.client(row.daemon, 'other') as never);
      // R3 m6: the shell context is hidden, so a daemon argument reaches nothing...
      expect(seen.hook).toBeUndefined();
      // ...and the plugin's own store on a machine comes only through its row (m9).
      expect(seen.rows.find(row => row.daemon === 'd1')?.hook(OWN_HOOK)).toEqual({ daemon: 'd1' });
    });
  }

  test('another plugin in the same kind of place gets its rows, never the first one’s', async () => {
    const parts = setup();
    parts.machine('d1').off.add('other');
    await parts.connectAll();
    await drawAt(parts, 'other', 'device');
    expect(seen.rows.map(row => row.daemon)).toEqual(['d2']);
    expect(seen.rows[0]?.client).toBe(parts.runtime.client('d2', 'other') as never);
  });
});

describe('a background place', () => {
  test("every row's client is the cache's background entry, and a POST to a locked machine raises no explicit prompt", async () => {
    const parts = setup();
    parts.machine('d1').locked = true;
    parts.machine('d2').locked = true;
    await parts.connectAll();
    await drawAt(parts, 'conv', 'background');
    expect(seen.rows).toHaveLength(2);
    for (const row of seen.rows) {
      expect(row.client).toBe(parts.runtime.client(row.daemon, 'conv', 'background') as never);
      expect(row.client).not.toBe(parts.runtime.client(row.daemon, 'conv') as never);
    }
    for (const row of seen.rows) await expect(row.client.call(SEND, { body: { text: 'hi' } })).rejects.toBeDefined();
    expect(parts.prompts.map(prompt => prompt.origin)).toEqual(['background', 'background']);
  });
});

describe('outside every place', () => {
  test('a plugin drawn in its own harness (no identity) gets []', async () => {
    view = await mount(<Probe />);
    expect(seen.rows).toEqual([]);
  });
});
