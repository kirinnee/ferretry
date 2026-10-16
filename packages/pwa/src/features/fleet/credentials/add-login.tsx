/**
 * Add a login (docs/design/account-model.md §4.6, docs/provider-presets.md): first its TYPE — **Sign in**
 * or **Environment** — then, for a sign-in, **Choose tool** (skipped when opened for a known
 * harness) → **Sign in** → **Label** (only when the same email already has a login of that harness,
 * E26).
 *
 * The flow is one entry on the shared stepper stack, so it runs on its own from the Credentials tab and
 * as a sub-stepper of Add a runtime ("+ Add a new login", E12), which gets the new login back picked.
 *
 * One click makes the login and starts its sign-in: the empty login is added as a reviewed change
 * (`credential.add`, kept by Ferretry on this machine) and the harness's sign-in is started for it.
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { type CredentialLoginFlow, startCredentialSignIn } from '../harness-login-api.ts';
import type { MachineData } from '../runtimes/machine-data.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import {
  currentFlow,
  goToStep,
  returnToParent,
  type StepperFlowInput,
  type StepperState,
  saveForReuse,
  stepForward,
  withSteps,
} from '../shell/stepper-model.ts';
import { CredentialSignIn } from './credential-sign-in.tsx';
import {
  credentialEmail,
  HARNESSES,
  type HarnessKind,
  labelsError,
  nextCredentialId,
  plural,
  sameEmailLogin,
} from './credentials-model.ts';
import { EnvironmentLogin } from './environment-login.tsx';

export const ADD_LOGIN_FLOW_KIND = 'add-login';

/** A login is a sign-in, or a named set of environment variables (docs/provider-presets.md). */
export type AddLoginKind = 'signin' | 'environment';

