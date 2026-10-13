/**
 * "Sign in now", inside the first run's Claude Code or Codex step (docs/design/account-model.md §4.3, E4).
 *
 * A tool that is installed but not signed in can still be imported and signed in later. This is the
 * other answer: sign in HERE, then carry on with the same step — missing, so made in place, then back.
 *
 * It signs in the person's OWN login, the one `claude` or `codex` in their terminal uses, because that
 * is the login the import shares in place. So it makes that login first when this machine has none yet
 * (`credential.add` with `store: host`, a reviewed change like any other) and the import that follows
 * reuses it rather than adding a second one. The sign-in itself is the existing web sign-in, unchanged.
 *
 * The operator password, when this browser owes it, is typed once and spent on both the change and the
 * sign-in start, then forgotten — the same way Add a login spends it.
 */

import type { FleetCredentialView } from '@ferretry/protocol';
import { useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { readFleetCredentials } from '../credentials-api.ts';
import { CredentialSignIn } from '../credentials/credential-sign-in.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { type CredentialLoginFlow, startCredentialSignIn } from '../harness-login-api.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { freeName } from './first-run-model.ts';
import type { SetupAccess } from './setup-access.ts';
import { SETUP_HARNESS_NAMES, type SetupHarness } from './setup-words.ts';

export interface FirstRunSignInProps {
  readonly harness: SetupHarness;
  readonly machineName: string;
  readonly access: SetupAccess;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** The harness accepted the sign-in: the step reads the machine again and carries on. */
  readonly onSignedIn: () => void;
  /** "Not now": back to the step, nothing signed in. */
  readonly onClose: () => void;
  /** Supplied in tests. */
  readonly pollMs?: number;
}

const hostLogin = (credentials: readonly FleetCredentialView[], harness: SetupHarness) =>
  credentials.find(candidate => candidate.harness === harness && candidate.store === 'host');

export function FirstRunSignIn({
  harness,
  machineName,
  access,
  connection,
  createClient,
  onSignedIn,
  onClose,
  pollMs,
}: FirstRunSignInProps) {
  const { changes } = access;
  const [credential, setCredential] = useState<FleetCredentialView | null>(null);
  const [started, setStarted] = useState<{ readonly flow: CredentialLoginFlow; readonly unlock?: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = SETUP_HARNESS_NAMES[harness];

  /** The person's own login on this machine: the one already listed, or one made now. */
  const ownLogin = async (password: string | undefined): Promise<FleetCredentialView | undefined> => {
    const listed = await access.read((client, unlock) => readFleetCredentials(client, unlock), password);
    if (listed.kind === 'refused') {
      if (!listed.passwordRejected) setRefusal(listed.sentence);
      return undefined;
    }
    const existing = hostLogin(listed.value.credentials, harness);
    if (existing !== undefined) return existing;
    const id = freeName(`${harness}-you`, new Set(listed.value.credentials.map(candidate => candidate.id)));
    const made = await changes.apply({ kind: 'credential.add', id, harness, store: 'host' }, password);
    if (made.kind === 'refused') return undefined;
    const after = await access.read((client, unlock) => readFleetCredentials(client, unlock));
    return after.kind === 'done' ? hostLogin(after.value.credentials, harness) : undefined;
  };

  const begin = async (password: string | undefined): Promise<void> => {
    setRefusal(null);
    setBusy(true);
    try {
      const login = await ownLogin(password);
      if (login === undefined) return;
      setCredential(login);
      let unlock: string | undefined;
      const flow = await access.act((client, authorization) => {
        unlock = authorization.unlock;
        return startCredentialSignIn(
          client,
          {
            credentialId: login.id,
            ...(authorization.operatorPassword === undefined
              ? {}
              : { operatorPassword: authorization.operatorPassword }),
          },
          authorization.unlock,
        );
      }, password);
      if (flow.kind === 'done') setStarted({ flow: flow.value, ...(unlock === undefined ? {} : { unlock }) });
    } finally {
      setBusy(false);
    }
  };

  const notNow = (
    <div>
      <Button type="button" data-first-run-sign-in-close="" onClick={onClose}>
        Not now
      </Button>
    </div>
  );

  return (
    <div className="kt-panel flex min-w-0 flex-col gap-3 p-panel" data-first-run-sign-in={harness}>
      <p className="m-0 text-row font-semibold text-fg">Sign in to {name}</p>
      <p className="m-0 text-cell leading-base text-muted">
        This is your own {name} login on {machineName}: {harness} in your terminal signs in too. When it’s done, you
        carry on from here.
      </p>
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err">
          {refusal}
        </p>
      )}
      {credential === null || (started === null && busy) ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy || busy}
          busyLabel="Starting sign-in…"
          refusal={changes.refusal}
          submitLabel={`Sign in to ${name}`}
          onSubmit={password => void begin(password)}
        >
          <Button type="button" data-first-run-sign-in-close="" onClick={onClose}>
            Not now
          </Button>
        </ChangeApplyPanel>
      ) : (
        <>
          <CredentialSignIn
            credential={credential}
            machineName={machineName}
            connection={connection}
            createClient={createClient}
            changes={changes}
            {...(started === null
              ? {}
              : {
                  initialFlow: started.flow,
                  ...(started.unlock === undefined ? {} : { initialUnlock: started.unlock }),
                })}
            {...(pollMs === undefined ? {} : { pollMs })}
            onSignedIn={onSignedIn}
          />
          {notNow}
        </>
      )}
    </div>
  );
}
