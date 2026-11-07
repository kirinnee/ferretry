/**
 * The Warden client of any paired daemon, kept where the views can reach it. A page that reads several daemons asks
 * for each one's client by its connection; the screen is handed the client of the daemon it is on, and the shell
 * supplies the others (`pluginClientFor` in `../shell.ts`).
 */

import { createContext, useContext } from 'react';
import type { DaemonConnection } from '../shell.ts';
import type { WardenClient } from './warden-client.ts';

export type WardenClientFactory = (connection: DaemonConnection) => Promise<WardenClient>;

export const WardenClientContext = createContext<WardenClientFactory | null>(null);

const OUTSIDE: WardenClientFactory = async () => {
  throw new Error('A Warden surface was rendered outside the Warden views, so it has no daemon to read.');
};

/** The factory the surrounding view provided. Outside the views every read fails, saying why. */
export function useWardenClientFactory(): WardenClientFactory {
  return useContext(WardenClientContext) ?? OUTSIDE;
}
