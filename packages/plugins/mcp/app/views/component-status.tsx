/**
 * `runtimes.component-mcp` — where one MCP component stands on this machine, with Check and Sign in, under its row in
 * Runtimes' Profiles library. The facts are the machine's MCP inventory (docs/mcp-scopes.md), the same one Settings ›
 * MCP servers reads, and the row is that tab's `McpServerRow`, so a server reads the same in both places. The inventory
 * is read ONCE for every row on the page (`useMachineServers`), not once per row.
 *
 * A component no runtime's config holds yet — no profile carries it, or its runtimes have not been launched since — is
 * not in the inventory and has nothing to check: the row says which.
 */
import { type ComponentMcpSlotProps, isComponentMcpSlotProps } from '@ferretry/plugin-runtimes/contract';
import { Loading, plainFailure } from '@ferretry/app/ui';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import type { McpClient } from '../lib/client.ts';
import { useMachineServers } from '../lib/machine-servers-store.ts';
import './mcp.css';
import { MACHINE_NAME } from './servers-panel.tsx';
import { McpServerRow, PlainFailureText, useMcpServerActions } from './server-row.tsx';

/** What a component's row says when the inventory does not hold it. */
export const unusedWords = (usedByRuntimes: number): string =>
  usedByRuntimes === 0
    ? 'No runtime’s profile uses it yet, so no ferret starts it and there is nothing to check.'
    : 'Its runtimes haven’t picked it up yet, so there is nothing to check. They do at their next launch.';

export interface ComponentMcpStatusProps {
  readonly client: McpClient;
  /** The component's name. */
  readonly name: string;
  readonly usedByRuntimes: number;
  readonly now?: () => number;
}

export function ComponentMcpStatus({ client, name, usedByRuntimes, now = Date.now }: ComponentMcpStatusProps) {
  const { servers, reload } = useMachineServers(client);
  const actions = useMcpServerActions({ client, machineName: MACHINE_NAME, now }, reload);
  if (servers.kind === 'failed')
    return (
      <div className="flex min-w-0 flex-col gap-1" data-component-mcp-status="failed">
        <PlainFailureText
          failure={plainFailure(servers.reason, MACHINE_NAME, `read where ${name} stands`)}
          spot="status"
        />
        <button className="self-start text-meta underline" type="button" onClick={reload} data-component-mcp-retry="">
          Try again
        </button>
      </div>
    );
  if (servers.kind === 'loading') return <Loading kind="bar" label={`Reading where ${name} stands…`} />;
  const server = servers.inventory.servers.find(
    candidate => candidate.scope === 'component' && candidate.name === name,
  );
  if (server === undefined)
    return (
      <p className="m-0 text-meta text-muted" data-component-mcp-status="unused">
        {unusedWords(usedByRuntimes)}
      </p>
    );
  return (
    <div data-component-mcp-status="ready">
      <McpServerRow server={server} actions={actions} nowMs={now()} compact />
      {actions.sheet}
    </div>
  );
}

/** The panel Runtimes' library mounts: what the page handed it is checked, since the shell does not read it. */
export const createComponentStatusPanel = (client: McpClient): AppComponent<PanelProps> =>
  function ComponentStatusPanel(props: PanelProps) {
    if (props.subject === undefined || !isComponentMcpSlotProps(props)) return null;
    const { usedByRuntimes }: ComponentMcpSlotProps = props;
    return <ComponentMcpStatus client={client} name={props.subject} usedByRuntimes={usedByRuntimes} />;
  };
