/**
 * Clone from another machine (docs/design/account-model.md §3.8, §4.7, E27–E31).
 *
 * **Source** → **Preview** → **Existing setup** (only when this machine already has profiles or
 * runtimes) → **Done**. The browser reads the source's export through the source's own connection and
 * hands it to this machine as the data of ONE reviewed change, `clone.import`, through the shared
 * change helper. Logins never travel: each becomes an empty slot here that needs sign-in, and Done
 * offers **Sign in once for n runtimes** on the busiest one (E31).
 */

import type { FleetCloneBundle, FleetCredentialView } from '@ferretry/protocol';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { daemonDisplayName } from '../../settings/daemon-settings.tsx';
import { readFleetProfileStacks } from '../catalog-api.ts';
import { readFleetCredentials } from '../credentials-api.ts';
import { readFleetExport } from '../setup-api.ts';
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
  cloneSlots,
  cloneSourceState,
  cloneSteps,
  copiesRows,
  existingSentence,
} from './clone-model.ts';
import { machineItemHash } from './settings-route.ts';
import { useSetupAccess } from './setup-access.ts';
import { RadioChoices, SetupNote, SetupRow, SetupSection } from './setup-ui.tsx';
import { countWords, listWords, SETUP_HARNESS_NAMES } from './setup-words.ts';

export interface CloneMachineProps extends MachineTabProps {
  /** Every OTHER machine this browser has paired. */
  readonly sources: readonly DaemonConnectionRecord[];
  readonly onDone: () => void;
  readonly onLeave: () => void;
  /** Supplied in tests. */
  readonly now?: () => number;
}

interface CloneResult {
  readonly source: string;
  readonly summary: string;
  readonly preview: ClonePreview;
  readonly slots: readonly FleetCredentialView[];
}

