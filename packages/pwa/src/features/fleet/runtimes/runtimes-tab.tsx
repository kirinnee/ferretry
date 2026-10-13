/**
 * The Runtimes tab (docs/design/account-model.md §4.2): what you launch on this machine — each a login
 * plus a profile — and each runtime's own page: its login, its profile's layers newest on top, its
 * model set, the fixed layer Ferretry adds last for an agent runtime, and Launch.
 *
 * Launch never starts anything by itself. It opens the ordinary New session form with this runtime
 * picked, so the person still chooses the folder and says what they want; it is a click, never a load.
 */

import type { FleetMachineView, FleetRuntimeView } from '@ferretry/protocol';
import { ChevronLeft, ChevronRight, Lock, Plus, TriangleAlert } from 'lucide-react';
import { type ComponentType, type MouseEvent, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { daemonNewSessionPath } from '../../../lib/pages/routes.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { credentialEmail, HARNESS_NAMES } from '../credentials/credentials-model.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { useAccountChanges } from '../shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { startStepper, type StepperState } from '../shell/stepper-model.ts';
import {
  AddRuntime,
  type AddRuntimeDraft,
  addRuntimeFlowInput,
  EMPTY_ADD_RUNTIME,
  type ProfileBuilder,
} from './add-runtime.tsx';
import { type MachineData, machineDetailHash, useMachineData, useMachineDetail } from './machine-data.ts';
import {
  harnessInstalled,
  launchLabel,
  layerRows,
  modelRows,
  modelSetNote,
  runtimeDefaultModel,
  runtimeProfileLine,
} from './runtimes-model.ts';

/** The status shape a runtime shows: its login's. */
const runtimeWord = (runtime: FleetRuntimeView) => runtime.credential.status ?? 'checking';

const loginLine = (runtime: FleetRuntimeView, data: MachineData): string => {
  const credential = data.credentials.credentials.find(item => item.id === runtime.credential.id);
  const email = credential === undefined ? 'Unknown login' : credentialEmail(credential);
  return runtime.credential.label === undefined ? email : `${email} (${runtime.credential.label})`;
};

/** The link to the New session form with this runtime picked. A hint only: the form decides. */
export const launchHref = (connection: DaemonConnection, runtime: string): string =>
  `${daemonNewSessionPath(connection.daemonId)}?agent=${encodeURIComponent(runtime)}`;

/** Moves inside the app without a reload: the app's router follows the browser's history. */
const followInApp = (event: MouseEvent<HTMLAnchorElement>, browser: Window = window): void => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  browser.history.pushState({}, '', event.currentTarget.getAttribute('href') ?? '');
  browser.dispatchEvent(new PopStateEvent('popstate'));
};

function MissingHarness({
  runtime,
  machineName,
}: {
  readonly runtime: FleetRuntimeView;
  readonly machineName: string;
}) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-1 text-cell text-warn" data-runtime-missing-harness="">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{HARNESS_NAMES[runtime.harness]} isn’t installed here</span> ·{' '}
      <a href={machineDetailHash(machineName, 'settings')} className="font-semibold text-accent underline">
        Install
      </a>
    </p>
  );
}

function Section({ title, children }: { readonly title: React.ReactNode; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="m-0 flex items-center gap-1 text-meta font-semibold uppercase text-muted">{title}</h4>
      {children}
    </section>
  );
}

interface RuntimePageProps {
  readonly runtime: FleetRuntimeView;
  readonly data: MachineData;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  readonly connection: DaemonConnection;
  readonly onBack: () => void;
}

