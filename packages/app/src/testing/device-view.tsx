import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import type { ScreenRef } from '../layout/engine.ts';
import { DaemonList } from '../daemons/daemon-list.ts';
import { AddressTaker, type FragmentDecl } from '../router/address.ts';
import { WithoutShell } from '../shell/context.tsx';
import { DeviceProvider, NO_INSTALL_PROMPT } from '../shell/device-context.tsx';
import type { DaemonReach } from '../shell/every-daemon.ts';
import { HandOffs } from '../shell/hand-off.ts';
import { WithPluginIdentity } from '../shell/plugin-identity.tsx';
import type { Authority } from '../shell/view-place.tsx';
import { memoryStore } from '../storage/records.ts';
import { ThemePreferenceStore } from '../theme/preferences.ts';

/**
 * A PLUGIN'S DEVICE VIEW, DRAWN AS THE SHELL DRAWS IT (shell contract S3), for the plugin's own suite: under
 * `WithoutShell`, inside the plugin's identity (`place: 'device'`) with the rows a test hands it, and with the shell's
 * REAL fragment taker over the plugin's declarations — so a suite runs its real link builder through the same strip
 * and hold the shell does, and reads what reaches its view.
 */

const OPEN: Authority = Object.freeze({ kind: 'open' });
const LOCKED: Authority = Object.freeze({ kind: 'locked' });

/** One machine's row as `useEveryDaemon` answers it, with everything a test does not name open and online. */
export function fakeReachRow(row: {
  readonly daemon: string;
  readonly client: PluginClient;
  readonly machine?: string;
  readonly online?: boolean;
  readonly locked?: boolean;
  readonly hook?: (name: string) => unknown;
}): DaemonReach {
  return Object.freeze({
    daemon: row.daemon,
    machine: row.machine ?? row.daemon,
    online: row.online ?? true,
    locked: row.locked ?? false,
    authority: () => (row.locked === true ? LOCKED : OPEN),
    authorityOf: () => (row.locked === true ? LOCKED : OPEN),
    unlock: async () => false,
    press: async <T,>(act: () => Promise<T>) => await act(),
    hook: row.hook ?? (() => undefined),
    client: row.client,
  });
}

export interface DeviceViewHarness {
  /**
   * Draws `children` as one of the plugin's device views — or, with `place`, as one of its per-daemon views or as its
   * daemon-less `screen` — under one device context, so a hand-off given in one is taken in another.
   */
  readonly Harness: (props: {
    readonly children: ReactNode;
    readonly place?: 'device' | 'daemon' | 'daemonless';
    readonly screen?: string;
  }) => ReactNode;
  /** The hand-offs given in these views (read with `peek`, as the taking screen would). */
  readonly handOffs: HandOffs;
  /** The machines the view lists, live. */
  readonly setRows: (rows: readonly DaemonReach[]) => void;
  /** A link arrives on the open page (a `hashchange`): the shell reads it, and a declared part leaves the address. */
  readonly arrive: (href: string) => void;
  /** What the address bar holds now (path, query and fragment). */
  readonly address: () => string;
}

export function deviceViewHarness(options: {
  readonly plugin: string;
  readonly fragments: readonly FragmentDecl[];
  /** The address the app was opened at; the shell reads it before the view is drawn. */
  readonly href?: string;
  /** The plugin's own screens, by id and path: what a hand-off may be carried to. */
  readonly screens?: readonly { readonly id: string; readonly path: string }[];
}): DeviceViewHarness {
  const location = { pathname: '/', search: '', hash: '' };
  let state: unknown = null;
  const move = (href: string): void => {
    const url = new URL(href, 'https://app.test');
    location.pathname = url.pathname;
    location.search = url.search;
    location.hash = url.hash;
  };
  move(options.href ?? '/app/');
  const hashListeners: (() => void)[] = [];
  const browser = {
    location,
    history: {
      get state() {
        return state;
      },
      replaceState: (next: unknown, _unused: string, to?: string | URL | null) => {
        state = next;
        if (to !== undefined && to !== null) move(String(to));
      },
    } as unknown as Pick<History, 'state' | 'replaceState'>,
    addEventListener: (_type: 'hashchange', listener: () => void) => void hashListeners.push(listener),
  };
  const screens = new Map<string, ScreenRef>(
    (options.screens ?? []).map(screen => [
      screen.id,
      { plugin: options.plugin, id: screen.id, path: screen.path, label: screen.id },
    ]),
  );
  const address = new AddressTaker(
    options.fragments.map(decl => {
      const screen = decl.form === 'path' ? screens.get(decl.screen) : undefined;
      return screen === undefined ? { plugin: options.plugin, decl } : { plugin: options.plugin, decl, screen };
    }),
    browser,
  );
  const handOffs = new HandOffs((plugin, screen) => (plugin === options.plugin ? screens.get(screen) : undefined), {
    now: Date.now,
    after: () => {},
  });
  let rows: readonly DaemonReach[] = [];
  const rowListeners = new Set<() => void>();
  const reach = {
    subscribe: (listener: () => void) => {
      rowListeners.add(listener);
      return () => void rowListeners.delete(listener);
    },
    rows: () => rows,
  };
  const device = {
    theme: new ThemePreferenceStore(memoryStore()),
    systemDark: false,
    install: NO_INSTALL_PROMPT,
    address,
    handOffs,
    daemons: new DaemonList({ storage: memoryStore(), now: () => 1 }),
  };
  return {
    handOffs,
    Harness: ({ children, place = 'device', screen }) => (
      <DeviceProvider value={device}>
        <WithPluginIdentity
          identity={
            place === 'daemonless'
              ? { plugin: options.plugin, place, ...(screen === undefined ? {} : { screen }) }
              : { plugin: options.plugin, place, reach }
          }
        >
          <WithoutShell>{children}</WithoutShell>
        </WithPluginIdentity>
      </DeviceProvider>
    ),
    setRows: next => {
      rows = next;
      for (const listener of [...rowListeners]) listener();
    },
    arrive: href => {
      move(href);
      for (const listener of hashListeners) listener();
    },
    address: () => `${location.pathname}${location.search}${location.hash}`,
  };
}
