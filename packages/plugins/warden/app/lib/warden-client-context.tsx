/**
 * The Warden client of any paired daemon, kept where the views can reach it. A page that reads several daemons asks
 * for each one's client by its connection; the screen is handed the client of the daemon it is on, and the shell
 * supplies the others (`useDaemonClients` in `@ferretry/app`).
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { createContext, useContext } from 'react';
import type { DaemonConnection } from './machine.ts';
import type { WardenClient } from './warden-client.ts';

export type WardenClientFactory = (connection: DaemonConnection) => Promise<WardenClient>;

/** The Warden's own plugin client on a paired daemon: what every read of another plugin's fact goes through. */
export type DaemonReach = (connection: DaemonConnection) => Promise<PluginClient>;

export const WardenClientContext = createContext<WardenClientFactory | null>(null);
export const DaemonReachContext = createContext<DaemonReach | null>(null);

const OUTSIDE = async (): Promise<never> => {
  throw new Error('A Warden surface was rendered outside the Warden views, so it has no daemon to read.');
};

/** The factory the surrounding view provided. Outside the views every read fails, saying why. */
export function useWardenClientFactory(): WardenClientFactory {
  return useContext(WardenClientContext) ?? OUTSIDE;
}

/** The client of any paired daemon the surrounding view provided. Outside the views every read fails, saying why. */
export function useDaemonReach(): DaemonReach {
  return useContext(DaemonReachContext) ?? OUTSIDE;
}
