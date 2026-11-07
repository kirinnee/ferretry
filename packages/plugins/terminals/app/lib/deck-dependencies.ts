/**
 * THE DECK'S DEPENDENCIES OVER THE SHELL'S PER-DAEMON CLIENT (§9.6).
 *
 * The deck takes everything that touches the daemon as injected operations; this binds them to the one client the
 * shell built for this daemon. Holds (quarantines) are Vault's routes, called by their manifest keys.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  browserTerminalDeckHost,
  type TerminalDeckDependencies,
  type TerminalDeckHost,
} from '../components/session-terminal-deck.tsx';
import {
  closeSessionTerminal,
  createSessionTerminal,
  endSessionQuarantine,
  listSessionQuarantines,
  listSessionTerminals,
  renameSessionTerminal,
  terminalRecovery,
  terminalStreamAttach,
} from './web-terminals.ts';

export const terminalDeckDependencies = (
  client: PluginClient,
  host: TerminalDeckHost = browserTerminalDeckHost(),
): TerminalDeckDependencies => {
  const recovery = terminalRecovery(client);
  return {
    list: scope => listSessionTerminals(client, scope),
    create: scope => createSessionTerminal(client, scope),
    rename: (scope, id, title) => renameSessionTerminal(client, scope, id, title),
    close: (scope, id) => closeSessionTerminal(client, scope, id),
    attach: terminalStreamAttach(client),
    quarantines: scope => listSessionQuarantines(client, scope),
    endQuarantine: (scope, key) => endSessionQuarantine(client, scope, key),
    ...(recovery === undefined ? {} : { onRecovered: recovery }),
    ...host,
  };
};
