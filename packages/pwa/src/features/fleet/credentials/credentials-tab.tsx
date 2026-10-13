/**
 * The Credentials tab (docs/design/account-model.md §4.2): the logins kept on this machine, grouped by
 * harness, each with its status, its usage and who uses it — and each login's own page, where it is
 * signed in, labelled, checked or signed out.
 *
 * One page is one login (§4.1 rule 1). Every write is a reviewed change through the shared apply path,
 * so while this machine does not accept account changes the page says so in one sentence and shows
 * everything else as it is.
 */

import type { FleetCredentialView, FleetMachineView } from '@ferretry/protocol';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { checkFleetCredential } from '../credentials-api.ts';
import type { FleetClientFactory } from '../fleet-configuration-surface.tsx';
import { type MachineData, machineDetailHash, useMachineData, useMachineDetail } from '../runtimes/machine-data.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { type AccountChanges, ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { startStepper, type StepperState } from '../shell/stepper-model.ts';
import { AddLoginStep, addLoginFlowInput } from './add-login.tsx';
import { CredentialSignIn } from './credential-sign-in.tsx';
import {
  credentialEmail,
  credentialExplanation,
  credentialName,
  credentialsOf,
  credentialUse,
  HARNESS_NAMES,
  HARNESSES,
  hasSharedEmails,
  plural,
  signedInSentence,
  slotBadge,
  terminalBadge,
  type UsageBar,
  usageBars,
  usageBarText,
} from './credentials-model.ts';

