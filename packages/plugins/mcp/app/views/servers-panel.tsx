/**
 * Info › Folder › MCP, and the Tools row: every MCP server this ferret sees, from every scope — Project, Local, User and
 * Ferretry — each with where it stands, Check and Sign in (docs/mcp-scopes.md).
 *
 * The rows are the shared `McpServerRow`, the same one Settings › MCP servers draws, and every act goes through
 * `useMcpServerActions`: Check asks the daemon to connect AS THIS FERRET would, and Sign in is the server's flow under its
 * own subject — which is what lets a project's `.mcp.json` server sign in at all. The panel reads one ferret's servers
 * through the half's own client; no secret value, token or program argument ever reaches it.
 */
import { ContextFailure, ContextFilterBar, contextEmptyCopy, ContextNote, useContextRead } from '@ferretry/app/ui';
import { useCallback, useState } from 'react';
import { type McpClient, readFerretMcpServers } from '../lib/client.ts';
import {
  type McpChip,
  MCP_EMPTY,
  MCP_SCOPE_LABEL,
  MCP_SCOPE_TITLE,
  MCP_SEARCH_LABEL,
  MCP_TRANSPORT_LABEL,
  mcpChips,
  sortedMcpServers,
  visibleMcpServers,
} from '../lib/mcp-model.ts';
import './mcp.css';
import { McpServerDetails } from './server-details.tsx';
import { McpServerRow, useMcpServerActions } from './server-row.tsx';

/** The machine's own name, for a failure said in words: a half talks to ONE daemon and does not know its label. */
export const MACHINE_NAME = 'This machine';

export interface McpServersPanelProps {
  readonly client: McpClient;
  /** The ferret whose servers these are: Check reaches each one as it does. */
  readonly ferretId: string;
  readonly now?: () => number;
  readonly searchDebounceMs?: number;
}

export function McpServersPanel({ client, ferretId, now = Date.now, searchDebounceMs }: McpServersPanelProps) {
  const loader = useCallback(async () => await readFerretMcpServers(client, ferretId), [client, ferretId]);
  const read = useContextRead(loader, true);
  const { load, reload } = read;
  const actions = useMcpServerActions({ client, machineName: MACHINE_NAME, ferretId, now }, reload);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<McpChip>('all');
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
        machineName={MACHINE_NAME}
        what="read this ferret’s MCP servers"
        reason={load.reason}
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
    <div className="flex min-w-0 flex-col gap-sm" data-mcp-panel="">
      <ContextFilterBar
        searchLabel={MCP_SEARCH_LABEL}
        query={query}
        onQueryChange={setQuery}
        chips={chips}
        chip={chip}
        onChipChange={setChip}
        {...(searchDebounceMs === undefined ? {} : { debounceMs: searchDebounceMs })}
      />
      <div className="flex min-w-0 items-center justify-between gap-sm text-meta text-muted">
        <span>
          {servers.length} server{servers.length === 1 ? '' : 's'} this ferret sees
        </span>
      </div>
      {inventory.problems.map(problem => (
        <p key={problem.source} className="m-0 break-words text-meta text-warn" data-context-mcp-problem="">
          {problem.message}
        </p>
      ))}
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy(MCP_EMPTY, total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="mcp">
          {visible.map(server => (
            <li key={server.id} className="border-b border-border-soft" data-context-mcp={server.name}>
              <McpServerRow server={server} actions={actions} nowMs={nowMs} />
              <button
                aria-expanded={shown.has(server.id)}
                className="fy-mcp-link text-meta"
                data-mcp-details-toggle={server.name}
                onClick={() => toggleDetails(server.id)}
                title={`${MCP_SCOPE_LABEL[server.scope]}: ${MCP_SCOPE_TITLE[server.scope]}`}
                type="button"
              >
                {shown.has(server.id) ? 'Hide details' : `Show details · ${MCP_TRANSPORT_LABEL[server.transport]}`}
              </button>
              {shown.has(server.id) ? <McpServerDetails server={server} /> : null}
            </li>
          ))}
        </ul>
      )}
      {actions.sheet}
    </div>
  );
}
