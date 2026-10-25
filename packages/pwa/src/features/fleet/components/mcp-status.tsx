/**
 * Where each MCP component stands on this machine, with Check and Sign in — on the Components page's
 * MCP rows and on one server's page.
 *
 * The facts come from the machine's MCP inventory (docs/mcp-scopes.md), the same one a ferret's
 * Context › MCP reads, and the row is that tab's `McpServerRow`, so a server reads the same in both
 * places. A component no runtime's config holds yet — no profile carries it, or its runtimes have not
 * been launched since — has nothing to check: the row says which.
 */

import type { FleetComponentView, McpInventory, McpInventoryServer } from '@ferretry/protocol';
import { useCallback } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { type ContextRead, useContextRead } from '../../context-rail/context-rail-parts.tsx';
import { readMachineMcpServers } from '../../mcp/mcp-api.ts';
import { plainFailure } from '../../mcp/mcp-model.ts';
import {
  type McpServerActions,
  McpServerRow,
  PlainFailureText,
  useMcpServerActions,
} from '../../mcp/mcp-server-row.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { Hint, Section } from './catalog-ui.tsx';

export interface MachineMcpHost {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly machineName: string;
  readonly online: boolean;
  /** Supplied in tests and captures. */
  readonly now?: () => number;
}

export interface MachineMcp {
  readonly read: ContextRead<McpInventory>;
  readonly actions: McpServerActions;
}

/** The machine's MCP inventory, read once, and the acts on it. */
export function useMachineMcp(host: MachineMcpHost): MachineMcp {
  const { connection, createClient } = host;
  const loader = useCallback(
    async (signal: AbortSignal) => await readMachineMcpServers(await createClient(connection), signal),
    [connection, createClient],
  );
  const read = useContextRead(loader, true);
  const actions = useMcpServerActions(
    {
      connection,
      createClient,
      machineName: host.machineName,
      ...(host.now === undefined ? {} : { now: host.now }),
    },
    read.reload,
  );
  return { read, actions };
}

/** A component's own row in the inventory: the fleet component of that name. */
const serverOf = (inventory: McpInventory, name: string): McpInventoryServer | undefined =>
  inventory.servers.find(server => server.scope === 'component' && server.name === name);

/** One component's status line, Check and Sign in. */
export function ComponentMcpStatus({
  component,
  mcp,
  host,
  offerSignIn = true,
}: {
  readonly component: FleetComponentView;
  readonly mcp: MachineMcp;
  readonly host: MachineMcpHost;
  readonly offerSignIn?: boolean;
}) {
  const { load, reload } = mcp.read;
  if (load.kind === 'failed')
    return (
      <div className="flex min-w-0 flex-col gap-1" data-component-mcp-status="failed">
        <PlainFailureText
          failure={plainFailure(load.reason, host.machineName, `read where ${component.name} stands`)}
          spot="status"
        />
        <button className="fy-info-link self-start text-meta" type="button" onClick={reload}>
          Try again
        </button>
      </div>
    );
  if (load.kind !== 'ready')
    return (
      <p className="m-0 text-meta text-muted" role="status" data-component-mcp-status="loading">
        Reading where {component.name} stands…
      </p>
    );
  const server = serverOf(load.value, component.name);
  if (server === undefined)
    return (
      <p className="m-0 text-meta text-muted" data-component-mcp-status="unused">
        {component.usedBy.runtimes.length === 0
          ? 'No runtime’s profile uses it yet, so no ferret starts it and there is nothing to check.'
          : 'Its runtimes haven’t picked it up yet, so there is nothing to check. They do at their next launch.'}
      </p>
    );
  return (
    <div data-component-mcp-status="ready">
      <McpServerRow
        server={server}
        actions={mcp.actions}
        nowMs={(host.now ?? Date.now)()}
        online={host.online}
        compact
        offerSignIn={offerSignIn}
      />
    </div>
  );
}

/** One server's page: its status and Check. Sign in stays in the page's own Sign-in section. */
export function ComponentMcpStatusSection({
  component,
  host,
}: {
  readonly component: FleetComponentView;
  readonly host: MachineMcpHost;
}) {
  const mcp = useMachineMcp(host);
  return (
    <Section title="Status" spot="mcp-status">
      <ComponentMcpStatus component={component} mcp={mcp} host={host} offerSignIn={false} />
      <Hint>Check connects to it the way a ferret on {host.machineName} would, and lists its tools.</Hint>
      {mcp.actions.sheet}
    </Section>
  );
}
