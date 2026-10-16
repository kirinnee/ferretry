/**
 * Add a runtime (docs/design/account-model.md §4.4): **Credential → Profile → Name → Done**, one
 * decision per page.
 *
 * A missing thing is made in place and the person comes back with it picked (§4.1 rule 5): no login →
 * "+ Add a new login" (Add a login as a sub-stepper, E12); no fitting profile → "+ Build a new profile"
 * (the Profiles tab's builder as a sub-stepper). Anything those make is saved for reuse and kept even if
 * this flow is stopped (E17).
 *
 * Edge cases, each where the prototype shows it: no logins at all (E12), a login that needs sign-in,
 * which can be signed in here or later (E13), profiles that do not apply to the login's harness (E14),
 * the same login and profile already being a runtime (E15), and a clashing or invalid name (E16).
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { ChevronRight, Plus } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { ComponentBadges } from '../components/catalog-ui.tsx';
import { HARNESS_NAMES, profileScopeBadge } from '../components/component-model.ts';
import { ADD_LOGIN_FLOW_KIND, AddLoginStep, addLoginFlowInput } from '../credentials/add-login.tsx';
import { CredentialSignIn } from '../credentials/credential-sign-in.tsx';
import {
  credentialEmail,
  credentialHarnesses,
  HARNESSES,
  type HarnessKind,
  harnessesName,
  plural,
} from '../credentials/credentials-model.ts';
import { LoginScopeChip } from '../credentials/login-scope-chip.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import {
  currentFlow,
  goToStep,
  openSubStepper,
  type StepperFlowInput,
  type StepperState,
  stepForward,
} from '../shell/stepper-model.ts';
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

export const ADD_RUNTIME_FLOW_KIND = 'add-runtime';

export const addRuntimeFlowInput = (): StepperFlowInput => ({
  kind: ADD_RUNTIME_FLOW_KIND,
  title: 'Add a runtime',
  steps: [
    { id: 'credential', label: 'Credential' },
    { id: 'profile', label: 'Profile' },
    { id: 'name', label: 'Name' },
    { id: 'done', label: 'Done', final: true },
  ],
  leave: {
    question: 'Stop adding a runtime?',
    consequence: 'No runtime is created.',
    stopLabel: 'Stop, add no runtime',
  },
});

/** What the Profiles tab's Build a profile hands this flow. It is injected, so the two tabs stay apart. */
export interface ProfileBuilderStepProps {
  readonly state: StepperState;
  readonly onChange: (next: StepperState) => void;
  /** The profile is saved; `next` has this flow back on top. */
  readonly onBuilt: (profileName: string, next: StepperState | null) => void;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly harness?: HarnessKind;
  readonly openedFromAddRuntime?: boolean;
}

export interface ProfileBuilder {
  /** The builder's flow kind on the stepper stack. */
  readonly kind: string;
  readonly flowInput: (options: { readonly harness?: HarnessKind }) => StepperFlowInput;
  readonly Step: ComponentType<ProfileBuilderStepProps>;
}

/** What the person has chosen so far. Kept beside the stepper, so Back never loses it. */
export interface AddRuntimeDraft {
  readonly credentialId: string | null;
  readonly profile: string | null;
  readonly name: string;
  readonly agent: boolean;
  /** E15: "Add another anyway". */
  readonly addAnother: boolean;
  /** The runtime this flow made. */
  readonly made: string | null;
  /** The harness a "Sign in to …" button opened Add a login for. */
  readonly loginHarness: HarnessKind | null;
  /** **Runs**: the CLI the person chose for a login that drives both. `null`: not chosen. */
  readonly runs: HarnessKind | null;
}

export const EMPTY_ADD_RUNTIME: AddRuntimeDraft = {
  credentialId: null,
  profile: null,
  name: '',
  agent: false,
  addAnother: false,
  made: null,
  loginHarness: null,
  runs: null,
};

