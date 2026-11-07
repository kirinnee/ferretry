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

/** The factory the surrounding view provided; a surface rendered outside the views of this half is a bug. */
export function useWardenClientFactory(): WardenClientFactory {
  const factory = useContext(WardenClientContext);
  if (factory === null) throw new Error('A Warden surface was rendered outside the Warden views.');
  return factory;
}
