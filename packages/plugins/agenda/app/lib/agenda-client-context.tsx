/**
 * The plugin client the shell hands this half (`build({ client })`), kept where the views and the libs can reach it.
 * The libs still build their requests with the shell's transport (`daemonRequest` and a `DaemonFetch`); this is where
 * they take `client.call` from when the shell exposes the request headers the agenda channel needs (GAP(app-shell)).
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { createContext, useContext } from 'react';

export const AgendaClientContext = createContext<PluginClient | null>(null);

/** The plugin client, or `null` outside the views of this half. */
export const useAgendaPluginClient = (): PluginClient | null => useContext(AgendaClientContext);
