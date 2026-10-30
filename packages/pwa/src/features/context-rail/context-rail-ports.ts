/**
 * The rail's PORTS, and the bindings that fill them from the APIs that already own each fact.
 *
 * The rail never reaches a daemon itself. It is handed one port per sub-tab, so a test — and the phone
 * sheet, and any later host — gives it exactly the rows a reader sees without a transport. The bindings
 * below are the ONLY place the rail's data meets the wire, and each one is a thin join over an existing
 * owner rather than a second read of the same route:
 *
 *   Signals  the agenda client and store the rest of the PWA already keeps live
 *   MCP      every server the ferret sees, from every scope (`../mcp/mcp-api.ts`, docs/mcp-scopes.md)
 *   Skills   every skill the ferret sees, with its scope and SKILL.md (`../mcp/mcp-api.ts`)
 *   Docs     the session filesystem listing (`files-api.ts`) of the agent's own folder
 */

import type {
  AgendaResponse,
  AgendaSnapshot,
  McpInventory,
  SessionSkillsInventory,
  SkillFile,
} from '@ferretry/protocol';
import { fsApi } from '../../components/files-api.ts';
import type { DaemonAgendaClient } from '../../lib/agenda-client.ts';
import type { AgendaLoadStatus } from '../../lib/agenda-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import type { FleetClientFactory } from '../fleet/fleet-client.ts';
import { readSessionMcpServers, readSessionSkillsInventory, readSkillFile } from '../mcp/mcp-api.ts';
import { type ContextDoc, instructionDocs } from './context-rail-model.ts';

/** A one-shot read the rail can cancel and repeat. */
export type ContextLoader<T> = (signal: AbortSignal) => Promise<T>;

/**
 * This agent's attention, live. Shaped after the agenda store so the rail re-renders when anything
 * else in the app answers or raises an item, rather than holding a copy that goes stale.
 */
export interface ContextSignalsPort {
  readonly subscribe: (listener: () => void) => () => void;
  readonly status: () => AgendaLoadStatus;
  readonly snapshot: () => AgendaSnapshot | undefined;
  /** Reads the board if it has not been read; a retry after a failure reads it again. */
  readonly load: () => Promise<void>;
  readonly respond: (id: string, response: AgendaResponse) => Promise<void>;
  /** Marks an item with no answer shape done. */
  readonly resolve: (id: string) => Promise<void>;
}

/** Binds the app's one agenda client to one agent's session. */
export const agendaSignalsPort = (
  client: DaemonAgendaClient,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
): ContextSignalsPort => ({
  subscribe: listener => client.store.subscribe(listener),
  status: () => client.store.status(scope),
  snapshot: () => client.store.agenda(scope),
  load: () =>
    client.store.status(scope) === 'error' ? client.revalidate(daemon, scope) : client.hydrate(daemon, scope),
  respond: (id, response) => client.respond(daemon, scope, id, response),
  resolve: id => client.resolve(daemon, scope, id),
});

/** Every MCP server one ferret sees, from every scope, on that ferret's machine. */
export const sessionMcpLoader =
  (connection: DaemonConnection, createClient: FleetClientFactory, sessionId: string): ContextLoader<McpInventory> =>
  async signal =>
    await readSessionMcpServers(await createClient(connection), sessionId, signal);

/** Every skill one ferret sees, with its scope, on that ferret's machine. */
export const sessionSkillsInventoryLoader =
  (
    connection: DaemonConnection,
    createClient: FleetClientFactory,
    sessionId: string,
  ): ContextLoader<SessionSkillsInventory> =>
  async signal =>
    await readSessionSkillsInventory(await createClient(connection), sessionId, signal);

/** One listed skill's SKILL.md, for Open. */
export const skillFileLoader =
  (connection: DaemonConnection, createClient: FleetClientFactory, sessionId: string) =>
  async (path: string, signal: AbortSignal): Promise<SkillFile> =>
    await readSkillFile(await createClient(connection), path, sessionId, signal);

/** The instruction files at the root of the agent's folder, from the session filesystem listing. */
export const instructionDocsLoader =
  (daemon: DaemonConnection, scope: DaemonSessionScope, fetcher: DaemonFetch): ContextLoader<readonly ContextDoc[]> =>
  async signal =>
    instructionDocs((await fsApi.list(daemon, scope, '', signal, fetcher)).entries);
