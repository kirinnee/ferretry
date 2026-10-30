/**
 * The rail's PORTS, and the bindings that fill them from the APIs that already own each fact.
 *
 * The rail never reaches a daemon itself. It is handed one port per sub-tab, so a test — and the phone
 * sheet, and any later host — gives it exactly the rows a reader sees without a transport. The bindings
 * below are the ONLY place the rail's data meets the wire, and each one is a thin join over an existing
 * owner rather than a second read of the same route:
 *
 *   MCP      every server the ferret sees, from every scope (`../mcp/mcp-api.ts`, docs/mcp-scopes.md)
 *   Skills   every skill the ferret sees, with its scope and SKILL.md (`../mcp/mcp-api.ts`)
 *   Docs     the session filesystem listing (`files-api.ts`) of the agent's own folder
 */

import type { McpInventory, SessionSkillsInventory, SkillFile } from '@ferretry/protocol';
import { fsApi } from '../../components/files-api.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import type { FleetClientFactory } from '../fleet/fleet-client.ts';
import { readSessionMcpServers, readSessionSkillsInventory, readSkillFile } from '../mcp/mcp-api.ts';
import { type ContextDoc, instructionDocs } from './context-rail-model.ts';

/** A one-shot read the rail can cancel and repeat. */
export type ContextLoader<T> = (signal: AbortSignal) => Promise<T>;

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
