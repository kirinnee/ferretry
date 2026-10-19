/**
 * New machine setup's **Claude Code** and **Codex** steps (the flat-onboarding proposal; docs/design/
 * account-model.md §4.3, E1–E11). ONE SCREEN per CLI, top to bottom, and nothing on it is a page of its
 * own:
 *
 * 1. **Installed?** — and when it is not, the install in place (`tool-install.tsx`).
 * 2. **Found on <machine>** — the login, instructions, settings, MCP servers and skills the scan read.
 * 3. **Sign-in** — the person's own login, signed in right here (`first-run-sign-in.tsx`).
 * 4. **Runtime name** — prefilled with the daemon's own suggestion (`claude-default`), editable.
 * 5. **What changed** — Import again only: updates offered, none ticked (O6).
 * 6. **Import and create <name>** — ONE reviewed change, `setup.import` for this CLI alone. The import
 *    makes the runtime, so there is no Name step and no runtime wizard.
 * 7. **Use a provider key instead** — the provider grid (`environment-login.tsx`) for this CLI; the login
 *    it adds gets its runtime right there, on the profile this CLI's import made.
 *
 * More runtimes are Settings › Runtimes › Add runtime. A machine that is asleep or offline shows a
 * one-line pause instead of anything that would send.
 */

import type { FleetRuntimeView, FleetSetupScan } from '@ferretry/protocol';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { readFleetRuntimes } from '../catalog-api.ts';
import { ConversationPicker } from '../conversations/conversation-picker.tsx';
import { EnvironmentLogin } from '../credentials/environment-login.tsx';
import type { MachineData } from '../runtimes/machine-data.ts';
import { useMachineData } from '../runtimes/machine-data.ts';
import { profileFit, runtimeNameProblem, suggestedRuntimeName } from '../runtimes/runtimes-model.ts';
import { readFleetSetupScan } from '../setup-api.ts';
import { type AccountChanges, ChangeApplyPanel, useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { FirstRunSignIn } from './first-run-sign-in.tsx';
import {
  foundRows,
  type HarnessAnswers,
  harnessImportChange,
  harnessProblems,
  importButtonLabel,
  importNotes,
  makesRuntime,
  missingTools,
  offersSignIn,
  runtimeName,
  runtimePlan,
  scanHasHarness,
  scanSignedIn,
  updateDetail,
  updateTitle,
} from './harness-import-model.ts';
import type { InstallPhase } from './install-model.ts';
import { machineItemHash } from './settings-route.ts';
import { useSetupAccess } from './setup-access.ts';
import { CheckChoices, SetupBadges, SetupNote, SetupRow, SetupSection } from './setup-ui.tsx';
import { listWords, SETUP_HARNESS_NAMES, type SetupHarness } from './setup-words.ts';
import { ToolInstall } from './tool-install.tsx';

export interface OnboardingHarnessStepProps {
  readonly tab: MachineTabProps;
  readonly harness: SetupHarness;
  /** What was answered here, kept with the rail's progress. */
  readonly answers: HarnessAnswers;
  readonly onAnswers: (answers: HarnessAnswers) => void;
  /** This CLI has a runtime on the machine: the step is set. */
  readonly onReady: () => void;
  /** How often a waiting sign-in is re-read. Supplied in tests. */
  readonly pollMs?: number;
}

/** The runtimes a CLI has on the machine. */
const runtimesOf = (runtimes: readonly FleetRuntimeView[], harness: SetupHarness): readonly FleetRuntimeView[] =>
  runtimes.filter(runtime => runtime.harness === harness);

export function OnboardingHarnessStep({
  tab,
  harness,
  answers,
  onAnswers,
  onReady,
  pollMs,
}: OnboardingHarnessStepProps) {
  const { connection, createClient, machineName, online } = tab;
  const access = useSetupAccess({ connection, createClient });
  const { changes } = access;
  const [scan, setScan] = useState<FleetSetupScan | null>(null);
  const [runtimes, setRuntimes] = useState<readonly FleetRuntimeView[]>([]);
  const [issue, setIssue] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [install, setInstall] = useState<InstallPhase>({ kind: 'choose' });
  const [installSkipped, setInstallSkipped] = useState(false);
  /** The import this visit sent, and the notes it left: shown in place of the form. */
  const [imported, setImported] = useState<readonly string[] | null>(null);
  const name = SETUP_HARNESS_NAMES[harness];

  const latest = useRef({ access, onReady });
  latest.current = { access, onReady };
  const read = useCallback(async (): Promise<void> => {
    setIssue(null);
    const scanned = await latest.current.access.read(client => readFleetSetupScan(client));
    if (scanned.kind === 'refused') {
      setIssue(scanned.sentence);
      return;
    }
    const listed = await latest.current.access.read(client => readFleetRuntimes(client));
    const now = listed.kind === 'done' ? listed.value.runtimes : [];
    setRuntimes(now);
    setScan(scanned.value);
    if (runtimesOf(now, harness).length > 0) latest.current.onReady();
  }, [harness]);

  useEffect(() => {
    void read();
  }, [read]);

  if (!online)
    return (
      <SetupNote live tone="warn" name="harness-paused" title={`${machineName} is asleep or offline`}>
        <span>Your place is kept. Wake {machineName}, or skip this step and come back to it.</span>
      </SetupNote>
    );

  if (scan === null)
    return issue === null ? (
      <p role="status" className="m-0 text-cell text-muted" data-harness-reading={harness}>
        Looking for {name} on {machineName}…
      </p>
    ) : (
      <div className="flex min-w-0 flex-col gap-3" data-onboarding-step-body={harness}>
        <SetupNote live tone="warn" name="scan-failed" title={`Couldn’t look at ${machineName}`}>
          <span>{issue}</span>
        </SetupNote>
        <div>
          <Button type="button" data-scan-retry="" onClick={() => void read()}>
            Try again
          </Button>
        </div>
      </div>
    );

  const tool = scan.tools.find(candidate => candidate.harness === harness);
  const missing = missingTools(tool === undefined ? [] : [tool]);
  const have = runtimesOf(runtimes, harness);
  const plan = runtimePlan(scan, harness);
  const makes = makesRuntime(plan, answers);
  const typed = runtimeName(plan, answers);
  const problem = makes ? runtimeNameProblem(typed, runtimes, machineName) : null;
  const set = (patch: Partial<HarnessAnswers>): void => onAnswers({ ...answers, ...patch });

  const send = (): void => {
    void changes.apply(harnessImportChange(harness, plan, answers)).then(async applied => {
      if (applied.kind === 'refused') return;
      setImported(importNotes(scan, [harness]));
      onAnswers({});
      await read();
    });
  };

  let body: ReactNode;
  if (!scanHasHarness(scan, harness)) {
    body =
      missing.length > 0 && !installSkipped ? (
        <SetupSection title={`Install ${name}`} name="install">
          <ToolInstall
            machineName={machineName}
            tools={missing}
            access={access}
            phase={install}
            onPhase={setInstall}
            onInstalled={() => void read()}
            onSkip={() => setInstallSkipped(true)}
            doneHint={`Next, Ferretry looks for your ${name} setup.`}
          />
        </SetupSection>
      ) : (
        <SetupNote name="not-installed">
          <span>
            {name} isn’t installed on {machineName}. Skip this step and install it later in Settings › Machine.
          </span>
        </SetupNote>
      );
  } else {
    const claudeImported = runtimesOf(runtimes, 'claude').length > 0;
    const signedIn = scanSignedIn(scan, harness);
    body = (
      <>
        <SetupSection title={`Found on ${machineName}`} name="found">
          {foundRows(scan, harness, claudeImported).map(row => (
            <SetupRow
              key={row.key}
              name={row.key}
              label={row.label}
              {...(row.status === undefined ? {} : { status: row.status })}
              title={row.title}
              detail={
                row.detail === undefined && row.badges.length === 0 ? undefined : (
                  <span className="flex min-w-0 flex-col gap-1">
                    {row.detail === undefined ? null : <span className="[overflow-wrap:anywhere]">{row.detail}</span>}
                    <SetupBadges badges={row.badges} />
                  </span>
                )
              }
            />
          ))}
        </SetupSection>
        {harnessProblems(scan, harness).map(text => (
          <SetupNote key={text} tone="warn" name="problem">
            <span>{text}</span>
          </SetupNote>
        ))}
        {!offersSignIn(scan, harness) ? null : signingIn ? (
          <FirstRunSignIn
            harness={harness}
            machineName={machineName}
            access={access}
            connection={connection}
            createClient={createClient}
            {...(pollMs === undefined ? {} : { pollMs })}
            onClose={() => setSigningIn(false)}
            onSignedIn={() => {
              setSigningIn(false);
              void read();
            }}
          />
        ) : (
          <SetupNote tone="warn" name="sign-in-now" title={`${name} isn’t signed in`}>
            <span>Sign in now, or import your setup and sign in later.</span>
            <div className="mt-2">
              <Button type="button" size="sm" data-harness-sign-in="" onClick={() => setSigningIn(true)}>
                Sign in now
              </Button>
            </div>
          </SetupNote>
        )}
        {imported === null ? (
          <SetupSection title="Runtime" name="runtime">
            {have.length === 0 ? null : (
              <p className="m-0 text-cell leading-base text-muted" data-harness-has={harness}>
                {listWords(have.map(runtime => runtime.name))} already {have.length === 1 ? 'runs' : 'run'} {name} on{' '}
                {machineName}. Importing again adds only what is new.
              </p>
            )}
            {plan.kind === 'duplicate' ? (
              <label className="flex min-h-control items-center gap-2 text-cell text-fg">
                <input
                  type="checkbox"
                  data-harness-add-another=""
                  checked={answers.addAnother === true}
                  onChange={event => set({ addAnother: event.target.checked })}
                />
                Also add another runtime on the same login and profile
              </label>
            ) : null}
            {makes ? (
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`harness-name-${harness}`} className="text-ui font-semibold text-fg">
                  Runtime name
                </label>
                <input
                  id={`harness-name-${harness}`}
                  className="kt-input font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  data-harness-name={harness}
                  aria-invalid={problem !== null}
                  value={typed}
                  onChange={event => set({ name: event.target.value.trim() })}
                />
                {problem === null ? (
                  <span className="text-meta text-muted">
                    Letters, digits and dashes. It’s what you launch; add more later in Settings › Runtimes.
                  </span>
                ) : (
                  <span className="text-meta text-err" data-harness-name-problem={harness}>
                    {problem.message}{' '}
                    {problem.suggestion === undefined ? null : (
                      <button
                        type="button"
                        className="font-semibold text-accent underline"
                        data-harness-name-suggestion={harness}
                        onClick={() => set({ name: problem.suggestion as string })}
                      >
                        Use {problem.suggestion}
                      </button>
                    )}
                  </span>
                )}
              </div>
            ) : null}
            {scan.updates.length === 0 ? null : (
              <CheckChoices
                legend="What changed since the last import"
                name="updates"
                values={answers.accepted ?? []}
                onToggle={(reference, on) => {
                  const accepted = answers.accepted ?? [];
                  set({
                    accepted: on ? [...accepted, reference] : accepted.filter(candidate => candidate !== reference),
                  });
                }}
                options={scan.updates.map(update => ({
                  id: update.reference,
                  title: `Update ${updateTitle(update.reference)}`,
                  detail: updateDetail(update.sources),
                }))}
              />
            )}
            <ChangeApplyPanel
              machineName={machineName}
              authority={changes.authority}
              busy={changes.busy}
              refusal={changes.refusal}
              submitLabel={importButtonLabel(plan, answers, signedIn)}
              busyLabel="Importing…"
              disabled={problem !== null}
              onSubmit={send}
            />
            <p className="m-0 text-meta leading-base text-muted">
              Importing copies your setup into Ferretry. {name} on {machineName} keeps working as before.
              {harness === 'claude'
                ? ' Ferretry and your own claude share this login: signing out in one signs out both.'
                : ''}
            </p>
          </SetupSection>
        ) : (
          <ImportedNote harness={harness} have={have} notes={imported} machineName={machineName} />
        )}
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body={harness}>
      <SetupRow
        name={`tool-${harness}`}
        status={tool?.installed === true ? 'ready' : 'needs_sign_in'}
        statusLabel={tool?.installed === true ? 'Installed' : 'Not installed'}
        title={name}
        detail={tool?.installed === true ? `Installed on ${machineName}` : `Not installed on ${machineName}`}
      />
      {body}
      {have.length === 0 ? null : <HarnessConversations tab={tab} harness={harness} runtimes={runtimes} />}
      {tool?.installed === true ? (
        <ProviderRuntimeSection tab={tab} harness={harness} onMade={() => void read()} />
      ) : null}
    </div>
  );
}

/** What the import made: the runtimes this CLI has now, and any that need a sign-in before they launch. */
function ImportedNote({
  harness,
  have,
  notes,
  machineName,
}: {
  readonly harness: SetupHarness;
  readonly have: readonly FleetRuntimeView[];
  readonly notes: readonly string[];
  readonly machineName: string;
}) {
  const needsSignIn = have.filter(runtime => runtime.credential.status === 'needs_sign_in');
  return (
    <div className="flex min-w-0 flex-col gap-2" data-harness-imported={harness}>
      <SetupNote
        live
        tone="ok"
        name="import-ready"
        title={
          have.length === 0
            ? 'Imported'
            : `${listWords(have.map(runtime => runtime.name))} ${have.length === 1 ? 'is' : 'are'} ready`
        }
      >
        <span>
          {have.length === 0
            ? `Your ${SETUP_HARNESS_NAMES[harness]} setup is in Ferretry.`
            : `${SETUP_HARNESS_NAMES[harness]} · ${have.map(runtime => `${runtime.profile} profile`).join(', ')}`}
        </span>
      </SetupNote>
      {needsSignIn.length === 0 ? null : (
        <SetupNote tone="warn" name="sign-in-later" title="Sign in before you launch">
          {needsSignIn.map(runtime => (
            <a
              key={runtime.name}
              href={machineItemHash(machineName, 'credentials', runtime.credential.id)}
              className="inline-flex items-center gap-1 font-semibold text-accent underline"
              data-harness-sign-in-later={runtime.credential.id}
            >
              Sign in for {runtime.name}
              <ChevronRight size={14} aria-hidden="true" />
            </a>
          ))}
        </SetupNote>
      )}
      {notes.map(note => (
        <SetupNote key={note} name="import-note">
          <span>{note}</span>
        </SetupNote>
      ))}
    </div>
  );
}

/**
 * The profile a provider login's runtime runs: the one this CLI's runtimes already use, else the first
 * profile on the machine that fits the CLI, else none — then the import above has to make one first.
 */
export const providerProfile = (data: MachineData, harness: SetupHarness): string | undefined =>
  data.runtimes.runtimes.find(runtime => runtime.harness === harness)?.profile ??
  data.profiles.profiles.find(profile => profileFit(profile, harness).fits)?.name;

/** "Use a provider key instead": the provider grid for this CLI, and the runtime its login gets. */
function ProviderRuntimeSection({
  tab,
  harness,
  onMade,
}: {
  readonly tab: MachineTabProps;
  readonly harness: SetupHarness;
  readonly onMade: () => void;
}) {
  const { connection, createClient, machineName } = tab;
  const { data, reload } = useMachineData(connection, createClient);
  const changes = useAccountChanges({ connection, createClient });
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-harness-provider={harness}>
      <div>
        <Button
          type="button"
          variant="ghost"
          className="kt-btn--flush-start"
          data-harness-provider-toggle=""
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={16} aria-hidden="true" className={open ? 'rotate-90' : undefined} />
          Use a provider key instead
        </Button>
        <p className="m-0 text-meta leading-base text-muted">
          GLM, DeepSeek, Kimi, OpenRouter, Bedrock and more: one tap each, and the runtime is made with it.
        </p>
      </div>
      {!open ? null : login === null ? (
        <EnvironmentLogin
          harness={harness}
          machineName={machineName}
          connection={connection}
          createClient={createClient}
          data={data}
          reload={reload}
          changes={changes}
          onSaved={setLogin}
          onAdded={setLogin}
        />
      ) : data === null ? null : (
        <ProviderRuntime
          key={login}
          harness={harness}
          credential={login}
          data={data}
          reload={reload}
          changes={changes}
          machineName={machineName}
          online={tab.online}
          onMade={onMade}
          onAnother={() => setLogin(null)}
        />
      )}
    </div>
  );
}

