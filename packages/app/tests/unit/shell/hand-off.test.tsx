import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import type { ScreenRef } from '../../../src/layout/engine.ts';
import { HELD_FOR_MS, type HoldClock } from '../../../src/router/address.ts';
import { WithoutShell } from '../../../src/shell/context.tsx';
import { DeviceProvider, NO_INSTALL_PROMPT } from '../../../src/shell/device-context.tsx';
import { handOff, HandOffs, type OwnScreenRef, useHandOff, useOwnScreen } from '../../../src/shell/hand-off.ts';
import { type PluginIdentity, WithPluginIdentity } from '../../../src/shell/plugin-identity.tsx';
import { AddressTaker } from '../../../src/router/address.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';

/**
 * THE IN-MEMORY HAND-OFF (shell contract S3, m4): a value carried to one of the calling plugin's OWN screens, keyed by
 * (plugin, screen), taken once, dropped on any other navigation and after two minutes, never in `history.state`. A
 * view of another plugin — even one with a screen of the same id — gets `undefined`.
 */

const screens = new Map<string, ScreenRef>([
  ['catalogs.join', { plugin: 'catalogs', id: 'join', path: '/join', label: 'Join' }],
  ['catalogs.sharing', { plugin: 'catalogs', id: 'sharing', path: 'sharing', label: 'Sharing' }],
  ['other.join', { plugin: 'other', id: 'join', path: '/other-join', label: 'Join' }],
]);
const screenOf = (plugin: string, screen: string) => screens.get(`${plugin}.${screen}`);

function clock(): HoldClock & { advance: (ms: number) => void } {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    after: (delayMs, run) => void timers.push({ at: now + delayMs, run }),
    advance: ms => {
      now += ms;
      for (const timer of timers.filter(t => t.at <= now)) timer.run();
    },
  };
}

describe('HandOffs', () => {
  test('a value given to a minted ref is peeked by its own plugin only, and gone once consumed', () => {
    const holder = new HandOffs(screenOf, clock());
    const join = holder.ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    expect(holder.ref<string>('catalogs', 'join')).toBe(join);
    holder.give(join, 'share-code');
    expect(holder.peek(join, 'other')).toBeUndefined();
    expect(holder.peek(join, 'catalogs')).toBe('share-code');
    holder.consume(join, 'other');
    expect(holder.peek(join, 'catalogs')).toBe('share-code');
    holder.consume(join, 'catalogs');
    expect(holder.peek(join, 'catalogs')).toBeUndefined();
  });

  test('another plugin with a screen of the same id never gets it', () => {
    const holder = new HandOffs(screenOf, clock());
    const mine = holder.ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    const theirs = holder.ref<string>('other', 'join') as OwnScreenRef<string>;
    handOff(mine, 'share-code');
    expect(holder.peek(theirs, 'other')).toBeUndefined();
    expect(holder.peek(mine, 'catalogs')).toBe('share-code');
  });

  test('a ref the holder did not mint carries nothing, and a screen the plugin lacks has no ref', () => {
    const holder = new HandOffs(screenOf, clock());
    const forged = Object.freeze({ plugin: 'catalogs', screen: 'join' });
    handOff(forged, 'share-code');
    holder.give(forged, 'share-code');
    const real = holder.ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    expect(holder.peek(real, 'catalogs')).toBeUndefined();
    expect(holder.peek(forged, 'catalogs')).toBeUndefined();
    // A value given through the real ref is still not read through a forged one naming the same screen.
    holder.give(real, 'share-code');
    expect(holder.peek(forged, 'catalogs')).toBeUndefined();
    expect(holder.peek(real, 'catalogs')).toBe('share-code');
    holder.consume(real, 'catalogs');
    expect(holder.ref('catalogs', 'ghost')).toBeUndefined();
    // Another holder's ref is not this one's.
    const elsewhere = new HandOffs(screenOf, clock()).ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    holder.give(elsewhere, 'x');
    expect(holder.peek(elsewhere, 'catalogs')).toBeUndefined();
  });

  test('it is dropped on a navigation to any other address, and kept on the screen’s own', () => {
    const holder = new HandOffs(screenOf, clock());
    const join = holder.ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    holder.give(join, 'share-code');
    holder.navigated('/app/join');
    expect(holder.peek(join, 'catalogs')).toBe('share-code');
    holder.navigated('/shared');
    expect(holder.peek(join, 'catalogs')).toBeUndefined();
    const sharing = holder.ref<number>('catalogs', 'sharing') as OwnScreenRef<number>;
    holder.give(sharing, 7);
    holder.navigated('/d/d1/sharing');
    expect(holder.peek(sharing, 'catalogs')).toBe(7);
  });

  test('it expires after two minutes, and an old timer does not drop a newer value', () => {
    const time = clock();
    const holder = new HandOffs(screenOf, time);
    const join = holder.ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    holder.give(join, 'first');
    time.advance(HELD_FOR_MS / 2);
    holder.give(join, 'second');
    time.advance(HELD_FOR_MS / 2);
    expect(holder.peek(join, 'catalogs')).toBe('second');
    time.advance(HELD_FOR_MS / 2);
    expect(holder.peek(join, 'catalogs')).toBeUndefined();
  });

  test('a take checks the clock even when the timer never ran', () => {
    let now = 0;
    const holder = new HandOffs(screenOf, { now: () => now, after: () => {} });
    const join = holder.ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    holder.give(join, 'share-code');
    now = HELD_FOR_MS;
    expect(holder.peek(join, 'catalogs')).toBeUndefined();
  });
});

