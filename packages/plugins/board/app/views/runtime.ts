/**
 * THE BOARD'S RUNTIME for one daemon: the store over the generated client, kept live by `board.changed`. The shell
 * builds this half once per daemon (§9.6), so the runtime is built once per half and shared by every view.
 */

import { AsksChanged } from '@ferretry/core-asks/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { BoardChanged } from '../../contract/index.ts';
import { clientBoardPort } from '../lib/board-client.ts';
import { DaemonBoardStore } from '../lib/board-store.ts';
import { THIS_MACHINE } from '../lib/machine.ts';
import type { FerretLineage } from '../lib/board-chat.ts';

export interface FerretRow extends FerretLineage {
  readonly name: string;
}

export interface BoardRuntime {
  readonly client: Pick<PluginClient, 'call'>;
  readonly store: DaemonBoardStore;
  /** The ferrets of this machine (names and parents), best effort: a ferret not listed is named by its id. */
  readonly ferrets: () => Promise<readonly FerretRow[]>;
}

const createBoardRuntime = (client: PluginClient): BoardRuntime => {
  const store = new DaemonBoardStore(clientBoardPort(client));
  client.subscribe(BoardChanged, payload => store.noteEvent(THIS_MACHINE.daemonId, payload));
  // A ferret's asks changed (raised, answered, closed, retitled): the open card's Agenda asks follow it, live.
  client.subscribe(AsksChanged, payload => store.noteAsksChanged(THIS_MACHINE.daemonId, payload.ferret));
  return {
    client,
    store,
    ferrets: async () => {
      try {
        const rows =
          await client.call<readonly { readonly id: string; readonly name?: string; readonly parent?: string }[]>(
            'GET /v1/ferrets',
          );
        return rows.map(row => ({
          id: row.id,
          name: row.name ?? row.id,
          ...(row.parent === undefined ? {} : { parent: row.parent }),
        }));
      } catch {
        return [];
      }
    },
  };
};

const RUNTIMES = new WeakMap<object, BoardRuntime>();

/**
 * The ONE runtime of a client: the shell builds a half's views and its app hooks (`shell.hooks`) over the same client,
 * so both read one store and one `board.changed` subscription. A replaced client (a new connection) gets its own.
 */
export const boardRuntimeOf = (client: PluginClient): BoardRuntime => {
  const known = RUNTIMES.get(client);
  if (known !== undefined) return known;
  const runtime = createBoardRuntime(client);
  RUNTIMES.set(client, runtime);
  return runtime;
};
