/**
 * The plugin client the shell hands this half (`build({ client })`), kept where the views' hooks can reach it: every
 * read and write a hook makes goes through it by route key (`lib/agenda-call.ts`). Outside this half's views (a
 * harness that mounts no provider) a call refuses with a plain sentence instead of reaching anything.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { createContext, useContext } from 'react';
import { type AgendaCall, DaemonResponseError } from './agenda-call.ts';

export const AgendaClientContext = createContext<AgendaCall | PluginClient | null>(null);

const NO_CLIENT: AgendaCall = {
  call: () => Promise.reject(new DaemonResponseError(0, 'This view is not connected to a machine.')),
};

/** The client the views call through. */
export const useAgendaCall = (): AgendaCall => useContext(AgendaClientContext) ?? NO_CLIENT;