describe('useOwnScreen, handOff and useHandOff in views', () => {
  let view: Mounted | null = null;
  afterEach(async () => {
    await view?.unmount();
    view = null;
  });

  const holder = (): HandOffs => new HandOffs(screenOf, clock());
  const deviceWith = (handOffs: HandOffs) => ({
    theme: new ThemePreferenceStore(memoryStore()),
    systemDark: false,
    install: NO_INSTALL_PROMPT,
    address: new AddressTaker([]),
    handOffs,
    daemons: new DaemonList({ storage: memoryStore(), now: () => 1 }),
  });
  const draw = (handOffs: HandOffs, identity: PluginIdentity | null, children: ReactNode) =>
    mount(
      <DeviceProvider value={deviceWith(handOffs)}>
        {identity === null ? (
          children
        ) : (
          <WithPluginIdentity identity={identity}>
            <WithoutShell>{children}</WithoutShell>
          </WithPluginIdentity>
        )}
      </DeviceProvider>,
    );

  test('the giver hands its own screen a value; that screen takes it on its first commit, once', async () => {
    const handOffs = holder();
    const got: { ref?: OwnScreenRef<string> | undefined; taken: (string | undefined)[] } = { taken: [] };
    function Giver() {
      got.ref = useOwnScreen<string>('join');
      return null;
    }
    function Taker() {
      const ref = useOwnScreen<string>('join');
      got.taken.push(useHandOff(ref));
      return null;
    }
    view = await draw(handOffs, { plugin: 'catalogs', place: 'daemon' }, <Giver />);
    handOff(got.ref as OwnScreenRef<string>, 'share-code');
    await view.unmount();
    view = await draw(handOffs, { plugin: 'catalogs', place: 'daemonless', screen: 'join' }, <Taker />);
    expect(got.taken.at(-1)).toBe('share-code');
    await view.unmount();
    // A second mount of the same screen takes nothing: it was taken once.
    got.taken.length = 0;
    view = await draw(handOffs, { plugin: 'catalogs', place: 'daemonless', screen: 'join' }, <Taker />);
    expect(got.taken.length).toBeGreaterThan(0);
    expect(got.taken.every(value => value === undefined)).toBe(true);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain('share-code');
  });

  test('another plugin’s view, holding a ref to the same screen, gets undefined', async () => {
    const handOffs = holder();
    const join = handOffs.ref<string>('catalogs', 'join') as OwnScreenRef<string>;
    handOff(join, 'share-code');
    const taken: (string | undefined)[] = [];
    function Thief() {
      taken.push(useHandOff(join));
      return null;
    }
    view = await draw(handOffs, { plugin: 'other', place: 'daemonless', screen: 'join' }, <Thief />);
    expect(taken.every(value => value === undefined)).toBe(true);
    expect(handOffs.peek(join, 'catalogs')).toBe('share-code');
  });

  test('outside any place, or outside a shell, there is no ref and nothing is taken', async () => {
    const results: unknown[] = [];
    function Bare() {
      const ref = useOwnScreen<string>('join');
      results.push(ref, useHandOff(ref));
      return null;
    }
    view = await draw(holder(), null, <Bare />);
    await interact(() => {});
    expect(results.every(value => value === undefined)).toBe(true);
    await view.unmount();
    results.length = 0;
    view = await mount(
      <WithPluginIdentity identity={{ plugin: 'catalogs', place: 'daemon' }}>
        <Bare />
      </WithPluginIdentity>,
    );
    expect(results.every(value => value === undefined)).toBe(true);
  });
});
