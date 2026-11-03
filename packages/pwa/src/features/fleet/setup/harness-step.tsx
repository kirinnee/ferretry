/**
 * New machine setup's **Claude Code** and **Codex** steps (the flat-onboarding proposal; docs/design/
 * account-model.md §4.3, E1–E11). ONE ACTION per page: the footer's primary IS this step's action —
 * `Import`, `Install <CLI>` when the CLI is missing, `Continue` when it is already imported — and a good
 * import moves on by itself. The body shows, top to bottom:
 *
 * 1. **What was found** — ticked lines, with the full list behind Details. A login that is not signed in
 *    says so in one line and offers `Sign in first` (`first-run-sign-in.tsx`); it never blocks the import.
 * 2. **Also bring my conversations** — a tick before Import; they follow the runtime, from the last 7 days.
 * 3. **Runtime name** — shown as text with Change; the daemon's suggestion (`claude-default`) unless typed.
 * 4. **What changed** — Import again only: updates offered, none ticked (O6).
 * 5. **Use a provider key instead** — the provider grid (`environment-login.tsx`) for this CLI; the login
 *    it adds gets its runtime right there, on the profile this CLI's import made.
 *
 * The import is ONE reviewed change, `setup.import` for this CLI alone, so its authority sentences (the
 * passkey line, a refusal) stay in the body even though its button is in the footer. The page only moves
 * on when the daemon did not refuse. More runtimes are Settings › Runtimes › Add runtime. A machine that
 * is asleep or offline shows a one-line pause instead of anything that would send.
 */

