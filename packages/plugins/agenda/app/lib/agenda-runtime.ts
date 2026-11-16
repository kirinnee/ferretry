/**
 * THE AGENDA'S RUNTIME for one daemon: the agenda client and the ferret store over the one generated client the
 * shell builds this half with (§9.6), kept live by Asks' `asks.changed` and Ferrets' `ferrets.changed`. The shell
 * builds the half once per daemon, so this is built once per half and shared by every view: the Agenda page, the ask
 * page, a ferret's agenda panel and the Settings tab all count and deal the same items, and an answer still inside its
 * undo window survives a navigation between them.
 */

import { AsksChanged } from '@ferretry/core-asks/contract';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { daemonOfClient } from '../shell.ts';
import type { AgendaCall } from './agenda-call.ts';
import type { ClearPort } from './agenda-clear-agents.ts';
import { DaemonAgendaClient } from './agenda-client.ts';
import { DaemonAgendaStore } from './agenda-store.ts';
import { AgendaFerretStore } from './ferret-store.ts';
import { type DaemonConnection, daemonConnection, THIS_MACHINE } from './machine.ts';

/**
 * The harness fallback for the machine's name. A machine's real name comes from `useEveryDaemon()` (the Inbox's machine
 * names and the Needs-you panel read it there), so this is only what a runtime built with no shell says.
 */
const THIS_MACHINE_NAME = 'This machine';

export interface AgendaRuntime {
  readonly client: AgendaCall;
  readonly connection: DaemonConnection;
  readonly name: string;
  readonly agenda: DaemonAgendaClient;
  readonly ferrets: AgendaFerretStore;
  readonly clearPort: ClearPort;
  /**
   * Lets go of the transport events this runtime listens to and stops the ferret store's queued reads. For the owner
   * of a runtime made for one purpose (the nav badge); the device's shared runtime (`AgendaFleet`) lives with the
   * connection. A disposed runtime does not read again — make a new one.
   */
  readonly dispose: () => void;
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
  const transport = [
    client.subscribe?.(AsksChanged, payload => {
      agenda.noteEvent(connection, payload);
      ferrets.askChanged();
    }),
    client.subscribe?.(FerretsChanged, () => ferrets.ferretChanged()),
  ];
  return {
    dispose: () => {
      for (const off of transport.splice(0)) off?.();
      ferrets.stop();
    },
    client,
    connection,
    name: THIS_MACHINE_NAME,
    agenda,
    ferrets,
    clearPort: { clientFor: target => (target.daemonId === connection.daemonId ? client : undefined) },
  };
};
