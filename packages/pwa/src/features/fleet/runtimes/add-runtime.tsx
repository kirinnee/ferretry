/**
 * Add a runtime (docs/design/account-model.md §4.4): ONE FORM on one page — **Login**, **Profile**,
 * **Name** — and one Create button. No stepper, and nothing opens a stepper of its own: a missing login
 * is added IN PLACE ("+ Add a new login" opens a sign-in or the provider grid right under the list) and
 * comes back picked; profiles are built in Settings › Profiles, linked from here.
 *
 * Edge cases, each where the prototype shows it: no logins at all (E12), a login that needs sign-in,
 * which can be signed in here or later (E13), profiles that do not apply to the login's harness (E14),
 * the same login and profile already being a runtime (E15), and a clashing or invalid name (E16).
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { ComponentBadges } from '../components/catalog-ui.tsx';
import { HARNESS_NAMES, profileScopeBadge } from '../components/component-model.ts';
import { CredentialSignIn } from '../credentials/credential-sign-in.tsx';
import {
  credentialEmail,
  credentialHarnesses,
  HARNESSES,
  type HarnessKind,
  harnessesName,
  nextCredentialId,
  plural,
} from '../credentials/credentials-model.ts';
import { EnvironmentLogin } from '../credentials/environment-login.tsx';
import { LoginScopeChip } from '../credentials/login-scope-chip.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { type CredentialLoginFlow, startCredentialSignIn } from '../harness-login-api.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { machineHash } from '../shell/machine-route.ts';
import type { MachineData } from './machine-data.ts';
import {
  harnessInstalled,
  profileFit,
  profileSummary,
  profilesFitFirst,
  runsHarness,
  runtimeNameProblem,
  sameLoginAndProfile,
  suggestedRuntimeName,
} from './runtimes-model.ts';

/** What the person has chosen so far. */
interface AddRuntimeDraft {
  readonly credentialId: string | null;
  readonly profile: string | null;
  /** The name typed; `null` while the suggestion is used. */
  readonly name: string | null;
  readonly agent: boolean;
  /** E15: "Add another anyway". */
  readonly addAnother: boolean;
  /** **Runs**: the CLI the person chose for a login that drives both. `null`: not chosen. */
  readonly runs: HarnessKind | null;
}

const EMPTY: AddRuntimeDraft = {
  credentialId: null,
  profile: null,
  name: null,
  agent: false,
  addAnother: false,
  runs: null,
};

export interface AddRuntimeProps {
  readonly data: MachineData;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** Leave: back to the list (`null`), or to the runtime that was made. */
  readonly onFinish: (open: string | null) => void;
  readonly pollMs?: number;
}

function Choice({
  name,
  checked,
  disabled = false,
  onChoose,
  title,
  sub,
  extra,
  data,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChoose: () => void;
  readonly title: ReactNode;
  readonly sub: ReactNode;
  readonly extra?: ReactNode;
  readonly data: Record<string, string>;
}) {
  return (
    <label
      className={cn(
        'kt-panel flex min-h-control min-w-0 items-start gap-3 p-panel',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        checked && 'border-accent',
      )}
      {...data}
    >
      <input type="radio" name={name} className="mt-1" checked={checked} disabled={disabled} onChange={onChoose} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 break-words text-row font-semibold text-fg">{title}</span>
        <span className="text-cell text-muted">{sub}</span>
        {extra}
      </span>
    </label>
  );
}

/** One labelled part of the form. */
function Part({
  title,
  name,
  children,
}: {
  readonly title: string;
  readonly name: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-add-runtime-part={name}>
      <legend className="mb-1 text-ui font-semibold text-fg">{title}</legend>
      {children}
    </fieldset>
  );
}

