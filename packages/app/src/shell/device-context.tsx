import { createContext, type ReactNode, useCallback, useContext, useRef, useSyncExternalStore } from 'react';
import { type DaemonList, type DaemonListSnapshot, daemonTitle } from '../daemons/daemon-list.ts';
import type { AddressTaker } from '../router/address.ts';
import type { HandOffs } from './hand-off.ts';
import type { InstallPromptHolder } from './install-prompt.ts';
import { usePluginIdentity } from './plugin-identity.tsx';
import {
  type ResolvedMode,
  resolveThemeMode,
  type TextScale,
  THEME_FAMILIES,
  type ThemeFamily,
  type ThemeFamilyId,
  type ThemeMode,
  type ThemePreference,
  type ThemePreferenceStore,
} from '../theme/preferences.ts';

/**
 * THE DEVICE CONTEXT (shell contract S9): what belongs to THIS device and no daemon — its theme, the install prompt the
 * browser offered, the address fragments the shell holds (S3) and the paired list. Set by the shell root ABOVE every
 * {@link WithoutShell} (`shell/context.tsx`), so a daemon-less screen, a device view and a device panel read it too.
 *
 * It carries NO CLIENT and nothing a client could be made from: the paired list is the list a device-less visitor
 * already sees (`snapshot`, `subscribe`). A plugin reaches a machine only through its own plugin-identity `reach`
 * (S2), never through here. The stores are built once by the composition root (`main.tsx`) and injected: nothing in
 * this module is a module-wide singleton.
 */

export { type InstallPromptHolder, NO_INSTALL_PROMPT } from './install-prompt.ts';

/** The paired list and the selected id, read-only, and no client (MA4: clients come only via `reach`). */
type DaemonListView = Pick<DaemonList, 'snapshot' | 'subscribe'>;

export interface DeviceContextValue {
  /** This device's theme preference (`fy:app:theme`), injected by the composition root. */
  readonly theme: ThemePreferenceStore;
  /** The operating system's answer to `system`, followed live by the shell root. */
  readonly systemDark: boolean;
  readonly install: InstallPromptHolder;
  /** S3: the held fragments and their arrival counts. */
  readonly address: AddressTaker;
  /** S3: values carried in memory to a plugin's own screen. */
  readonly handOffs: HandOffs;
  readonly daemons: DaemonListView;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

/** The shell root's provider. Never hidden by `WithoutShell`: device state is no daemon's. */
export function DeviceProvider({
  value,
  children,
}: {
  readonly value: DeviceContextValue;
  readonly children: ReactNode;
}) {
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

/** The device context, or `null` outside an app shell (a plugin's own harness or suite). */
export function useOptionalDevice(): DeviceContextValue | null {
  return useContext(DeviceContext);
}

/** This device's theme as a control reads it: the preference, the mode in force, and the setters. */
export interface DeviceTheme {
  readonly preference: ThemePreference;
  /** The mode actually in force — never `system`. */
  readonly resolved: ResolvedMode;
  readonly families: readonly ThemeFamily[];
  readonly setMode: (mode: ThemeMode) => void;
  readonly setFamily: (family: ThemeFamilyId) => void;
  readonly setTextScale: (scale: TextScale) => void;
}

const noSubscription = (): (() => void) => () => {};

/**
 * THIS DEVICE'S THEME (S9): daemon-less safe — it works on a daemon-less screen, in a device view and in a per-daemon
 * view alike, and a switch here is the one the device settings page shows. `null` outside an app shell.
 */
export function useDeviceTheme(): DeviceTheme | null {
  const device = useOptionalDevice();
  const store = device?.theme;
  const read = useCallback(() => store?.snapshot(), [store]);
  const preference = useSyncExternalStore(store?.subscribe ?? noSubscription, read, read);
  if (device === null || store === undefined || preference === undefined) return null;
  return {
    preference,
    resolved: resolveThemeMode(preference.mode, device.systemDark),
    families: THEME_FAMILIES,
    setMode: mode => void store.setMode(mode),
    setFamily: family => void store.setFamily(family),
    setTextScale: scale => void store.setTextScale(scale),
  };
}

/** One paired machine as a device view sees it: which one and what it is called — never where it is or how it connects. */
export interface DevicePairedMachine {
  readonly daemon: string;
  readonly title: string;
}

/** The paired machines and the selected id, narrowed to what a device view needs to tell "connecting" from "not paired". */
export interface DevicePaired {
  readonly daemons: readonly DevicePairedMachine[];
  readonly selected: string | null;
}

const NO_PAIRED: DevicePaired = Object.freeze({ daemons: Object.freeze([]), selected: null });

const project = (snapshot: DaemonListSnapshot): DevicePaired =>
  Object.freeze({
    daemons: Object.freeze(
      snapshot.daemons.map(paired => Object.freeze({ daemon: paired.daemon, title: daemonTitle(paired) })),
    ),
    selected: snapshot.selected,
  });

/**
 * THE PAIRED MACHINES, FOR A DEVICE VIEW (S9): each paired daemon's id and title and the selected id, live — what a
 * device view needs to tell a machine that is still connecting (paired, no row yet) from one this device is not
 * paired with. It carries NO address, carrier or device id, and it answers only where the shell gave the plugin a
 * `reach` (a device view, a device panel, a per-daemon or background view): a daemon-less screen — the kind a stranger's
 * link opens — and code outside any place get the empty list, so no machine is named without a tap (MA4). Empty
 * outside an app shell too.
 */
export function useDevicePaired(): DevicePaired {
  const list = useOptionalDevice()?.daemons;
  const reached = usePluginIdentity()?.reach !== undefined;
  const held = useRef<{ readonly source: DaemonListSnapshot; readonly view: DevicePaired } | null>(null);
  const read = useCallback((): DevicePaired => {
    if (list === undefined || !reached) return NO_PAIRED;
    const source = list.snapshot();
    if (held.current?.source !== source) held.current = { source, view: project(source) };
    return held.current.view;
  }, [list, reached]);
  return useSyncExternalStore(list?.subscribe ?? noSubscription, read, read);
}