function Foot({ children }: { readonly children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap gap-2">{children}</div>;
}

export function CloneMachine(props: CloneMachineProps) {
  const { sources, machineName, machine, connection, createClient, online, checking, onRetry, onDone, onLeave, now } =
    props;
  const clock = now === undefined ? {} : { now };
  const target = useSetupAccess({ connection, createClient, ...clock });
  const { changes } = target;
  const [reach, setReach] = useState<ReadonlyMap<DaemonId, MachineReach>>(new Map());
  const [picked, setPicked] = useState<DaemonId | null>(null);
  const pickedRecord = sources.find(source => source.daemonId === picked);
  const source = useSetupAccess({ connection: pickedRecord ?? connection, createClient, ...clock });
  const [bundle, setBundle] = useState<FleetCloneBundle | null>(null);
  const [sourceIssue, setSourceIssue] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [profiles, setProfiles] = useState(0);
  const [mode, setMode] = useState<CloneMode>('alongside');
  const [result, setResult] = useState<CloneResult | null>(null);
  const [stepper, setStepper] = useState<StepperState>(() =>
    startStepper({
      kind: CLONE_FLOW_KIND,
      title: 'Clone from another machine',
      steps: cloneSteps(false),
      leave: { question: 'Stop cloning?', consequence: 'Nothing is copied.', stopLabel: 'Stop, copy nothing' },
      leaveWithoutConfirm: true,
    }),
  );

  // Each other machine answers once, through its own connection, so offline and not-set-up are known (E27).
  const listed = useRef(sources);
  listed.current = sources;
  const sourceKey = sources.map(record => record.daemonId).join(' ');
  useEffect(() => {
    let live = true;
    for (const record of listed.current.filter(candidate => sourceKey.split(" ").includes(String(candidate.daemonId)))) {
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
      .read((client, unlock) => readFleetProfileStacks(client, unlock))
      .then(answer => {
        if (answer.kind === 'done') setProfiles(answer.value.profiles.length);
      });
  }, []);

  const runtimeCount = machine?.runtimeCount ?? 0;
  const hasSetup = runtimeCount > 0 || profiles > 0;
  const steps = cloneSteps(hasSetup);
  const state = withSteps(stepper, steps);
  const at = currentFlow(state).at;
  const next = (): void => setStepper(stepForward(state));
  const preview = bundle === null ? null : clonePreview(bundle, machine);

  const readSource = (password?: string): void => {
    setSourceIssue(null);
    setReading(true);
    void source.read((client, unlock) => readFleetExport(client, unlock), password).then(answer => {
      setReading(false);
      if (answer.kind === 'refused') {
        if (!answer.passwordRejected) setSourceIssue(answer.sentence);
        return;
      }
      setBundle(answer.value);
      setStepper(current => stepForward(withSteps(current, steps)));
    });
  };

  const copy = (password: string | undefined): void => {
    if (bundle === null || preview === null) return;
    void changes.apply({ kind: 'clone.import', mode, bundle: { ...bundle } }, password).then(async applied => {
      if (applied.kind === 'refused') return;
      const credentials = await target.read((client, unlock) => readFleetCredentials(client, unlock));
      setResult({
        source: bundle.machine,
        summary: applied.outcome.outcome === 'executed' ? applied.outcome.summary : applied.staged.summary,
        preview,
        slots: credentials.kind === 'done' ? cloneSlots(credentials.value.credentials, bundle.machine) : [],
      });
      setStepper(current => stepForward(withSteps(current, steps)));
      onRetry();
    });
  };

  const copyPanel = (label: string, variant: 'primary' | 'danger' = 'primary') => (
    <div className="mt-4">
      <ChangeApplyPanel
        machineName={machineName}
        changes={machine?.changes ?? null}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={label}
        busyLabel="Copying…"
        variant={variant}
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
            Copy setup from which machine into <span className="font-mono">{machineName}</span>?
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
          {pickedRecord !== undefined && source.locked ? (
            <ChangeApplyPanel
              machineName={daemonDisplayName(pickedRecord)}
              changes={null}
              authority={source.changes.authority}
              busy={reading}
              refusal={source.changes.refusal}
              submitLabel="Next"
              busyLabel="Reading…"
              onSubmit={password => readSource(password)}
            />
          ) : (
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
          )}
        </div>
      );
    }

    if (at === 'done') return <DoneStep result={result} machineName={machineName} onDone={onDone} />;
    if (bundle === null || preview === null) return null;

    if (at === 'preview')
      return (
        <div className="flex min-w-0 flex-col gap-4" data-clone-step="preview">
          <p className="m-0 text-cell leading-base text-fg">
            This is a one-time copy. Later changes on <span className="font-mono">{bundle.machine}</span> don’t follow.
          </p>
          <SetupSection title="Copies" name="copies">
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
          <SetupSection title="Doesn’t copy" name="not-copied">
            <SetupRow
              status="needs_sign_in"
              statusLabel="Doesn’t copy"
              title={countWords(preview.logins, 'login')}
              detail={`Each becomes an empty slot on ${machineName} that needs sign-in. Runtimes keep pointing at their slot.`}
            />
            <SetupRow
              status="needs_sign_in"
              statusLabel="Doesn’t copy"
              title="History"
              detail={`Past sessions stay on ${bundle.machine}.`}
            />
          </SetupSection>
          {preview.checkPaths.length === 0 ? null : (
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
          )}
          {preview.missingTools.length === 0 ? null : (
            <SetupNote tone="warn" name="missing-tools">
              <span>
                {listWords(preview.missingTools.map(harness => SETUP_HARNESS_NAMES[harness]))} isn’t installed on{' '}
                {machineName}. Its runtimes are copied and wait until you install it.
              </span>
            </SetupNote>
          )}
          {preview.notCopied.length === 0 ? null : (
            <SetupNote tone="warn" name="files-not-copied" title={`${countWords(preview.notCopied.length, 'file')} can’t be copied`}>
              {preview.notCopied.map(entry => (
                <span key={entry.path} className="break-all">
                  {entry.path}: {entry.reason}
                </span>
              ))}
            </SetupNote>
          )}
          {hasSetup ? (
            <Foot>
              <Button type="button" variant="primary" data-step-next="" onClick={next}>
                Next
              </Button>
            </Foot>
          ) : (
            copyPanel(`Copy to ${machineName}`)
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
    >
      {body()}
    </MachineStepper>
  );
}

function DoneStep({
  result,
  machineName,
  onDone,
}: {
  readonly result: CloneResult | null;
  readonly machineName: string;
  readonly onDone: () => void;
}) {
  if (result === null) return null;
  const busiest = result.slots[0];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-clone-step="done">
      <SetupNote live tone="ok" name="cloned" title={`Copied from ${result.source}`}>
        <span>{result.summary}</span>
      </SetupNote>
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
                <span className="break-words text-row font-semibold text-fg">
                  {SETUP_HARNESS_NAMES[slot.harness]} · <span className="font-mono">{slot.email ?? slot.label ?? slot.id}</span>
                </span>
                <span className="text-cell text-muted">
                  Empty slot · used by {countWords(slot.usedBy.length, 'runtime')}
                  {result.preview.missingTools.includes(slot.harness)
                    ? ` · ${SETUP_HARNESS_NAMES[slot.harness]} isn’t installed here`
                    : ''}
                </span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
            </a>
          ))}
          <p className="m-0 text-meta text-muted">Sign in once per slot. Every runtime that uses it is fixed together.</p>
        </SetupSection>
      )}
      {result.preview.checkPaths.length === 0 ? null : (
        <SetupNote tone="warn" name="check-paths-after" title={`Check ${countWords(result.preview.checkPaths.length, 'path')} on ${machineName}`}>
          <span>
            {listWords(result.preview.checkPaths.map(check => check.title))} point at folders on {result.source}.
          </span>
        </SetupNote>
      )}
      <Foot>
        <Button type="button" data-clone-finish="" onClick={onDone}>
          Go to Runtimes
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
