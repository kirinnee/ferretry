/**
 * MCP: the servers this agent can reach here, where each sign-in stands, and Sign in for the ones that
 * need it.
 *
 * Signing in is the Components tab's flow, unchanged (docs/mcp-oauth.md): the rail starts it with
 * `startMcpSignIn` and hands the flow to the same `McpSignInSheet`, which owns the provider page, the
 * callback hand-over and the paste way. Nothing about OAuth is decided here.
 */

import type { McpOAuthFlow } from '@ferretry/protocol';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { mcpRedirectUri } from '../fleet/components/mcp-sign-in-model.ts';
import { type McpSignInChannelFactory, McpSignInSheet } from '../fleet/components/mcp-sign-in-sheet.tsx';
import type { FleetClientFactory } from '../fleet/fleet-client.ts';
import { startMcpSignIn } from '../fleet/mcp-auth-api.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import {
  CONTEXT_RAIL_SEARCH_LABEL,
  type ContextMcpServer,
  contextEmptyCopy,
  type McpChip,
  type McpRowStatus,
  MCP_SCOPE_LABEL,
  mcpChips,
  mcpRowStatus,
  mcpScopeTitle,
  visibleMcpServers,
} from './context-rail-model.ts';
import { type ContextRead, ContextFailure, ContextFilterBar, ContextNote } from './context-rail-parts.tsx';

/**
 * What the rail needs to run a sign-in on the agent's machine. Without it the rail still shows where
 * every sign-in stands, and offers no Sign in.
 */
export interface ContextMcpSignInHost {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The machine's own name, as the sign-in sheet says it. */
  readonly machineName: string;
  /** The origin the provider sends the browser back to. This page's own unless a test says otherwise. */
  readonly origin?: string;
  /** Supplied in tests. */
  readonly channel?: McpSignInChannelFactory;
}

export interface ContextMcpPanelProps {
  readonly read: ContextRead<readonly ContextMcpServer[]>;
  readonly signIn?: ContextMcpSignInHost;
  /** Opens Actions › Add MCP server… — the same form, from the list it adds to. */
  readonly onAdd?: () => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly chip: McpChip;
  readonly onChipChange: (chip: McpChip) => void;
  readonly now: () => number;
  readonly searchDebounceMs?: number;
}

const DOT: Readonly<Record<McpRowStatus['tone'], string>> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  pend: 'bg-muted',
  none: 'bg-faint',
};

export function ContextMcpPanel({
  read,
  signIn,
  onAdd,
  query,
  onQueryChange,
  chip,
  onChipChange,
  now,
  searchDebounceMs,
}: ContextMcpPanelProps) {
  const [starting, setStarting] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ readonly name: string; readonly reason: string } | null>(null);
  const [flow, setFlow] = useState<McpOAuthFlow | null>(null);
  const { load, reload } = read;

  if (load.kind === 'failed')
    return <ContextFailure title="Couldn’t read this agent’s MCP servers" reason={load.reason} onRetry={reload} />;
  if (load.kind !== 'ready') return <ContextNote>Reading MCP servers…</ContextNote>;

  const nowMs = now();
  const servers = load.value;
  const chips = mcpChips(servers, query, nowMs);
  const visible = visibleMcpServers(servers, query, chip, nowMs);
  const chipLabel = chip === 'all' ? 'All' : 'Needs sign-in';
  const total = visibleMcpServers(servers, '', chip, nowMs).length;

  const start = async (host: ContextMcpSignInHost, name: string): Promise<void> => {
    setStarting(name);
    setRefusal(null);
    try {
      const client = await host.createClient(host.connection);
      setFlow(
        await startMcpSignIn(client, name, { redirectUri: mcpRedirectUri(host.origin ?? window.location.origin) }),
      );
    } catch (error) {
      setRefusal({ name, reason: changeRefusalSentence(error) });
    } finally {
      setStarting(null);
    }
  };

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
      {onAdd === undefined ? null : (
        <div className="flex min-w-0 items-center justify-between gap-sm text-meta text-muted">
          <span>
            {servers.length} server{servers.length === 1 ? '' : 's'} this agent sees
          </span>
          <button className="fy-info-link" data-context-mcp-add="" onClick={onAdd} type="button">
            <Plus aria-hidden="true" size={12} /> Add…
          </button>
        </div>
      )}
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy('mcp', total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0" data-context-list="mcp">
          {visible.map(server => {
            const status = mcpRowStatus(server, nowMs);
            return (
              <li
                key={`${server.scope ?? ''}:${server.name}`}
                className="flex min-h-row min-w-0 flex-wrap items-center gap-x-sm gap-y-xs border-b border-border-soft py-xs"
                data-context-mcp={server.name}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-cell text-fg">{server.name}</span>
                {server.scope === undefined ? null : (
                  <span
                    className="fy-info-chip"
                    data-context-mcp-scope={server.scope}
                    data-tone={server.scope === 'project' ? 'accent' : 'muted'}
                    title={mcpScopeTitle(server.scope)}
                  >
                    {MCP_SCOPE_LABEL[server.scope]}
                  </span>
                )}
                <span className="text-meta text-faint">{server.transport === 'url' ? 'URL' : 'command'}</span>
                {status.canSignIn && signIn !== undefined ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={starting !== null}
                    onClick={() => void start(signIn, server.name)}
                    data-context-mcp-sign-in={server.name}
                  >
                    {starting === server.name ? 'Opening sign-in…' : status.signInLabel}
                  </Button>
                ) : (
                  <span className="flex min-w-0 items-center gap-1 text-meta text-muted" data-context-mcp-status="">
                    <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', DOT[status.tone])} />
                    <span className="min-w-0 truncate">{status.label}</span>
                  </span>
                )}
                {refusal?.name === server.name ? (
                  <p className="m-0 w-full break-words text-meta text-err" role="alert" data-context-mcp-refusal="">
                    {refusal.reason}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {flow === null || signIn === undefined ? null : (
        <McpSignInSheet
          component={flow.component}
          machineName={signIn.machineName}
          flow={flow}
          redirectUri={mcpRedirectUri(signIn.origin ?? window.location.origin)}
          connection={signIn.connection}
          createClient={signIn.createClient}
          onSignedIn={reload}
          onClose={() => setFlow(null)}
          {...(signIn.channel === undefined ? {} : { channel: signIn.channel })}
          now={now}
        />
      )}
    </div>
  );
}
