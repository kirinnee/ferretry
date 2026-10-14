/**
 * The first run, and Import again (docs/design/account-model.md §4.3, E1–E11).
 *
 * **Check tools** → **Claude Code** → **Codex** → **Name runtimes** → **Done**, one decision per page.
 * Import again (Settings → Setup) runs the same flow from the Claude Code step. What the machine has is
 * read from its setup scan — names and sizes, never a value — and every answer becomes ONE reviewed
 * change, `setup.import`, sent from the last step before Done through the shared change helper. Until
 * then nothing is imported, so Back can change any answer.
 *
 * Starting a daemon imports nothing, so this is how a machine gets set up: the app opens it by itself
 * for a machine that is not set up (`first-run-landing.ts`). Each tool's step asks ONE question — "We
 * found Claude Code on <machine>. Use your login and setup?" — answered Import or Skip. A login that is
 * installed but not signed in can be signed in right there ("Sign in now", `first-run-sign-in.tsx`),
 * which returns to the same step. Skipping everything ends on "Nothing is set up on <machine> yet",
 * with Start again and the Runtimes tab, which keeps offering the way back.
 *
 * A machine that is asleep or offline pauses the flow with its progress kept (E11).
 */

import type { FleetRuntimeView, FleetSetupScan } from '@ferretry/protocol';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { readFleetRuntimes } from '../catalog-api.ts';
import { readFleetSetupScan } from '../setup-api.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import {
  currentFlow,
  goToStep,
  type StepperState,
  type StepperStep,
  startStepper,
  stepForward,
  withSteps,
} from '../shell/stepper-model.ts';
import {
  cardMakes,
  cardName,
  createLabel,
  FIRST_RUN_FLOW_KIND,
  type FirstRunAnswers,
  type FirstRunMode,
  firstRunSteps,
  foundRows,
  harnessProblems,
  importChange,
  importLabel,
  importNotes,
  importsAnything,
  includedHarnesses,
  missingTools,
  NO_ANSWERS,
  nameCards,
  nameProblems,
  offersSignIn,
  scanHasHarness,
  sendsImport,
  updateDetail,
  updateTitle,
} from './first-run-model.ts';
import { FirstRunSignIn } from './first-run-sign-in.tsx';
import type { InstallPhase } from './install-model.ts';
import { machineItemHash } from './settings-route.ts';
import { useSetupAccess } from './setup-access.ts';
import { CheckChoices, SetupBadges, SetupNote, SetupRow, SetupSection } from './setup-ui.tsx';
import { countWords, listWords, SETUP_HARNESS_NAMES, type SetupHarness } from './setup-words.ts';
import { ToolInstall } from './tool-install.tsx';

export interface MachineFirstRunProps extends MachineTabProps {
  /** `setup` is the first run; `import` is Import again from Settings (no Check tools step). */
  readonly mode: FirstRunMode;
  /** Go to Runtimes. */
  readonly onDone: () => void;
  /** The person left the flow. */
  readonly onLeave: () => void;
  /** Supplied in tests. */
  /** How often a waiting sign-in is re-read. Supplied in tests. */
  readonly pollMs?: number;
}

interface ImportResult {
  readonly summary: string;
  readonly include: readonly SetupHarness[];
  readonly notes: readonly string[];
  /** The runtimes this import created, as the machine now reports them. */
  readonly runtimes: readonly FleetRuntimeView[];
}

const flowInput = (mode: FirstRunMode, machineName: string, scan: FleetSetupScan | null) => ({
  kind: FIRST_RUN_FLOW_KIND,
  title: mode === 'setup' ? `Set up ${machineName}` : 'Import again',
  steps: firstRunSteps(mode, scan, NO_ANSWERS),
  leave:
    mode === 'setup'
      ? {
          question: 'Leave setup?',
          consequence: 'Nothing is imported until the last step. You can set up later from Settings.',
          stopLabel: 'Leave setup',
        }
      : { question: 'Stop importing?', consequence: 'Nothing is imported.', stopLabel: 'Stop, import nothing' },
  ...(mode === 'import' ? { leaveWithoutConfirm: true } : {}),
});

