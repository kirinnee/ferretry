/**
 * Copy settings from another machine — Clone v2 (docs/design/account-model.md §4.7, E27–E31; spec R6).
 *
 * **Source** → **Preview** → **Existing setup** (only when this machine already has profiles or
 * runtimes AND they are being copied) → **Done**. The browser holds both connections, so no machine
 * talks to another: it reads the source through the source's own connection and writes here through
 * this one.
 *
 * WHAT IS COPIED IS CHOSEN, item by item (`clone-settings-model.ts`):
 *
 * - **Profiles, components, runtimes and logins** — the source's export, handed to this machine as ONE
 *   reviewed change, `clone.import`. The Preview lists everything it would RUN here — each MCP
 *   server's command line, each hook, each runnable setting and document — with a box to leave any of
 *   them out, and the change names the source by the daemon id this browser paired with.
 * - **Warden**, **Learning defaults**, **Voice clean-up** — the source's `warden.yaml`, `learning.yaml`
 *   and `voice.yaml`, written here as files. The daemon validates each one, and HOLDS a file that
 *   loosens spend or authority until the owner confirms it; Done offers Confirm on those.
 * - **Agent controls and default runtime** — the source's machine settings, as one reviewed change.
 *
 * API-KEY LOGINS COPY WITH THEIR KEYS; SIGN-INS DO NOT (owner decision 2026-10-20, docs/secrets.md). The
 * Preview splits the logins: an environment login travels as variables and secret NAMES, and the keys the
 * copied setup needs follow in ONE sealed copy the source confirms with a passkey, so the cloned runtime
 * works on arrival. A Claude Code or Codex sign-in is marked "Sign in on <machine>" and arrives as an empty
 * slot; Done offers a Sign in button for each, and **Sign in once for n runtimes** on the busiest (E31).
 * The Preview still lists every secret and sign-in the copied settings need, with a field to add a secret
 * now, and **Copy secrets from <source>…** for anything else, picked by name.
 */

import type { CloneRunnable, FleetCloneBundle, FleetCredentialView, SpeedupsView } from '@ferretry/protocol';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import {
  configInvalidBody,
  confirmConfigChange,
  readConfigFile,
  writeConfigFile,
} from '../../config-files/config-files-api.ts';
import { copySecrets as sealSecretsAcross } from '../../secrets/secret-clone-api.ts';
import { copyRefusalSentence } from '../../secrets/secret-clone-model.ts';
import { SecretCopyLauncher } from '../../secrets/secret-copy-panel.tsx';
import { listSecrets, putSecret } from '../../secrets/secrets-api.ts';
import { daemonDisplayName } from '../../settings/daemon-settings.tsx';
import { readSpeedups } from '../../speedups/speedups-api.ts';
import { readFleetMachine, readFleetProfiles } from '../catalog-api.ts';
import { readFleetCredentials } from '../credentials-api.ts';
import { readFleetExport } from '../setup-api.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { type MachineReach, readMachineReach } from '../shell/machine-reach.ts';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { currentFlow, type StepperState, startStepper, stepForward, withSteps } from '../shell/stepper-model.ts';
import {
  CLONE_FLOW_KIND,
  type CloneMode,
  type ClonePreview,
  clonePreview,
  cloneSharesSentence,
  cloneSlots,
  cloneSourceState,
  cloneSteps,
  copiesRows,
  documentSize,
  CLONE_NO_DEFAULT,
  cloneDefaultView,
  existingSentence,
  runnableTitle,
} from './clone-model.ts';
import {
  CloneItemsChoices,
  DefaultRuntimeChoice,
  CloneLoginsSection,
  CloneNeedsList,
  CloneOutcomes,
} from './clone-settings.tsx';
import {
  ALL_CLONE_ITEMS,
  CLONE_ITEMS,
  CLONE_KEYS_ITEM,
  CLONE_SETTINGS_FILES,
  type CloneItem,
  type CloneItemId,
  type CloneItemOutcome,
  type CloneNeed,
  type CloneOutcomeItem,
  cloneLogins,
  cloneNeeds,
  controlsChange,
  keysToCopy,
  type SourceSettingsFile,
  sourceItemSummary,
} from './clone-settings-model.ts';
import { machineItemHash } from './settings-route.ts';
import { useSetupAccess } from './setup-access.ts';
import { RadioChoices, SetupCommand, SetupNote, SetupRow, SetupSection } from './setup-ui.tsx';
import { countWords, listWords, SETUP_HARNESS_NAMES } from './setup-words.ts';