export function AddRuntime({
  data,
  reload,
  changes,
  machine,
  machineName,
  online,
  connection,
  createClient,
  onFinish,
  pollMs,
}: AddRuntimeProps) {
  const [draft, setDraft] = useState<AddRuntimeDraft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const credentials = data.credentials.credentials;
  const runtimes = data.runtimes.runtimes;
  const credential = credentials.find(candidate => candidate.id === draft.credentialId);
  // A login that drives both CLIs runs the one chosen under Runs, else the one its profile is scoped to.
  const harnesses = credential === undefined ? [] : credentialHarnesses(credential);
  const dual = harnesses.length > 1;
  const chosenProfile = data.profiles.profiles.find(candidate => candidate.name === draft.profile);
  const harness = credential === undefined ? undefined : runsHarness(harnesses, draft.runs, chosenProfile);
  const set = (patch: Partial<AddRuntimeDraft>): void => setDraft(current => ({ ...current, ...patch }));
  const pickLogin = (id: string): void =>
    setDraft(current => ({ ...current, credentialId: id, profile: null, addAnother: false, runs: null }));

  const back = (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="kt-btn--flush-start"
        data-page-back=""
        onClick={() => onFinish(null)}
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Runtimes
      </Button>
      <h3 className="m-0 mt-2 text-title font-semibold text-fg">Add a runtime</h3>
      <p className="m-0 mt-1 text-cell leading-base text-muted">
        A runtime is a login plus a profile. It’s what you launch on {machineName}.
      </p>
    </div>
  );

  if (made !== null) {
    const runtime = runtimes.find(item => item.name === made);
    const signInFirst = runtime?.credential.status === 'needs_sign_in';
    return (
      <section className="flex min-w-0 flex-col gap-4" data-add-runtime="" data-add-runtime-made={made}>
        {back}
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel" data-add-runtime-done="">
          <p className="m-0 text-row font-semibold text-ok">
            <span className="font-mono">{made}</span> is ready to launch
          </p>
          <p className="m-0 text-cell leading-base text-muted">
            {runtime === undefined ? '' : `${HARNESS_NAMES[runtime.harness]} · ${runtime.profile} profile`}
            {signInFirst ? '. Sign in before you launch.' : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" data-add-runtime-finish="list" onClick={() => onFinish(null)}>
            Back to Runtimes
          </Button>
          <Button type="button" variant="primary" data-add-runtime-finish="open" onClick={() => onFinish(made)}>
            Open {made}
          </Button>
        </div>
      </section>
    );
  }

  const duplicate =
    credential === undefined || draft.profile === null
      ? undefined
      : sameLoginAndProfile(runtimes, credential.id, draft.profile);
  const name =
    draft.name ??
    (harness === undefined || draft.profile === null ? '' : suggestedRuntimeName(harness, draft.profile, runtimes));
  const problem = draft.profile === null ? null : runtimeNameProblem(name, runtimes, machineName);
  const ready =
    credential !== undefined &&
    draft.profile !== null &&
    problem === null &&
    (duplicate === undefined || draft.addAnother);

  const create = async (): Promise<void> => {
    if (credential === undefined || draft.profile === null) return;
    const result = await changes.apply({
      kind: 'runtime.put',
      name,
      credential: credential.id,
      profile: draft.profile,
      ...(dual && harness !== undefined ? { harness } : {}),
      agent: draft.agent,
      create: true,
      ...(draft.addAnother ? { addAnother: true } : {}),
    });
    if (result.kind === 'refused') return;
    await reload();
    setMade(name);
  };

  return (
    <section className="flex min-w-0 flex-col gap-5" data-add-runtime="">
      {back}

      <Part title="Login" name="login">
        {credentials.length === 0 ? (
          <p className="m-0 text-cell leading-base text-muted" data-add-runtime-no-logins="">
            There are no logins on {machineName} yet. Add one below: sign in to Claude Code or Codex, or use a provider
            key.
          </p>
        ) : (
          HARNESSES.flatMap(candidate => credentials.filter(item => item.harness === candidate)).map(item => {
            const drives = credentialHarnesses(item);
            const missing = drives.filter(candidate => !harnessInstalled(machine, candidate));
            return (
              <Choice
                key={item.id}
                name="add-runtime-credential"
                checked={item.id === draft.credentialId}
                onChoose={() => pickLogin(item.id)}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{item.store === 'environment' ? item.id : credentialEmail(item)}</span>
                    <LoginScopeChip harnesses={drives} />
                    {item.label === undefined ? null : <Badge tone="accent">{item.label}</Badge>}
                  </span>
                }
                sub={
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {harnessesName(drives)} ·
                    <AccountStatus word={item.status.word} showLabel /> · used by{' '}
                    {plural(item.usedBy.length, 'runtime')}
                    {missing.length === 0 ? '' : ` · ${harnessesName(missing)} isn’t installed here`}
                  </span>
                }
                data={{ 'data-add-runtime-credential': item.id }}
              />
            );
          })
        )}
        {adding ? (
          <NewLogin
            data={data}
            reload={reload}
            machine={machine}
            machineName={machineName}
            connection={connection}
            createClient={createClient}
            {...(pollMs === undefined ? {} : { pollMs })}
            onAdded={id => {
              setAdding(false);
              pickLogin(id);
            }}
            onClose={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              changes.clear();
              setAdding(true);
            }}
            data-add-row="login"
            className="kt-panel flex min-h-control w-full min-w-0 items-center gap-3 p-panel text-left text-row font-semibold text-fg hover:border-accent"
          >
            <Plus size={16} aria-hidden="true" className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">Add a new login</span>
          </button>
        )}
        {credential?.status.word === 'needs_sign_in' ? (
          <CredentialSignIn
            credential={credential}
            machineName={machineName}
            connection={connection}
            createClient={createClient}
            changes={changes}
            {...(pollMs === undefined ? {} : { pollMs })}
            onSignedIn={() => void reload()}
          />
        ) : null}
      </Part>

      {credential === undefined || harness === undefined ? null : (
        <>
          {dual ? (
            <Part title="Runs" name="runs">
              <p className="m-0 text-cell leading-base text-muted" data-add-runtime-runs={harness}>
                This login drives both CLIs. The runtime runs one of them
                {draft.runs === null ? ' — picked from the profile until you choose' : ''}.
              </p>
              <div className="flex flex-wrap gap-2">
                {harnesses.map(candidate => (
                  <label
                    key={candidate}
                    className={cn(
                      'kt-panel flex min-h-control min-w-0 cursor-pointer items-center gap-2 px-3 py-2',
                      candidate === harness && 'border-accent',
                    )}
                    data-add-runtime-runs-option={candidate}
                  >
                    <input
                      type="radio"
                      name="add-runtime-runs"
                      checked={candidate === harness}
                      onChange={() => {
                        const keeps =
                          chosenProfile !== undefined && profileFit(chosenProfile, candidate).fits
                            ? draft.profile
                            : null;
                        set({ runs: candidate, profile: keeps, addAnother: false });
                      }}
                    />
                    <span className="text-row font-semibold text-fg">{HARNESS_NAMES[candidate]}</span>
                  </label>
                ))}
              </div>
            </Part>
          ) : null}

          <Part title="Profile" name="profile">
            {data.profiles.profiles.length === 0 ? (
              <p className="m-0 text-cell text-muted">There are no profiles on {machineName} yet.</p>
            ) : (
              profilesFitFirst(data.profiles.profiles, harnesses, draft.runs).map(({ profile, fit }) => (
                <Choice
                  key={profile.name}
                  name="add-runtime-profile"
                  checked={profile.name === draft.profile}
                  disabled={!fit.fits}
                  onChoose={() => set({ profile: profile.name, addAnother: false })}
                  title={profile.name}
                  sub={profileSummary(profile, harness)}
                  extra={
                    <>
                      <ComponentBadges
                        badges={[
                          profileScopeBadge(profile.scope),
                          ...(fit.fits ? fit.notes.map(note => ({ text: note, tone: 'warn' as const })) : []),
                        ]}
                      />
                      {fit.fits ? null : (
                        <span className="text-cell text-warn" data-profile-unavailable="">
                          {fit.reason}
                        </span>
                      )}
                    </>
                  }
                  data={{ 'data-add-runtime-profile': profile.name }}
                />
              ))
            )}
            <a
              href={machineHash(machineName, 'profiles')}
              className="inline-flex min-h-control items-center gap-1 self-start text-cell font-semibold text-accent underline"
              data-add-runtime-profiles-link=""
            >
              Build or change profiles in Profiles
              <ChevronRight size={14} aria-hidden="true" />
            </a>
            {duplicate === undefined ? null : (
              <div role="status" className="kt-panel flex flex-col gap-2 p-panel" data-add-runtime-duplicate="">
                <p className="m-0 text-row font-semibold text-fg">
                  <span className="font-mono">{duplicate.name}</span> already uses this login and profile.
                </p>
                <label className="flex min-h-control items-center gap-2 text-cell text-fg">
                  <input
                    type="checkbox"
                    data-duplicate-ok=""
                    checked={draft.addAnother}
                    onChange={event => set({ addAnother: event.target.checked })}
                  />
                  Add another anyway
                </label>
              </div>
            )}
          </Part>
        </>
      )}

      {draft.profile === null ? null : (
        <Part title="Name" name="name">
          <label htmlFor="add-runtime-name" className="sr-only">
            Runtime name
          </label>
          <input
            id="add-runtime-name"
            className="kt-input font-mono"
            autoComplete="off"
            spellCheck={false}
            value={name}
            aria-invalid={problem !== null}
            onChange={event => set({ name: event.target.value.trim() })}
          />
          {problem === null ? (
            <span className="text-meta text-muted">Letters, digits and dashes. You type this to launch it.</span>
          ) : (
            <span className="text-meta text-err" data-runtime-name-problem="">
              {problem.message}{' '}
              {problem.suggestion === undefined ? null : (
                <button
                  type="button"
                  className="font-semibold text-accent underline"
                  data-runtime-name-suggestion=""
                  onClick={() => set({ name: problem.suggestion ?? name })}
                >
                  Use {problem.suggestion}
                </button>
              )}
            </span>
          )}
          <label
            className="kt-panel flex min-h-control cursor-pointer items-start gap-3 p-panel"
            data-add-runtime-agent=""
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.agent}
              onChange={event => set({ agent: event.target.checked })}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-row font-semibold text-fg">Ferretry launches this as an agent</span>
              <span className="text-cell leading-base text-muted">
                Adds Ferretry’s fixed layer last: no trust or onboarding prompts, and the machine’s agent permissions.
              </span>
            </span>
          </label>
        </Part>
      )}

      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Creating…"
        refusal={changes.refusal}
        submitLabel="Create runtime"
        disabled={!ready || !online}
        onSubmit={() => void create()}
      />
    </section>
  );
}

