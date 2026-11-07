/**
 * Signing one login in, in place (docs/design/harness-login.md).
 *
 * The harness's own sign-in, driven from here: Claude shows a link and takes back the code its page shows; Codex shows
 * a link and a device code and finishes on its own — or, when device codes do not work for the account, shows a link
 * and takes back the address the browser ends on. The daemon holds no token while it happens — the harness writes its
 * own login into the one store every runtime on it reads, so one sign-in fixes all of them.
 *
 * A login has one sign-in at a time. Starting one that is already running — a page that reloaded, a phone that slept —
 * picks it up and shows it again; "Start over" ends it and starts a fresh one. A start after a sign-in failed is a
 * start-over too, so a leftover Codex sign-in holding the machine's callback port is cleared on the way.
 *
 * The live flow is re-read every two seconds only while it waits for the person, because they are acting somewhere
 * this browser cannot see; it stops the moment the flow ends. The code or address a person pastes goes to the daemon
 * and is cleared from this tree before the request settles.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HarnessLoginCodexMethod, HarnessLoginFlow, LoginView } from '../../contract/index.ts';
import { refusalSentence, type LoginsClient } from '../lib/client.ts';
import type { LoginPanelWording } from '../lib/harness-login-model.ts';
import {
  cancelLoginSignIn,
  type LoginSignInFlow,
  readLoginSignIn,
  recheckLoginSignIn,
  restartLoginSignIn,
  startLoginSignIn,
  submitLoginSignInCode,
  switchLoginSignInToLink,
} from '../lib/harness-login-api.ts';
import { finishSignInLabel, HARNESS_NAMES, loginName, signedInSentence, signInCoverage } from '../lib/logins-view.ts';
import { Button, ChangeApplyPanel, useChangeAuthority } from '../ui.ts';
import { ClaudeLoginPanel } from './claude-login-panel.tsx';
import { CodexLoginPanel } from './codex-login-panel.tsx';

/** How often a waiting sign-in is re-read. */
const SIGN_IN_POLL_MS = 2_000;

export interface LoginSignInProps {
  readonly login: LoginView;
  readonly machineName: string;
  readonly client: LoginsClient;
  /** The harness accepted the sign-in. The caller re-reads what changed. */
  readonly onSignedIn: () => void;
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

export function LoginSignIn({ login, machineName, client, onSignedIn, pollMs = SIGN_IN_POLL_MS }: LoginSignInProps) {
  const [flow, setFlow] = useState<LoginSignInFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Codex's sign-in method for the next start. Follows a flow that moved to a link by itself. */
  const [method, setMethod] = useState<HarnessLoginCodexMethod>('device-code');
  /** The next start follows a sign-in that ended badly, so it starts over rather than picking one up. */
  const [restartNext, setRestartNext] = useState(false);
  const reported = useRef<string | null>(null);
  /** What this caller may change here: a remote caller that needs a passkey is told so, one that is refused is not offered the button. */
  const authority = useChangeAuthority(client);

  const finished = useCallback(
    (next: LoginSignInFlow): void => {
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
    const timer = globalThis.setTimeout(() => {
      void readLoginSignIn(client, flow.flowId)
        .then(finished)
        .catch((error: unknown) => setRefusal(refusalSentence(error)));
    }, pollMs);
    return () => globalThis.clearTimeout(timer);
  }, [client, finished, flow, pollMs]);

  /**
   * Start this login's sign-in. `over` ends whatever sign-in is running for it first (`running` names it, when this
   * screen knows it); otherwise one already running is picked up.
   */
  const start = async (over: boolean, running?: string): Promise<void> => {
    setRefusal(null);
    setBusy(true);
    try {
      const request = {
        loginId: login.id,
        ...(login.harness === 'codex' && method === 'link' ? { method } : {}),
      } as Parameters<typeof startLoginSignIn>[1];
      finished(over ? await restartLoginSignIn(client, request, running) : await startLoginSignIn(client, request));
      setRestartNext(false);
    } catch (error) {
      setRefusal(refusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  /** Back to the start panel after an ending, so the next start starts over. */
  const again = (): void => {
    setRestartNext(true);
    setFlow(null);
  };

  const answer = async (
    send: (flowId: string) => Promise<Awaited<ReturnType<typeof submitLoginSignInCode>>>,
    afterAccept?: () => void,
  ): Promise<void> => {
    if (flow === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const reply = await send(flow.flowId);
      if (reply.outcome === 'accepted') {
        afterAccept?.();
        finished(reply.flow);
      } else setRefusal(reply.reason);
    } catch (error) {
      setRefusal(refusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  const submit = (code: string): Promise<void> => answer(flowId => submitLoginSignInCode(client, flowId, code));
  const switchToLink = (): Promise<void> =>
    answer(
      flowId => switchLoginSignInToLink(client, flowId),
      () => setMethod('link'),
    );

  /**
   * Look in the store again, launching nothing: for a sign-in whose harness finished but whose login was not found — it
   * may have landed late. Found, the flow completes; still missing, the flow's own reason now says what THIS look found.
   */
  const recheck = async (): Promise<void> => {
    if (flow === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const reply = await recheckLoginSignIn(client, flow.flowId);
      if (reply.outcome === 'accepted') finished(reply.flow);
      else {
        setRefusal('Looked again just now, and there is still no usable login. What that look found is below.');
        finished(await readLoginSignIn(client, flow.flowId));
      }
    } catch (error) {
      setRefusal(refusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (flow === null) return;
    setBusy(true);
    try {
      await cancelLoginSignIn(client, flow.flowId);
    } catch {
      // The flow ends on its own within minutes; the panel goes back to its start either way.
    } finally {
      setBusy(false);
      setFlow(null);
    }
  };

  if (!login.signIn.available)
    return (
      <p className="m-0 text-cell leading-base text-muted" data-login-sign-in="unavailable">
        {login.signIn.reason}
      </p>
    );

  const name = HARNESS_NAMES[login.harness];
  const linkStart = method === 'link';
  if (flow === null)
    return (
      <section className="kt-panel flex flex-col gap-3 p-panel" data-login-sign-in="start">
        <div>
          <p className="m-0 text-row font-semibold text-fg">Sign in to {name}</p>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">{signInCoverage(login, machineName)}</p>
        </div>
        <ChangeApplyPanel
          machineName={machineName}
          authority={authority}
          busy={busy}
          busyLabel="Starting sign-in…"
          refusal={refusal}
          submitLabel={linkStart ? `Sign in to ${name} with a link` : `Sign in to ${name}`}
          onSubmit={() => void start(restartNext)}
        />
        {login.harness === 'codex' ? (
          <div data-login-sign-in-method={method}>
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
    coverage: signInCoverage(login, machineName),
    signedIn: signedInSentence(login.usedBy.length),
    finishLabel: finishSignInLabel(login),
  };
  const common = {
    accountLabel: loginName(login),
    loginId: login.id,
    busy,
    refusal,
    wording,
    onStart: again,
    onCancel: () => void cancel(),
    ...(waiting(flow) ? { onStartOver: () => void start(true, flow.flowId) } : {}),
    ...(flow.state === 'failed' && flow.recheck === true ? { onRecheck: () => void recheck() } : {}),
  };
  return (
    <div data-login-sign-in={flow.state}>
      {flow.harness === 'claude-code' ? (
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
