import type { PluginClient } from '@ferretry/kernel/manifest';
import { MovedDocumentSchema, type MovedDocument } from '../../contract/index.ts';

/**
 * The ferrets this machine handed to another, read once per daemon this half was built for and read again after a move.
 * Plain data (ids and instants) from `GET /v1/relocate/moved`; a refused or failed read is an empty ledger, so a row that
 * cannot tell never claims a ferret moved.
 */
export interface MovedStore {
  readonly snapshot: () => MovedDocument;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the ledger again (after a move, or when a row first mounts). */
  readonly refresh: () => Promise<void>;
}

const NONE: MovedDocument = Object.freeze({ moved: {} });

export function createMovedStore(client: Pick<PluginClient, 'call'>): MovedStore {
  let held: MovedDocument = NONE;
  let started = false;
  const listeners = new Set<() => void>();
  const refresh = async (): Promise<void> => {
    try {
      const next = MovedDocumentSchema.parse(await client.call('GET /v1/relocate/moved', { quiet: true }));
      if (JSON.stringify(next) === JSON.stringify(held)) return;
      held = next;
    } catch {
      return;
    }
    for (const listener of [...listeners]) listener();
  };
  return {
    snapshot: () => held,
    subscribe: listener => {
      listeners.add(listener);
      if (!started) {
        started = true;
        void refresh();
      }
      return () => listeners.delete(listener);
    },
    refresh,
  };
}