export interface AddRuntimeProps {
  readonly state: StepperState;
  readonly onState: (next: StepperState | null) => void;
  readonly draft: AddRuntimeDraft;
  readonly onDraft: (next: AddRuntimeDraft) => void;
  readonly data: MachineData;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  readonly checking: boolean;
  readonly onRetry: () => void;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly profileBuilder?: ProfileBuilder;
  /** Done: back to the list, or to the runtime that was made. */
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

function AddRow({
  label,
  onClick,
  data,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly data: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-add-row={data}
      className="kt-panel flex min-h-control w-full min-w-0 items-center gap-3 p-panel text-left text-row font-semibold text-fg hover:border-accent"
    >
      <Plus size={16} aria-hidden="true" className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1">{label}</span>
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
    </button>
  );
}

function NextButton({
  label = 'Next',
  disabled,
  onClick,
}: {
  readonly label?: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <div>
      <Button type="button" variant="primary" data-step-next="" disabled={disabled} onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}

export function AddRuntime({
  state,
  onState,
  draft,
  onDraft,
  data,
  reload,
  changes,
  machine,
  machineName,
  online,
  checking,
  onRetry,
  connection,
  createClient,
  profileBuilder,
  onFinish,
  pollMs,
}: AddRuntimeProps) {
  const top = currentFlow(state);
  const credentials = data.credentials.credentials;
  const runtimes = data.runtimes.runtimes;
  const credential = credentials.find(candidate => candidate.id === draft.credentialId);
  // A login that drives both CLIs runs the one chosen under Runs, else the one its profile is scoped to.
  const harnesses = credential === undefined ? [] : credentialHarnesses(credential);
  const dual = harnesses.length > 1;
  const chosenProfile = data.profiles.profiles.find(candidate => candidate.name === draft.profile);
  const harness = credential === undefined ? undefined : runsHarness(harnesses, draft.runs, chosenProfile);
  const set = (patch: Partial<AddRuntimeDraft>): void => onDraft({ ...draft, ...patch });

  const openLogin = (fixed?: HarnessKind): void => {
    onDraft({ ...draft, loginHarness: fixed ?? null });
    onState(openSubStepper(state, addLoginFlowInput(fixed === undefined ? {} : { harness: fixed })));
  };

  let body: ReactNode;
  if (top.kind === ADD_LOGIN_FLOW_KIND) {
    const fixed = draft.loginHarness ?? undefined;
    body = (
      <AddLoginStep
        state={state}
        onChange={onState}
        onAdded={(id, next) => {
          onDraft({ ...draft, credentialId: id, profile: null, name: '', addAnother: false, runs: null });
          onState(next);
        }}
        {...(fixed === undefined ? {} : { harness: fixed })}
        machine={machine}
        machineName={machineName}
        connection={connection}
        createClient={createClient}
        data={data}
        reload={reload}
        changes={changes}
        {...(pollMs === undefined ? {} : { pollMs })}
      />
    );
  } else if (profileBuilder !== undefined && top.kind === profileBuilder.kind) {
    const Builder = profileBuilder.Step;
    body = (
      <Builder
        state={state}
        onChange={onState}
        onBuilt={(profile, next) => {
          onDraft({ ...draft, profile, name: '', addAnother: false });
          void reload();
          onState(next);
        }}
        machine={machine}
        machineName={machineName}
        connection={connection}
        createClient={createClient}
        {...(harness === undefined ? {} : { harness })}
        openedFromAddRuntime
      />
    );
  } else if (top.at === 'credential') {
    body =
      credentials.length === 0 ? (
        <div className="flex flex-col gap-3" data-add-runtime-step="no-logins">
          <h4 className="m-0 text-row font-semibold text-fg">Add a login first</h4>
          <p className="m-0 text-cell leading-base text-muted">
            A runtime needs a login to Claude Code or Codex. You don’t have one on {machineName} yet. Pick which one to
            sign in to.
          </p>
          <div className="flex flex-col gap-2">
            {HARNESSES.map(candidate => {
              const ready = harnessInstalled(machine, candidate);
              return (
                <button
                  key={candidate}
                  type="button"
                  disabled={!ready}
                  data-add-runtime-login={candidate}
                  onClick={() => openLogin(candidate)}
                  className="kt-panel flex min-h-control w-full min-w-0 items-center gap-3 p-panel text-left hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-row font-semibold text-fg">Sign in to {HARNESS_NAMES[candidate]}</span>
                    <span className="text-cell text-muted">
                      {ready
                        ? `Installed on ${machineName}`
                        : `Not installed on ${machineName} · install it in Settings`}
                    </span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
                </button>
              );
            })}
          </div>
          <NextButton disabled onClick={() => undefined} />
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-add-runtime-step="credential">
          <p className="m-0 text-ui leading-base text-fg">Which login should this runtime use?</p>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="sr-only">Login</legend>
            {HARNESSES.flatMap(candidate => credentials.filter(item => item.harness === candidate)).map(item => {
              const drives = credentialHarnesses(item);
              const missing = drives.filter(candidate => !harnessInstalled(machine, candidate));
              return (
                <Choice
                  key={item.id}
                  name="add-runtime-credential"
                  checked={item.id === draft.credentialId}
                  onChoose={() =>
                    item.id === draft.credentialId
                      ? undefined
                      : set({ credentialId: item.id, profile: null, name: '', addAnother: false, runs: null })
                  }
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{credentialEmail(item)}</span>
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
            })}
          </fieldset>
          <AddRow label="Add a new login" data="login" onClick={() => openLogin()} />
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
          <NextButton
            label={credential?.status.word === 'needs_sign_in' ? 'Next, sign in later' : 'Next'}
            disabled={credential === undefined}
            onClick={() => onState(stepForward(state))}
          />
        </div>
      );
  } else if (top.at === 'profile' && credential !== undefined && harness !== undefined) {
    const profiles = data.profiles.profiles;
    const duplicate = draft.profile === null ? undefined : sameLoginAndProfile(runtimes, credential.id, draft.profile);
    body = (
      <div className="flex flex-col gap-3" data-add-runtime-step="profile">
        <p className="m-0 text-ui leading-base text-fg">
          Which profile should it use with <span className="font-mono">{credentialEmail(credential)}</span> on{' '}
          {HARNESS_NAMES[harness]}?
        </p>
        {dual ? (
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-add-runtime-runs={harness}>
            <legend className="mb-1 text-ui font-semibold text-fg">Runs</legend>
            <p className="m-0 text-cell leading-base text-muted">
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
                        chosenProfile !== undefined && profileFit(chosenProfile, candidate).fits ? draft.profile : null;
                      set({ runs: candidate, profile: keeps, name: '', addAnother: false });
                    }}
                  />
                  <span className="text-row font-semibold text-fg">{HARNESS_NAMES[candidate]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {profiles.length === 0 ? (
          <p className="m-0 text-cell text-muted">There are no profiles on {machineName} yet.</p>
        ) : (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="sr-only">Profile</legend>
            {profilesFitFirst(profiles, harnesses, draft.runs).map(({ profile, fit }) => {
              return (
                <Choice
                  key={profile.name}
                  name="add-runtime-profile"
                  checked={profile.name === draft.profile}
                  disabled={!fit.fits}
                  onChoose={() => set({ profile: profile.name, name: '', addAnother: false })}
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
              );
            })}
          </fieldset>
        )}
        {profileBuilder === undefined ? null : (
          <AddRow
            label="Build a new profile"
            data="profile"
            onClick={() => onState(openSubStepper(state, profileBuilder.flowInput({ harness })))}
          />
        )}
        {duplicate === undefined ? null : (
          <div role="status" className="kt-panel flex flex-col gap-2 p-panel" data-add-runtime-duplicate="">
            <p className="m-0 text-row font-semibold text-fg">
              <span className="font-mono">{duplicate.name}</span> already uses this login and profile.
            </p>
            {draft.addAnother ? (
              <p className="m-0 flex items-center gap-2 text-cell text-ok">
                <AccountStatus word="ready" />
                OK, you’ll get a second one
              </p>
            ) : (
              <>
                <p className="m-0 text-cell text-muted">Add another anyway?</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" data-duplicate-ok="" onClick={() => set({ addAnother: true })}>
                    Add another anyway
                  </Button>
                  <Button type="button" size="sm" data-duplicate-no="" onClick={() => set({ profile: null })}>
                    Pick a different profile
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        <NextButton
          disabled={draft.profile === null || (duplicate !== undefined && !draft.addAnother)}
          onClick={() => {
            if (draft.profile === null) return;
            if (draft.name === '') set({ name: suggestedRuntimeName(harness, draft.profile, runtimes) });
            onState(stepForward(state));
          }}
        />
      </div>
    );
  } else if (top.at === 'name' && credential !== undefined && draft.profile !== null) {
    const problem = runtimeNameProblem(draft.name, runtimes, machineName);
    const profile = draft.profile;
    const create = async (): Promise<void> => {
      const result = await changes.apply({
        kind: 'runtime.put',
        name: draft.name,
        credential: credential.id,
        profile,
        ...(dual && harness !== undefined ? { harness } : {}),
        agent: draft.agent,
        create: true,
        ...(draft.addAnother ? { addAnother: true } : {}),
      });
      if (result.kind === 'refused') return;
      onDraft({ ...draft, made: draft.name });
      await reload();
      onState(goToStep(state, 'done'));
    };
    body = (
      <div className="flex flex-col gap-3" data-add-runtime-step="name">
        <div className="kt-panel flex min-w-0 items-center gap-3 p-panel">
          <AccountStatus word={credential.status.word} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-row text-fg">{credentialEmail(credential)}</span>
            <span className="text-cell text-muted">
              {HARNESS_NAMES[harness ?? credential.harness]} · {profile} profile
            </span>
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="add-runtime-name" className="text-ui font-semibold text-fg">
            Runtime name
          </label>
          <input
            id="add-runtime-name"
            className="kt-input font-mono"
            autoComplete="off"
            spellCheck={false}
            value={draft.name}
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
                  onClick={() => set({ name: problem.suggestion ?? draft.name })}
                >
                  Use {problem.suggestion}
                </button>
              )}
            </span>
          )}
        </div>
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
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          busyLabel="Creating…"
          refusal={changes.refusal}
          submitLabel="Create runtime"
          disabled={problem !== null || !online}
          onSubmit={() => void create()}
        />
      </div>
    );
  } else {
    const made = runtimes.find(runtime => runtime.name === draft.made);
    const madeCredential = credentials.find(item => item.id === made?.credential.id) ?? credential;
    const signInFirst = madeCredential?.status.word === 'needs_sign_in';
    const saved = top.saved;
    body = (
      <div className="flex flex-col gap-3" data-add-runtime-step="done">
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel">
          <p className="m-0 text-row font-semibold text-ok">
            <span className="font-mono">{draft.made}</span> is ready to launch
          </p>
          <p className="m-0 text-cell leading-base text-muted">
            {madeCredential === undefined
              ? ''
              : `${HARNESS_NAMES[made?.harness ?? madeCredential.harness]} · ${credentialEmail(madeCredential)} · `}
            {draft.profile} profile{signInFirst ? '. Sign in before you launch.' : '.'}
          </p>
        </div>
        {saved.length === 0 ? null : (
          <p className="m-0 text-cell text-muted" data-add-runtime-saved="">
            Also saved for reuse: {saved.join(', ')}.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" data-add-runtime-finish="list" onClick={() => onFinish(null)}>
            Back to Runtimes
          </Button>
          <Button type="button" variant="primary" data-add-runtime-finish="open" onClick={() => onFinish(draft.made)}>
            Open {draft.made}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <MachineStepper
      state={state}
      onChange={onState}
      machineName={machineName}
      online={online}
      checking={checking}
      onRetry={onRetry}
    >
      {body}
    </MachineStepper>
  );
}
