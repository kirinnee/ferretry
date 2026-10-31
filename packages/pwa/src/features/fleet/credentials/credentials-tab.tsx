/**
 * The Credentials tab (docs/design/account-model.md §4.2): the logins kept on this machine, grouped by
 * harness, each with its status, its usage and who uses it — and each login's own page, where it is
 * signed in, labelled, checked or signed out.
 *
 * One page is one login (§4.1 rule 1). Every write is a reviewed change through the shared apply path.
 */

import type { FleetCredentialView, FleetMachineView } from '@ferretry/protocol';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { OLLAMA_PRESET_ID } from '../../../lib/local-models.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import { checkFleetCredential } from '../credentials-api.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { type MachineData, machineDetailHash, useMachineData, useMachineDetail } from '../runtimes/machine-data.ts';
import { runtimeActionRefusal } from '../runtimes/runtime-actions-model.ts';
import { AccountStatus, ProviderQuota } from '../shell/account-status.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { DisableSwitch } from '../shell/disable-switch.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { AddLogin } from './add-login.tsx';
import { BudgetSection } from './budget-editor.tsx';
import { BudgetMeter } from './budget-meter.tsx';
import { CredentialEnvironment, environmentChip } from './credential-environment.tsx';
import { CredentialSignIn } from './credential-sign-in.tsx';
import {
  budgetChip,
  credentialEmail,
  credentialExplanation,
  credentialGroups,
  credentialHarnesses,
  credentialName,
  credentialUse,
  harnessesName,
  hasSharedEmails,
  plural,
  signedInSentence,
  slotBadge,
  terminalBadge,
  type UsageBar,
  usageBars,
  usageBarText,
} from './credentials-model.ts';
import { LocalModelsPanel } from './local-models-panel.tsx';
import { METER_LABEL, METER_WORDS } from './meter-layout.ts';
import { SIGN_OUT_VERSUS_REMOVE } from './login-remove-model.ts';
import { LoginScopeChip } from './login-scope-chip.tsx';
import { RemoveLoginDialog } from './remove-login-dialog.tsx';
import { useLocalModels } from './use-local-models.ts';

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
          <span className={METER_LABEL}>{usage.label}</span>
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
          <span className={METER_WORDS}>
            {usage.percent === null ? 'not measured' : `${String(usage.percent)}% used`}
            {usage.resets === null ? '' : ` · ${usage.resets}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The badges a login carries: its scope (which CLI it drives), an environment login's preset, its
 * label, a copied slot, and the terminal it shares a login with.
 */
export function CredentialBadges({ credential }: { readonly credential: FleetCredentialView }) {
  const terminal = terminalBadge(credential);
  const slot = slotBadge(credential);
  const budget = budgetChip(credential.budget);
  return (
    <span className="flex min-w-0 flex-wrap gap-1" data-credential-badges="">
      <LoginScopeChip harnesses={credentialHarnesses(credential)} />
      {credential.environment === undefined ? null : (
        <Badge tone="accent" className="max-w-full !whitespace-normal" data-credential-environment-chip="">
          {environmentChip(credential.environment)}
        </Badge>
      )}
      {credential.disabled === undefined ? null : (
        <Badge tone="warn" data-credential-disabled-badge="">
          Disabled
        </Badge>
      )}
      {budget === null ? null : (
        <Badge tone={budget.tone} data-credential-budget-badge="">
          {budget.label}
        </Badge>
      )}
      {credential.label === undefined ? null : <Badge tone="accent">{credential.label}</Badge>}
      {slot === null ? null : <Badge className="max-w-full !whitespace-normal">{slot}</Badge>}
      {terminal === null ? null : <Badge className="max-w-full !whitespace-normal">{terminal}</Badge>}
    </span>
  );
}

/** Remove, in the destructive style. Disabled, with the reason, when the caller may not change the fleet. */
function RemoveLoginButton({
  credential,
  refusal,
  onRemove,
}: {
  readonly credential: FleetCredentialView;
  readonly refusal: string | null;
  readonly onRemove: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="danger"
      disabled={refusal !== null}
      title={refusal ?? undefined}
      aria-label={`Remove ${credential.id}`}
      data-credential-remove={credential.id}
      onClick={onRemove}
    >
      <Trash2 size={14} aria-hidden="true" />
      Remove
    </Button>
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
  /** Why this browser may not remove a login, or `null` when it may. */
  readonly removeRefusal: string | null;
  readonly onRemove: () => void;
  readonly now: number;
  readonly pollMs?: number;
}

function CredentialPage({
  credential,
  data,
  machineName,
  online,
  connection,
  createClient,
  changes,
  reload,
  onBack,
  removeRefusal,
  onRemove,
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
  // An Ollama login lists what Ollama has installed: read once when its page opens, then on Check again.
  const ollama = credential.environment?.preset?.id === OLLAMA_PRESET_ID;
  const local = useLocalModels({ connection, createClient, enabled: ollama });

  const check = async (): Promise<void> => {
    setNotice(null);
    setChecking(true);
    try {
      const client = await createClient(connection);
      const checked = await checkFleetCredential(client, credential.id);
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

  const signOut = async (): Promise<void> => {
    const result = await changes.apply({ kind: 'credential.signout', id: credential.id });
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

  const saveLabel = async (): Promise<void> => {
    const trimmed = label.trim();
    const result = await changes.apply({
      kind: 'credential.label',
      id: credential.id,
      label: trimmed === '' ? null : trimmed,
    });
    if (result.kind === 'applied') {
      setNotice('Label saved.');
      await reload();
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" data-credential-page={credential.id}>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start"
          data-page-back=""
          onClick={onBack}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Credentials
        </Button>
        <h3 className="m-0 mt-2 font-display text-title font-semibold tracking-display text-fg">
          {harnessesName(credentialHarnesses(credential))} login
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
        {credential.usage.provider === undefined ? (
          credential.status.word === 'ready' ? (
            <UsageBars credential={credential} now={now} />
          ) : null
        ) : (
          <ProviderQuota reading={credential.usage.provider} now={now} />
        )}
      </div>

      <div data-credential-switch="">
        <DisableSwitch
          target={{ kind: 'login', id: credential.id }}
          disabled={credential.disabled}
          machineName={machineName}
          online={online}
          changes={changes}
          now={() => now}
          onChanged={reload}
        />
      </div>

      <BudgetSection
        credential={credential}
        machineName={machineName}
        online={online}
        connection={connection}
        createClient={createClient}
        changes={changes}
        onChanged={reload}
      />

      {credential.environment === undefined ? null : (
        <CredentialEnvironment
          credentialId={credential.id}
          environment={credential.environment}
          connection={connection}
          createClient={createClient}
          online={online}
        />
      )}

      {ollama ? <LocalModelsPanel machineName={machineName} read={local} onCheck={local.check} /> : null}

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
            authority={changes.authority}
            busy={changes.busy}
            refusal={changes.refusal}
            submitLabel="Save label"
            disabled={!online}
            onSubmit={() => void saveLabel()}
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
                  className="kt-panel flex min-h-control min-w-0 items-center gap-3 p-panel text-left no-underline hover:border-accent hover:no-underline"
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
                authority={changes.authority}
                busy={changes.busy}
                busyLabel="Signing out…"
                refusal={changes.refusal}
                submitLabel="Sign out"
                variant="danger"
                disabled={!online}
                onSubmit={() => void signOut()}
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
                  authority={changes.authority}
                  busy={checking || changes.busy}
                  busyLabel="Checking…"
                  refusal={changes.refusal}
                  submitLabel="Check now"
                  variant="primary"
                  disabled={!online}
                  onSubmit={() => void check()}
                />
              ) : (
                <p className="m-0 text-cell text-muted">{credential.checkNow.reason}</p>
              )}
              {credential.signOut.available ? (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="kt-btn--flush-start"
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

      <div className="flex flex-col items-start gap-2 border-t border-border pt-3" data-credential-remove-zone="">
        <p className="m-0 text-meta leading-base text-muted" data-credential-remove-hint="">
          {SIGN_OUT_VERSUS_REMOVE}
        </p>
        <RemoveLoginButton credential={credential} refusal={removeRefusal} onRemove={onRemove} />
        {removeRefusal === null ? null : (
          <p className="m-0 text-meta leading-base text-warn" data-credential-remove-refused="">
            Remove is off here: {removeRefusal}
          </p>
        )}
      </div>
    </section>
  );
}

function CredentialRow({
  credential,
  href,
  now,
  machineName,
  online,
  changes,
  reload,
  removeRefusal,
  onRemove,
}: {
  readonly credential: FleetCredentialView;
  readonly href: string;
  readonly now: number;
  readonly machineName: string;
  readonly online: boolean;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
  readonly removeRefusal: string | null;
  readonly onRemove: () => void;
}) {
  return (
    <div
      className="kt-panel relative flex min-w-0 flex-col gap-2 p-panel hover:border-accent"
      data-credential-card={credential.id}
    >
      <DisableSwitch
        compact
        target={{ kind: 'login', id: credential.id }}
        disabled={credential.disabled}
        machineName={machineName}
        online={online}
        changes={changes}
        now={() => now}
        onChanged={reload}
      >
        {({ toggle, details }) => (
          <>
            <div className="flex min-w-0 items-start gap-3">
              <a
                href={href}
                className="flex min-h-control min-w-0 flex-1 items-start gap-3 text-left no-underline after:absolute after:inset-0 after:content-[''] hover:no-underline"
                data-credential-row={credential.id}
              >
                <AccountStatus word={credential.status.word} className="mt-1" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-mono text-row text-fg">
                    {credential.store === 'environment' ? credential.id : credentialEmail(credential)}
                  </span>
                  <CredentialBadges credential={credential} />
                  <span className="text-cell text-muted">
                    {credential.status.label} · {credentialUse(credential)}
                  </span>
                  {credential.usage.provider === undefined ? (
                    credential.status.word === 'ready' ? (
                      <UsageBars credential={credential} now={now} />
                    ) : null
                  ) : (
                    <ProviderQuota reading={credential.usage.provider} now={now} />
                  )}
                  {credential.budget === undefined ? null : (
                    <BudgetMeter budget={credential.budget} machineName={machineName} />
                  )}
                </span>
              </a>
              {toggle}
              <ChevronRight size={16} aria-hidden="true" className="mt-1 shrink-0 text-muted" />
            </div>
            {details}
          </>
        )}
      </DisableSwitch>
      <div className="relative flex flex-wrap items-start justify-end gap-2 border-t border-border-soft pt-2">
        <RemoveLoginButton credential={credential} refusal={removeRefusal} onRemove={onRemove} />
      </div>
    </div>
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
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const removeRefusal = runtimeActionRefusal(changes.authority);

  if (adding)
    return (
      <AddLogin
        machine={machine}
        machineName={machineName}
        online={online}
        checking={checking}
        onRetry={onRetry}
        connection={connection}
        createClient={createClient}
        data={data}
        reload={reload}
        changes={changes}
        onAdded={id => {
          setAdding(false);
          openDetail(id);
        }}
        onLeave={() => {
          changes.clear();
          setAdding(false);
        }}
        {...(pollMs === undefined ? {} : { pollMs })}
      />
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

  const removingLogin = removing === null ? undefined : data.credentials.credentials.find(item => item.id === removing);
  const removeDialog =
    removingLogin === undefined ? null : (
      <RemoveLoginDialog
        credential={removingLogin}
        credentials={data.credentials.credentials}
        runtimes={data.runtimes.runtimes}
        machine={machine}
        machineName={machineName}
        changes={changes}
        connection={connection}
        createClient={createClient}
        onClose={() => {
          changes.clear();
          setRemoving(null);
        }}
        onRemoved={() => {
          changes.clear();
          setRemoving(null);
          if (detail === removingLogin.id) openDetail(null);
          void reload();
        }}
      />
    );

  const credential = detail === null ? undefined : data.credentials.credentials.find(item => item.id === detail);
  if (credential !== undefined)
    return (
      <>
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
          removeRefusal={removeRefusal}
          onRemove={() => {
            changes.clear();
            setRemoving(credential.id);
          }}
          now={now()}
          {...(pollMs === undefined ? {} : { pollMs })}
        />
        {removeDialog}
      </>
    );

  const startAdd = (): void => {
    changes.clear();
    setAdding(true);
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
          {credentialGroups(data.credentials).map(group => (
            <div key={group.scope} data-credentials-group={group.scope}>
              <h4 className="m-0 text-meta font-semibold uppercase text-muted">{group.title}</h4>
              <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {group.credentials.map(item => (
                  <li key={item.id}>
                    <CredentialRow
                      credential={item}
                      href={machineDetailHash(machineName, 'credentials', item.id)}
                      now={now()}
                      machineName={machineName}
                      online={online}
                      changes={changes}
                      reload={reload}
                      removeRefusal={removeRefusal}
                      onRemove={() => {
                        changes.clear();
                        setRemoving(item.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {hasSharedEmails(data.credentials) ? (
            <p className="m-0 text-cell leading-base text-muted" data-credentials-labels-hint="">
              Two logins share an email, so each has a label you chose. Change a label from the login’s page.
            </p>
          ) : null}
        </>
      )}
      {removeDialog}
    </section>
  );
}
