/**
 * Add a login (docs/design/account-model.md §4.6, docs/provider-presets.md): ONE SCREEN, no stepper.
 *
 * First the provider, as tiles: **Claude Code** or **Codex** with a subscription sign-in, then every
 * API-key provider this machine offers (Popular, Cloud, Self-hosted…) and **Paste variables…**. One tap
 * folds the tiles to the one chosen and shows, right under it, only what that provider needs — a sign-in,
 * or its key — and ONE button that adds the login and, when no runtime runs that CLI yet, the runtime on
 * it. What it is doing and anything that went wrong say so in place.
 *
 * A sign-in starts in the same click that made the login, and its link (and Codex's code) appears under
 * the button. A signed-in email that already has a login of that harness asks for two labels here (E26).
 * An environment login is offered its Test once saved: the daemon tests the login it has, never a draft.
 *
 * Every write is a reviewed change through the shared apply path, so the grant and passkey rules are the
 * change panel's. A machine that is asleep or offline pauses the screen (O5) and renders nothing that
 * could send.
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { Check, ChevronLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { type CredentialLoginFlow, startCredentialSignIn } from '../harness-login-api.ts';
import type { MachineData } from '../runtimes/machine-data.ts';
import { type FirstRuntime, firstRuntimeFor } from '../runtimes/runtimes-model.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
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
import { useProviderCatalog } from './environment-login.tsx';
import { OLLAMA_PRESET_ID } from '../../../lib/local-models.ts';
import { type LocalModelsControl, useLocalModels } from './use-local-models.ts';
import { offeredHarnesses, presetScope } from './environment-model.ts';
import { LoginScopeChip } from './login-scope-chip.tsx';
import { LoginTest } from './login-test.tsx';
import { OneClickLogin } from './one-click-login.tsx';
import { PasteVariables } from './paste-variables.tsx';
import { PROVIDER_TILE, ProviderGrid } from './provider-grid.tsx';
import type { Prefill } from './provider-model.ts';

/** What the person picked: a subscription sign-in, an API-key provider, or a paste to recognise one from. */
type Choice =
  | { readonly kind: 'signin'; readonly harness: HarnessKind }
  | { readonly kind: 'preset'; readonly presetId: string; readonly prefill?: Prefill }
  | { readonly kind: 'paste' };

/** What the one button made. */
interface Made {
  readonly credentialId: string;
  /** The runtime made on it, its refusal, or `null` when none was asked for. */
  readonly runtime:
    | { readonly kind: 'made'; readonly name: string }
    | { readonly kind: 'refused'; readonly sentence: string }
    | null;
}

/** A sign-in started for the new login, or the reason it would not start. */
interface Started {
  readonly flow: CredentialLoginFlow | null;
  readonly refusal: string | null;
}

/** What each sign-in tile signs in with. */
const SUBSCRIPTION: Readonly<Record<HarnessKind, string>> = {
  claude: 'Claude subscription',
  codex: 'ChatGPT subscription',
};

export interface AddLoginProps {
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  /** `false` pauses the screen (O5). */
  readonly online: boolean;
  /** A reachability check is running, so Retry is busy. */
  readonly checking?: boolean;
  readonly onRetry: () => void;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly data: MachineData | null;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  /** The login is added and the person pressed Done: its id. */
  readonly onAdded: (credentialId: string) => void;
  /** Back to the logins, adding nothing more. */
  readonly onLeave: () => void;
  /** Supplied in tests. */
  readonly pollMs?: number;
}

const installed = (machine: FleetMachineView | null, harness: HarnessKind): boolean =>
  machine?.tools.find(tool => tool.harness === harness)?.installed === true;