/** The runtime a provider login gets, named in place: one field and one button. */
function ProviderRuntime({
  harness,
  credential,
  data,
  reload,
  changes,
  machineName,
  online,
  onMade,
  onAnother,
}: {
  readonly harness: SetupHarness;
  readonly credential: string;
  readonly data: MachineData;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  readonly machineName: string;
  readonly online: boolean;
  readonly onMade: () => void;
  readonly onAnother: () => void;
}) {
  const runtimes = data.runtimes.runtimes;
  const profile = providerProfile(data, harness);
  const [name, setName] = useState(() => suggestedRuntimeName(harness, credential, runtimes));
  const [made, setMade] = useState<string | null>(null);
  const problem = runtimeNameProblem(name, runtimes, machineName);

  if (made !== null)
    return (
      <SetupNote live tone="ok" name="provider-runtime-ready" title={`${made} is ready`}>
        <span>
          {SETUP_HARNESS_NAMES[harness]} · {credential} · {profile} profile
        </span>
        <div className="mt-2">
          <Button type="button" size="sm" data-harness-provider-another="" onClick={onAnother}>
            Add another provider
          </Button>
        </div>
      </SetupNote>
    );
  if (profile === undefined)
    return (
      <SetupNote tone="warn" name="provider-no-profile" title={`${credential} is added`}>
        <span>
          Its runtime needs a profile for {SETUP_HARNESS_NAMES[harness]}. Import above first — it makes one — then add
          the runtime in Settings › Runtimes.
        </span>
      </SetupNote>
    );

  const create = async (): Promise<void> => {
    const result = await changes.apply({ kind: 'runtime.put', name, credential, profile, agent: true, create: true });
    if (result.kind === 'refused') return;
    setMade(name);
    await reload();
    onMade();
  };

  return (
    <div className="kt-panel flex min-w-0 flex-col gap-3 p-panel" data-harness-provider-runtime={credential}>
      <p className="m-0 text-row font-semibold text-fg">
        <span className="font-mono">{credential}</span> is added. Name its runtime.
      </p>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`provider-name-${harness}`} className="text-ui font-semibold text-fg">
          Runtime name
        </label>
        <input
          id={`provider-name-${harness}`}
          className="kt-input font-mono"
          autoComplete="off"
          spellCheck={false}
          data-provider-runtime-name=""
          aria-invalid={problem !== null}
          value={name}
          onChange={event => setName(event.target.value.trim())}
        />
        {problem === null ? (
          <span className="text-meta text-muted">Runs the {profile} profile.</span>
        ) : (
          <span className="text-meta text-err" data-provider-runtime-problem="">
            {problem.message}
          </span>
        )}
      </div>
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Creating…"
        refusal={changes.refusal}
        submitLabel={`Create ${name || 'runtime'}`}
        disabled={problem !== null || !online}
        onSubmit={() => void create()}
      />
    </div>
  );
}

/** "Your conversations": once this CLI has a runtime, its earlier conversations can be kept as ferrets. */
function HarnessConversations({
  tab,
  harness,
  runtimes,
}: {
  readonly tab: MachineTabProps;
  readonly harness: SetupHarness;
  readonly runtimes: readonly FleetRuntimeView[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <SetupSection title="Your conversations" name="conversations">
      {open ? (
        <ConversationPicker
          connection={tab.connection}
          createClient={tab.createClient}
          harness={harness}
          runtimes={runtimes}
        />
      ) : (
        <div>
          <Button type="button" data-harness-conversations="" onClick={() => setOpen(true)}>
            Choose conversations to keep…
          </Button>
          <p className="m-0 mt-1 text-meta leading-base text-muted">
            Keep earlier {SETUP_HARNESS_NAMES[harness]} conversations as ferrets that resume where they left off.
          </p>
        </div>
      )}
    </SetupSection>
  );
}
