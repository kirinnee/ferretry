/**
 * Signing one login in, in place (docs/design/account-model.md §4.6, E13, E31).
 *
 * The harness's own sign-in, driven from here: Claude shows a link and takes back the code its page
 * shows; Codex shows a link and a device code and finishes on its own. The daemon holds no token while
 * it happens — the harness writes its own login into the one store every runtime on it reads, so one
 * sign-in fixes all of them.
 *
 * Before a sign-in starts, this is the ordinary change panel ("Sign in to Claude Code", with the
 * operator password when this browser owes it). Once one is running, it is the harness's panel. The
 * live flow is re-read every two seconds only while it waits for the person, because they are acting
 * somewhere this browser cannot see; it stops the moment the flow ends.
 */

import type { FleetCredentialView, HarnessLoginFlow } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { ClaudeLoginPanel } from '../claude-login-panel.tsx';
import { CodexLoginPanel } from '../codex-login-panel.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-configuration-surface.tsx';
import {
  type CredentialLoginFlow,
  cancelCredentialSignIn,
  readCredentialSignIn,
  startCredentialSignIn,
  submitCredentialSignInCode,
} from '../harness-login-api.ts';
import type { LoginPanelWording } from '../harness-login-model.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { credentialName, finishSignInLabel, signedInSentence, signInCoverage } from './credentials-model.ts';

/** How often a waiting sign-in is re-read. */
export const SIGN_IN_POLL_MS = 2_000;

export interface CredentialSignInProps {
  readonly credential: FleetCredentialView;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly changes: AccountChanges;
  /** The harness accepted the sign-in. The caller re-reads what changed. */
  readonly onSignedIn: () => void;
  /** A sign-in the caller already started (Add a login starts it in the same click that made the login). */
  readonly initialFlow?: CredentialLoginFlow;
  /** The unlock that start used, to read the flow back with. */
  readonly initialUnlock?: string;
  /** Supplied in tests. */
  readonly pollMs?: number;
}

const waiting = (flow: HarnessLoginFlow | null): boolean =>
  flow !== null && (flow.state === 'starting' || flow.state === 'awaiting-code' || flow.state === 'awaiting-approval');

export function CredentialSignIn({
  credential,
  machineName,
  connection,
  createClient,
  changes,
  onSignedIn,
  initialFlow,
  initialUnlock,
  pollMs = SIGN_IN_POLL_MS,
}: CredentialSignInProps) {
  const [flow, setFlow] = useState<CredentialLoginFlow | null>(initialFlow ?? null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const unlock = useRef<string | undefined>(initialUnlock);
  const reported = useRef<string | null>(null);

  const finished = useCallback(
    (next: CredentialLoginFlow): void => {
      setFlow(next);
      if (next.state === 'complete' && reported.current !== next.flowId) {
        reported.current = next.flowId;
        onSignedIn();
      }
    },
    [onSignedIn],
  );

  useEffect(() => {
    if (flow === null || !waiting(flow)) return;
    const timer = setTimeout(() => {
      void createClient(connection)
        .then(client => readCredentialSignIn(client, flow.flowId, unlock.current))
        .then(finished)
        .catch((error: unknown) => setRefusal(changeRefusalSentence(error)));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [connection, createClient, finished, flow, pollMs]);

  const start = async (operatorPassword: string | undefined): Promise<void> => {
    setRefusal(null);
    const authorization = await changes.authorize(operatorPassword);
    if (authorization.kind === 'refused') return;
    unlock.current = authorization.unlock;
    setBusy(true);
    try {
      const client = await createClient(connection);
      finished(
        await startCredentialSignIn(
          client,
          {
            credentialId: credential.id,
            ...(authorization.operatorPassword === undefined
              ? {}
              : { operatorPassword: authorization.operatorPassword }),
          },
          authorization.unlock,
        ),
      );
    } catch (error) {
      setRefusal(changeRefusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (code: string): Promise<void> => {
    if (flow === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const client = await createClient(connection);
      const answer = await submitCredentialSignInCode(client, flow.flowId, code, unlock.current);
      if (answer.outcome === 'accepted') finished(answer.flow);
      else setRefusal(answer.reason);
    } catch (error) {
      setRefusal(changeRefusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (flow === null) return;
    setBusy(true);
    try {
      const client = await createClient(connection);
      await cancelCredentialSignIn(client, flow.flowId, unlock.current);
    } catch {
      // The flow ends on its own within minutes; the panel goes back to its start either way.
    } finally {
      setBusy(false);
      setFlow(null);
    }
  };

  if (!credential.signIn.available)
    return (
      <p className="m-0 text-cell leading-base text-muted" data-credential-sign-in="unavailable">
        {credential.signIn.reason}
      </p>
    );

  const name = HARNESS_NAMES[credential.harness];
  if (flow === null)
    return (
      <section className="kt-panel flex flex-col gap-3 p-panel" data-credential-sign-in="start">
        <div>
          <p className="m-0 text-row font-semibold text-fg">Sign in to {name}</p>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">{signInCoverage(credential, machineName)}</p>
        </div>
        <ChangeApplyPanel
          machineName={machineName}
          // Signing in is not an account-model change: it works while changes are switched off.
          changes={null}
          authority={changes.authority}
          busy={busy || changes.busy}
          busyLabel="Starting sign-in…"
          refusal={refusal ?? changes.refusal}
          submitLabel={`Sign in to ${name}`}
          onSubmit={password => void start(password)}
        />
      </section>
    );

  const wording: LoginPanelWording = {
    coverage: signInCoverage(credential, machineName),
    signedIn: signedInSentence(credential.usedBy.length),
    finishLabel: finishSignInLabel(credential),
  };
  const common = {
    accountLabel: credentialName(credential),
    identity: credential.id,
    memberCount: 1,
    busy,
    refusal,
    wording,
    onStart: () => setFlow(null),
    onCancel: () => void cancel(),
  };
  return (
    <div data-credential-sign-in={flow.state}>
      {flow.harness === 'claude' ? (
        <ClaudeLoginPanel {...common} flow={flow} onSubmitCode={code => void submit(code)} />
      ) : (
        <CodexLoginPanel {...common} flow={flow} />
      )}
    </div>
  );
}