export interface CloneMachineProps extends MachineTabProps {
  /** Every OTHER machine this browser has paired. */
  readonly sources: readonly DaemonConnectionRecord[];
  readonly onDone: () => void;
  readonly onLeave: () => void;
  /** What Done's main button says; Settings goes to Runtimes, New machine setup continues. */
  readonly doneLabel?: string;
  /** Told the source's name once the copy has run, so a caller can say where the settings came from. */
  readonly onCopied?: (source: string) => void;
  /** `embedded` inside New machine setup's Start from step: no stepper of its own on screen. */
  readonly presentation?: 'inline' | 'embedded';
}

interface CloneResult {
  readonly source: string;
  readonly summary: string | null;
  readonly preview: ClonePreview | null;
  readonly slots: readonly FleetCredentialView[];
  readonly outcomes: readonly { readonly item: CloneOutcomeItem; readonly outcome: CloneItemOutcome }[];
  /** The source as the person names it, for the Done sentences. */
  readonly sourceName: string;
}

function Foot({ children }: { readonly children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap gap-2">{children}</div>;
}

const reasonOf = (error: unknown): string => {
  const invalid = configInvalidBody(error);
  return invalid === undefined
    ? changeRefusalSentence(error)
    : invalid.issues
        .filter(issue => issue.severity === 'error')
        .map(issue => `${issue.message} (${issue.fix})`)
        .join(' ');
};

export function CloneMachine(props: CloneMachineProps) {
  const {
    sources,
    machineName,
    machine,
    connection,
    createClient,
    online,
    checking,
    onRetry,
    onDone,
    onLeave,
    doneLabel = 'Go to Runtimes',
    onCopied,
    presentation = 'inline',
  } = props;
  const target = useSetupAccess({ connection, createClient });
  const { changes } = target;
  const [reach, setReach] = useState<ReadonlyMap<DaemonId, MachineReach>>(new Map());
  const [picked, setPicked] = useState<DaemonId | null>(null);
  const pickedRecord = sources.find(source => source.daemonId === picked);
  const source = useSetupAccess({ connection: pickedRecord ?? connection, createClient });
  const [bundle, setBundle] = useState<FleetCloneBundle | null>(null);
  const [files, setFiles] = useState<ReadonlyMap<string, SourceSettingsFile>>(new Map());
  const [speedups, setSpeedups] = useState<SpeedupsView | null>(null);
  const [held, setHeld] = useState<readonly string[]>([]);
  // The names the SOURCE holds (never values), so only a key it really has is asked for; `null` when unread.
  const [sourceSecrets, setSourceSecrets] = useState<readonly string[] | null>(null);
  const [copyKeys, setCopyKeys] = useState(true);
  const [chosen, setChosen] = useState<readonly CloneItemId[]>(ALL_CLONE_ITEMS);
  const [sourceIssue, setSourceIssue] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [profiles, setProfiles] = useState(0);
  const [mode, setMode] = useState<CloneMode>('alongside');
  const [skip, setSkip] = useState<readonly string[]>([]);
  // What the person picked for "Default runtime for new agents": a source runtime name, null for none, undefined until they pick.
  const [defaultPick, setDefaultPick] = useState<string | null | undefined>(undefined);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [stepper, setStepper] = useState<StepperState>(() =>
    startStepper({
      kind: CLONE_FLOW_KIND,
      title: 'Copy settings from another machine',
      steps: cloneSteps(false),
      leave: { question: 'Stop copying?', consequence: 'Nothing is copied.', stopLabel: 'Stop, copy nothing' },
      leaveWithoutConfirm: true,
    }),
  );

  // Each other machine answers once, through its own connection, so offline and not-set-up are known (E27).
  const listed = useRef(sources);
  listed.current = sources;
  const sourceKey = sources.map(record => record.daemonId).join(' ');
  useEffect(() => {
    let live = true;
    for (const record of listed.current.filter(candidate =>
      sourceKey.split(' ').includes(String(candidate.daemonId)),
    )) {
      void readMachineReach(() => createClient(record)).then(next => {
        if (live) setReach(current => new Map(current).set(record.daemonId, next));
      });
    }
    return () => {
      live = false;
    };
  }, [createClient, sourceKey]);

  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    void latest.current
      .read(client => readFleetProfiles(client))
      .then(answer => {
        if (answer.kind === 'done') setProfiles(answer.value.profiles.length);
      });
  }, []);

  /** The secret names this machine holds, read again after every add. Names only: there is no value route. */
  const readHeld = useCallback(async (): Promise<void> => {
    const answer = await latest.current.read(client => listSecrets(client));
    if (answer.kind === 'done') setHeld(answer.value.secrets.map(secret => secret.name));
  }, []);

  const addSecret = useCallback(
    async (name: string, value: string): Promise<string | null> => {
      const stored = await latest.current.read(client => putSecret(client, name, value));
      if (stored.kind === 'refused') return stored.sentence;
      await readHeld();
      return null;
    },
    [readHeld],
  );

  const runtimeCount = machine?.runtimeCount ?? 0;
  const copiesFleet = chosen.includes('fleet');
  const hasSetup = copiesFleet && (runtimeCount > 0 || profiles > 0);
  const steps = cloneSteps(hasSetup);
  const state = withSteps(stepper, steps);
  const at = currentFlow(state).at;
  const next = (): void => setStepper(stepForward(state));
  const preview = bundle === null ? null : clonePreview(bundle, machine, skip);
  const pickedReach = picked === null ? undefined : reach.get(picked);
  const sourceMachine = pickedReach?.kind === 'online' ? pickedReach.machine : null;
  // The person's name for the source (`Liftoff EC2`); the bundle's own `machine` is only what it called itself, often a hostname.
  const sourceName = pickedRecord === undefined ? (bundle?.machine ?? '') : daemonDisplayName(pickedRecord);
  const defaultView =
    bundle === null
      ? null
      : cloneDefaultView({
          bundle,
          mode,
          machineName,
          targetDefault: machine?.defaultRuntime ?? undefined,
          sourceDefault: chosen.includes('controls') ? (sourceMachine?.defaultRuntime ?? undefined) : undefined,
          picked: defaultPick,
        });

  const readSource = (): void => {
    setSourceIssue(null);
    setReading(true);
    void (async () => {
      const exported = await source.read(client => readFleetExport(client));
      if (exported.kind === 'refused') {
        setReading(false);
        setSourceIssue(exported.sentence);
        return;
      }
      const read = new Map<string, SourceSettingsFile>();
      for (const item of CLONE_SETTINGS_FILES) {
        const file = await source.read(client => readConfigFile(client, item.file));
        if (file.kind === 'done')
          read.set(item.file, { path: item.file, exists: file.value.exists, text: file.value.text });
      }
      const [view, sourceList] = await Promise.all([
        target.read(client => readSpeedups(client)),
        source.read(client => listSecrets(client)),
        readHeld(),
      ]);
      setSpeedups(view.kind === 'done' ? view.value : null);
      setSourceSecrets(
        sourceList.kind === 'done' && sourceList.value.health === 'ready'
          ? sourceList.value.secrets.map(secret => secret.name)
          : null,
      );
      setCopyKeys(true);
      setFiles(read);
      setBundle(exported.value);
      // A fresh read is a fresh review: nothing it lists has been left out yet, and every item it can copy is ticked.
      setSkip([]);
      setDefaultPick(undefined);
      setChosen(ALL_CLONE_ITEMS.filter(id => itemReadable(id, read, pickedReach)));
      setReading(false);
      setStepper(current => stepForward(withSteps(current, steps)));
    })();
  };

  /** Write one settings file here against what is here now; a loosening is held, not refused. */
  const copyFile = async (path: string, text: string): Promise<CloneItemOutcome> => {
    try {
      const client = await createClient(connection);
      const here = await readConfigFile(client, path);
      const written = await writeConfigFile(client, path, text, here.etag);
      return written.outcome === 'pending' && written.pending !== undefined
        ? { kind: 'pending', path, etag: written.pending.etag, changes: written.pending.changes }
        : { kind: 'copied' };
    } catch (error) {
      return { kind: 'refused', reason: reasonOf(error) };
    }
  };

  /** The sealed copy of the keys: the source asks for the passkey, this browser carries ciphertext. */
  const sealKeys = async (names: readonly string[]): Promise<CloneItemOutcome> => {
    if (pickedRecord === undefined) return { kind: 'refused', reason: 'No source machine is picked.' };
    try {
      await sealSecretsAcross(await createClient(pickedRecord), await createClient(connection), names);
      return { kind: 'copied' };
    } catch (error) {
      return { kind: 'refused', reason: `${copyRefusalSentence(error)} Copy them from the list below.` };
    }
  };

  const copy = (): void => {
    if (bundle === null || preview === null || pickedRecord === undefined) return;
    setCopying(true);
    void (async () => {
      let summary: string | null = null;
      const outcomes: { item: CloneOutcomeItem; outcome: CloneItemOutcome }[] = [];
      const item = (id: CloneItemId): CloneItem => CLONE_ITEMS.find(candidate => candidate.id === id) as CloneItem;
      if (copiesFleet) {
        const applied = await changes.apply({
          kind: 'clone.import' as const,
          mode,
          bundle: { ...bundle },
          ...(skip.length === 0 ? {} : { skip: [...skip] }),
          source: { daemonId: String(pickedRecord.daemonId) },
          names: { source: sourceName, target: machineName },
          ...(defaultView === null || defaultView.send === undefined ? {} : { defaultRuntime: defaultView.send }),
        });
        // The fleet goes first because a copied default runtime may name a runtime it brings; when it
        // is refused nothing else is copied either, and the refusal stays on screen to act on.
        if (applied.kind === 'refused') {
          setCopying(false);
          return;
        }
        summary = applied.outcome.outcome === 'executed' ? applied.outcome.summary : applied.staged.summary;
        outcomes.push({ item: item('fleet'), outcome: { kind: 'copied' } });
      }
      for (const settings of CLONE_SETTINGS_FILES) {
        const file = files.get(settings.file);
        if (!chosen.includes(settings.id) || file === undefined) continue;
        outcomes.push({ item: settings, outcome: await copyFile(settings.file, file.text) });
      }
      if (chosen.includes('controls') && sourceMachine !== null) {
        // The fleet copy already decided this machine's default; read it back so the controls do not undo it.
        const decided = copiesFleet ? await target.read(client => readFleetMachine(client)) : null;
        const applied = await changes.apply(
          controlsChange(sourceMachine, decided?.kind === 'done' ? decided.value.defaultRuntime : undefined),
        );
        outcomes.push({
          item: item('controls'),
          outcome: applied.kind === 'refused' ? { kind: 'refused', reason: applied.sentence } : { kind: 'copied' },
        });
      }
      // The keys the copied setup needs follow, sealed, for ONE passkey on the source. After the fleet, so a
      // refused copy has not already moved a key; before the credentials are read, so a login shows ready.
      if (keyNames.length > 0) {
        outcomes.push({ item: CLONE_KEYS_ITEM, outcome: await sealKeys(keyNames) });
        await readHeld();
      }
      const credentials = copiesFleet ? await target.read(client => readFleetCredentials(client)) : null;
      setResult({
        source: bundle.machine,
        summary,
        preview: copiesFleet ? preview : null,
        slots: credentials?.kind === 'done' ? cloneSlots(credentials.value.credentials, bundle.machine) : [],
        outcomes,
        sourceName,
      });
      setCopying(false);
      setStepper(current => stepForward(withSteps(current, steps)));
      onCopied?.(sourceName);
      onRetry();
    })();
  };

  const confirm = async (path: string, etag: string): Promise<string | null> => {
    try {
      await confirmConfigChange(await createClient(connection), path, etag);
      return null;
    } catch (error) {
      return reasonOf(error);
    }
  };

  const needs: readonly CloneNeed[] = cloneNeeds(chosen, bundle, files, speedups, held);
  const keyNames = copyKeys ? keysToCopy(needs, sourceSecrets) : [];
  // Secrets come only when a person picks them, by name, and the source asks for a passkey (docs/secrets.md).
  // The ones the copied settings need here start ticked.
  const neededSecrets = needs
    .filter(need => need.kind === 'secret' && !need.held && need.secretName !== undefined)
    .map(need => need.secretName as string);
  const copySecrets =
    pickedRecord === undefined ? undefined : (
      <SecretCopyLauncher
        label={`Copy secrets from ${daemonDisplayName(pickedRecord)}…`}
        direction="from"
        here={connection}
        others={[pickedRecord]}
        createClient={createClient}
        machineName={daemonDisplayName}
        preselect={neededSecrets}
        onCopied={() => void readHeld()}
      />
    );

  const copyPanel = (label: string, variant: 'primary' | 'danger' = 'primary') => (
    <div className="mt-4">
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy || copying}
        refusal={changes.refusal}
        submitLabel={label}
        busyLabel="Copying…"
        variant={variant}
        disabled={chosen.length === 0}
        onSubmit={copy}
      />
    </div>
  );

  const body = (): ReactNode => {
    if (at === 'source') {
      const pickedState = pickedRecord === undefined ? null : cloneSourceState(reach.get(pickedRecord.daemonId), '');
      return (
        <div className="flex min-w-0 flex-col gap-3" data-clone-step="source">
          <p className="m-0 text-cell leading-base text-fg">
            Copy settings from which machine into <span className="font-mono">{machineName}</span>?
          </p>
          <p className="m-0 text-cell leading-base text-muted" data-clone-shares="">
            {cloneSharesSentence(machineName)}
          </p>
          {sources.length === 0 ? (
            <SetupNote name="no-sources" title="No other machine is paired">
              <span>Pair another machine with this browser first, from Machines → Add machine.</span>
            </SetupNote>
          ) : (
            <RadioChoices
              legend="Copy from"
              legendHidden
              name="clone-source"
              value={picked}
              onChoose={id => {
                setPicked(id);
                setBundle(null);
                setSourceIssue(null);
              }}
              options={sources.map(record => {
                const name = daemonDisplayName(record);
                const sourceState = cloneSourceState(reach.get(record.daemonId), name);
                return {
                  id: record.daemonId,
                  title: <span className="font-mono">{name}</span>,
                  detail:
                    sourceState.kind === 'ready'
                      ? countWords(sourceState.runtimeCount, 'runtime')
                      : sourceState.kind === 'checking'
                        ? 'Checking…'
                        : undefined,
                  extra:
                    sourceState.kind === 'disabled' ? (
                      <span className="text-cell text-warn" data-clone-source-reason="">
                        {sourceState.reason}
                      </span>
                    ) : undefined,
                  disabled: sourceState.kind !== 'ready',
                };
              })}
            />
          )}
          {sourceIssue === null ? null : (
            <SetupNote live tone="warn" name="source-failed" title="Couldn’t read that machine’s setup">
              <span>{sourceIssue}</span>
            </SetupNote>
          )}
          <Foot>
            <Button
              type="button"
              variant="primary"
              data-step-next=""
              disabled={pickedState?.kind !== 'ready' || reading || source.changes.authority === null}
              onClick={() => readSource()}
            >
              {reading ? 'Reading…' : 'Next'}
            </Button>
          </Foot>
        </div>
      );
    }

    if (at === 'done')
      return (
        <DoneStep
          result={result}
          machineName={machineName}
          needs={needs}
          doneLabel={doneLabel}
          onDone={onDone}
          onAdd={addSecret}
          onConfirm={confirm}
          copy={copySecrets}
        />
      );
    if (bundle === null || preview === null) return null;

    const summaries: Partial<Record<CloneItemId, string>> = {};
    const unavailable: Partial<Record<CloneItemId, string>> = {};
    for (const entry of CLONE_ITEMS) {
      if (itemReadable(entry.id, files, pickedReach))
        summaries[entry.id] = sourceItemSummary(entry.id, files, sourceMachine, bundle);
      else unavailable[entry.id] = `${sourceName} didn’t share this one, so it can’t be copied.`;
    }
    const copyLabel = `Copy ${countWords(chosen.length, 'item')} from ${sourceName}`;

    if (at === 'preview')
      return (
        <div className="flex min-w-0 flex-col gap-4" data-clone-step="preview">
          <p className="m-0 text-cell leading-base text-fg">
            This is a one-time copy. Later changes on <span className="font-mono">{sourceName}</span> don’t follow.
          </p>
          <CloneItemsChoices
            chosen={chosen}
            summaries={summaries}
            unavailable={unavailable}
            source={sourceName}
            onToggle={(id, on) =>
              setChosen(current =>
                on
                  ? ALL_CLONE_ITEMS.filter(candidate => candidate === id || current.includes(candidate))
                  : current.filter(candidate => candidate !== id),
              )
            }
          />
          {copiesFleet ? (
            <>
              <SetupSection title="Profiles and runtimes copy" name="copies">
                {copiesRows(preview).map(row => (
                  <SetupRow
                    key={row.title}
                    status="ready"
                    statusLabel="Copies"
                    title={row.title}
                    {...(row.detail === undefined ? {} : { detail: row.detail })}
                  />
                ))}
              </SetupSection>
              {defaultView === null || defaultView.candidates.length === 0 ? null : (
                <DefaultRuntimeChoice
                  view={defaultView}
                  onPick={value => setDefaultPick(value === CLONE_NO_DEFAULT ? null : value)}
                />
              )}
              {preview.runnables.length === 0 ? null : (
                <RunsHere
                  runnables={preview.runnables}
                  skip={skip}
                  source={sourceName}
                  machineName={machineName}
                  onToggle={(reference, copyIt) =>
                    setSkip(current =>
                      copyIt ? current.filter(entry => entry !== reference) : [...current, reference].toSorted(),
                    )
                  }
                />
              )}
            </>
          ) : null}
          <CloneLoginsSection
            logins={cloneLogins(copiesFleet ? bundle : null, held)}
            machineName={machineName}
            sourceName={sourceName}
            keys={keysToCopy(needs, sourceSecrets)}
            copyKeys={copyKeys}
            onCopyKeys={setCopyKeys}
          />
          <CloneNeedsList needs={needs} machineName={machineName} onAdd={addSecret} copy={copySecrets} />
          <SetupSection title="Doesn’t copy" name="not-copied">
            {copiesFleet && preview.skipped > 0 ? (
              <SetupRow
                status="needs_sign_in"
                statusLabel="Doesn’t copy"
                title={`${countWords(preview.skipped, 'component')} you left out`}
                detail={`Not copied to ${machineName}, and removed from every profile that used ${preview.skipped === 1 ? 'it' : 'them'}.`}
              />
            ) : null}
            {copiesFleet ? (
              <SetupRow
                status="needs_sign_in"
                statusLabel="Doesn’t copy"
                title={countWords(preview.signIns, 'sign-in')}
                detail={`Claude Code and Codex sign-ins never copy: a refresh token on two machines would sign one of them out. Each becomes an empty slot on ${machineName}; sign in there. Runtimes keep pointing at their slot.`}
              />
            ) : null}
            <SetupRow
              status="needs_sign_in"
              statusLabel="Doesn’t copy"
              title="Other secret values"
              detail="Only the keys these logins and settings need are copied, sealed. Any other secret, copy by name from Settings › Secrets."
            />
            <SetupRow
              status="needs_sign_in"
              statusLabel="Doesn’t copy"
              title="History and device settings"
              detail={`Past sessions stay on ${sourceName}; appearance and composer choices stay on each device.`}
            />
          </SetupSection>
          {copiesFleet && preview.checkPaths.length > 0 ? (
            <SetupSection title="Check after copying" name="check-paths">
              {preview.checkPaths.map(check => (
                <SetupRow
                  key={check.title}
                  title={check.title}
                  detail={
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="break-all font-mono">{check.path}</span>
                      <span className="text-warn">Check this path on {machineName}</span>
                    </span>
                  }
                />
              ))}
            </SetupSection>
          ) : null}
          {copiesFleet && preview.missingTools.length > 0 ? (
            <SetupNote tone="warn" name="missing-tools">
              <span>
                {listWords(preview.missingTools.map(harness => SETUP_HARNESS_NAMES[harness]))} isn’t installed on{' '}
                {machineName}. Its runtimes are copied and wait until you install it.
              </span>
            </SetupNote>
          ) : null}
          {copiesFleet && preview.notCopied.length > 0 ? (
            <SetupNote
              tone="warn"
              name="files-not-copied"
              title={`${countWords(preview.notCopied.length, 'file')} can’t be copied`}
            >
              {preview.notCopied.map(entry => (
                <span key={entry.path} className="break-all">
                  {entry.path}: {entry.reason}
                </span>
              ))}
            </SetupNote>
          ) : null}
          {copiesFleet && preview.problem !== null ? (
            // Never offered: a bundle the review could misread is one the target refuses anyway.
            <SetupNote live tone="err" name="bundle-refused" title={`${sourceName}’s setup can’t be copied`}>
              <span>{preview.problem}</span>
            </SetupNote>
          ) : hasSetup ? (
            <Foot>
              <Button type="button" variant="primary" data-step-next="" onClick={next}>
                Next
              </Button>
            </Foot>
          ) : (
            copyPanel(copyLabel)
          )}
        </div>
      );

    // existing
    return (
      <div className="flex min-w-0 flex-col gap-3" data-clone-step="existing">
        <p className="m-0 text-cell leading-base text-fg">{existingSentence(machineName, profiles, runtimeCount)}</p>
        <RadioChoices
          legend="Existing setup"
          legendHidden
          name="clone-mode"
          value={mode}
          onChoose={setMode}
          options={[
            {
              id: 'alongside',
              title: 'Add alongside (rename clashes)',
              detail: (
                <>
                  Keep what’s here. Copies with the same name get -2, e.g.{' '}
                  <span className="font-mono">claude-default-2</span>.
                </>
              ),
            },
            {
              id: 'replace',
              title: 'Replace',
              detail: `Delete ${machineName}’s components, profiles and runtimes first. Its logins stay.`,
            },
          ]}
        />
        {defaultView === null || defaultView.candidates.length === 0 ? null : (
          <DefaultRuntimeChoice
            view={defaultView}
            onPick={value => setDefaultPick(value === CLONE_NO_DEFAULT ? null : value)}
          />
        )}
        {mode === 'replace' ? copyPanel('Replace and copy', 'danger') : copyPanel('Copy alongside')}
      </div>
    );
  };

  return (
    <MachineStepper
      state={state}
      onChange={nextState => (nextState === null ? onLeave() : setStepper(nextState))}
      machineName={machineName}
      online={online}
      checking={checking}
      onRetry={onRetry}
      presentation={presentation}
    >
      {body()}
    </MachineStepper>
  );
}

