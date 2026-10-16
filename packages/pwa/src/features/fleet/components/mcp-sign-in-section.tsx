/**
 * The Sign-in section of a remote MCP server's page (docs/mcp-oauth.md): where its sign-in stands, who it
 * is with, the secrets it lives under, and the two acts — Sign in, which opens the sign-in sheet, and Sign
 * out, which asks first.
 *
 * Both acts are `fleet`/configure on the daemon, so they sit behind the same change panel every other
 * Machines write does: it says when this device will be asked for its passkey, and the carrier asks for it
 * when the daemon wants it.
 */

import type { FleetComponentView, McpOAuthConnection, McpOAuthFlow } from '@ferretry/protocol';
import { Lock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { cn } from '../../../lib/class-names.ts';
import { Button } from '../../../shell/primitives.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { readMcpSignIns, signOutMcp, startMcpSignIn } from '../mcp-auth-api.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { CatalogNote, Hint, Section } from './catalog-ui.tsx';
import { issuerHost, mcpRedirectUri, mcpSignInStatus, type McpSignInTone } from './mcp-sign-in-model.ts';
import { type McpSignInChannelFactory, McpSignInSheet } from './mcp-sign-in-sheet.tsx';

export interface McpSignInSectionProps {
  readonly component: FleetComponentView;
  readonly machineName: string;
  readonly online: boolean;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The origin the provider sends the browser back to. This page's own, unless a test says otherwise. */
  readonly origin?: string;
  /** Supplied in tests. */
  readonly channel?: McpSignInChannelFactory;
  readonly now?: () => number;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly connection: McpOAuthConnection | undefined }
  | { readonly kind: 'failed'; readonly reason: string };

const DOT: Readonly<Record<McpSignInTone, string>> = { ok: 'bg-ok', warn: 'bg-warn', pend: 'bg-muted' };

export function McpSignInSection({
  component,
  machineName,
  online,
  connection,
  createClient,
  origin = window.location.origin,
  channel,
  now = Date.now,
}: McpSignInSectionProps) {
  const name = component.name;
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [flow, setFlow] = useState<McpOAuthFlow | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const changes = useAccountChanges({ connection, createClient });
  const redirectUri = mcpRedirectUri(origin);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const list = await readMcpSignIns(await createClient(connection));
      setRead({ kind: 'ready', connection: list.connections.find(entry => entry.component === name) });
    } catch (error) {
      setRead({ kind: 'failed', reason: changeRefusalSentence(error) });
    }
  }, [connection, createClient, name]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const start = async (): Promise<void> => {
    setStarting(true);
    setSaid(null);
    changes.clear();
    try {
      setFlow(await startMcpSignIn(await createClient(connection), name, { redirectUri }));
    } catch (error) {
      changes.refuse(changeRefusalSentence(error));
    } finally {
      setStarting(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setStarting(true);
    changes.clear();
    try {
      const answer = await signOutMcp(await createClient(connection), name);
      setConfirming(false);
      setSaid(
        answer.revoked
          ? `Signed out of ${name}. The provider confirmed it ended the sign-in.`
          : `Signed out of ${name}. The stored sign-in is deleted.`,
      );
      await reload();
    } catch (error) {
      changes.refuse(changeRefusalSentence(error));
    } finally {
      setStarting(false);
    }
  };

  if (read.kind === 'loading')
    return (
      <Section title="Sign-in" spot="mcp-sign-in">
        <p className="m-0 text-cell text-muted" role="status">
          Reading whether {name} is signed in…
        </p>
      </Section>
    );
  if (read.kind === 'failed')
    return (
      <Section title="Sign-in" spot="mcp-sign-in">
        <CatalogNote
          tone="warn"
          spot="mcp-sign-in-failed"
          role="status"
          title={`Couldn’t read whether ${name} is signed in`}
          actions={
            <Button type="button" size="sm" onClick={() => void reload()} data-mcp-sign-in-retry="">
              Try again
            </Button>
          }
        >
          {read.reason}
        </CatalogNote>
      </Section>
    );

  const signedIn = read.connection;
  const status = mcpSignInStatus(signedIn, now());
  return (
    <Section title="Sign-in" spot="mcp-sign-in">
      <div className="kt-panel flex min-w-0 flex-col gap-2 p-panel" data-mcp-sign-in-state={signedIn?.state ?? 'none'}>
        <p className="m-0 flex min-w-0 items-center gap-2 text-row font-semibold text-fg">
          <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', DOT[status.tone])} />
          <span className="min-w-0 break-words" data-mcp-sign-in-status="">
            {status.title}
          </span>
        </p>
        {status.detail === undefined ? null : <Hint>{status.detail}</Hint>}
        {signedIn?.issuer === undefined ? null : (
          <p className="m-0 break-words text-cell text-muted">
            With <span className="font-mono text-fg">{issuerHost(signedIn.issuer)}</span>
          </p>
        )}
        {signedIn === undefined || signedIn.secrets.length === 0 ? null : (
          <div className="flex min-w-0 flex-col gap-1 text-meta text-muted" data-mcp-sign-in-secrets="">
            <span className="inline-flex items-center gap-1">
              <Lock size={12} aria-hidden="true" /> Stored as secrets, listed in Settings › Secrets:
            </span>
            <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0">
              {signedIn.secrets.map(secret => (
                <li key={secret} className="min-w-0 break-all font-mono">
                  {secret}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {said === null ? null : (
        <p className="m-0 text-cell text-ok" role="status" data-mcp-sign-in-said="">
          {said}
        </p>
      )}

      {confirming ? (
        <CatalogNote tone="danger" spot="mcp-sign-out" role="alert" title={`Sign out of ${name}?`}>
          <span>
            Ferretry deletes the stored sign-in
            {signedIn?.issuer === undefined ? '' : ` and asks ${issuerHost(signedIn.issuer)} to end it`}. Runtimes that
            use {name} can’t launch until you sign in again.
          </span>
          <ChangeApplyPanel
            machineName={machineName}
            authority={changes.authority}
            busy={starting}
            refusal={changes.refusal}
            submitLabel="Sign out"
            busyLabel="Signing out…"
            variant="danger"
            disabled={!online}
            onSubmit={() => void signOut()}
          >
            <Button type="button" onClick={() => setConfirming(false)} data-mcp-sign-out-keep="">
              Keep signed in
            </Button>
          </ChangeApplyPanel>
        </CatalogNote>
      ) : (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={starting}
          refusal={changes.refusal}
          submitLabel={status.signedInBefore ? 'Sign in again' : 'Sign in'}
          busyLabel="Opening sign-in…"
          disabled={!online}
          onSubmit={() => void start()}
        >
          {status.canSignOut ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                changes.clear();
                setSaid(null);
                setConfirming(true);
              }}
              data-mcp-sign-out-ask=""
            >
              Sign out…
            </Button>
          ) : null}
        </ChangeApplyPanel>
      )}

      {flow === null ? null : (
        <McpSignInSheet
          component={name}
          machineName={machineName}
          flow={flow}
          redirectUri={redirectUri}
          connection={connection}
          createClient={createClient}
          onSignedIn={() => void reload()}
          onClose={() => setFlow(null)}
          {...(channel === undefined ? {} : { channel })}
          now={now}
        />
      )}
    </Section>
  );
}
