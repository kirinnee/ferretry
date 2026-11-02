/**
 * Context › MCP: every MCP server this ferret sees, from every scope — Project, Local, User and Ferretry —
 * each with where it stands, Check and Sign in (docs/mcp-scopes.md).
 *
 * The rows are the shared `McpServerRow`, the same one the Components page draws, and every act goes
 * through `useMcpServerActions`: Check asks the daemon to connect AS THIS FERRET would, and Sign in is the
 * components' flow, unchanged, under the server's own subject — which is what lets a project's
 * `.mcp.json` server sign in at all.
 */

import type { McpInventory } from '@ferretry/protocol';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CatalogItemRow } from '../catalogs/catalog-item-row.tsx';
import { type CatalogRowsHost, useCatalogRows } from '../catalogs/catalog-row-tools.tsx';
import { McpServerDetails } from '../mcp/mcp-server-details.tsx';
import { MCP_SCOPE_LABEL, MCP_SCOPE_TITLE, MCP_TRANSPORT_LABEL, sortedMcpServers } from '../mcp/mcp-model.ts';
import { type McpActionsHost, McpServerRow, useMcpServerActions } from '../mcp/mcp-server-row.tsx';
import {
  CONTEXT_RAIL_SEARCH_LABEL,
  contextEmptyCopy,
  type McpChip,
  mcpChips,
  visibleMcpServers,
} from './context-rail-model.ts';
import { ContextFailure, ContextFilterBar, ContextNote, type ContextRead } from './context-rail-parts.tsx';

/**
 * What the rail needs to check a server and run a sign-in on the agent's machine. Without it the rail
 * still shows where every server stands, and offers neither act.
 */
export type ContextMcpSignInHost = Omit<McpActionsHost, 'sessionId' | 'now' | 'machineName'> & {
  /** The machine's own name, as the sign-in sheet says it. */
  readonly machineName: string;
};

export interface ContextMcpPanelProps {
  readonly read: ContextRead<McpInventory>;
  /** The ferret whose servers these are: Check reaches each one as it does. */
  readonly sessionId: string;
  readonly signIn?: ContextMcpSignInHost;
  /** The machine's own name, for a failure said in words. */
  readonly machineName: string;
  /** Opens Actions › Add MCP server… — the same form, from the list it adds to. */
  readonly onAdd?: () => void;
  /** Lets rows offer Share and Add, say where an installed server came from, and install from a file. */
  readonly catalogs?: CatalogRowsHost;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly chip: McpChip;
  readonly onChipChange: (chip: McpChip) => void;
  readonly now: () => number;
  readonly searchDebounceMs?: number;
}

export function ContextMcpPanel({
  read,
  sessionId,
  signIn,
  machineName,
  onAdd,
  catalogs,
  query,
  onQueryChange,
  chip,
  onChipChange,
  now,
  searchDebounceMs,
}: ContextMcpPanelProps) {
  const { load, reload } = read;
  const actions = useMcpServerActions(
    signIn === undefined ? undefined : { ...signIn, machineName, sessionId, now },
    reload,
  );

  const rows = useCatalogRows(catalogs);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const toggleDetails = (id: string): void =>
    setShown(previous => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (load.kind === 'failed')
    return (
      <ContextFailure
        machineName={machineName}
        what="read this ferret’s MCP servers"
        reason={load.reason}
        {...(load.outdated === undefined ? {} : { outdated: load.outdated, showing: 'MCP' })}
        onRetry={reload}
      />
    );
  if (load.kind !== 'ready') return <ContextNote>Reading MCP servers…</ContextNote>;

  const nowMs = now();
  const inventory = load.value;
  const servers = sortedMcpServers(inventory.servers);
  const chips = mcpChips(servers, query, actions.checks, nowMs);
  const visible = visibleMcpServers(servers, query, chip, actions.checks, nowMs);
  const total = visibleMcpServers(servers, '', chip, actions.checks, nowMs).length;
  const chipLabel = chip === 'all' ? 'All' : 'Needs attention';

  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <ContextFilterBar
        searchLabel={CONTEXT_RAIL_SEARCH_LABEL.mcp}
        query={query}
        onQueryChange={onQueryChange}
        chips={chips}
        chip={chip}
        onChipChange={onChipChange}
        {...(searchDebounceMs === undefined ? {} : { debounceMs: searchDebounceMs })}
      />
      <div className="flex min-w-0 items-center justify-between gap-sm text-meta text-muted">
        <span>
          {servers.length} server{servers.length === 1 ? '' : 's'} this ferret sees
        </span>
        <span className="flex flex-wrap items-center gap-sm">
          {onAdd === undefined ? null : (
            <button className="fy-info-link" data-context-mcp-add="" onClick={onAdd} type="button">
              <Plus aria-hidden="true" size={12} /> Add…
            </button>
          )}
        </span>
      </div>
      {inventory.problems.map(problem => (
        <p key={problem.source} className="m-0 break-words text-meta text-warn" data-context-mcp-problem="">
          {problem.message}
        </p>
      ))}
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy('mcp', total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="mcp">
          {visible.map(server => (
            <li key={server.id} className="border-b border-border-soft" data-context-mcp={server.name}>
              {catalogs === undefined ? (
                <McpServerRow server={server} actions={actions} nowMs={nowMs} online={signIn !== undefined} />
              ) : (
                <CatalogItemRow
                  host={catalogs}
                  read={rows}
                  kind="mcp"
                  itemName={server.name}
                  label={server.name}
                  source={{ kind: 'mcp', mcp: server.id }}
                  scope={{
                    label: MCP_SCOPE_LABEL[server.scope],
                    title: MCP_SCOPE_TITLE[server.scope],
                    tone: server.scope === 'project' || server.scope === 'local' ? 'accent' : 'muted',
                  }}
                  description={MCP_TRANSPORT_LABEL[server.transport]}
                  onOpen={() => toggleDetails(server.id)}
                  openLabel={shown.has(server.id) ? 'Hide details' : 'Show details'}
                  dimmed={server.shadowedBy !== undefined}
                >
                  <div className="px-xs">
                    <McpServerRow
                      server={server}
                      actions={actions}
                      nowMs={nowMs}
                      online={signIn !== undefined}
                      compact
                    />
                  </div>
                  {shown.has(server.id) ? <McpServerDetails server={server} /> : null}
                </CatalogItemRow>
              )}
            </li>
          ))}
        </ul>
      )}
      {actions.sheet}
    </div>
  );
}
