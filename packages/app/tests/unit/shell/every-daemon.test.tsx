import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { usePairedDaemons } from '../../../src/shell/daemon-access.ts';
import { type DaemonReach, useEveryDaemon } from '../../../src/shell/every-daemon.ts';
import { controlState } from '../../../src/shell/view-place.tsx';
import { memoryStore } from '../../../src/storage/records.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { builds, drawn, MEMORY, OTHER_HOOK, OWN_HOOK, READ, settle, setup } from './reach-fixtures.tsx';

/**
 * THE SAME PLUGIN ON EVERY MACHINE (shell contract S2): `useEveryDaemon()` answers one row per paired daemon where the
 * calling plugin is on and allowed, each carrying S1's place for that machine and the plugin's OWN client from the
 * one client cache — the same object for the connection's life.
 */

const rowsOf = (parts: ReturnType<typeof setup>, origin: 'ordinary' | 'background' = 'ordinary') =>
  parts.runtime.reach('conv', origin).rows();
const rowFor = (parts: ReturnType<typeof setup>, daemon: string): DaemonReach => {
  const found = rowsOf(parts).find(row => row.daemon === daemon);
  if (found === undefined) throw new Error(`no row for ${daemon}`);
  return found;
};

describe('the rows', () => {
  test('two machines, the plugin on one: one row; a plugin blocked there disappears, and returns', async () => {
    const parts = setup();
    parts.machine('d2').off.add('conv');
    await parts.connectAll();
    expect(rowsOf(parts).map(row => row.daemon)).toEqual(['d1']);
    expect(rowFor(parts, 'd1').machine).toBe('d1-host');
    parts.machine('d1').off.add('conv');
    await parts.reread('d1');
    expect(rowsOf(parts)).toEqual([]);
    parts.machine('d1').off.delete('conv');
    await parts.reread('d1');
    expect(rowsOf(parts).map(row => row.daemon)).toEqual(['d1']);
  });

  test("a row's client is the cache's own entry, once per origin", async () => {
    const parts = setup();
    await parts.connectAll();
    for (const daemon of ['d1', 'd2']) {
      const ordinary = rowsOf(parts).find(row => row.daemon === daemon)?.client;
      const background = rowsOf(parts, 'background').find(row => row.daemon === daemon)?.client;
      expect(ordinary).toBe(parts.runtime.client(daemon, 'conv') as PluginClient);
      expect(background).toBe(parts.runtime.client(daemon, 'conv', 'background') as PluginClient);
      expect(background).not.toBe(ordinary);
    }
  });

  test('a reconnect and a kernel.plugins-changed keep every row client; an unpair and re-pair gives a new one', async () => {
    const parts = setup();
    await parts.connectAll();
    const before = rowFor(parts, 'd1').client;
    const background = rowsOf(parts, 'background').find(row => row.daemon === 'd1')?.client;
    parts.machine('d1').transport.reconnect();
    await settle();
    expect(rowFor(parts, 'd1').client).toBe(before);
    parts.machine('d1').transport.emit({ name: 'kernel.plugins-changed', payload: { generation: 2 } });
    await settle();
    expect(rowFor(parts, 'd1').client).toBe(before);
    expect(rowsOf(parts, 'background').find(row => row.daemon === 'd1')?.client).toBe(background as PluginClient);
    parts.list.remove('d1');
    expect(rowsOf(parts).map(row => row.daemon)).toEqual(['d2']);
    parts.list.add({ daemon: 'd1', machine: 'd1-host', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
    rowsOf(parts);
    await settle();
    expect(rowFor(parts, 'd1').client).not.toBe(before);
  });

  test('the same array and rows until one moves; a machine whose feed drops keeps its row, offline', async () => {
    const parts = setup();
    await parts.connectAll();
    const first = rowsOf(parts);
    expect(rowsOf(parts)).toBe(first);
    parts.machine('d1').transport.openFeed();
    await settle();
    const live = rowsOf(parts);
    expect(live).not.toBe(first);
    expect(live.find(row => row.daemon === 'd1')?.online).toBe(true);
    // The other machine's row did not move, so it is the same object.
    expect(live.find(row => row.daemon === 'd2')).toBe(first.find(row => row.daemon === 'd2') as DaemonReach);
    parts.machine('d1').transport.dropFeed();
    await settle();
    expect(rowFor(parts, 'd1').online).toBe(false);
    // A change that moves no row (another plugin's own runtime signal) keeps the array.
    const held = rowsOf(parts);
    parts.runtime.noteConfirmed('nowhere');
    expect(rowsOf(parts)).toBe(held);
  });

  test("a row's authority is S1's for that machine: a view-only machine hides the control", async () => {
    const parts = setup();
    parts.machine('d2').configure = false;
    await parts.connectAll();
    expect(controlState(rowFor(parts, 'd1').authorityOf(MEMORY))).toMatchObject({ shown: true, enabled: true });
    expect(controlState(rowFor(parts, 'd2').authorityOf(MEMORY)).shown).toBe(false);
    expect(rowFor(parts, 'd2').authority('fleet', 'configure')).toEqual({ kind: 'refused', refusal: 'not-granted' });
  });
});

describe('locked machines, press and unlock', () => {
  test('a locked machine reads locked with no prompt; unlock for B asks at once, releases B, and never moves focus', async () => {
    const parts = setup();
    parts.machine('d2').locked = true;
    await parts.connectAll();
    expect(rowFor(parts, 'd2').locked).toBe(true);
    expect(rowFor(parts, 'd1').locked).toBe(false);
    expect(parts.prompts).toEqual([]);
    parts.answer(true);
    expect(await rowFor(parts, 'd2').unlock()).toBe(true);
    await settle();
    expect(parts.prompts).toEqual([{ need: { kind: 'unlock' }, origin: 'explicit', daemon: 'd2' }]);
    expect(rowFor(parts, 'd2').locked).toBe(false);
    // A's prompts still work: a background read on A, now locked, still asks on A.
    parts.answer(false);
    parts.machine('d1').locked = true;
    const onA = rowsOf(parts, 'background').find(row => row.daemon === 'd1');
    await expect(onA?.client.call(READ)).rejects.toBeDefined();
    expect(parts.prompts.at(-1)).toMatchObject({ origin: 'background', daemon: 'd1' });
    expect(parts.focused).toEqual([]);
  });

  test('a press on an off-screen locked row whose act starts with a GET asks first; dismissed runs nothing', async () => {
    const parts = setup();
    parts.machine('d2').locked = true;
    await parts.connectAll();
    const row = rowFor(parts, 'd2');
    const sent = (): number =>
      parts
        .machine('d2')
        .transport.paths()
        .filter(path => path === READ).length;
    let ran = 0;
    const act = async () => {
      ran += 1;
      return await row.client.call<{ ok: boolean }>(READ);
    };
    expect(await row.press(act)).toBeUndefined();
    expect(ran).toBe(0);
    expect(sent()).toBe(0);
    expect(parts.prompts).toEqual([{ need: { kind: 'unlock' }, origin: 'explicit', daemon: 'd2' }]);
    parts.answer(true);
    expect(await row.press(act)).toEqual({ ok: true });
    expect(ran).toBe(1);
    expect(sent()).toBe(1);
  });

  test('a press on an unlocked row runs the act at once', async () => {
    const parts = setup();
    await parts.connectAll();
    expect(await rowFor(parts, 'd1').press(async () => 'done')).toBe('done');
    expect(parts.prompts).toEqual([]);
  });
});

describe('hook', () => {
  test("a row's own hook is the store the half's views read; another plugin's hook answers undefined", async () => {
    builds.length = 0;
    const parts = setup();
    await parts.connectAll();
    const own = rowFor(parts, 'd1').hook(OWN_HOOK);
    expect(own).toBe(parts.runtime.appHook('d1', OWN_HOOK));
    expect(own).toEqual({ daemon: 'd1' });
    // One store per machine: built once on d1, over conv's own ordinary client.
    expect(builds.filter(build => build.daemon === 'd1')).toHaveLength(1);
    expect(builds.find(build => build.daemon === 'd1')?.client).toBe(rowFor(parts, 'd1').client);
    expect(parts.runtime.appHook('d1', OTHER_HOOK)).toEqual({ other: true });
    expect(rowFor(parts, 'd1').hook(OTHER_HOOK)).toBeUndefined();
    expect(rowFor(parts, 'd1').hook('nobody.provides')).toBeUndefined();
  });
});

describe('in a per-daemon view', () => {
  const browser: ShellWindow = {
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    document: { documentElement: document.documentElement },
  };
  let view: Mounted | null = null;
  afterEach(async () => {
    await view?.unmount();
    view = null;
    window.history.replaceState({}, '', '/');
    drawn.screen = () => null;
  });

  test("a screen's rows list every machine with the plugin on, and the screen's own machine row is its prop client", async () => {
    const parts = setup(['d1', 'd2', 'd3']);
    parts.machine('d3').off.add('conv');
    const seen: { rows: readonly DaemonReach[]; client?: PluginClient; paired: number } = { rows: [], paired: 0 };
    drawn.screen = client => {
      const Probe = () => {
        seen.rows = useEveryDaemon();
        seen.paired = usePairedDaemons().length;
        seen.client = client;
        return <p data-testid="rows">{seen.rows.map(row => row.machine).join(',')}</p>;
      };
      return <Probe />;
    };
    window.history.replaceState({}, '', '/d/d1/main');
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
    // In the daemon list's order, the machine with the plugin off left out.
    const order = (on: readonly string[]) =>
      parts.list
        .snapshot()
        .daemons.filter(paired => on.includes(paired.daemon))
        .map(paired => paired.machine)
        .join(',');
    expect(view.container.querySelector('[data-testid="rows"]')?.textContent).toBe(order(['d1', 'd2']));
    expect(seen.paired).toBe(3);
    expect(seen.rows.find(row => row.daemon === 'd1')?.client).toBe(seen.client as PluginClient);
    // Live: a machine turning the plugin on draws its row.
    parts.machine('d3').off.delete('conv');
    await interact(() => parts.reread('d3'));
    expect(view.container.querySelector('[data-testid="rows"]')?.textContent).toBe(order(['d1', 'd2', 'd3']));
  });
});

describe('why a machine has no row (S2)', () => {
  test('a machine still connecting waits; an unpaired one and one with the plugin off say so for good', async () => {
    const parts = setup();
    parts.machine('d2').off.add('conv');
    const whyNone = parts.runtime.reach('conv', 'ordinary').whyNone;
    // Nothing is connected yet: both are still being reached.
    expect(whyNone('d1')?.waiting).toBe(true);
    await parts.connectAll();
    expect(whyNone('d1')).toBeUndefined();
    expect(whyNone('d2')).toEqual({ waiting: false, line: expect.stringContaining('is off on this daemon') });
    expect(whyNone('nobody')).toEqual({ waiting: false, line: 'This device is not paired with that machine.' });
  });
});

describe('no hook takes a package id', () => {
  test('useEveryDaemon accepts no argument (a type test)', () => {
    // Mutation row: giving `useEveryDaemon` a `packageId?` goes red under `tsc` (this line), not under `bun test`.
    // @ts-expect-error — the caller is the plugin-identity context, never a package id.
    const call = () => useEveryDaemon('conv');
    expect(typeof call).toBe('function');
  });
});