export function UsageBars({ credential, now }: { readonly credential: FleetCredentialView; readonly now: number }) {
  const bars = usageBars(credential, now);
  if (bars === null)
    return (
      <p className="m-0 text-meta text-muted" data-credential-usage="unknown">
        Usage not measured yet
      </p>
    );
  return (
    <div className="flex flex-col gap-1" data-credential-usage="">
      {bars.map((usage: UsageBar) => (
        <div key={usage.label} className="flex min-w-0 items-center gap-2 text-meta">
          <span className="w-10 shrink-0 text-muted">{usage.label}</span>
          <span
            role="img"
            aria-label={usageBarText(usage)}
            className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
          >
            <span
              className={cn('absolute inset-y-0 left-0 rounded-full', usage.high ? 'bg-warn' : 'bg-accent')}
              style={{ width: `${String(usage.percent ?? 0)}%` }}
            />
          </span>
          <span className="shrink-0 text-muted">
            {usage.percent === null ? 'not measured' : `${String(usage.percent)}% used`}
            {usage.resets === null ? '' : ` · ${usage.resets}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The badges a login carries: its label, a copied slot, and the terminal it shares a login with. */
export function CredentialBadges({ credential }: { readonly credential: FleetCredentialView }) {
  const terminal = terminalBadge(credential);
  const slot = slotBadge(credential);
  if (credential.label === undefined && terminal === null && slot === null) return null;
  return (
    <span className="flex flex-wrap gap-1" data-credential-badges="">
      {credential.label === undefined ? null : <Badge tone="accent">{credential.label}</Badge>}
      {slot === null ? null : <Badge>{slot}</Badge>}
      {terminal === null ? null : <Badge>{terminal}</Badge>}
    </span>
  );
}

interface CredentialPageProps {
  readonly credential: FleetCredentialView;
  readonly data: MachineData;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<MachineData | null>;
  readonly onBack: () => void;
  readonly now: number;
  readonly pollMs?: number;
}

function CredentialPage({
  credential,
  data,
  machine,
  machineName,
  online,
  connection,
  createClient,
  changes,
  reload,
  onBack,
  now,
  pollMs,
}: CredentialPageProps) {
  const [label, setLabel] = useState(credential.label ?? '');
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [signedInFor, setSignedInFor] = useState<readonly string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const word = checking ? 'checking' : credential.status.word;
  const needsSignIn = credential.status.word === 'needs_sign_in';
  const runtimesUsing = data.runtimes.runtimes.filter(runtime => credential.usedBy.includes(runtime.name));

  const check = async (operatorPassword: string | undefined): Promise<void> => {
    setNotice(null);
    const authorization = await changes.authorize(operatorPassword);
    if (authorization.kind === 'refused') return;
    setChecking(true);
    try {
      const client = await createClient(connection);
      const checked = await checkFleetCredential(
        client,
        credential.id,
        authorization.operatorPassword === undefined ? {} : { operatorPassword: authorization.operatorPassword },
        authorization.unlock,
      );
      setNotice(
        checked.status.word === 'ready' ? 'Checked. The login works.' : `Checked. ${checked.status.explanation}`,
      );
    } catch (error) {
      changes.refuse(changeRefusalSentence(error));
    } finally {
      setChecking(false);
      await reload();
    }
  };

  const signOut = async (operatorPassword: string | undefined): Promise<void> => {
    const result = await changes.apply({ kind: 'credential.signout', id: credential.id }, operatorPassword);
    if (result.kind === 'refused') return;
    setSigningOut(false);
    setSignedInFor(null);
    setNotice(
      result.outcome.outcome === 'sign-out-failed'
        ? result.outcome.reason
        : `Signed out. ${plural(credential.signOut.runtimesAffected, 'runtime')} need sign-in.`,
    );
    await reload();
  };

  const saveLabel = async (operatorPassword: string | undefined): Promise<void> => {
    const trimmed = label.trim();
    const result = await changes.apply(
      { kind: 'credential.label', id: credential.id, label: trimmed === '' ? null : trimmed },
      operatorPassword,
    );
    if (result.kind === 'applied') {
      setNotice('Label saved.');
      await reload();
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" data-credential-page={credential.id}>
      <div>
        <Button type="button" variant="ghost" size="sm" data-page-back="" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden="true" />
          Credentials
        </Button>
        <h3 className="m-0 mt-2 font-display text-title font-semibold tracking-display text-fg">
          {HARNESS_NAMES[credential.harness]} login
        </h3>
        <p className="m-0 mt-1 break-all font-mono text-cell text-muted">{credentialName(credential)}</p>
        <div className="mt-2">
          <CredentialBadges credential={credential} />
        </div>
      </div>

      <div className="kt-panel flex flex-col gap-2 p-panel" data-credential-status={word}>
        <AccountStatus word={word} showLabel className="text-row font-semibold text-fg" />
        <p className="m-0 text-cell leading-base text-muted">
          {checking ? `Checking with ${HARNESS_NAMES[credential.harness]}…` : credentialExplanation(credential)}
        </p>
        {credential.status.word === 'ready' ? <UsageBars credential={credential} now={now} /> : null}
      </div>

      {notice === null ? null : (
        <p role="status" className="m-0 text-cell leading-base text-fg" data-credential-notice="">
          {notice}
        </p>
      )}

      {signedInFor === null ? null : (
        <div className="kt-panel flex flex-col gap-2 p-panel" role="status" data-credential-signed-in="">
          <p className="m-0 text-row font-semibold text-ok">{signedInSentence(signedInFor.length)}</p>
          {signedInFor.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {signedInFor.map(name => {
                const runtime = data.runtimes.runtimes.find(candidate => candidate.name === name);
                const ready = runtime?.credential.status === 'ready' || runtime?.launch.available === true;
                return (
                  <li key={name} className="flex items-center gap-2 text-cell">
                    <AccountStatus word={ready ? 'ready' : 'checking'} />
                    <span className="font-mono text-fg">{name}</span>
                    <span className="text-muted">{ready ? 'Ready' : 'Checking'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {needsSignIn && online ? (
        <CredentialSignIn
          credential={credential}
          machine={machine}
          machineName={machineName}
          connection={connection}
          createClient={createClient}
          changes={changes}
          {...(pollMs === undefined ? {} : { pollMs })}
          onSignedIn={() => {
            setSignedInFor(credential.usedBy);
            void reload();
          }}
        />
      ) : null}

      <div className="flex flex-col gap-2" data-credential-label="">
        <label htmlFor={`credential-label-${credential.id}`} className="text-ui font-semibold text-fg">
          Label
        </label>
        <input
          id={`credential-label-${credential.id}`}
          className="kt-input"
          autoComplete="off"
          value={label}
          placeholder="e.g. personal or work"
          onChange={event => setLabel(event.target.value)}
        />
        <span className="text-meta leading-base text-muted">
          Only you see this. It tells logins with the same email apart.
        </span>
        {credential.needsLabel ? (
          <span className="text-meta leading-base text-warn" data-credential-needs-label="">
            Another {HARNESS_NAMES[credential.harness]} login here has the same email. Give each a different label.
          </span>
        ) : null}
        {label.trim() === (credential.label ?? '') ? null : (
          <ChangeApplyPanel
            machineName={machineName}
            changes={machine?.changes ?? null}
            authority={changes.authority}
            busy={changes.busy}
            refusal={changes.refusal}
            submitLabel="Save label"
            disabled={!online}
            onSubmit={password => void saveLabel(password)}
          />
        )}
      </div>

      <div>
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">Used by</h4>
        {runtimesUsing.length === 0 ? (
          <p className="mb-0 mt-1 text-cell text-muted">No runtime uses this login yet.</p>
        ) : (
          <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
            {runtimesUsing.map(runtime => (
              <li key={runtime.name}>
                <a
                  href={machineDetailHash(machineName, 'runtimes', runtime.name)}
                  className="kt-panel flex min-h-control min-w-0 items-center gap-3 p-panel text-left no-underline hover:border-accent"
                  data-credential-runtime={runtime.name}
                >
                  <AccountStatus word={credential.status.word} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-row text-fg">{runtime.name}</span>
                    <span className="text-cell text-muted">{runtime.profile} profile</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {needsSignIn ? null : (
        <div className="flex flex-col gap-3 border-t border-border pt-3" data-credential-actions="">
          {signingOut ? (
            <div role="alert" className="kt-panel flex flex-col gap-3 p-panel" data-credential-sign-out="">
              <p className="m-0 text-row font-semibold text-fg">{credential.signOut.sentence}</p>
              <ChangeApplyPanel
                machineName={machineName}
                changes={machine?.changes ?? null}
                authority={changes.authority}
                busy={changes.busy}
                busyLabel="Signing out…"
                refusal={changes.refusal}
                submitLabel="Sign out"
                variant="danger"
                disabled={!online}
                onSubmit={password => void signOut(password)}
              >
                <Button type="button" data-sign-out-keep="" onClick={() => setSigningOut(false)}>
                  Keep signed in
                </Button>
              </ChangeApplyPanel>
            </div>
          ) : (
            <>
              {credential.checkNow.available ? (
                <ChangeApplyPanel
                  machineName={machineName}
                  changes={null}
                  authority={changes.authority}
                  busy={checking || changes.busy}
                  busyLabel="Checking…"
                  refusal={changes.refusal}
                  submitLabel="Check now"
                  variant="primary"
                  disabled={!online}
                  onSubmit={password => void check(password)}
                />
              ) : (
                <p className="m-0 text-cell text-muted">{credential.checkNow.reason}</p>
              )}
              {credential.signOut.available ? (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    data-credential-sign-out-ask=""
                    onClick={() => {
                      changes.clear();
                      setSigningOut(true);
                    }}
                  >
                    Sign out…
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function CredentialRow({
  credential,
  href,
  now,
}: {
  readonly credential: FleetCredentialView;
  readonly href: string;
  readonly now: number;
}) {
  return (
    <a
      href={href}
      className="kt-panel flex min-h-control min-w-0 items-start gap-3 p-panel text-left no-underline hover:border-accent"
      data-credential-row={credential.id}
    >
      <AccountStatus word={credential.status.word} className="mt-1" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-mono text-row text-fg">{credentialEmail(credential)}</span>
        <CredentialBadges credential={credential} />
        <span className="text-cell text-muted">
          {credential.status.label} · {credentialUse(credential)}
        </span>
        {credential.status.word === 'ready' ? <UsageBars credential={credential} now={now} /> : null}
      </span>
      <ChevronRight size={16} aria-hidden="true" className="mt-1 shrink-0 text-muted" />
    </a>
  );
}

export interface CredentialsTabOptions {
  /** Supplied in tests. */
  readonly now?: () => number;
  readonly pollMs?: number;
}

export function CredentialsTab({
  connection,
  machineName,
  machine,
  online,
  checking,
  onRetry,
  createClient,
  now = Date.now,
  pollMs,
}: MachineTabProps & CredentialsTabOptions) {
  const { state, data, reload } = useMachineData(connection, createClient);
  const changes = useAccountChanges({ connection, createClient });
  const [detail, openDetail] = useMachineDetail(machineName, 'credentials');
  const [flow, setFlow] = useState<StepperState | null>(null);

  if (flow !== null)
    return (
      <MachineStepper
        state={flow}
        onChange={setFlow}
        machineName={machineName}
        online={online}
        checking={checking}
        onRetry={onRetry}
      >
        <AddLoginStep
          state={flow}
          onChange={setFlow}
          onAdded={(id, next) => {
            setFlow(next);
            openDetail(id);
          }}
          machine={machine}
          machineName={machineName}
          connection={connection}
          createClient={createClient}
          data={data}
          reload={reload}
          changes={changes}
          {...(pollMs === undefined ? {} : { pollMs })}
        />
      </MachineStepper>
    );

  if (data === null)
    return state.kind === 'failed' ? (
      <p role="alert" className="m-0 text-cell leading-base text-warn" data-credentials-failed="">
        {state.sentence}
      </p>
    ) : (
      <p role="status" className="m-0 text-cell text-muted" data-credentials-loading="">
        Reading the logins on {machineName}…
      </p>
    );

  const credential = detail === null ? undefined : data.credentials.credentials.find(item => item.id === detail);
  if (credential !== undefined)
    return (
      <CredentialPage
        key={credential.id}
        credential={credential}
        data={data}
        machine={machine}
        machineName={machineName}
        online={online}
        connection={connection}
        createClient={createClient}
        changes={changes}
        reload={reload}
        onBack={() => openDetail(null)}
        now={now()}
        {...(pollMs === undefined ? {} : { pollMs })}
      />
    );

  const startAdd = (): void => {
    changes.clear();
    setFlow(startStepper(addLoginFlowInput()));
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" data-credentials-tab="">
      {state.kind === 'failed' ? (
        <p role="alert" className="m-0 text-cell leading-base text-warn">
          {state.sentence}
        </p>
      ) : null}
      {detail === null ? null : (
        <p role="status" className="m-0 text-cell text-warn" data-credential-missing="">
          There is no login {detail} on {machineName} any more.
        </p>
      )}
      {data.credentials.credentials.length === 0 ? (
        <div className="kt-panel flex flex-col items-start gap-2 p-panel" data-credentials-empty="">
          <h3 className="m-0 text-row font-semibold text-fg">No logins on {machineName}</h3>
          <p className="m-0 text-cell leading-base text-muted">
            A credential is one login to Claude Code or Codex. It belongs to this machine.
          </p>
          <Button type="button" variant="primary" data-add-login="" onClick={startAdd}>
            Add a login
          </Button>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-cell text-muted">
              {plural(data.credentials.credentials.length, 'login')} on {machineName}
            </p>
            <Button type="button" variant="primary" data-add-login="" onClick={startAdd}>
              <Plus size={16} aria-hidden="true" />
              Add a login
            </Button>
          </div>
          {HARNESSES.map(harness => {
            const list = credentialsOf(data.credentials, harness);
            if (list.length === 0) return null;
            return (
              <div key={harness} data-credentials-group={harness}>
                <h4 className="m-0 text-meta font-semibold uppercase text-muted">{HARNESS_NAMES[harness]}</h4>
                <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                  {list.map(item => (
                    <li key={item.id}>
                      <CredentialRow
                        credential={item}
                        href={machineDetailHash(machineName, 'credentials', item.id)}
                        now={now()}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {hasSharedEmails(data.credentials) ? (
            <p className="m-0 text-cell leading-base text-muted" data-credentials-labels-hint="">
              Two logins share an email, so each has a label you chose. Change a label from the login’s page.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
