/**
 * THE BOARD'S RUNTIME for one daemon: the store over the generated client, kept live by `board.changed`. The shell
 * builds this half once per daemon (§9.6), so the runtime is built once per half and shared by every view.
 */

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

export const createBoardRuntime = (client: PluginClient): BoardRuntime => {
  const store = new DaemonBoardStore(clientBoardPort(client));
  client.subscribe(BoardChanged, payload => store.noteEvent(THIS_MACHINE.daemonId, payload));
  return {
    client,
    store,
    ferrets: async () => {
      try {
        const rows = await client.call<readonly { readonly id: string; readonly name?: string; readonly parent?: string }[]>(
          'GET /v1/ferrets',
        );
        return rows.map(row => ({ id: row.id, name: row.name ?? row.id, ...(row.parent === undefined ? {} : { parent: row.parent }) }));
      } catch {
        return [];
      }
    },
  };
};