/**
 * "+ Add a new login", in place under the list: sign in to Claude Code or Codex (the login is made and its
 * sign-in started in one tap), or a provider key from the provider grid. The login comes back picked.
 */
function NewLogin({
  data,
  reload,
  machine,
  machineName,
  connection,
  createClient,
  pollMs,
  onAdded,
  onClose,
}: {
  readonly data: MachineData;
  readonly reload: () => Promise<MachineData | null>;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly pollMs?: number;
  readonly onAdded: (credentialId: string) => void;
  readonly onClose: () => void;
}) {
  // Its own change state, so a refusal here is said here and not again under the form's Create.
  const changes = useAccountChanges({ connection, createClient });
  const [kind, setKind] = useState<'signin' | 'environment'>('signin');
  const [made, setMade] = useState<{ readonly id: string; readonly flow: CredentialLoginFlow | null } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const credential = made === null ? undefined : data.credentials.credentials.find(item => item.id === made.id);

  /** Make the empty login, then start its sign-in. */
  const signIn = async (harness: HarnessKind): Promise<void> => {
    setRefusal(null);
    const id = nextCredentialId(data.credentials, harness);
    const added = await changes.apply({ kind: 'credential.add', id, harness });
    if (added.kind === 'refused') return;
    await reload();
    try {
      const client = await createClient(connection);
      setMade({ id, flow: await startCredentialSignIn(client, { credentialId: id }) });
    } catch (error) {
      // The login exists; it is picked, and signs in from its own page or right here once picked.
      setMade({ id, flow: null });
      setRefusal(changeRefusalSentence(error));
    }
  };

  return (
    <div className="kt-panel flex min-w-0 flex-col gap-3 p-panel" data-add-runtime-new-login={kind}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-row font-semibold text-fg">Add a new login</p>
        <Button type="button" size="sm" variant="ghost" data-add-runtime-new-login-close="" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {credential !== undefined ? (
        <>
          {refusal === null ? null : (
            <p role="alert" className="m-0 text-cell leading-base text-err">
              {refusal}
            </p>
          )}
          <CredentialSignIn
            credential={credential}
            machineName={machineName}
            connection={connection}
            createClient={createClient}
            changes={changes}
            {...(made?.flow === null || made === null ? {} : { initialFlow: made.flow })}
            {...(pollMs === undefined ? {} : { pollMs })}
            onSignedIn={() => {
              void reload();
              onAdded(credential.id);
            }}
          />
          <div>
            <Button type="button" size="sm" data-add-runtime-sign-in-later="" onClick={() => onAdded(credential.id)}>
              Use it, sign in later
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type">
            {(
              [
                ['signin', 'Sign in'],
                ['environment', 'Provider key'],
              ] as const
            ).map(([value, title]) => (
              <label
                key={value}
                className={cn(
                  'kt-panel flex min-h-control min-w-0 cursor-pointer items-center gap-2 p-panel',
                  kind === value && 'border-accent',
                )}
                data-add-login-kind-option={value}
              >
                <input
                  type="radio"
                  name="add-runtime-login-kind"
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                <span className="text-row font-semibold text-fg">{title}</span>
              </label>
            ))}
          </div>
          {kind === 'signin' ? (
            <div className="flex flex-col gap-2">
              {HARNESSES.map(candidate => {
                const ready = harnessInstalled(machine, candidate);
                return (
                  <Button
                    key={candidate}
                    type="button"
                    disabled={!ready || changes.busy}
                    data-add-runtime-login={candidate}
                    onClick={() => void signIn(candidate)}
                  >
                    {ready
                      ? `Sign in to ${HARNESS_NAMES[candidate]}`
                      : `${HARNESS_NAMES[candidate]} isn’t installed on ${machineName}`}
                  </Button>
                );
              })}
              {changes.refusal === null ? null : (
                <p role="alert" className="m-0 text-cell leading-base text-err">
                  {changes.refusal}
                </p>
              )}
            </div>
          ) : (
            <EnvironmentLogin
              machineName={machineName}
              connection={connection}
              createClient={createClient}
              data={data}
              reload={reload}
              changes={changes}
              onAdded={onAdded}
            />
          )}
        </>
      )}
    </div>
  );
}