export function AddLogin({
  machine,
  machineName,
  online,
  checking = false,
  onRetry,
  connection,
  createClient,
  data,
  reload,
  changes,
  onAdded,
  onLeave,
  pollMs,
}: AddLoginProps) {
  const catalog = useProviderCatalog(connection, createClient);
  // One read of Ollama when this screen opens and it offers the Ollama tile; then only on Check again.
  const local = useLocalModels({
    connection,
    createClient,
    enabled:
      catalog.loaded.kind === 'ready' && catalog.loaded.presets.some(candidate => candidate.id === OLLAMA_PRESET_ID),
  });
  const [choice, setChoice] = useState<Choice | null>(null);
  /** Whether to make the runtime too; `null` while the default (make it when none runs that CLI) holds. */
  const [withRuntime, setWithRuntime] = useState<boolean | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [labels, setLabels] = useState<{ older: string; newer: string } | null>(null);
  /** What the button is doing right now, said on it. */
  const [working, setWorking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // A new screen, so the reader starts at its title.
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const presets = catalog.loaded.kind === 'ready' ? catalog.loaded.presets : [];
  const preset = choice?.kind === 'preset' ? presets.find(candidate => candidate.id === choice.presetId) : undefined;
  const credential =
    made === null ? undefined : data?.credentials.credentials.find(candidate => candidate.id === made.credentialId);
  const twin = credential === undefined || data === null ? undefined : sameEmailLogin(data.credentials, credential);

  /** The CLIs the chosen login drives, Claude Code first. */
  const drives: readonly HarnessKind[] =
    choice?.kind === 'signin' ? [choice.harness] : preset === undefined ? [] : offeredHarnesses(preset);
  const plan: FirstRuntime | null =
    data === null ? null : firstRuntimeFor(drives, data.runtimes.runtimes, data.profiles.profiles);
  const makeRuntime = plan !== null && (withRuntime ?? plan.needed);

  const choose = (next: Choice | null): void => {
    changes.clear();
    setWithRuntime(null);
    setChoice(next);
  };

  /** The runtime on the login just made, when one was asked for. A refusal is said, and the login stays. */
  const addRuntime = async (credentialId: string): Promise<Made['runtime']> => {
    if (!makeRuntime || plan === null) return null;
    setWorking(`Creating ${plan.name}…`);
    const result = await changes.apply({
      kind: 'runtime.put',
      name: plan.name,
      credential: credentialId,
      profile: plan.profile,
      ...(drives.length > 1 ? { harness: plan.harness } : {}),
      agent: false,
      create: true,
    });
    // The login is made either way: the runtime's refusal is said beside it, not on the button.
    changes.clear();
    return result.kind === 'refused'
      ? { kind: 'refused', sentence: result.sentence }
      : { kind: 'made', name: plan.name };
  };

  /** A sign-in: make the empty login, its runtime, then start the harness's sign-in for it. */
  const signIn = async (harness: HarnessKind): Promise<void> => {
    const id = nextCredentialId(data?.credentials ?? null, harness);
    setWorking('Adding the login…');
    try {
      const added = await changes.apply({ kind: 'credential.add', id, harness });
      if (added.kind === 'refused') return;
      const runtime = await addRuntime(id);
      await reload();
      setMade({ credentialId: id, runtime });
      setWorking('Starting sign-in…');
      try {
        const client = await createClient(connection);
        setStarted({ flow: await startCredentialSignIn(client, { credentialId: id }), refusal: null });
      } catch (error) {
        // The login exists; the sign-in panel below can start it again.
        setStarted({ flow: null, refusal: changeRefusalSentence(error) });
      }
    } finally {
      setWorking(null);
    }
  };

  /** An environment login is saved: its runtime next, then the Test. */
  const saved = async (credentialId: string): Promise<void> => {
    setMade({ credentialId, runtime: null });
    try {
      const runtime = await addRuntime(credentialId);
      if (runtime !== null) {
        setMade({ credentialId, runtime });
        await reload();
      }
    } finally {
      setWorking(null);
    }
  };

  const saveLabels = async (): Promise<void> => {
    if (credential === undefined || twin === undefined || labels === null) return;
    const first = await changes.apply({ kind: 'credential.label', id: twin.id, label: labels.older.trim() });
    if (first.kind === 'refused') return;
    const second = await changes.apply({ kind: 'credential.label', id: credential.id, label: labels.newer.trim() });
    if (second.kind === 'refused') return;
    await reload();
    onAdded(credential.id);
  };

  const done = made !== null && (choice?.kind !== 'signin' || signedIn);
  const leave = (): void => {
    if (choice === null || done) onLeave();
    else setConfirming(true);
  };

  const body = (() => {
    if (confirming)
      return (
        <div role="alert" data-add-login-confirm="" className="kt-panel p-panel">
          <p className="m-0 text-row font-semibold text-fg">Stop adding a login?</p>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">
            {made === null
              ? 'No new login is added.'
              : 'The login you added is kept, and can be signed in from its own page.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="danger" data-add-login-stop="" onClick={onLeave}>
              Stop
            </Button>
            <Button type="button" variant="primary" data-add-login-keep="" onClick={() => setConfirming(false)}>
              Keep going
            </Button>
          </div>
        </div>
      );
    if (!online)
      return (
        <div role="status" data-add-login-paused="" className="kt-panel p-panel">
          <p className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
            <AccountStatus word="needs_sign_in" label="Offline" />
            <span className="min-w-0">{machineName} is asleep or offline</span>
          </p>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">
            This is paused. What you chose is kept. Wake {machineName} and tap Retry.
          </p>
          <div className="mt-3">
            <Button type="button" variant="primary" data-add-login-retry="" disabled={checking} onClick={onRetry}>
              {checking ? 'Checking…' : 'Retry'}
            </Button>
          </div>
        </div>
      );
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {choice === null ? (
          <Choices machine={machine} machineName={machineName} catalog={catalog} local={local} onChoose={choose} />
        ) : (
          <Chosen
            choice={choice}
            presetLabel={preset?.label}
            scope={preset === undefined ? [] : presetScope(preset)}
            onChange={made === null && working === null ? () => choose(null) : undefined}
          />
        )}
        {choice === null ? null : (
          <div
            className="flex min-w-0 flex-col gap-3"
            data-add-login-fields={
              choice.kind === 'signin' ? choice.harness : choice.kind === 'paste' ? 'paste' : choice.presetId
            }
          >
            {fields()}
          </div>
        )}
      </div>
    );
  })();

  /** The runtime this button makes too, as a choice the person can turn off. */
  function runtimeChoice() {
    if (data === null || drives.length === 0) return null;
    if (plan === null)
      return (
        <p className="m-0 text-cell leading-base text-muted" data-add-login-runtime="none">
          No profile runs {drives.map(harness => HARNESS_NAMES[harness]).join(' or ')} yet, so no runtime is made. Add
          one later in Runtimes.
        </p>
      );
    return (
      <label className="flex min-h-control min-w-0 cursor-pointer items-start gap-3" data-add-login-runtime={plan.name}>
        <input
          type="checkbox"
          className="mt-1"
          checked={makeRuntime}
          onChange={event => setWithRuntime(event.target.checked)}
        />
        <span className="flex min-w-0 flex-col">
          <span className="text-ui text-fg">
            Also create the runtime <span className="break-all font-mono">{plan.name}</span>
          </span>
          <span className="text-meta leading-base text-muted">
            {HARNESS_NAMES[plan.harness]} · {plan.profile} profile
            {plan.needed ? '' : ` · ${HARNESS_NAMES[plan.harness]} already has a runtime here`}
          </span>
        </span>
      </label>
    );
  }

  /** What became of the runtime, beside the login it was made on. */
  function runtimeOutcome() {
    if (made?.runtime === null || made === null) return null;
    return made.runtime.kind === 'made' ? (
      <p
        role="status"
        className="m-0 inline-flex items-center gap-2 text-cell text-ok"
        data-add-login-runtime-made={made.runtime.name}
      >
        <Check size={14} aria-hidden="true" />
        <span>
          Created the runtime <span className="break-all font-mono">{made.runtime.name}</span>
        </span>
      </p>
    ) : (
      <p role="alert" className="m-0 text-cell leading-base text-warn" data-add-login-runtime-refused="">
        The login is added, but its runtime was not: {made.runtime.sentence} Add it later in Runtimes.
      </p>
    );
  }

  function fields() {
    if (choice === null) return null;
    if (choice.kind === 'paste')
      return (
        <PasteVariables
          presets={presets}
          onBack={() => choose(null)}
          onContinue={(presetId, prefill) => choose({ kind: 'preset', presetId, prefill })}
        />
      );

    if (choice.kind === 'preset') {
      if (preset === undefined) return null;
      if (made !== null) {
        const row = data?.credentials.credentials.find(candidate => candidate.id === made.credentialId);
        return (
          <div className="flex min-w-0 flex-col gap-3" data-add-login-done="">
            <p role="status" className="m-0 inline-flex items-center gap-2 text-row font-semibold text-ok">
              <Check size={16} aria-hidden="true" />
              <span>
                Added <span className="break-all font-mono">{made.credentialId}</span>
              </span>
            </p>
            {working === null ? (
              runtimeOutcome()
            ) : (
              <p role="status" className="m-0 text-cell text-muted" data-add-login-working="">
                {working}
              </p>
            )}
            <p className="m-0 text-cell leading-base text-muted">
              Test it now: the daemon tests the login it saved, sending the key only where the login sends it.
            </p>
            <LoginTest
              credentialId={made.credentialId}
              act={row?.environment?.test ?? preset.test}
              connection={connection}
              createClient={createClient}
            />
            <div>
              <Button
                type="button"
                variant="primary"
                data-add-login-finish=""
                disabled={working !== null}
                onClick={() => onAdded(made.credentialId)}
              >
                Done
              </Button>
            </div>
          </div>
        );
      }
      return (
        <OneClickLogin
          key={preset.id}
          preset={preset}
          stored={catalog.stored}
          onStored={catalog.onStored}
          {...(choice.prefill === undefined ? {} : { prefill: choice.prefill })}
          list={data?.credentials ?? null}
          machineName={machineName}
          connection={connection}
          createClient={createClient}
          changes={changes}
          local={preset.id === OLLAMA_PRESET_ID ? local : undefined}
          reload={reload}
          submitLabel={makeRuntime ? 'Add login and runtime' : 'Add login'}
          onSaved={credentialId => void saved(credentialId)}
        >
          {runtimeChoice()}
        </OneClickLogin>
      );
    }

    // A subscription sign-in.
    const name = HARNESS_NAMES[choice.harness];
    if (credential !== undefined && signedIn) {
      if (twin !== undefined && labels !== null) {
        const problem = labelsError(labels.older, labels.newer);
        return (
          <div className="flex min-w-0 flex-col gap-3" data-add-login-label="">
            <p className="m-0 text-ui leading-base text-fg">
              You already have a {name} login for{' '}
              <span className="break-all font-mono">{credentialEmail(credential)}</span>. Label both so you can tell
              them apart.
            </p>
            <div className="flex min-w-0 flex-col gap-1">
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
            <div className="flex min-w-0 flex-col gap-1">
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
      return (
        <div className="flex min-w-0 flex-col gap-3" data-add-login-done="">
          <p role="status" className="m-0 inline-flex items-center gap-2 text-row font-semibold text-ok">
            <Check size={16} aria-hidden="true" />
            <span>
              Signed in to {name} as <span className="break-all font-mono">{credentialEmail(credential)}</span>
            </span>
          </p>
          {runtimeOutcome()}
          <div>
            <Button
              type="button"
              variant="primary"
              data-add-login-finish=""
              onClick={() => {
                if (twin === undefined) onAdded(credential.id);
                else setLabels({ older: twin.label ?? 'personal', newer: twin.label === 'work' ? 'side' : 'work' });
              }}
            >
              {twin === undefined ? 'Done' : 'Next: label them'}
            </Button>
          </div>
        </div>
      );
    }
    if (credential !== undefined && started !== null)
      return (
        <div className="flex min-w-0 flex-col gap-3" data-add-login-signing-in="">
          {runtimeOutcome()}
          {started.refusal === null ? null : (
            <p role="alert" className="m-0 text-cell leading-base text-err" data-add-login-start-refused="">
              {started.refusal}
            </p>
          )}
          <CredentialSignIn
            credential={credential}
            machineName={machineName}
            connection={connection}
            createClient={createClient}
            changes={changes}
            {...(started.flow === null ? {} : { initialFlow: started.flow })}
            {...(pollMs === undefined ? {} : { pollMs })}
            onSignedIn={() => {
              setSignedIn(true);
              void reload();
            }}
          />
        </div>
      );
    return (
      <>
        <p className="m-0 text-cell leading-base text-muted">
          You sign in on {name}’s own page; the login is kept on {machineName}, and nothing here sees your password.
        </p>
        {runtimeChoice()}
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy || working !== null}
          busyLabel={working ?? 'Adding the login…'}
          refusal={changes.refusal}
          submitLabel={makeRuntime ? `Sign in and create ${plan?.name}` : `Sign in to ${name}`}
          onSubmit={() => void signIn(choice.harness)}
        />
      </>
    );
  }

  return (
    <section data-add-login-screen="" aria-labelledby="add-login-title" className="min-w-0">
      <div className="flex min-h-control items-center gap-2">
        {confirming ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="kt-btn--flush-start"
            data-add-login-back=""
            onClick={leave}
          >
            <ChevronLeft size={16} aria-hidden="true" />
            AI logins
          </Button>
        )}
      </div>
      <h3
        id="add-login-title"
        ref={titleRef}
        tabIndex={-1}
        className="m-0 mt-2 font-display text-title font-semibold tracking-display text-fg outline-none"
      >
        Add a login
      </h3>
      <div className="mt-3 min-w-0">{body}</div>
    </section>
  );
}

/** Every provider, as tiles: the two sign-ins first, then the API-key providers and Paste variables. */
function Choices({
  machine,
  machineName,
  catalog,
  local,
  onChoose,
}: {
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly catalog: ReturnType<typeof useProviderCatalog>;
  readonly local: LocalModelsControl;
  readonly onChoose: (choice: Choice) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-add-login-choices="">
      <p className="m-0 text-ui leading-base text-fg">How will {machineName} reach the model?</p>
      <section className="flex min-w-0 flex-col gap-1" data-add-login-section="signin">
        <h4 className="m-0 text-meta font-semibold uppercase text-muted">Sign in</h4>
        <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4">
          {HARNESSES.map(harness => {
            const available = installed(machine, harness);
            return (
              <li key={harness} className="flex min-w-0">
                <button
                  type="button"
                  className={`${PROVIDER_TILE} ${available ? '' : 'border-dashed text-muted hover:border-border'}`}
                  aria-disabled={available ? undefined : true}
                  data-add-login-choice={harness}
                  onClick={() => {
                    if (available) onChoose({ kind: 'signin', harness });
                  }}
                >
                  <span className={`text-row font-semibold ${available ? 'text-fg' : 'text-muted'}`}>
                    {HARNESS_NAMES[harness]}
                  </span>
                  <span className={`text-meta leading-base ${available ? 'text-muted' : 'text-warn'}`}>
                    {available ? SUBSCRIPTION[harness] : `Not installed on ${machineName} · install it in Settings`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {catalog.loaded.kind === 'loading' ? (
        <p role="status" className="m-0 text-cell text-muted" data-env-login="loading">
          Reading the providers on {machineName}…
        </p>
      ) : catalog.loaded.kind === 'failed' ? (
        <p role="alert" className="m-0 text-cell leading-base text-warn" data-env-login="failed">
          {catalog.loaded.sentence}
        </p>
      ) : catalog.loaded.presets.length === 0 ? null : (
        <ProviderGrid
          presets={catalog.loaded.presets}
          local={local}
          onPick={presetId => onChoose({ kind: 'preset', presetId })}
          onPaste={() => onChoose({ kind: 'paste' })}
        />
      )}
    </div>
  );
}

/** The tiles, folded to the one chosen: its name, which CLI it drives, and Change while nothing is made. */
function Chosen({
  choice,
  presetLabel,
  scope,
  onChange,
}: {
  readonly choice: Choice;
  readonly presetLabel: string | undefined;
  readonly scope: readonly HarnessKind[];
  readonly onChange: (() => void) | undefined;
}) {
  const title =
    choice.kind === 'signin'
      ? HARNESS_NAMES[choice.harness]
      : choice.kind === 'paste'
        ? 'Paste variables'
        : presetLabel;
  return (
    <div
      className="kt-panel flex min-w-0 max-w-[42rem] items-center gap-3 border-accent p-panel"
      data-add-login-chosen={choice.kind}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 break-words text-row font-semibold text-fg">{title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {scope.length === 0 ? null : <LoginScopeChip harnesses={scope} />}
          {choice.kind === 'signin' ? (
            <span className="text-meta text-muted">{SUBSCRIPTION[choice.harness]}</span>
          ) : null}
        </span>
      </span>
      {onChange === undefined ? null : (
        <Button type="button" size="sm" variant="ghost" data-add-login-change="" onClick={onChange}>
          Change
        </Button>
      )}
    </div>
  );
}
