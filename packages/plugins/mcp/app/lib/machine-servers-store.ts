/**
 * THE MACHINE'S MCP INVENTORY, READ ONCE FOR EVERY ROW THAT ASKS (the status under each MCP server in Runtimes' Profiles
 * library). A library lists many servers and each draws its own status panel; one `GET /v1/mcp` serves them all, not one
 * per row. The store belongs to a client (a client is per daemon), reads when its first row shows and forgets what it
 * read when its last row goes, so the next library to open reads the machine as it is then. Nothing here holds a token:
 * the inventory has none (docs/mcp-oauth.md).
 */
import { loadFailureReason } from '@ferretry/app/ui';
import { useCallback, useSyncExternalStore } from 'react';
import type { McpInventory } from '../../contract/index.ts';
import { type McpClient, readMachineMcpServers } from './client.ts';

export type MachineServers =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly inventory: McpInventory }
  | { readonly kind: 'failed'; readonly reason: string };

const LOADING: MachineServers = { kind: 'loading' };

export interface MachineServersStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => MachineServers;
  /** Read again; the rows on screen keep what they show until the new answer lands. */
  readonly reload: () => void;
}

/** A store over one client. Exported for a test; the panel gets its client's through {@link machineServersStore}. */
export function createMachineServersStore(client: McpClient): MachineServersStore {
  const listeners = new Set<() => void>();
  let state: MachineServers = LOADING;
  // A read that finishes after the last row left, or after a newer read began, is not told to anybody.
  let generation = 0;

  const set = (next: MachineServers): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const read = (): void => {
    generation += 1;
    const mine = generation;
    readMachineMcpServers(client).then(
      inventory => {
        if (mine === generation) set({ kind: 'ready', inventory });
      },
      (error: unknown) => {
        if (mine === generation) set({ kind: 'failed', reason: loadFailureReason(error) });
      },
    );
  };

  return {
    subscribe: listener => {
      listeners.add(listener);
      if (listeners.size === 1) read();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation += 1;
          state = LOADING;
        }
      };
    },
    snapshot: () => state,
    reload: () => {
      if (listeners.size === 0) return;
      // A failed read goes back to "reading"; a good one stays on screen until the new answer lands.
      if (state.kind === 'failed') set(LOADING);
      read();
    },
  };
}

const stores = new WeakMap<McpClient, MachineServersStore>();

/** THE store of this client: every row that shares the client shares its one read. */
export function machineServersStore(client: McpClient): MachineServersStore {
  const known = stores.get(client);
  if (known !== undefined) return known;
  const made = createMachineServersStore(client);
  stores.set(client, made);
  return made;
}

/** The machine's servers as the one shared read has them, and a way to read again. */
export function useMachineServers(client: McpClient): {
  readonly servers: MachineServers;
  readonly reload: () => void;
} {
  const store = machineServersStore(client);
  const servers = useSyncExternalStore(store.subscribe, store.snapshot);
  const reload = useCallback(() => store.reload(), [store]);
  return { servers, reload };
}
