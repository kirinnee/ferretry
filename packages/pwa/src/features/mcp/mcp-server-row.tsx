/**
 * One MCP server, as a row a person can act on: its scope, where it stands, Check, and Sign in.
 *
 * Context › MCP inside a ferret and the Components page's MCP rows both draw THIS row and run its acts
 * through {@link useMcpServerActions}, so a server reads and behaves the same in both places.
 *
 * Signing in is the components' flow, unchanged (docs/mcp-oauth.md): the row starts it with the server's
 * `signIn.subject` — a component's name, or a project server's `<name>..<project key>` — and hands the flow
 * to the same `McpSignInSheet`, which owns the provider page, the callback hand-over and the paste way.
 */

import type { McpInventoryServer, McpOAuthFlow } from '@ferretry/protocol';
import { type ReactNode, useCallback, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { mcpRedirectUri } from '../fleet/components/mcp-sign-in-model.ts';
import { type McpSignInChannelFactory, McpSignInSheet } from '../fleet/components/mcp-sign-in-sheet.tsx';
import type { FleetClientFactory } from '../fleet/fleet-client.ts';
import { startMcpSignIn } from '../fleet/mcp-auth-api.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { checkMcpServer } from './mcp-api.ts';
import {
  checkedTools,
  MCP_SCOPE_LABEL,
  MCP_SCOPE_TITLE,
  MCP_TRANSPORT_LABEL,
  type McpCheckState,
  type McpTone,
  mcpRowStatus,
  type PlainFailure,
  plainFailure,
} from './mcp-model.ts';

/** What a row needs to check a server and sign in to it on one machine. */
export interface McpActionsHost {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The machine's own name, as the sheet and the failures say it. */
  readonly machineName: string;
  /** Check as this ferret reaches the server. Absent on the Components page: the machine's view. */
  readonly sessionId?: string;
  /** The origin the provider sends the browser back to. This page's own unless a test says otherwise. */
  readonly origin?: string;
  /** Supplied in tests. */
  readonly channel?: McpSignInChannelFactory;
  readonly now?: () => number;
}

export interface McpServerActions {
  readonly checks: ReadonlyMap<string, McpCheckState>;
  readonly check: (server: McpInventoryServer) => Promise<void>;
  readonly signIn: (server: McpInventoryServer) => Promise<void>;
  /** The server whose Sign in is opening, while it is. */
  readonly starting: string | null;
  /** Why a Sign in did not start, by server id. */
  readonly refusals: ReadonlyMap<string, PlainFailure>;
  /** The sign-in sheet, when one is open. Render it once, beside the list. */
  readonly sheet: ReactNode;
}

/**
 * Check and Sign in for a list of servers. `onSignedIn` re-reads the list once a sign-in lands. With no
 * host (a surface that cannot reach the machine's fleet) both acts do nothing and no row offers them.
 */
export function useMcpServerActions(host: McpActionsHost | undefined, onSignedIn: () => void): McpServerActions {
  const [checks, setChecks] = useState<ReadonlyMap<string, McpCheckState>>(new Map());
  const [refusals, setRefusals] = useState<ReadonlyMap<string, PlainFailure>>(new Map());
  const [starting, setStarting] = useState<string | null>(null);
  const [flow, setFlow] = useState<McpOAuthFlow | null>(null);
  const connection = host?.connection;
  const createClient = host?.createClient;
  const machineName = host?.machineName ?? '';
  const sessionId = host?.sessionId;
  const redirectUri = mcpRedirectUri(host?.origin ?? window.location.origin);

  const check = useCallback(
    async (server: McpInventoryServer): Promise<void> => {
      if (connection === undefined || createClient === undefined) return;
      setChecks(previous => new Map(previous).set(server.id, { kind: 'checking' }));
      let next: McpCheckState;
      try {
        next = { kind: 'done', result: await checkMcpServer(await createClient(connection), server.id, sessionId) };
      } catch (error) {
        next = { kind: 'failed', failure: plainFailure(rawReason(error), machineName, `check ${server.name}`) };
      }
      setChecks(previous => new Map(previous).set(server.id, next));
    },
    [connection, createClient, machineName, sessionId],
  );

  const signIn = useCallback(
    async (server: McpInventoryServer): Promise<void> => {
      if (server.signIn === undefined || connection === undefined || createClient === undefined) return;
      setStarting(server.id);
      setRefusals(previous => {
        const next = new Map(previous);
        next.delete(server.id);
        return next;
      });
      try {
        setFlow(await startMcpSignIn(await createClient(connection), server.signIn.subject, { redirectUri }));
      } catch (error) {
        const failure = plainFailure(rawReason(error), machineName, `start signing in to ${server.name}`);
        setRefusals(previous => new Map(previous).set(server.id, failure));
      } finally {
        setStarting(null);
      }
    },
    [connection, createClient, machineName, redirectUri],
  );

  const sheet =
    flow === null || host === undefined ? null : (
      <McpSignInSheet
        component={flow.component}
        machineName={machineName}
        flow={flow}
        redirectUri={redirectUri}
        connection={host.connection}
        createClient={host.createClient}
        onSignedIn={() => {
          // A new sign-in makes an older check's "needs sign-in" stale.
          setChecks(new Map());
          onSignedIn();
        }}
        onClose={() => setFlow(null)}
        {...(host.channel === undefined ? {} : { channel: host.channel })}
        now={host.now ?? Date.now}
      />
    );

  return { checks, check, signIn, starting, refusals, sheet };
}

/** The error's own text, for Details; a sentence when it has none. */
const rawReason = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : changeRefusalSentence(error);

const DOT: Readonly<Record<McpTone, string>> = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', none: 'bg-faint' };

/** A failure: the sentence, and the raw text behind Details. */
export function PlainFailureText({ failure, spot }: { readonly failure: PlainFailure; readonly spot: string }) {
  return (
    <div className="m-0 flex w-full min-w-0 flex-col gap-0.5 text-meta" role="alert" data-mcp-failure={spot}>
      <span className="break-words text-err">{failure.headline}</span>
      {failure.details === undefined ? null : (
        <details className="min-w-0 text-faint">
          <summary className="cursor-pointer select-none">Details</summary>
          <span className="block break-words font-mono text-2xs" data-mcp-failure-details="">
            {failure.details}
          </span>
        </details>
      )}
    </div>
  );
}

export interface McpServerRowProps {
  readonly server: McpInventoryServer;
  readonly actions: McpServerActions;
  readonly nowMs: number;
  /** Whether acts are offered (the machine is answering). */
  readonly online?: boolean;
  /**
   * Draw only the status line and the acts, under a row that already names the server and its scope
   * (the Components page).
   */
  readonly compact?: boolean;
  /** Leave Sign in to a section beside the row that already offers it (a server's own page). */
  readonly offerSignIn?: boolean;
}

export function McpServerRow({
  server,
  actions,
  nowMs,
  online = true,
  compact = false,
  offerSignIn = true,
}: McpServerRowProps) {
  const state = actions.checks.get(server.id);
  const result = state?.kind === 'done' ? state.result : undefined;
  const status = mcpRowStatus(server, result, nowMs);
  const names = checkedTools(result);
  const refusal = actions.refusals.get(server.id);
  const checking = state?.kind === 'checking';
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-1 py-xs', server.shadowedBy !== undefined && 'opacity-70')}
      data-mcp-row={server.name}
      data-mcp-scope={server.scope}
    >
      {compact ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
          <span className="min-w-0 flex-1 truncate font-mono text-cell text-fg">{server.name}</span>
          <span
            className="fy-info-chip"
            data-tone={server.scope === 'project' || server.scope === 'local' ? 'accent' : 'muted'}
            title={MCP_SCOPE_TITLE[server.scope]}
            data-mcp-scope-chip=""
          >
            {MCP_SCOPE_LABEL[server.scope]}
          </span>
          <span className="text-meta text-faint">{MCP_TRANSPORT_LABEL[server.transport]}</span>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-meta text-muted" data-mcp-status={status.tone}>
          <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', DOT[status.tone])} />
          <span className="min-w-0 break-words">{checking ? 'Checking…' : status.label}</span>
        </span>
        {status.canCheck ? (
          <Button
            type="button"
            size="sm"
            disabled={!online || checking}
            onClick={() => void actions.check(server)}
            data-mcp-check={server.name}
          >
            {checking ? 'Checking…' : 'Check'}
          </Button>
        ) : null}
        {status.signIn === undefined || !offerSignIn ? null : (
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={!online || actions.starting !== null}
            onClick={() => void actions.signIn(server)}
            data-mcp-sign-in={server.name}
          >
            {actions.starting === server.id ? 'Opening sign-in…' : status.signIn}
          </Button>
        )}
      </div>
      {status.detail === undefined || checking ? null : (
        <p className="m-0 break-words text-meta text-faint" data-mcp-detail="">
          {status.detail}
        </p>
      )}
      {status.signInUnsupported === undefined ? null : (
        <p className="m-0 break-words text-meta text-faint" data-mcp-sign-in-unsupported="">
          {status.signInUnsupported}
        </p>
      )}
      {names.length === 0 ? null : (
        <p className="m-0 break-words font-mono text-2xs text-faint" data-mcp-tools="">
          {names.join(' · ')}
        </p>
      )}
      {state?.kind === 'failed' ? <PlainFailureText failure={state.failure} spot="check" /> : null}
      {refusal === undefined ? null : <PlainFailureText failure={refusal} spot="sign-in" />}
    </div>
  );
}
