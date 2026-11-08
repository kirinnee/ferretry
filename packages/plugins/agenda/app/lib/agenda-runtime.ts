/**
 * THE AGENDA'S RUNTIME for one daemon: the agenda client and the ferret store over the one generated client the
 * shell builds this half with (§9.6), kept live by Asks' `asks.changed` and Ferrets' `ferrets.changed`. The shell
 * builds the half once per daemon, so this is built once per half and shared by every view: the Agenda page, the ask
 * page, a ferret's agenda panel and the Settings tab all count and deal the same items, and an answer still inside its
 * undo window survives a navigation between them.
 */

import { AsksChanged } from '@ferretry/core-asks/contract';
import { PushSeenRequestSchema } from '../../contract/wire.ts';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { daemonOfClient } from '../shell.ts';
import { type AgendaCall, agendaCall, requestIdHeaders } from './agenda-call.ts';
import type { ClearPort } from './agenda-clear-agents.ts';
import { DaemonAgendaClient } from './agenda-client.ts';
import { DaemonAgendaStore } from './agenda-store.ts';
import { PUSH_SEEN } from './agenda-wire.ts';
import { AgendaFerretStore } from './ferret-store.ts';
import { type DaemonConnection, daemonConnection, THIS_MACHINE } from './machine.ts';

/** What the Inbox calls the one machine when the shell does not name it. */
const THIS_MACHINE_NAME = 'This machine';

export interface AgendaRuntime {
  readonly client: AgendaCall;
  readonly connection: DaemonConnection;
  readonly name: string;
  readonly agenda: DaemonAgendaClient;
  readonly ferrets: AgendaFerretStore;
  readonly clearPort: ClearPort;
  /** The owner opened an ask here: its buzz is spent on every device (`POST /v1/push/seen`). Best effort. */
  readonly itemOpened: (ferret: string, ask: string) => Promise<void>;
}

export type RuntimeClient = AgendaCall & Partial<Pick<PluginClient, 'subscribe'>>;

/**
 * One machine's runtime over its client. `agenda` is the agenda client it counts and answers through: the device's
 * fleet hands its one client shared by every machine (`agenda-fleet.ts`); alone, the runtime builds its own.
 */
export const createAgendaRuntime = (
  client: RuntimeClient,
  agenda: DaemonAgendaClient = new DaemonAgendaClient(new DaemonAgendaStore(), client),
): AgendaRuntime => {
  const id = daemonOfClient(client);
  const connection = id === undefined ? THIS_MACHINE : daemonConnection({ daemonId: id });
  const ferrets = new AgendaFerretStore(client, connection, agenda.rollup);
  client.subscribe?.(AsksChanged, payload => {
    agenda.noteEvent(connection, payload);
    ferrets.askChanged();
  });
  client.subscribe?.(FerretsChanged, () => ferrets.ferretChanged());
  return {
    client,
    connection,
    name: THIS_MACHINE_NAME,
    agenda,
    ferrets,
    clearPort: { clientFor: target => (target.daemonId === connection.daemonId ? client : undefined) },
    itemOpened: async (ferret, ask) => {
      try {
        await agendaCall(client, PUSH_SEEN, {
          body: PushSeenRequestSchema.parse({ sessionId: ferret, agendaId: ask }),
          headers: requestIdHeaders(),
        });
      } catch {
        // A seen mark that did not land only leaves a buzz on another device; nothing here waits on it.
      }
    },
  };
};