/** The Sign in | Environment choice every first screen of the flow opens with. */
function LoginKindChoice({
  kind,
  onChoose,
}: {
  readonly kind: AddLoginKind;
  readonly onChoose: (kind: AddLoginKind) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-add-login-kind={kind}>
      <legend className="mb-1 text-ui font-semibold text-fg">Type</legend>
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['signin', 'Sign in', 'OAuth or a device code; the CLI keeps the login.'],
            ['environment', 'Environment', 'A provider and its key — GLM, DeepSeek, OpenRouter, Bedrock…'],
          ] as const
        ).map(([value, title, sub]) => (
          <label
            key={value}
            className="kt-panel flex min-h-control min-w-0 flex-1 basis-56 cursor-pointer items-start gap-3 p-panel"
            data-add-login-kind-option={value}
          >
            <input
              type="radio"
              name="add-login-kind"
              className="mt-1"
              checked={kind === value}
              onChange={() => onChoose(value)}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-row font-semibold text-fg">{title}</span>
              <span className="text-cell text-muted">{sub}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const TOOL = { id: 'tool', label: 'Choose tool' } as const;
const SIGN_IN = { id: 'signin', label: 'Sign in' } as const;
/** An environment login's own two steps: fill it in, then Test the saved login (docs/provider-presets.md). */
const ENVIRONMENT = { id: 'environment', label: 'Environment' } as const;
const TEST = { id: 'test', label: 'Test' } as const;
const LABEL = { id: 'label', label: 'Label' } as const;

/** The flow, for `startStepper` or `openSubStepper`. A known harness skips Choose tool. */
export const addLoginFlowInput = ({ harness }: { readonly harness?: HarnessKind } = {}): StepperFlowInput => ({
  kind: ADD_LOGIN_FLOW_KIND,
  title: 'Add a login',
  steps: harness === undefined ? [TOOL, SIGN_IN] : [SIGN_IN],
  leave: {
    question: 'Stop adding a login?',
    consequence: 'No new login is added. One you already signed in with is kept.',
    stopLabel: 'Stop',
  },
});

export interface AddLoginStepProps {
  readonly state: StepperState;
  readonly onChange: (next: StepperState) => void;
  /** The login is added. `next` is the parent flow on top, or `null` when this was the whole stepper. */
  readonly onAdded: (credentialId: string, next: StepperState | null) => void;
  /** Set when the flow was opened for one harness. */
  readonly harness?: HarnessKind;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly data: MachineData | null;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  /** Supplied in tests. */
  readonly pollMs?: number;
}

const installed = (machine: FleetMachineView | null, harness: HarnessKind) =>
  machine?.tools.find(tool => tool.harness === harness);

/**
 * The body of whichever Add a login step is current. Keep it at ONE place in the tree while the flow is
 * on top: what the person chose lives in its own state, and ends with the flow.
 */
export function AddLoginStep({
  state,
  onChange,
  onAdded,
  harness: fixedHarness,
  machine,
  machineName,
  connection,
  createClient,
  data,
  reload,
  changes,
  pollMs,
}: AddLoginStepProps) {
  const [harness, setHarness] = useState<HarnessKind | null>(fixedHarness ?? null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [started, setStarted] = useState<CredentialLoginFlow | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [labels, setLabels] = useState<{ older: string; newer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const flow = currentFlow(state);
  // The type is the flow's own steps, so the stepper always says which path this is.
  const kind: AddLoginKind = flow.at === ENVIRONMENT.id || flow.at === TEST.id ? 'environment' : 'signin';
  const setKind = (next: AddLoginKind): void => {
    onChange(
      next === 'environment'
        ? withSteps(state, [ENVIRONMENT, TEST])
        : withSteps(state, fixedHarness === undefined ? [TOOL, SIGN_IN] : [SIGN_IN]),
    );
  };

  const credential = data?.credentials.credentials.find(candidate => candidate.id === credentialId);
  const twin = credential === undefined || data === null ? undefined : sameEmailLogin(data.credentials, credential);

  /** Make the empty login, then start its sign-in. */
  const create = async (): Promise<void> => {
    if (harness === null) return;
    setRefusal(null);
    const id = nextCredentialId(data?.credentials ?? null, harness);
    const made = await changes.apply({ kind: 'credential.add', id, harness });
    if (made.kind === 'refused') return;
    setCredentialId(id);
    onChange(saveForReuse(state, `${HARNESS_NAMES[harness]} login`));
    await reload();
    setBusy(true);
    try {
      const client = await createClient(connection);
      const started = await startCredentialSignIn(client, { credentialId: id });
      setStarted(started);
    } catch (error) {
      // The login exists; its own page can sign it in.
      setRefusal(changeRefusalSentence(error));
    } finally {
      setBusy(false);
    }
  };

  const finish = (from: StepperState): void => {
    if (credentialId === null) return;
    onAdded(credentialId, returnToParent(from));
  };

  /** Signed in: on to the label step when this email already has a login here, else done. */
  const next = (): void => {
    if (credential === undefined) return;
    if (twin === undefined) {
      finish(state);
      return;
    }
    setLabels({ older: twin.label ?? 'personal', newer: twin.label === 'work' ? 'side' : 'work' });
    onChange(goToStep(withSteps(state, [...flow.steps.filter(step => step.id !== LABEL.id), LABEL]), LABEL.id));
  };

  const saveLabels = async (): Promise<void> => {
    if (credential === undefined || twin === undefined || labels === null) return;
    const first = await changes.apply({ kind: 'credential.label', id: twin.id, label: labels.older.trim() });
    if (first.kind === 'refused') return;
    const second = await changes.apply({ kind: 'credential.label', id: credential.id, label: labels.newer.trim() });
    if (second.kind === 'refused') return;
    await reload();
    finish(state);
  };

  // An environment login has no sign-in and no tool step of its own: its preset says which CLI it drives.
  if (kind === 'environment' && credentialId === null)
    return (
      <div className="flex flex-col gap-3" data-add-login-step={flow.at}>
        {flow.at === TEST.id ? null : <LoginKindChoice kind={kind} onChoose={setKind} />}
        <EnvironmentLogin
          {...(fixedHarness === undefined ? {} : { harness: fixedHarness })}
          machineName={machineName}
          connection={connection}
          createClient={createClient}
          data={data}
          reload={reload}
          changes={changes}
          onSaved={() => onChange(goToStep(state, TEST.id))}
          onAdded={id => onAdded(id, returnToParent(state))}
        />
      </div>
    );

  if (flow.at === TOOL.id)
    return (
      <div className="flex flex-col gap-3" data-add-login-step="tool">
        <LoginKindChoice kind={kind} onChoose={setKind} />
        <p className="m-0 text-ui leading-base text-fg">Which tool do you want to sign in to on {machineName}?</p>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">Tool</legend>
          {HARNESSES.map(candidate => {
            const tool = installed(machine, candidate);
            const available = tool?.installed === true;
            return (
              <label
                key={candidate}
                className="kt-panel flex min-h-control cursor-pointer items-start gap-3 p-panel"
                data-add-login-tool={candidate}
              >
                <input
                  type="radio"
                  name="add-login-tool"
                  className="mt-1"
                  checked={harness === candidate}
                  disabled={!available}
                  onChange={() => {
                    setHarness(candidate);
                    setCredentialId(null);
                    setStarted(null);
                    setSignedIn(false);
                  }}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-row font-semibold text-fg">{HARNESS_NAMES[candidate]}</span>
                  <span className="text-cell text-muted">
                    {available ? 'Installed' : `Not installed on ${machineName} · install it in Settings`}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div>
          <Button
            type="button"
            variant="primary"
            data-step-next=""
            disabled={harness === null}
            onClick={() => onChange(stepForward(state))}
          >
            Next
          </Button>
        </div>
      </div>
    );

  if (flow.at === LABEL.id && credential !== undefined && twin !== undefined && labels !== null) {
    const problem = labelsError(labels.older, labels.newer);
    return (
      <div className="flex flex-col gap-3" data-add-login-step="label">
        <p className="m-0 text-ui leading-base text-fg">
          You already have a {HARNESS_NAMES[credential.harness]} login for{' '}
          <span className="font-mono">{credentialEmail(credential)}</span>. Label both so you can tell them apart.
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor="add-login-label-old" className="text-ui font-semibold text-fg">
            Label for the login you already had
          </label>
          <input
            id="add-login-label-old"
            className="kt-input"
            autoComplete="off"
            value={labels.older}
            placeholder="e.g. personal"
            onChange={event => setLabels({ ...labels, older: event.target.value })}
          />
          <span className="text-meta text-muted">Used by {plural(twin.usedBy.length, 'runtime')}.</span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="add-login-label-new" className="text-ui font-semibold text-fg">
            Label for the new login
          </label>
          <input
            id="add-login-label-new"
            className="kt-input"
            autoComplete="off"
            value={labels.newer}
            placeholder="e.g. work"
            onChange={event => setLabels({ ...labels, newer: event.target.value })}
          />
          {problem === null ? null : (
            <span className="text-meta text-err" data-add-login-label-error="">
              {problem}
            </span>
          )}
        </div>
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save labels"
          disabled={problem !== null}
          onSubmit={() => void saveLabels()}
        />
      </div>
    );
  }

  // Sign in.
  const name = harness === null ? '' : HARNESS_NAMES[harness];
  if (credential !== undefined && signedIn)
    return (
      <div className="flex flex-col gap-3" data-add-login-step="signed-in">
        <p role="status" className="m-0 text-row font-semibold text-ok">
          Signed in to {name} as <span className="font-mono">{credentialEmail(credential)}</span>
        </p>
        <div>
          <Button type="button" variant="primary" data-step-next="" onClick={next}>
            Next
          </Button>
        </div>
      </div>
    );
  if (credential !== undefined)
    return (
      <div className="flex flex-col gap-3" data-add-login-step="signin">
        <p className="m-0 text-ui leading-base text-fg">
          Sign in to {name}. The login is kept on {machineName}.
        </p>
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
          {...(started === null ? {} : { initialFlow: started })}
          {...(pollMs === undefined ? {} : { pollMs })}
          onSignedIn={() => {
            setSignedIn(true);
            void reload();
          }}
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-3" data-add-login-step="start">
      {fixedHarness === undefined ? null : <LoginKindChoice kind={kind} onChoose={setKind} />}
      <p className="m-0 text-ui leading-base text-fg">
        Sign in to {name}. The login is kept on {machineName}.
      </p>
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy || busy}
        busyLabel="Starting sign-in…"
        refusal={changes.refusal}
        submitLabel={`Sign in to ${name}`}
        onSubmit={() => void create()}
      />
    </div>
  );
}
