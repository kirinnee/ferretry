/**
 * Settings › MCP servers: every MCP server on this machine, once each, with every runtime that sees it, where it stands,
 * Check and Sign in; and, for a server a Ferretry component configures, its sign-in section (who it is with, the secrets
 * it lives under, Sign out). Signing in is the daemon's OAuth client at work (docs/mcp-oauth.md): the app only opens the
 * provider's page and hands the daemon back the address the provider sent the browser to, and no token ever reaches it.
 */
import { ContextFailure, ContextFilterBar, contextEmptyCopy, ContextNote, useContextRead } from '@ferretry/app/ui';
import { useCallback, useState } from 'react';
import { type McpClient, readMachineMcpServers } from '../lib/client.ts';
import { type McpChip, MCP_SEARCH_LABEL, mcpChips, sortedMcpServers, visibleMcpServers } from '../lib/mcp-model.ts';
import './mcp.css';
import { MACHINE_NAME } from './servers-panel.tsx';
import { McpSignInSection } from './sign-in-section.tsx';
import { McpServerDetails } from './server-details.tsx';
import { McpServerRow, useMcpServerActions } from './server-row.tsx';

export interface McpSettingsProps {
  readonly client: McpClient;
  readonly now?: () => number;
  readonly origin?: string;
}

export function McpSettings({ client, now = Date.now, origin }: McpSettingsProps) {
  const loader = useCallback(async () => await readMachineMcpServers(client), [client]);
  const { load, reload } = useContextRead(loader, true);
  const actions = useMcpServerActions(
    { client, machineName: MACHINE_NAME, now, ...(origin === undefined ? {} : { origin }) },
    reload,
  );
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<McpChip>('all');

  if (load.kind === 'failed')
    return (
      <ContextFailure machineName={MACHINE_NAME} what="read the MCP servers" reason={load.reason} onRetry={reload} />
    );
  if (load.kind !== 'ready') return <ContextNote>Reading MCP servers…</ContextNote>;

  const nowMs = now();
  const servers = sortedMcpServers(load.value.servers);
  const chips = mcpChips(servers, query, actions.checks, nowMs);
  const visible = visibleMcpServers(servers, query, chip, actions.checks, nowMs);
  const total = visibleMcpServers(servers, '', chip, actions.checks, nowMs).length;
  const chipLabel = chip === 'all' ? 'All' : 'Needs attention';

  return (
    <section aria-label="MCP servers" className="flex min-w-0 flex-col gap-sm" data-settings="mcp">
      <p className="m-0 text-cell leading-base text-muted">
        An MCP server gives a ferret more tools. These are the servers any runtime on this machine sees; Check connects
        to one the way a ferret would and lists its tools.
      </p>
      <ContextFilterBar
        searchLabel={MCP_SEARCH_LABEL}
        query={query}
        onQueryChange={setQuery}
        chips={chips}
        chip={chip}
        onChipChange={setChip}
      />
      {load.value.problems.map(problem => (
        <p key={problem.source} className="m-0 break-words text-meta text-warn" data-context-mcp-problem="">
          {problem.message}
        </p>
      ))}
      {visible.length === 0 ? (
        <ContextNote>
          {contextEmptyCopy('No runtime on this machine sees an MCP server.', total, query, chipLabel)}
        </ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="mcp">
          {visible.map(server => {
            const section = server.scope === 'component' && server.signIn !== undefined;
            return (
              <li key={server.id} className="border-b border-border-soft" data-context-mcp={server.name}>
                {/* A server with its own sign-in section leaves Sign in to that section. */}
                <McpServerRow server={server} actions={actions} nowMs={nowMs} offerSignIn={!section} />
                <McpServerDetails server={server} />
                {section && server.signIn !== undefined ? (
                  <McpSignInSection
                    client={client}
                    component={server.signIn.subject}
                    machineName={MACHINE_NAME}
                    online
                    now={now}
                    {...(origin === undefined ? {} : { origin })}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {actions.sheet}
    </section>
  );
}