import type { FleetRuntimeView, FleetSetupScan } from '@ferretry/protocol';
import { adoptionBatches, conversationsToImport } from '@ferretry/protocol';
import { Check, ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { Button } from '../../../shell/primitives.tsx';
import { readFleetRuntimes } from '../catalog-api.ts';
import { adoptConversations, readImportableConversations } from '../conversations/conversations-api.ts';
import { EnvironmentLogin } from '../credentials/environment-login.tsx';
import type { MachineData } from '../runtimes/machine-data.ts';
import { useMachineData } from '../runtimes/machine-data.ts';
import { profileFit, runtimeNameProblem, suggestedRuntimeName } from '../runtimes/runtimes-model.ts';
import { readFleetSetupScan } from '../setup-api.ts';
import { type AccountChanges, ChangeApplyPanel, changeReady, useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { FirstRunSignIn } from './first-run-sign-in.tsx';
import { PrimaryAction, useQuietFooter } from './footer-slot.tsx';
import {
  changeList,
  changeSummary,
  foundLines,
  foundRows,
  type HarnessAnswers,
  harnessImportChange,
  harnessProblems,
  type ImportCounts,
  importCounts,
  importNotes,
  importSummary,
  makesRuntime,
  missingTools,
  offersSignIn,
  runtimeName,
  runtimePlan,
  scanHasHarness,
} from './harness-import-model.ts';
import type { InstallPhase } from './install-model.ts';
import { machineItemHash } from './settings-route.ts';
import { type SetupAccess, useSetupAccess } from './setup-access.ts';
import { SetupBadges, SetupDisclosure, SetupNote, SetupRow } from './setup-ui.tsx';
import { countWords, listWords, SETUP_HARNESS_NAMES, type SetupHarness } from './setup-words.ts';
import { ToolInstall } from './tool-install.tsx';

/** How far back "Also bring my conversations" reaches. */
const CONVERSATION_DAYS = 7;

/** What a finished CLI page tells the next one and Done: what it brought in. */
export interface HarnessReport {
  readonly harness: SetupHarness;
  /** The runtime the import made, when it made one. */
  readonly runtime: string | null;
  /** "Imported 1 login, 3 skills, 3 MCP servers". */
  readonly summary: string;
  /** What the conversations import said, when it was asked for. */
  readonly conversations: string | null;
  /** The runtimes that still need a sign-in, each with the sign-in to open. */
  readonly signIn: readonly { readonly runtime: string; readonly credential: string }[];
}

export interface OnboardingHarnessStepProps {
  readonly tab: MachineTabProps;
  readonly harness: SetupHarness;
  /** What was answered here, kept with the rail's progress. */
  readonly answers: HarnessAnswers;
  readonly onAnswers: (answers: HarnessAnswers) => void;
  /** This CLI has a runtime on the machine: the step is set. */
  readonly onReady: () => void;
  /**
   * The step's action is done and the page moves on: an import the daemon did not refuse (with what it
   * brought in), or `Continue` on a CLI that is already imported (`null`). `stillHere` is false when the
   * person left this page while the import ran: the result is kept, and the page they chose stays open.
   */
  readonly onFinished: (report: HarnessReport | null, stillHere: boolean) => void;
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
  onFinished,
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
  const [renaming, setRenaming] = useState(false);
  const [sending, setSending] = useState(false);
  /** The import this visit sent, and the notes it left: shown in place of the form. */
  const [imported, setImported] = useState<ImportedResult | null>(null);
  const name = SETUP_HARNESS_NAMES[harness];

  const latest = useRef({ access, onReady });
  latest.current = { access, onReady };
  // One mount is one visit: leaving the page (Skip, Back, the rail) ends it, even if an import is still running.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
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

  const have = runtimesOf(runtimes, harness);
  const plan = runtimePlan(scan, harness);
  const makes = makesRuntime(plan, answers);
  const typed = runtimeName(plan, answers);
  const problem = makes ? runtimeNameProblem(typed, runtimes, machineName) : null;
  const set = (patch: Partial<HarnessAnswers>): void => onAnswers({ ...answers, ...patch });
  const installed = scanHasHarness(scan, harness);
  /** A first import, or an import again the person asked for: otherwise this page has nothing to send. */
  const willImport =
    imported === null &&
    (have.length === 0 ||
      (answers.accepted?.length ?? 0) > 0 ||
      answers.addAnother === true ||
      answers.conversations === true);

  const send = (): void => {
    if (sending) return;
    setSending(true);
    void (async () => {
      try {
        const applied = await changes.apply(harnessImportChange(harness, plan, answers));
        if (applied.kind === 'refused') return;
        const listed = await access.read(client => readFleetRuntimes(client));
        const now = listed.kind === 'done' ? runtimesOf(listed.value.runtimes, harness) : [];
        const kept = answers.conversations === true ? await bringConversations(access, harness, now, typed) : null;
        const counts = importCounts(scan, harness, kept?.adopted ?? 0);
        setImported({ notes: importNotes(scan, [harness]), counts });
        onAnswers({});
        await read();
        onFinished(
          {
            harness,
            runtime: makes ? typed : null,
            summary: importSummary(counts),
            conversations: kept === null ? null : kept.sentence,
            signIn: now
              .filter(runtime => runtime.credential.status === 'needs_sign_in')
              .map(runtime => ({ runtime: runtime.name, credential: runtime.credential.id })),
          },
          here.current,
        );
      } finally {
        setSending(false);
      }
    })();
  };

  let body: ReactNode;
  let primary: ReactNode = null;
  if (!installed) {
    const missing = missingTools(scan.tools.filter(candidate => candidate.harness === harness));
    body =
      missing.length > 0 ? (
        <>
          <p className="m-0 text-cell leading-base text-muted">
            Ferretry can install {name} on {machineName} for you, then bring in its setup. Skip if you don’t use it.
          </p>
          <ToolInstall
            machineName={machineName}
            tools={missing}
            access={access}
            phase={install}
            onPhase={setInstall}
            onInstalled={() => void read()}
            doneHint={`Next, Ferretry looks for your ${name} setup.`}
            inFooter
          />
        </>
      ) : (
        <SetupNote name="not-installed">
          <span>
            {name} isn’t installed on {machineName}. Skip this step and install it later in Settings › Machine.
          </span>
        </SetupNote>
      );
  } else {
    const claudeImported = runtimesOf(runtimes, 'claude').length > 0;
    const rows = foundRows(scan, harness, claudeImported);
    const lines = foundLines(rows);
    const canSignIn = offersSignIn(scan, harness);
    const naming = makes && (renaming || problem !== null);
    const ready = changeReady(changes.authority, problem !== null, changes.busy || sending);
    primary = signingIn ? null : willImport ? (
      <PrimaryAction
        label={changes.busy || sending ? 'Importing…' : 'Import'}
        disabled={!ready}
        onClick={send}
        name="import"
      />
    ) : (
      <PrimaryAction label="Continue" onClick={() => onFinished(null, true)} name="continue" />
    );
    body = (
      <>
        {imported !== null ? null : (
          <p className="m-0 text-cell leading-base text-muted">
            Copies your {name} setup into Ferretry. {name} on {machineName} keeps working as before.
            {harness === 'claude'
              ? ' Ferretry and your own claude share this login: signing out in one signs out both.'
              : ''}
          </p>
        )}
        {signingIn ? (
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
          <div className="kt-panel flex min-w-0 flex-col gap-2 p-panel" data-setup-section="found">
            <h4 className="sr-only">Found on {machineName}</h4>
            {lines.map(line => (
              <span
                key={line.text}
                className="flex min-w-0 items-start gap-2 text-cell text-fg"
                data-found-line={line.ok ? 'ok' : 'attention'}
              >
                <span aria-hidden="true" className={cn('shrink-0 pt-0.5', line.ok ? 'text-ok' : 'text-warn')}>
                  {line.ok ? <Check size={14} /> : '!'}
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{line.text}</span>
              </span>
            ))}
            {!canSignIn ? null : (
              <div>
                <button
                  type="button"
                  className="font-semibold text-accent underline"
                  data-harness-sign-in=""
                  onClick={() => setSigningIn(true)}
                >
                  Sign in first
                </button>
              </div>
            )}
            <SetupDisclosure label="Details" name="found-details">
              {rows.map(row => (
                <SetupRow
                  key={row.key}
                  name={row.key}
                  label={row.label}
                  {...(row.status === undefined ? {} : { status: row.status })}
                  title={row.title}
                  detail={
                    row.detail === undefined && row.badges.length === 0 ? undefined : (
                      <span className="flex min-w-0 flex-col gap-1">
                        {row.detail === undefined ? null : (
                          <span className="[overflow-wrap:anywhere]">{row.detail}</span>
                        )}
                        <SetupBadges badges={row.badges} />
                      </span>
                    )
                  }
                />
              ))}
            </SetupDisclosure>
          </div>
        )}
        {harnessProblems(scan, harness).map(text => (
          <SetupNote key={text} tone="warn" name="problem">
            <span>{text}</span>
          </SetupNote>
        ))}
        {imported === null ? (
          <div className="flex min-w-0 flex-col gap-3" data-setup-section="runtime">
            {have.length === 0 ? null : (
              <p className="m-0 text-cell leading-base text-muted" data-harness-has={harness}>
                {listWords(have.map(runtime => runtime.name))} already {have.length === 1 ? 'runs' : 'run'} {name} on{' '}
                {machineName}. Importing again adds only what is new.
              </p>
            )}
            <label className="flex min-h-control items-center gap-2 text-cell text-fg">
              <input
                type="checkbox"
                data-harness-conversations=""
                checked={answers.conversations === true}
                onChange={event => set({ conversations: event.target.checked })}
              />
              Also bring my conversations from the last {CONVERSATION_DAYS} days
            </label>
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
            {makes && !naming ? (
              <p className="m-0 text-meta text-muted" data-harness-runtime-line="">
                Runtime name: <span className="font-mono text-fg">{typed}</span>{' '}
                <button
                  type="button"
                  className="font-semibold text-accent underline"
                  data-harness-name-change=""
                  onClick={() => setRenaming(true)}
                >
                  Change
                </button>
              </p>
            ) : null}
            {makes && naming ? (
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
              <ChangedSince
                updates={scan.updates}
                accepted={answers.accepted ?? []}
                onAccept={on => set({ accepted: on ? scan.updates.map(update => update.reference) : [] })}
              />
            )}
            <ChangeApplyPanel
              machineName={machineName}
              authority={changes.authority}
              busy={changes.busy}
              refusal={changes.refusal}
              submitLabel="Import"
              disabled={problem !== null}
              hideSubmit
              onSubmit={send}
            />
          </div>
        ) : (
          <ImportedNote harness={harness} have={have} result={imported} machineName={machineName} />
        )}
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body={harness}>
      {body}
      {primary}
      {installed ? <ProviderRuntimeSection tab={tab} harness={harness} onMade={() => void read()} /> : null}
    </div>
  );
}

/** What bringing the conversations in did, for the report. */
interface ConversationsOutcome {
  readonly adopted: number;
  readonly sentence: string;
}

/**
 * Bring the last {@link CONVERSATION_DAYS} days of this CLI's conversations into the runtime just made,
 * through the same adopt route "Import conversations" always used: stopped, linked, never copied. It
 * says what happened in a sentence and never throws: the runtime import is already done by now.
 */
async function bringConversations(
  access: SetupAccess,
  harness: SetupHarness,
  mine: readonly FleetRuntimeView[],
  runtimeNamed: string,
): Promise<ConversationsOutcome> {
  const name = SETUP_HARNESS_NAMES[harness];
  const target = mine.find(runtime => runtime.name === runtimeNamed) ?? mine[0];
  if (target === undefined)
    return { adopted: 0, sentence: `Couldn’t bring in your ${name} conversations: no runtime to put them in.` };
  const found = await access.read(client => readImportableConversations(client, { harness, limit: 5_000 }));
  if (found.kind === 'refused')
    return { adopted: 0, sentence: `Couldn’t bring in your ${name} conversations: ${found.sentence}` };
  const ids = conversationsToImport(found.value.conversations, CONVERSATION_DAYS, Date.now());
  if (ids.length === 0)
    return { adopted: 0, sentence: `No ${name} conversations from the last ${CONVERSATION_DAYS} days.` };
  let adopted = 0;
  let refused = 0;
  for (const batch of adoptionBatches(ids)) {
    const answer = await access.act(client =>
      adoptConversations(client, {
        harness,
        runtime: target.wrapper,
        conversations: batch.map(id => ({ id, start: false })),
      }),
    );
    if (answer.kind === 'refused')
      return { adopted, sentence: `Brought in ${countWords(adopted, 'conversation')}, then: ${answer.sentence}` };
    adopted += answer.value.adopted.length;
    refused += answer.value.refused.length;
  }
  return {
    adopted,
    sentence: `Brought in ${countWords(adopted, 'conversation')}${refused === 0 ? '' : `; ${countWords(refused, 'conversation')} couldn’t be imported`}.`,
  };
}

/** What this visit's import brought in, for the one-line result. */
interface ImportedResult {
  readonly notes: readonly string[];
  readonly counts: ImportCounts;
}

/** "What changed since the last import": one line, one tick to take it, and the names behind a disclosure. */
function ChangedSince({
  updates,
  accepted,
  onAccept,
}: {
  readonly updates: FleetSetupScan['updates'];
  readonly accepted: readonly string[];
  readonly onAccept: (on: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-harness-changed="">
      <p className="m-0 text-cell text-fg" data-harness-changed-summary="">
        {changeSummary(updates)} since the last import.
      </p>
      <label className="flex min-h-control items-center gap-2 text-cell text-fg">
        <input
          type="checkbox"
          data-harness-update-all=""
          checked={accepted.length > 0}
          onChange={event => onAccept(event.target.checked)}
        />
        Update {updates.length === 1 ? 'it' : 'them'} too
      </label>
      <SetupDisclosure label="Show list" name="changed-list">
        {changeList(updates).map(line => (
          <p key={line.kind} className="m-0 [overflow-wrap:anywhere]" data-harness-changed-line={line.kind}>
            <span className="font-semibold text-fg">{line.kind}:</span> {line.names}
          </p>
        ))}
      </SetupDisclosure>
    </div>
  );
}

/** What the import made, in ONE line; the runtimes and notes sit behind Details, a needed sign-in stays up front. */
function ImportedNote({
  harness,
  have,
  result,
  machineName,
}: {
  readonly harness: SetupHarness;
  readonly have: readonly FleetRuntimeView[];
  readonly result: ImportedResult;
  readonly machineName: string;
}) {
  const needsSignIn = have.filter(runtime => runtime.credential.status === 'needs_sign_in');
  const ready =
    have.length === 0
      ? [`Your ${SETUP_HARNESS_NAMES[harness]} setup is in Ferretry.`]
      : [
          `${listWords(have.map(runtime => runtime.name))} ${have.length === 1 ? 'is' : 'are'} ready`,
          `${SETUP_HARNESS_NAMES[harness]} · ${have.map(runtime => `${runtime.profile} profile`).join(', ')}`,
        ];
  return (
    <div className="flex min-w-0 flex-col gap-2" data-harness-imported={harness}>
      <SetupNote live tone="ok" name="import-ready" title={importSummary(result.counts)}>
        <SetupDisclosure label="Details" name="import-details">
          {ready.map(line => (
            <p key={line} className="m-0">
              {line}
            </p>
          ))}
          {result.notes.map(note => (
            <p key={note} className="m-0" data-setup-note="import-note">
              {note}
            </p>
          ))}
        </SetupDisclosure>
      </SetupNote>
      {needsSignIn.length === 0 ? null : (
        <SetupNote tone="warn" name="sign-in-later" title="Sign in before you launch">
          {needsSignIn.map(runtime => (
            <a
              key={runtime.name}
              href={machineItemHash(machineName, 'sign-ins', runtime.credential.id)}
              className="inline-flex items-center gap-1 font-semibold text-accent underline"
              data-harness-sign-in-later={runtime.credential.id}
            >
              Sign in for {runtime.name}
              <ChevronRight size={14} aria-hidden="true" />
            </a>
          ))}
        </SetupNote>
      )}
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
  useQuietFooter(made === null && profile !== undefined);

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
