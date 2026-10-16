/**
 * The rail's PORTS, and the bindings that fill them from the APIs that already own each fact.
 *
 * The rail never reaches a daemon itself. It is handed one port per sub-tab, so a test — and the phone
 * sheet, and any later host — gives it exactly the rows a reader sees without a transport. The bindings
 * below are the ONLY place the rail's data meets the wire, and each one is a thin join over an existing
 * owner rather than a second read of the same route:
 *
 *   Signals  the attention client and store the rest of the PWA already keeps live
 *   MCP      the fleet component catalogue + the MCP sign-in list (`mcp-auth-api.ts`)
 *   Skills   the session skills loader (`skills-api.ts`), so the rail can share `useSessionSkills`' read
 *   Docs     the session filesystem listing (`files-api.ts`) of the agent's own folder
 */

import type { AttentionResponse, AttentionSnapshot } from '@ferretry/protocol';
import { fsApi } from '../../components/files-api.ts';
import type { DaemonAttentionClient } from '../../lib/attention-client.ts';
import type { AttentionLoadStatus } from '../../lib/attention-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import { readFleetComponents } from '../fleet/catalog-api.ts';
import type { FleetClientFactory } from '../fleet/fleet-client.ts';
import { readMcpSignIns } from '../fleet/mcp-auth-api.ts';
import type { SkillsCatalog } from '../skills/skills-catalog.ts';
import { type ContextDoc, type ContextMcpServer, contextMcpServers, instructionDocs } from './context-rail-model.ts';

/** A one-shot read the rail can cancel and repeat. */
export type ContextLoader<T> = (signal: AbortSignal) => Promise<T>;

/**
 * This agent's attention, live. Shaped after the attention store so the rail re-renders when anything
 * else in the app answers or raises an item, rather than holding a copy that goes stale.
 */
export interface ContextSignalsPort {
  readonly subscribe: (listener: () => void) => () => void;
  readonly status: () => AttentionLoadStatus;
  readonly snapshot: () => AttentionSnapshot | undefined;
  /** Reads the board if it has not been read; a retry after a failure reads it again. */
  readonly load: () => Promise<void>;
  readonly respond: (id: string, response: AttentionResponse) => Promise<void>;
  /** Marks an item with no answer shape done. */
  readonly resolve: (id: string) => Promise<void>;
}

/** Binds the app's one attention client to one agent's session. */
export const attentionSignalsPort = (
  client: DaemonAttentionClient,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
): ContextSignalsPort => ({
  subscribe: listener => client.store.subscribe(listener),
  status: () => client.store.status(scope),
  snapshot: () => client.store.attention(scope),
  load: () =>
    client.store.status(scope) === 'error' ? client.revalidate(daemon, scope) : client.hydrate(daemon, scope),
  respond: (id, response) => client.respond(daemon, scope, id, response),
  resolve: id => client.resolve(daemon, scope, id),
});

/**
 * The MCP servers on the agent's machine, joined with their sign-ins.
 *
 * `runtime` is the session's `agent` — the runtime it was started as — so the rail lists only the servers
 * that runtime's profile stack carries. A host that does not know it passes nothing and the rail lists
 * every MCP server on the machine.
 */
export const fleetMcpLoader =
  (
    connection: DaemonConnection,
    createClient: FleetClientFactory,
    runtime?: string,
  ): ContextLoader<readonly ContextMcpServer[]> =>
  async () => {
    const client = await createClient(connection);
    const [catalog, signIns] = await Promise.all([readFleetComponents(client), readMcpSignIns(client)]);
    return contextMcpServers(catalog, signIns.connections, runtime);
  };

/** The session skills read, bound to the agent's scope. Pass `useSessionSkills().load` to share its read. */
export const sessionSkillsLoader =
  (
    load: (scope: DaemonSessionScope, signal: AbortSignal) => Promise<SkillsCatalog>,
    scope: DaemonSessionScope,
  ): ContextLoader<SkillsCatalog> =>
  signal =>
    load(scope, signal);

/** The instruction files at the root of the agent's folder, from the session filesystem listing. */
export const instructionDocsLoader =
  (daemon: DaemonConnection, scope: DaemonSessionScope, fetcher: DaemonFetch): ContextLoader<readonly ContextDoc[]> =>
  async signal =>
    instructionDocs((await fsApi.list(daemon, scope, '', signal, fetcher)).entries);