function Foot({ children }: { readonly children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap gap-2">{children}</div>;
}

function ContinueButton({ onClick, disabled = false }: { readonly onClick: () => void; readonly disabled?: boolean }) {
  return (
    <Button type="button" variant="primary" data-step-next="" disabled={disabled} onClick={onClick}>
      Continue
    </Button>
  );
}

/** The scan is not in hand yet: reading it, or why it could not be read. */
function ScanGate({
  machineName,
  issue,
  onRead,
}: {
  readonly machineName: string;
  readonly issue: string | null;
  readonly onRead: () => void;
}) {
  if (issue !== null)
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <SetupNote live tone="warn" name="scan-failed" title={`Couldn’t look at ${machineName}`}>
          <span>{issue}</span>
        </SetupNote>
        <div>
          <Button type="button" data-scan-retry="" onClick={() => onRead()}>
            Try again
          </Button>
        </div>
      </div>
    );
  return (
    <p role="status" className="m-0 text-cell text-muted" data-first-run-reading="">
      Looking at what’s on {machineName}…
    </p>
  );
}

export function MachineFirstRun(props: MachineFirstRunProps) {
  const { mode, machineName, connection, createClient, online, checking, onRetry, onDone, onLeave, pollMs } = props;
  const access = useSetupAccess({ connection, createClient });
  const { changes } = access;
  const [scan, setScan] = useState<FleetSetupScan | null>(null);
  /** The tool whose own login is being signed in, in place, on its step. */
  const [signingIn, setSigningIn] = useState<SetupHarness | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<FirstRunAnswers>(NO_ANSWERS);
  const [install, setInstall] = useState<InstallPhase>({ kind: 'choose' });
  const [installSkipped, setInstallSkipped] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [stepper, setStepper] = useState<StepperState>(() => startStepper(flowInput(mode, machineName, null)));

  const latest = useRef(access);
  latest.current = access;
  const read = useCallback(async (): Promise<void> => {
    setIssue(null);
    const scanned = await latest.current.read(client => readFleetSetupScan(client));
    if (scanned.kind === 'refused') {
      setIssue(scanned.sentence);
      return;
    }
    setScan(scanned.value);
    const runtimes = await latest.current.read(client => readFleetRuntimes(client));
    if (runtimes.kind === 'done') setTaken(new Set(runtimes.value.runtimes.map(runtime => runtime.name)));
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void read();
  }, [read]);

  const steps = firstRunSteps(mode, scan, answers);
  const state = withSteps(stepper, steps);
  const at = currentFlow(state).at;
  const next = (): void => setStepper(stepForward(state));
  const answer = (patch: Partial<FirstRunAnswers>): void => setAnswers(current => ({ ...current, ...patch }));
  const choose = (harness: SetupHarness, choice: 'import' | 'skip'): void =>
    setAnswers(current => ({ ...current, choices: { ...current.choices, [harness]: choice } }));

  const send = (): void => {
    if (scan === null) return;
    const change = importChange(scan, answers);
    const include = includedHarnesses(scan, answers);
    const names = nameCards(scan, answers)
      .filter(card => cardMakes(card, answers))
      .map(card => cardName(card, answers));
    void changes.apply(change).then(async applied => {
      if (applied.kind === 'refused') return;
      const summary = applied.outcome.outcome === 'executed' ? applied.outcome.summary : applied.staged.summary;
      const after = await access.read(client => readFleetRuntimes(client));
      setResult({
        summary,
        include,
        notes: importNotes(scan, include),
        runtimes: after.kind === 'done' ? after.value.runtimes.filter(runtime => names.includes(runtime.name)) : [],
      });
      setStepper(current => stepForward(withSteps(current, steps)));
      onRetry();
    });
  };

  const sendPanel = (label: string, disabled = false) => (
    <div className="mt-4">
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={label}
        busyLabel="Importing…"
        disabled={disabled}
        onSubmit={send}
      />
    </div>
  );

  const wouldSend = scan !== null && importsAnything(scan, answers);
  const sending = sendsImport(steps, at, wouldSend);

  const body = (): ReactNode => {
    if (at === 'done')
      return (
        <DoneStep
          result={result}
          mode={mode}
          machineName={machineName}
          onDone={onDone}
          onStartAgain={() => setStepper(goToStep(state, (steps[0] as StepperStep).id))}
        />
      );
    if (scan === null) return <ScanGate machineName={machineName} issue={issue} onRead={() => void read()} />;

    if (at === 'tools') {
      const missing = missingTools(scan.tools);
      const canGo = missing.length === 0 || installSkipped || install.kind === 'done';
      return (
        <div className="flex min-w-0 flex-col gap-3" data-first-run-step="tools">
          <p className="m-0 text-cell leading-base text-fg">
            Ferretry runs Claude Code and Codex on {machineName}. First it checks they’re installed.
          </p>
          <div className="flex min-w-0 flex-col gap-2">
            {scan.tools.map(tool => (
              <SetupRow
                key={tool.harness}
                name={`tool-${tool.harness}`}
                status={tool.installed ? 'ready' : 'needs_sign_in'}
                statusLabel={tool.installed ? 'Installed' : 'Not installed'}
                title={tool.label}
                detail={tool.installed ? 'Installed' : 'Not installed'}
              />
            ))}
          </div>
          {missing.length === 0 ? null : installSkipped ? (
            <p className="m-0 text-cell text-muted" data-install-skipped="">
              Skipped. You can install {listWords(missing.map(tool => tool.label))} later in Settings.
            </p>
          ) : (
            <SetupSection title="Install what’s missing" name="install">
              <ToolInstall
                machineName={machineName}
                tools={missing}
                access={access}
                phase={install}
                onPhase={setInstall}
                onInstalled={() => void read()}
                onSkip={() => setInstallSkipped(true)}
                doneHint="Next, Ferretry looks for your existing setup."
              />
            </SetupSection>
          )}
          <Foot>
            {missing.length > 0 && !installSkipped && install.kind === 'choose' ? (
              <Button type="button" data-install-skip="" onClick={() => setInstallSkipped(true)}>
                Skip, continue without them
              </Button>
            ) : null}
            <ContinueButton onClick={next} disabled={!canGo || install.kind === 'running'} />
          </Foot>
        </div>
      );
    }

    if (at === 'claude' || at === 'codex') return harnessStep(at);

    if (at === 'updates')
      return (
        <div className="flex min-w-0 flex-col gap-3" data-first-run-step="updates">
          <p className="m-0 text-cell leading-base text-fg">
            Some of your setup on {machineName} changed since the last import. Pick what to update. Nothing is updated
            unless you tick it.
          </p>
          <CheckChoices
            legend="What to update"
            legendHidden
            name="updates"
            values={answers.accepted}
            onToggle={(reference, on) =>
              answer({
                accepted: on
                  ? [...answers.accepted, reference]
                  : answers.accepted.filter(candidate => candidate !== reference),
              })
            }
            options={scan.updates.map(update => ({
              id: update.reference,
              title: `Update ${updateTitle(update.reference)}`,
              detail: updateDetail(update.sources),
            }))}
          />
          {sending ? (
            sendPanel('Import the updates')
          ) : (
            <Foot>
              <ContinueButton onClick={next} />
            </Foot>
          )}
        </div>
      );

    // names
    const cards = nameCards(scan, answers);
    const problems = nameProblems(cards, answers, taken, machineName);
    return (
      <div className="flex min-w-0 flex-col gap-3" data-first-run-step="names">
        <p className="m-0 text-cell leading-base text-fg">
          A runtime is a login plus a profile. It’s what you launch. Name each one.
        </p>
        {cards.map(card => {
          const makes = cardMakes(card, answers);
          const problem = problems[card.harness];
          const fieldId = `first-run-name-${card.harness}`;
          return (
            <div
              key={card.harness}
              className="kt-panel flex min-w-0 flex-col gap-3 p-panel"
              data-name-card={card.harness}
            >
              <p className="m-0 text-row font-semibold text-fg">{SETUP_HARNESS_NAMES[card.harness]}</p>
              {card.duplicate === undefined ? null : (
                <>
                  <p className="m-0 text-cell text-warn" data-name-duplicate="">
                    <span className="font-mono">{card.duplicate}</span> already uses this login and profile.
                  </p>
                  <label className="flex min-h-control items-center gap-2 text-cell text-fg">
                    <input
                      type="checkbox"
                      data-name-add-another=""
                      checked={makes}
                      onChange={event => answer({ make: { ...answers.make, [card.harness]: event.target.checked } })}
                    />
                    Add another anyway
                  </label>
                </>
              )}
              {makes ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={fieldId} className="text-ui font-semibold text-fg">
                    Runtime name
                  </label>
                  <input
                    id={fieldId}
                    className="kt-input font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    data-name-input={card.harness}
                    aria-invalid={problem !== undefined}
                    value={cardName(card, answers)}
                    onChange={event =>
                      answer({ names: { ...answers.names, [card.harness]: event.target.value.trim() } })
                    }
                  />
                  {problem === undefined ? (
                    <span className="text-meta text-muted">Letters, digits and dashes.</span>
                  ) : (
                    <span className="text-meta text-err" data-name-problem={card.harness}>
                      {problem.message}{' '}
                      {problem.suggestion === undefined ? null : (
                        <button
                          type="button"
                          className="font-semibold text-accent underline"
                          data-name-suggestion={card.harness}
                          onClick={() =>
                            answer({ names: { ...answers.names, [card.harness]: problem.suggestion as string } })
                          }
                        >
                          Use {problem.suggestion}
                        </button>
                      )}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {sendPanel(createLabel(cards, answers), Object.keys(problems).length > 0)}
      </div>
    );
  };

  function harnessStep(harness: SetupHarness): ReactNode {
    const current = scan as FleetSetupScan;
    const name = SETUP_HARNESS_NAMES[harness];
    if (!scanHasHarness(current, harness))
      return (
        <div className="flex min-w-0 flex-col gap-3" data-first-run-step={harness}>
          <SetupNote name="not-installed">
            <span>
              {name} isn’t installed on {machineName}. You can install it later in Settings.
            </span>
          </SetupNote>
          <Foot>
            <ContinueButton onClick={next} />
          </Foot>
        </div>
      );
    const claudeImported = answers.choices.claude === 'import' && scanHasHarness(current, 'claude');
    const problems = harnessProblems(current, harness);
    const canSignIn = offersSignIn(current, harness);
    return (
      <div className="flex min-w-0 flex-col gap-3" data-first-run-step={harness}>
        <p className="m-0 text-row font-semibold leading-base text-fg" data-first-run-question="">
          We found {name} on {machineName}. Use your login and setup?
        </p>
        <SetupSection title={`Found on ${machineName}`} name="found">
          {foundRows(current, harness, claudeImported).map(row => (
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
        {problems.map(problem => (
          <SetupNote key={problem} tone="warn" name="problem">
            <span>{problem}</span>
          </SetupNote>
        ))}
        {!canSignIn ? null : signingIn === harness ? (
          <FirstRunSignIn
            harness={harness}
            machineName={machineName}
            access={access}
            connection={connection}
            createClient={createClient}
            {...(pollMs === undefined ? {} : { pollMs })}
            onClose={() => setSigningIn(null)}
            onSignedIn={() => {
              setSigningIn(null);
              void read();
            }}
          />
        ) : (
          <SetupNote tone="warn" name="sign-in-now" title={`${name} isn’t signed in`}>
            <span>Sign in now, or import your setup and sign in later.</span>
            <div className="mt-2">
              <Button type="button" size="sm" data-harness-sign-in="" onClick={() => setSigningIn(harness)}>
                Sign in now
              </Button>
            </div>
          </SetupNote>
        )}
        <p className="m-0 text-meta leading-base text-muted">
          Importing copies your setup into Ferretry. {name} on {machineName} keeps working as before.
          {harness === 'claude'
            ? ' Ferretry and your own claude share this login: signing out in one signs out both.'
            : ''}
        </p>
        {signingIn === harness ? null : (
          <Foot>
            <Button
              type="button"
              data-harness-skip=""
              onClick={() => {
                choose(harness, 'skip');
                next();
              }}
            >
              Skip
            </Button>
            <Button
              type="button"
              variant="primary"
              data-harness-import=""
              onClick={() => {
                choose(harness, 'import');
                next();
              }}
            >
              {importLabel(current, harness)}
            </Button>
          </Foot>
        )}
      </div>
    );
  }

  return (
    <MachineStepper
      state={state}
      onChange={nextState => (nextState === null ? onLeave() : setStepper(nextState))}
      machineName={machineName}
      online={online}
      checking={checking}
      onRetry={onRetry}
    >
      {body()}
    </MachineStepper>
  );
}

function DoneStep({
  result,
  mode,
  machineName,
  onDone,
  onStartAgain,
}: {
  readonly result: ImportResult | null;
  readonly mode: FirstRunMode;
  readonly machineName: string;
  readonly onDone: () => void;
  /** Back to the first question, every answer kept. */
  readonly onStartAgain: () => void;
}) {
  const goToRuntimes = (
    <Foot>
      <Button type="button" variant="primary" data-first-run-finish="" onClick={onDone}>
        Go to Runtimes
      </Button>
    </Foot>
  );
  if (result === null)
    return (
      <div className="flex min-w-0 flex-col gap-2" data-first-run-step="done" data-first-run-result="nothing">
        <p className="m-0 text-row font-semibold text-fg">
          {mode === 'setup' ? `Nothing is set up on ${machineName} yet` : 'Nothing was imported'}
        </p>
        <p className="m-0 text-cell leading-base text-muted">
          {mode === 'setup'
            ? `That’s fine. Ferretry can’t start a session on ${machineName} until it has a runtime. Set it up any time from Settings, or add a runtime yourself.`
            : 'That’s fine. Your runtimes are unchanged.'}
        </p>
        <Foot>
          <Button type="button" data-first-run-start-again="" onClick={onStartAgain}>
            ‹ Start again
          </Button>
          <Button type="button" variant="primary" data-first-run-finish="" onClick={onDone}>
            Go to Runtimes
          </Button>
        </Foot>
      </div>
    );
  const needsSignIn = result.runtimes.filter(runtime => runtime.credential.status === 'needs_sign_in');
  return (
    <div className="flex min-w-0 flex-col gap-3" data-first-run-step="done" data-first-run-result="imported">
      {result.runtimes.length === 0 ? (
        <SetupNote live tone="ok" name="import-finished" title="Import finished">
          <span>No new runtimes were added. Your existing runtimes are unchanged.</span>
        </SetupNote>
      ) : (
        <SetupNote live tone="ok" name="import-ready" title={`${machineName} is ready`}>
          <span>{countWords(result.runtimes.length, 'runtime')} created.</span>
        </SetupNote>
      )}
      {result.runtimes.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-2">
          {result.runtimes.map(runtime => (
            <SetupRow
              key={runtime.name}
              name={`runtime-${runtime.name}`}
              status={runtime.credential.status ?? 'checking'}
              title={<span className="font-mono">{runtime.name}</span>}
              detail={[
                SETUP_HARNESS_NAMES[runtime.harness],
                `${runtime.profile} profile`,
                ...(runtime.modelSet.source === 'model-set' && runtime.modelSet.default !== undefined
                  ? [runtime.modelSet.default]
                  : []),
              ].join(' · ')}
            />
          ))}
        </div>
      )}
      {needsSignIn.length === 0 ? null : (
        <SetupNote tone="warn" name="sign-in-later" title="Sign in before you launch">
          <span>
            {listWords(needsSignIn.map(runtime => runtime.name))}{' '}
            {needsSignIn.length === 1 ? 'uses a login' : 'use logins'} that needs sign-in.
          </span>
          {needsSignIn.map(runtime => (
            <a
              key={runtime.name}
              href={machineItemHash(machineName, 'credentials', runtime.credential.id)}
              className="inline-flex items-center gap-1 font-semibold text-accent underline"
              data-first-run-sign-in={runtime.credential.id}
            >
              Sign in for {runtime.name}
              <ChevronRight size={14} aria-hidden="true" />
            </a>
          ))}
        </SetupNote>
      )}
      {result.notes.map(note => (
        <SetupNote key={note} name="import-note">
          <span>{note}</span>
        </SetupNote>
      ))}
      {goToRuntimes}
    </div>
  );
}
