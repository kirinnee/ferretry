/**
 * The Sign-in section of a remote MCP server's page (docs/mcp-oauth.md): where its sign-in stands, who it
 * is with, the secrets it lives under, and the two acts — Sign in, which opens the sign-in sheet, and Sign
 * out, which asks first.
 *
 * Both acts are `fleet`/configure on the daemon, so they sit behind the same change panel every other
 * Machines write does: it says when this device will be asked for its passkey, and the carrier asks for it
 * when the daemon wants it.
 */

import { Button, type ChangeAuthority, ChangeApplyPanel, cn } from '@ferretry/app/ui';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import type { McpOAuthFlow } from '../../contract/index.ts';
import { type McpClient, signOutMcp, startMcpSignIn } from '../lib/client.ts';
import { changeRefusalSentence } from '../lib/refusal.ts';
import { issuerHost, type McpSignInTone, mcpRedirectUri, mcpSignInStatus } from '../lib/sign-in-model.ts';
import { useSignInChanges } from '../lib/use-sign-in-changes.ts';
import type { McpSignIns } from '../lib/use-sign-ins.ts';
import { Hint, Note, Section } from './parts.tsx';
import { type McpSignInChannelFactory, McpSignInSheet } from './sign-in-sheet.tsx';

export interface McpSignInSectionProps {
  /** The server's sign-in subject: a component's name. */
  readonly component: string;
  readonly machineName: string;
  readonly online: boolean;
  readonly client: McpClient;
  /** Where every server's sign-in stands, read once by the tab (`useMcpSignIns`); this section finds its own server in it. */
  readonly signIns: McpSignIns;
  /** What this browser may change here, read once by the tab (`useChangeAuthority`). */
  readonly authority: ChangeAuthority | null;
  /** The origin the provider sends the browser back to. This page's own, unless a test says otherwise. */
  readonly origin?: string;
  /** Supplied in tests. */
  readonly channel?: McpSignInChannelFactory;
  readonly now?: () => number;
}

const DOT: Readonly<Record<McpSignInTone, string>> = { ok: 'bg-ok', warn: 'bg-warn', pend: 'bg-muted' };

export function McpSignInSection({
  component,
  machineName,
  online,
  client,
  signIns,
  authority,
  origin = window.location.origin,
  channel,
  now = Date.now,
}: McpSignInSectionProps) {
  const name = component;
  const read = signIns.read;
  const reload = signIns.reload;
  const [flow, setFlow] = useState<McpOAuthFlow | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const changes = useSignInChanges(authority);
  const redirectUri = mcpRedirectUri(origin);

  const start = async (): Promise<void> => {
    setStarting(true);
    setSaid(null);
    changes.clear();
    try {
      setFlow(await startMcpSignIn(client, name, { redirectUri }));
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
      const answer = await signOutMcp(client, name);
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
        <Note
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
        </Note>
      </Section>
    );

  const signedIn = read.list.connections.find(entry => entry.component === name);
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
        <Note tone="danger" spot="mcp-sign-out" role="alert" title={`Sign out of ${name}?`}>
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
        </Note>
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
          client={client}
          onSignedIn={() => void reload()}
          onClose={() => setFlow(null)}
          {...(channel === undefined ? {} : { channel })}
          now={now}
        />
      )}
    </Section>
  );
}
