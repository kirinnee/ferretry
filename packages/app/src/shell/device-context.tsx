import { createContext, type ReactNode, useCallback, useContext, useSyncExternalStore } from 'react';
import type { DaemonList, DaemonListSnapshot } from '../daemons/daemon-list.ts';
import type { AddressTaker } from '../router/address.ts';
import type { HandOffs } from './hand-off.ts';
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

/**
 * The install-as-app prompt the browser offered, captured at boot (S13 fills it; until then it holds nothing). A typed
 * holder so the device context's shape is final now.
 */
export interface InstallPromptHolder {
  /** The captured prompt, or `undefined` when the browser offered none (or none was captured yet). */
  readonly current: () => unknown;
}

/** The holder S13 replaces: no prompt was ever captured. */
export const NO_INSTALL_PROMPT: InstallPromptHolder = Object.freeze({ current: () => undefined });

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

const NO_PAIRED: DaemonListSnapshot = Object.freeze({ daemons: Object.freeze([]), selected: null });

/**
 * THE PAIRED LIST, DAEMON-LESS SAFE (S9): every paired daemon and the selected id, live — what a device view needs to
 * tell a machine that is still connecting (paired, no row yet) from one this device is not paired with. It reads the
 * device context, so it answers in a device view, a daemon-less screen and a per-daemon view alike (unlike
 * `usePairedDaemons`, which `WithoutShell` hides); it carries no client. Empty outside an app shell.
 */
export function useDevicePaired(): DaemonListSnapshot {
  const list = useOptionalDevice()?.daemons;
  const read = useCallback(() => list?.snapshot() ?? NO_PAIRED, [list]);
  return useSyncExternalStore(list?.subscribe ?? noSubscription, read, read);
}