function RuntimePage({ runtime, data, machine, machineName, online, connection, onBack }: RuntimePageProps) {
  const installed = harnessInstalled(machine, runtime.harness);
  const word = runtimeWord(runtime);
  const profile = data.profiles.profiles.find(item => item.name === runtime.profile);
  const layers = profile === undefined ? [] : layerRows(profile, data.components, runtime.harness);
  const models = modelRows(runtime);
  const canLaunch = online && runtime.launch.available;
  return (
    <section className="flex min-w-0 flex-col gap-4" data-runtime-page={runtime.name}>
      <div>
        <Button type="button" variant="ghost" size="sm" data-page-back="" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden="true" />
          Runtimes
        </Button>
        <h3 className="m-0 mt-2 break-all font-mono text-title font-semibold text-fg">{runtime.name}</h3>
        <p className="m-0 mt-1 flex items-center gap-2 text-cell text-muted">
          <AccountStatus word={word} showLabel />
          {runtime.agent ? <span>· Agent runtime</span> : null}
        </p>
      </div>

      {installed ? null : (
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel" data-runtime-note="missing">
          <p className="m-0 text-row font-semibold text-fg">{HARNESS_NAMES[runtime.harness]} isn’t installed here</p>
          <p className="m-0 text-cell text-muted">Install it on {machineName} to launch this runtime.</p>
          <a
            href={machineDetailHash(machineName, 'settings')}
            className="text-cell font-semibold text-accent underline"
          >
            Install {HARNESS_NAMES[runtime.harness]}
          </a>
        </div>
      )}
      {word === 'needs_sign_in' ? (
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel" data-runtime-note="sign-in">
          <p className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
            <AccountStatus word="needs_sign_in" /> This login needs sign-in
          </p>
          <p className="m-0 text-cell text-muted">Sign in once and every runtime that uses it can launch.</p>
          <a
            href={machineDetailHash(machineName, 'credentials', runtime.credential.id)}
            className="text-cell font-semibold text-accent underline"
            data-runtime-sign-in=""
          >
            Sign in
          </a>
        </div>
      ) : null}
      {word === 'refresh_due' ? (
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel" data-runtime-note="refresh">
          <p className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
            <AccountStatus word="refresh_due" /> Refresh due
          </p>
          <p className="m-0 text-cell text-muted">Ferretry renews the sign-in when you launch. Nothing to do.</p>
        </div>
      ) : null}

      <Section title="Credential">
        <a
          href={machineDetailHash(machineName, 'credentials', runtime.credential.id)}
          className="kt-panel flex min-h-control min-w-0 items-center gap-3 p-panel no-underline hover:border-accent"
          data-runtime-credential={runtime.credential.id}
        >
          <AccountStatus word={word} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-row text-fg">{loginLine(runtime, data)}</span>
            <span className="text-cell text-muted">{HARNESS_NAMES[runtime.harness]}</span>
          </span>
          <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
        </a>
      </Section>

      <Section title="Profile">
        <a
          href={machineDetailHash(machineName, 'profiles', runtime.profile)}
          className="kt-panel flex min-h-control min-w-0 items-center gap-3 p-panel no-underline hover:border-accent"
          data-runtime-profile={runtime.profile}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-row font-semibold text-fg">{runtime.profile}</span>
            <span className="text-cell text-muted">{runtimeProfileLine(runtime, profile)}</span>
          </span>
          <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
        </a>
        {layers.length === 0 ? null : (
          <div className="flex flex-col gap-1" data-runtime-layers="">
            <p className="m-0 text-meta text-muted">Newest on top · newer layer wins</p>
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {layers.map((layer, index) => (
                <li
                  key={layer.reference}
                  className={cn('kt-panel flex min-w-0 items-start gap-3 px-3 py-2', layer.skipped && 'opacity-60')}
                  data-runtime-layer={layer.reference}
                >
                  <span className="w-5 shrink-0 text-meta text-muted">{layers.length - index}</span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="break-words text-cell font-semibold text-fg">{layer.title}</span>
                    {layer.notes.length === 0 && !layer.skipped ? null : (
                      <span className="flex flex-wrap gap-1">
                        {layer.skipped ? <Badge>Skipped on {HARNESS_NAMES[runtime.harness]}</Badge> : null}
                        {layer.notes.map(note => (
                          <Badge
                            key={note}
                            tone={note.startsWith('Partly') || note.includes('not found') ? 'warn' : 'pend'}
                          >
                            {note}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Section>

      <Section title="Model set">
        {models.length === 0 ? null : (
          <ul className="kt-panel m-0 flex list-none flex-col gap-1 p-panel" data-runtime-models="">
            {models.map(model => (
              <li key={model.id} className="flex min-w-0 items-center justify-between gap-2 text-cell">
                {model.available ? (
                  <span className="min-w-0 truncate text-fg">{model.id}</span>
                ) : (
                  <s className="min-w-0 truncate text-muted">{model.id}</s>
                )}
                <span className={model.available ? 'text-muted' : 'text-err'}>
                  {model.available ? (model.isDefault ? 'Default' : '') : 'Not available on this login'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-cell leading-base text-muted" data-runtime-model-note="">
          {modelSetNote(runtime)}
        </p>
      </Section>

      {runtime.fixedLayer === undefined ? null : (
        <Section
          title={
            <>
              <Lock size={12} aria-hidden="true" /> Fixed layer
            </>
          }
        >
          <div data-runtime-fixed-layer="" className="flex flex-col gap-2">
            <p className="m-0 text-cell leading-base text-fg">
              Ferretry launches <span className="font-mono">{runtime.name}</span> as an agent, so it adds a locked layer
              last. You can’t edit it here.
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {runtime.fixedLayer.entries.map(entry => (
                <li key={entry.key} className="kt-panel flex min-w-0 items-center gap-2 px-3 py-2 text-cell">
                  <Lock size={14} aria-hidden="true" className="shrink-0 text-muted" />
                  <span className="min-w-0 break-all font-mono text-fg">
                    {entry.key} = {entry.value}
                  </span>
                </li>
              ))}
            </ul>
            {runtime.fixedLayer.overridden.length === 0 ? null : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" data-runtime-overridden="">
                {runtime.fixedLayer.overridden.map(entry => (
                  <li key={entry.key} className="flex min-w-0 flex-col px-3 py-1 text-cell">
                    <s className="break-all font-mono text-muted">
                      {entry.key} = {entry.value}
                    </s>
                    <span className="text-muted">{entry.sentence}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      )}

      <div className="border-t border-border pt-3">
        {canLaunch ? (
          <a
            href={launchHref(connection, runtime.name)}
            onClick={event => followInApp(event)}
            className="kt-btn w-full justify-center no-underline"
            data-variant="primary"
            data-runtime-launch=""
          >
            {launchLabel(runtime, machineName, online)}
          </a>
        ) : (
          <Button type="button" variant="primary" className="w-full" disabled data-runtime-launch="">
            {launchLabel(runtime, machineName, online)}
          </Button>
        )}
      </div>
    </section>
  );
}

function RuntimeRow({
  runtime,
  data,
  machine,
  machineName,
}: {
  readonly runtime: FleetRuntimeView;
  readonly data: MachineData;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <a
        href={machineDetailHash(machineName, 'runtimes', runtime.name)}
        className="kt-panel flex min-h-control min-w-0 items-start gap-3 p-panel text-left no-underline hover:border-accent"
        data-runtime-row={runtime.name}
      >
        <AccountStatus word={runtimeWord(runtime)} className="mt-1" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-mono text-row font-semibold text-fg">{runtime.name}</span>
          <span className="break-words text-cell text-muted">
            <span className="font-mono">{loginLine(runtime, data)}</span> · {runtime.profile} profile ·{' '}
            {runtimeDefaultModel(runtime)}
          </span>
          {runtime.agent ? (
            <span>
              <Badge tone="accent">Agent</Badge>
            </span>
          ) : null}
        </span>
        <ChevronRight size={16} aria-hidden="true" className="mt-1 shrink-0 text-muted" />
      </a>
      {harnessInstalled(machine, runtime.harness) ? null : (
        <MissingHarness runtime={runtime} machineName={machineName} />
      )}
    </div>
  );
}

export interface RuntimesTabOptions {
  /** The Profiles tab's Build a profile, used for "+ Build a new profile". */
  readonly profileBuilder?: ProfileBuilder;
  /** Supplied in tests. */
  readonly pollMs?: number;
}

export function RuntimesTab({
  connection,
  machineName,
  machine,
  online,
  checking,
  onRetry,
  createClient,
  profileBuilder,
  pollMs,
}: MachineTabProps & RuntimesTabOptions) {
  const { state, data, reload } = useMachineData(connection, createClient);
  const changes = useAccountChanges({ connection, createClient });
  const [detail, openDetail] = useMachineDetail(machineName, 'runtimes');
  const [flow, setFlow] = useState<StepperState | null>(null);
  const [draft, setDraft] = useState<AddRuntimeDraft>(EMPTY_ADD_RUNTIME);

  if (data === null)
    return state.kind === 'failed' ? (
      <p role="alert" className="m-0 text-cell leading-base text-warn" data-runtimes-failed="">
        {state.sentence}
      </p>
    ) : (
      <p role="status" className="m-0 text-cell text-muted" data-runtimes-loading="">
        Reading the runtimes on {machineName}…
      </p>
    );

  if (flow !== null)
    return (
      <AddRuntime
        state={flow}
        onState={setFlow}
        draft={draft}
        onDraft={setDraft}
        data={data}
        reload={reload}
        changes={changes}
        machine={machine}
        machineName={machineName}
        online={online}
        checking={checking}
        onRetry={onRetry}
        connection={connection}
        createClient={createClient}
        {...(profileBuilder === undefined ? {} : { profileBuilder })}
        {...(pollMs === undefined ? {} : { pollMs })}
        onFinish={open => {
          setFlow(null);
          openDetail(open);
        }}
      />
    );

  const start = (): void => {
    changes.clear();
    setDraft(EMPTY_ADD_RUNTIME);
    setFlow(startStepper(addRuntimeFlowInput()));
  };

  const runtime = detail === null ? undefined : data.runtimes.runtimes.find(item => item.name === detail);
  if (runtime !== undefined)
    return (
      <RuntimePage
        runtime={runtime}
        data={data}
        machine={machine}
        machineName={machineName}
        online={online}
        connection={connection}
        onBack={() => openDetail(null)}
      />
    );

  const runtimes = data.runtimes.runtimes;
  return (
    <section className="flex min-w-0 flex-col gap-4" data-runtimes-tab="">
      {state.kind === 'failed' ? (
        <p role="alert" className="m-0 text-cell leading-base text-warn">
          {state.sentence}
        </p>
      ) : null}
      {detail === null ? null : (
        <p role="status" className="m-0 text-cell text-warn" data-runtime-missing="">
          There is no runtime {detail} on {machineName} any more.
        </p>
      )}
      {runtimes.length === 0 ? (
        <div className="kt-panel flex flex-col items-start gap-2 p-panel" data-runtimes-empty="">
          <h3 className="m-0 text-row font-semibold text-fg">No runtimes on {machineName} yet</h3>
          <p className="m-0 text-cell leading-base text-muted">
            A runtime is a login plus a profile. It’s the thing you launch.
          </p>
          <Button type="button" variant="primary" data-add-runtime="" onClick={start}>
            Add your first runtime
          </Button>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-cell text-muted">
              {runtimes.length} {runtimes.length === 1 ? 'runtime' : 'runtimes'} on {machineName}
            </p>
            <Button type="button" variant="primary" data-add-runtime="" onClick={start}>
              <Plus size={16} aria-hidden="true" />
              Add runtime
            </Button>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {runtimes.map(item => (
              <li key={item.name}>
                <RuntimeRow runtime={item} data={data} machine={machine} machineName={machineName} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The tab as the composition root's `machineTabs` entry, with the profile builder plugged in. */
export const createRuntimesTab = (options: RuntimesTabOptions = {}): ComponentType<MachineTabProps> =>
  function RuntimesTabSurface(props: MachineTabProps) {
    return <RuntimesTab {...props} {...options} />;
  };