/** Whether the source shared an item: its export always, its files when they were read, its controls when it answered. */
const itemReadable = (
  id: CloneItemId,
  files: ReadonlyMap<string, SourceSettingsFile>,
  reach: MachineReach | undefined,
): boolean => {
  if (id === 'fleet') return true;
  if (id === 'controls') return reach?.kind === 'online';
  const file = CLONE_SETTINGS_FILES.find(candidate => candidate.id === id) as CloneItem & { readonly file: string };
  return files.has(file.file);
};

/**
 * Everything the copy would run on this machine, one panel per component, each with a box that
 * leaves it out. A document is folded, because a hook script can be long — but every line of it is
 * there, and its size is on the fold.
 */
function RunsHere({
  runnables,
  skip,
  source,
  machineName,
  onToggle,
}: {
  readonly runnables: readonly CloneRunnable[];
  readonly skip: readonly string[];
  readonly source: string;
  readonly machineName: string;
  readonly onToggle: (reference: string, copy: boolean) => void;
}) {
  return (
    <SetupSection title={`Runs on ${machineName}`} name="runs">
      <SetupNote
        tone="warn"
        name="runs-warning"
        title={`${countWords(runnables.length, 'component')} can make ${machineName} run something`}
      >
        <span>
          MCP servers, hooks and settings start programs the next time an agent launches on{' '}
          <span className="font-mono">{machineName}</span>. Instructions and skills are text an agent follows, and one
          running unattended will act on it. Read each one and untick any you don’t trust: if{' '}
          <span className="font-mono">{source}</span> was ever broken into, this is where it would plant a command.
        </span>
      </SetupNote>
      {runnables.map(runnable => {
        const copy = !skip.includes(runnable.reference);
        return (
          <div
            key={runnable.reference}
            className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
            data-clone-runnable={runnable.reference}
            data-copy={copy ? 'yes' : 'no'}
          >
            <label className="relative flex min-h-control min-w-0 cursor-pointer items-center gap-3 has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-offset-focus">
              <input
                type="checkbox"
                checked={copy}
                onChange={event => onToggle(runnable.reference, event.currentTarget.checked)}
                className="shrink-0 accent-[var(--accent)]"
                data-clone-copy={runnable.reference}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">
                  {runnableTitle(runnable)}
                </span>
                <span className={copy ? 'text-cell text-muted' : 'text-cell text-warn'}>
                  {copy ? `Copies to ${machineName}` : 'Left out: not copied'}
                </span>
              </span>
            </label>
            <dl className="m-0 flex min-w-0 flex-col gap-2">
              {runnable.entries.map((entry, index) => (
                <div key={`${entry.label}-${String(index)}`} className="flex min-w-0 flex-col gap-1">
                  <dt className="[overflow-wrap:anywhere] text-meta text-muted">{entry.label}</dt>
                  <dd className="m-0 min-w-0">
                    {entry.document ? (
                      <details className="min-w-0">
                        <summary className="min-h-control cursor-pointer text-cell text-fg">
                          Show all {documentSize(entry.text)}
                        </summary>
                        <SetupCommand>{entry.text}</SetupCommand>
                      </details>
                    ) : (
                      <SetupCommand>{entry.text}</SetupCommand>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </SetupSection>
  );
}

function DoneStep({
  result,
  machineName,
  needs,
  doneLabel,
  onDone,
  onAdd,
  onConfirm,
  copy,
}: {
  readonly result: CloneResult | null;
  readonly machineName: string;
  readonly needs: readonly CloneNeed[];
  readonly doneLabel: string;
  readonly onDone: () => void;
  readonly onAdd: (name: string, value: string) => Promise<string | null>;
  readonly onConfirm: (path: string, etag: string) => Promise<string | null>;
  readonly copy?: ReactNode;
}) {
  if (result === null) return null;
  const busiest = result.slots[0];
  const slotFor = (need: CloneNeed): FleetCredentialView | undefined =>
    result.slots.find(slot => slot.id === need.credentialId);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-clone-step="done">
      <SetupNote live tone="ok" name="cloned" title={`Copied from ${result.sourceName}`}>
        <span>{result.summary ?? `${countWords(result.outcomes.length, 'item')} copied.`}</span>
      </SetupNote>
      <CloneOutcomes outcomes={result.outcomes} onConfirm={onConfirm} />
      <CloneNeedsList
        needs={needs}
        machineName={machineName}
        onAdd={onAdd}
        copy={copy}
        signIn={need => {
          const slot = slotFor(need);
          return slot === undefined ? null : (
            <a
              href={machineItemHash(machineName, 'credentials', slot.id)}
              className="inline-flex min-h-control items-center gap-1 font-semibold text-accent underline"
              data-clone-need-sign-in={slot.id}
            >
              Sign in
              <ChevronRight size={14} aria-hidden="true" />
            </a>
          );
        }}
      />
      {result.slots.length === 0 ? null : (
        <SetupSection title="Sign in to use them" name="slots">
          {result.slots.map(slot => (
            <a
              key={slot.id}
              href={machineItemHash(machineName, 'credentials', slot.id)}
              data-clone-slot={slot.id}
              className="kt-panel flex min-h-control min-w-0 items-center gap-3 p-panel no-underline hover:border-accent"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="[overflow-wrap:anywhere] text-row font-semibold text-fg">
                  {SETUP_HARNESS_NAMES[slot.harness]} ·{' '}
                  <span className="font-mono">{slot.email ?? slot.label ?? slot.id}</span>
                </span>
                <span className="text-cell text-muted">
                  Empty slot · used by {countWords(slot.usedBy.length, 'runtime')}
                  {result.preview?.missingTools.includes(slot.harness)
                    ? ` · ${SETUP_HARNESS_NAMES[slot.harness]} isn’t installed here`
                    : ''}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-accent">
                Sign in
                <ChevronRight size={16} aria-hidden="true" />
              </span>
            </a>
          ))}
          <p className="m-0 text-meta text-muted">
            A sign-in never copies, so each login is signed in on {machineName}. Sign in once per login: every runtime
            that uses it is fixed together.
          </p>
        </SetupSection>
      )}
      {result.preview === null || result.preview.checkPaths.length === 0 ? null : (
        <SetupNote
          tone="warn"
          name="check-paths-after"
          title={`Check ${countWords(result.preview.checkPaths.length, 'path')} on ${machineName}`}
        >
          <span>
            {listWords(result.preview.checkPaths.map(check => check.title))} point at folders on {result.sourceName}.
          </span>
        </SetupNote>
      )}
      <Foot>
        <Button type="button" data-clone-finish="" onClick={onDone}>
          {doneLabel}
        </Button>
        {busiest === undefined ? null : (
          <a
            href={machineItemHash(machineName, 'credentials', busiest.id)}
            data-clone-sign-in={busiest.id}
            className="kt-btn"
            data-variant="primary"
          >
            Sign in once for {countWords(busiest.usedBy.length, 'runtime')}
          </a>
        )}
      </Foot>
    </div>
  );
}
