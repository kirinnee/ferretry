/**
 * Signing one login in, in place (docs/design/account-model.md §4.6, E13, E31).
 *
 * The harness's own sign-in, driven from here: Claude shows a link and takes back the code its page
 * shows; Codex shows a link and a device code and finishes on its own — or, when device codes do not
 * work for the account, shows a link and takes back the address the browser ends on. The daemon holds
 * no token while it happens — the harness writes its own login into the one store every runtime on it
 * reads, so one sign-in fixes all of them.
 *
 * A login has one sign-in at a time. Starting one that is already running — a page that reloaded, a
 * phone that slept, the same login opened from setup and then from Credentials — picks it up and shows
 * it again; "Start over" ends it and starts a fresh one. A start after a sign-in failed is a start-over
 * too, so a leftover Codex sign-in holding the machine's callback port is cleared on the way.
 *
 * Before a sign-in starts, this is the ordinary change panel ("Sign in to Claude Code"). Once one is running, it is the harness's panel. The
 * live flow is re-read every two seconds only while it waits for the person, because they are acting
 * somewhere this browser cannot see; it stops the moment the flow ends.
 */

import type { FleetCredentialView, HarnessLoginCodexMethod, HarnessLoginFlow } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { ClaudeLoginPanel } from '../claude-login-panel.tsx';
import { CodexLoginPanel } from '../codex-login-panel.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import {
  type CredentialLoginFlow,
  cancelCredentialSignIn,
  readCredentialSignIn,
  restartCredentialSignIn,
  startCredentialSignIn,
  submitCredentialSignInCode,
  switchCredentialSignInToLink,
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
  /** Supplied in tests. */
  readonly pollMs?: number;
}

const WAITING: ReadonlySet<HarnessLoginFlow['state']> = new Set([
  'starting',
  'awaiting-code',
  'awaiting-approval',
  'awaiting-callback',
  'finishing',
]);

const waiting = (flow: HarnessLoginFlow | null): boolean => flow !== null && WAITING.has(flow.state);

/** A Codex flow that is on its link sign-in, which its endings and its next start follow. */
const onLink = (flow: HarnessLoginFlow | null): boolean =>
  flow?.harness === 'codex' && (flow.state === 'awaiting-callback' || flow.state === 'finishing');

export function CredentialSignIn({
  credential,
  machineName,
  connection,
  createClient,
  changes,
  onSignedIn,
  initialFlow,
  pollMs = SIGN_IN_POLL_MS,
}: CredentialSignInProps) {
  const [flow, setFlow] = useState<CredentialLoginFlow | null>(initialFlow ?? null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Codex's sign-in method for the next start. Follows a flow that moved to a link by itself. */
  const [method, setMethod] = useState<HarnessLoginCodexMethod>('device-code');
  /** The next start follows a sign-in that ended badly, so it starts over rather than picking one up. */
  const [restartNext, setRestartNext] = useState(false);
  const reported = useRef<string | null>(null);

  const finished = useCallback(
    (next: CredentialLoginFlow): void => {
      setFlow(next);
      if (onLink(next)) setMethod('link');
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
        .then(client => readCredentialSignIn(client, flow.flowId))
        .then(finished)
        .catch((error: unknown) => setRefusal(changeRefusalSentence(error)));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [connection, createClient, finished, flow, pollMs]);

  /**
   * Start this login's sign-in. `over` ends whatever sign-in is running for it first (`running` names
   * it, when this screen knows it); otherwise one already running is picked up.
   */
  const start = async (over: boolean, running?: string): Promise<void> => {
    setRefusal(null);
    setBusy(true);
    try {
      const client = await createClient(connection);
      const request = {
        credentialId: credential.id,
        ...(credential.harness === 'codex' && method === 'link' ? { method } : {}),
      };
      finished(
        over ? await restartCredentialSignIn(client, request, running) : await startCredentialSignIn(client, request),
      );
      setRestartNext(false);
    } catch (error) {
      setRefusal(changeRefusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  /** Back to the start panel after an ending, so the next start starts over. */
  const again = (): void => {
    setRestartNext(true);
    setFlow(null);
  };

  const submit = async (code: string): Promise<void> => {
    if (flow === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const client = await createClient(connection);
      const answer = await submitCredentialSignInCode(client, flow.flowId, code);
      if (answer.outcome === 'accepted') finished(answer.flow);
      else setRefusal(answer.reason);
    } catch (error) {
      setRefusal(changeRefusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  const switchToLink = async (): Promise<void> => {
    if (flow === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const client = await createClient(connection);
      const answer = await switchCredentialSignInToLink(client, flow.flowId);
      if (answer.outcome === 'accepted') {
        setMethod('link');
        finished(answer.flow);
      } else setRefusal(answer.reason);
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
      await cancelCredentialSignIn(client, flow.flowId);
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
  const linkStart = method === 'link';
  if (flow === null)
    return (
      <section className="kt-panel flex flex-col gap-3 p-panel" data-credential-sign-in="start">
        <div>
          <p className="m-0 text-row font-semibold text-fg">Sign in to {name}</p>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">{signInCoverage(credential, machineName)}</p>
        </div>
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={busy || changes.busy}
          busyLabel="Starting sign-in…"
          refusal={refusal ?? changes.refusal}
          submitLabel={linkStart ? `Sign in to ${name} with a link` : `Sign in to ${name}`}
          onSubmit={() => void start(restartNext)}
        />
        {credential.harness === 'codex' ? (
          <div data-credential-sign-in-method={method}>
            <p className="m-0 text-meta leading-base text-muted">
              {linkStart ? 'You’ll paste back the address the browser ends on.' : 'Device code didn’t work?'}
            </p>
            <Button
              type="button"
              className="mt-2"
              disabled={busy}
              onClick={() => setMethod(linkStart ? 'device-code' : 'link')}
            >
              {linkStart ? 'Use a device code instead' : 'Sign in with a link instead'}
            </Button>
          </div>
        ) : null}
      </section>
    );

  const wording: LoginPanelWording = {
    coverage: signInCoverage(credential, machineName),
    signedIn: signedInSentence(credential.usedBy.length),
    finishLabel: finishSignInLabel(credential),
  };
  const common = {
    accountLabel: credentialName(credential),
    loginId: credential.id,
    busy,
    refusal,
    wording,
    onStart: again,
    onCancel: () => void cancel(),
    ...(waiting(flow) ? { onStartOver: () => void start(true, flow.flowId) } : {}),
  };
  return (
    <div data-credential-sign-in={flow.state}>
      {flow.harness === 'claude' ? (
        <ClaudeLoginPanel {...common} flow={flow} onSubmitCode={code => void submit(code)} />
      ) : (
        <CodexLoginPanel
          {...common}
          flow={flow}
          linked={linkStart}
          onUseLink={() => void switchToLink()}
          onStartLink={() => {
            setMethod('link');
            again();
          }}
          onSubmitAddress={address => void submit(address)}
        />
      )}
    </div>
  );
}
