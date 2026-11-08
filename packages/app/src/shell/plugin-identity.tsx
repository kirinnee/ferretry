import { createContext, type ReactNode, useContext } from 'react';
import type { DaemonReach } from './every-daemon.ts';
import type { ShellRuntime } from './runtime.ts';

/**
 * WHO IS CALLING, AND FROM WHERE (shell contract §1.1, MA4). Every place a plugin's code is drawn sets this context:
 * `PluginView` (`'daemon'`), `DaemonlessScreen` (`'daemonless'`), and — as later units mount them — the device-view
 * host (`'device'`), the device-panel wrapper (`'device-panel'`) and the background host (`'background'`).
 *
 * - **Not hidden by `WithoutShell`.** It is its own context, so a device view or a daemon-less screen still knows which
 *   plugin it belongs to; what it may reach is in `reach`, not in the shell model.
 * - **`reach` is per plugin, over the one client cache**, and present for every place but `'daemonless'`, where it is
 *   ABSENT: a daemon-less screen (the kind a stranger's link opens) gets no machine from `useEveryDaemon`.
 * - **In `'background'` every row's client is the background-origin entry**, so nothing a background view sends raises
 *   a prompt; everywhere else it is the ordinary entry.
 * - **Not exported from `@ferretry/app`**: a plugin cannot set it, so it cannot claim another plugin's reach.
 */

export type PluginPlace = 'daemon' | 'background' | 'device-panel' | 'device' | 'daemonless';

/** One plugin's live reader of its own rows on every paired daemon (`useSyncExternalStore`-shaped). */
export interface PluginReach {
  readonly subscribe: (listener: () => void) => () => void;
  /** The same array until a row changes. */
  readonly rows: () => readonly DaemonReach[];
}

export interface PluginIdentity {
  readonly plugin: string;
  readonly place: PluginPlace;
  /** Absent on a daemon-less screen. */
  readonly reach?: PluginReach;
  /** The daemon-less screen drawn here: the one place its declared path fragment may be taken (S3). */
  readonly screen?: string;
}

const PluginIdentityContext = createContext<PluginIdentity | null>(null);

/** The identity a place draws `plugin` with: the one rule for which client origin, and whether there is a reach. */
export function identityOf(runtime: ShellRuntime, plugin: string, place: PluginPlace, screen?: string): PluginIdentity {
  if (place === 'daemonless') return screen === undefined ? { plugin, place } : { plugin, place, screen };
  return { plugin, place, reach: runtime.reach(plugin, place === 'background' ? 'background' : 'ordinary') };
}

export function WithPluginIdentity({
  identity,
  children,
}: {
  readonly identity: PluginIdentity;
  readonly children: ReactNode;
}) {
  return <PluginIdentityContext.Provider value={identity}>{children}</PluginIdentityContext.Provider>;
}

/** The plugin whose code is drawn here, or `null` outside any place (a plugin's own harness or suite). */
export function usePluginIdentity(): PluginIdentity | null {
  return useContext(PluginIdentityContext);
}
