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
import { type MouseEvent, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { daemonNewSessionPath } from '../../../lib/pages/routes.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import { ImportConversations } from '../conversations/conversation-picker.tsx';
import { credentialEmail } from '../credentials/credentials-model.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { type AccountChanges, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { DisableSwitch, type DisableSwitchParts } from '../shell/disable-switch.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { groupSkipped, type SkippedItem } from '../shell/skipped-model.ts';
import { AddRuntime } from './add-runtime.tsx';
import { type MachineData, machineDetailHash, useMachineData, useMachineDetail } from './machine-data.ts';
import { RemoveRuntimeDialog, RenameRuntimeDialog, RuntimeActionButtons } from './runtime-actions.tsx';
import { runtimeActionRefusal } from './runtime-actions-model.ts';
import {
  harnessInstalled,
  launchLabel,
  layerRows,
  modelRows,
  modelSetNote,
  runtimeDefaultModel,
  runtimeProfileLine,
} from './runtimes-model.ts';
import { SkippedLine } from './skipped-line.tsx';

/** The status shape a runtime shows: its login's. */
const runtimeWord = (runtime: FleetRuntimeView) => runtime.credential.status ?? 'checking';

const loginLine = (runtime: FleetRuntimeView, data: MachineData): string => {
  const credential = data.credentials.credentials.find(item => item.id === runtime.credential.id);
  const email = credential === undefined ? 'Unknown login' : credentialEmail(credential);
  return runtime.credential.label === undefined ? email : `${email} (${runtime.credential.label})`;
};

/** The link to the New session form with this runtime picked, by its wrapper. A hint only: the form decides. */
export const launchHref = (connection: DaemonConnection, wrapper: string): string =>
  `${daemonNewSessionPath(connection.daemonId)}?agent=${encodeURIComponent(wrapper)}`;

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
      <a href={machineDetailHash(machineName, 'machine')} className="font-semibold text-accent underline">
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
  /** Why this browser may not rename or remove it, or `null`. */
  readonly refusal: string | null;
  readonly onAct: (act: RuntimeAct) => void;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
  /** What the last change left as it was in this runtime. */
  readonly skipped: readonly SkippedItem[];
}

/** The switch on a runtime: its own, or its login's when that is what holds it off. */
function RuntimeSwitch({
  runtime,
  machineName,
  online,
  changes,
  reload,
  compact,
  children,
}: {
  readonly runtime: FleetRuntimeView;
  readonly machineName: string;
  readonly online: boolean;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
  readonly compact?: boolean;
  readonly children?: (parts: DisableSwitchParts) => React.ReactNode;
}) {
  return (
    <DisableSwitch
      {...(compact === undefined ? {} : { compact })}
      {...(children === undefined ? {} : { children })}
      target={{ kind: 'runtime', name: runtime.name }}
      disabled={runtime.disabled}
      login={{ id: runtime.credential.id, href: machineDetailHash(machineName, 'credentials', runtime.credential.id) }}
      machineName={machineName}
      online={online}
      changes={changes}
      onChanged={reload}
    />
  );
}

function RuntimePage({
  runtime,
  data,
  machine,
  machineName,
  online,
  connection,
  onBack,
  refusal,
  onAct,
  changes,
  reload,
  skipped,
}: RuntimePageProps) {
  const installed = harnessInstalled(machine, runtime.harness);
  const word = runtimeWord(runtime);
  const profile = data.profiles.profiles.find(item => item.name === runtime.profile);
  const layers = profile === undefined ? [] : layerRows(profile, data.components, runtime.harness);
  const models = modelRows(runtime);
  const canLaunch = online && runtime.launch.available;
  return (
    <section className="flex min-w-0 flex-col gap-4" data-runtime-page={runtime.name}>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start"
          data-page-back=""
          onClick={onBack}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Runtimes
        </Button>
        <h3 className="m-0 mt-2 break-all font-mono text-title font-semibold text-fg">{runtime.name}</h3>
        <p className="m-0 mt-1 flex items-center gap-2 text-cell text-muted">
          <AccountStatus word={word} showLabel />
          {runtime.agent ? <span>· Agent runtime</span> : null}
        </p>
        <div className="mt-3 flex flex-col gap-1">
          <RuntimeActionButtons
            runtime={runtime}
            refusal={refusal}
            onRename={() => onAct({ kind: 'rename', name: runtime.name })}
            onRemove={() => onAct({ kind: 'remove', name: runtime.name })}
          />
          {refusal === null ? null : (
            <p className="m-0 text-meta leading-base text-warn" data-runtime-actions-refused="">
              {refusal}
            </p>
          )}
        </div>
      </div>

      <RuntimeSwitch runtime={runtime} machineName={machineName} online={online} changes={changes} reload={reload} />

      <SkippedLine name={runtime.name} items={skipped} />

      {installed ? null : (
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel" data-runtime-note="missing">
          <p className="m-0 text-row font-semibold text-fg">{HARNESS_NAMES[runtime.harness]} isn’t installed here</p>
          <p className="m-0 text-cell text-muted">Install it on {machineName} to launch this runtime.</p>
          <a href={machineDetailHash(machineName, 'machine')} className="text-cell font-semibold text-accent underline">
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
          className="kt-panel flex min-h-control min-w-0 items-center gap-3 p-panel no-underline hover:border-accent hover:no-underline"
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
          className="kt-panel flex min-h-control min-w-0 items-center gap-3 p-panel no-underline hover:border-accent hover:no-underline"
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
                  className={cn(
                    'kt-panel flex min-w-0 items-start gap-3 px-panel py-row-y',
                    layer.skipped && 'opacity-60',
                  )}
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
                            className="max-w-full !whitespace-normal"
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
                <li key={entry.key} className="kt-panel flex min-w-0 items-center gap-2 px-panel py-row-y text-cell">
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
            href={launchHref(connection, runtime.wrapper)}
            onClick={event => followInApp(event)}
            className="kt-btn w-full justify-center no-underline hover:no-underline"
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
  online,
  refusal,
  onAct,
  changes,
  reload,
  skipped,
}: {
  readonly runtime: FleetRuntimeView;
  readonly data: MachineData;
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  readonly refusal: string | null;
  readonly onAct: (act: RuntimeAct) => void;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
  readonly skipped: readonly SkippedItem[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="kt-panel relative flex min-w-0 flex-col gap-2 p-panel has-[a:hover]:border-accent"
        data-runtime-card={runtime.name}
      >
        <RuntimeSwitch
          compact
          runtime={runtime}
          machineName={machineName}
          online={online}
          changes={changes}
          reload={reload}
        >
          {({ toggle, details }) => (
            <>
              <div className="flex min-w-0 items-start gap-3">
                <a
                  href={machineDetailHash(machineName, 'runtimes', runtime.name)}
                  className="flex min-h-control min-w-0 flex-1 items-start gap-3 text-left no-underline after:absolute after:inset-0 after:content-[''] hover:no-underline"
                  data-runtime-row={runtime.name}
                >
                  <AccountStatus word={runtimeWord(runtime)} className="mt-1" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate font-mono text-row font-semibold text-fg">{runtime.name}</span>
                    <span className="break-words text-cell text-muted">
                      <span className="font-mono">{loginLine(runtime, data)}</span> · {runtime.profile} profile ·{' '}
                      {runtimeDefaultModel(runtime)}
                    </span>
                    {runtime.agent || runtime.disabled !== undefined ? (
                      <span className="flex flex-wrap gap-1">
                        {runtime.agent ? <Badge tone="accent">Agent</Badge> : null}
                        {runtime.disabled === undefined ? null : (
                          <Badge tone="warn" data-runtime-disabled-badge="">
                            Disabled
                          </Badge>
                        )}
                      </span>
                    ) : null}
                  </span>
                </a>
                {toggle}
                <ChevronRight size={16} aria-hidden="true" className="mt-1 shrink-0 text-muted" />
              </div>
              {details}
            </>
          )}
        </RuntimeSwitch>
        <div className="relative flex flex-wrap items-start justify-end gap-2 border-t border-border-soft pt-2">
          <RuntimeActionButtons
            runtime={runtime}
            refusal={refusal}
            onRename={() => onAct({ kind: 'rename', name: runtime.name })}
            onRemove={() => onAct({ kind: 'remove', name: runtime.name })}
          />
        </div>
      </div>
      {harnessInstalled(machine, runtime.harness) ? null : (
        <MissingHarness runtime={runtime} machineName={machineName} />
      )}
      <SkippedLine name={runtime.name} items={skipped} />
    </div>
  );
}

/** A rename or a removal the person opened, by the runtime's name. */
interface RuntimeAct {
  readonly kind: 'rename' | 'remove';
  readonly name: string;
}

export interface RuntimesTabOptions {
  /** Supplied in tests. */
  readonly pollMs?: number;
}

export function RuntimesTab({
  connection,
  machineName,
  machine,
  online,
  createClient,
  pollMs,
  onRetry,
  onRefresh,
}: MachineTabProps & RuntimesTabOptions) {
  const { state, data, reload } = useMachineData(connection, createClient);
  const changes = useAccountChanges({ connection, createClient });
  const [detail, openDetail] = useMachineDetail(machineName, 'runtimes');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [act, setAct] = useState<RuntimeAct | null>(null);
  const refusal = runtimeActionRefusal(changes.authority);

  // M3: a machine that is not set up has no runtimes; the banner above the tabs resumes its setup.
  if (machine !== null && !machine.setUp)
    return (
      <div className="kt-panel flex flex-col items-start gap-1 p-panel" data-runtimes-not-set-up="">
        <h3 className="m-0 text-row font-semibold text-fg">No runtimes on {machineName} yet</h3>
        <p className="m-0 text-cell leading-base text-muted">
          Finish setting it up above to bring in your Claude Code and Codex setup.
        </p>
      </div>
    );

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

  if (adding)
    return (
      <AddRuntime
        data={data}
        reload={reload}
        changes={changes}
        machine={machine}
        machineName={machineName}
        online={online}
        connection={connection}
        createClient={createClient}
        {...(pollMs === undefined ? {} : { pollMs })}
        onFinish={open => {
          setAdding(false);
          openDetail(open);
        }}
      />
    );

  if (importing)
    return (
      <ImportConversations
        connection={connection}
        createClient={createClient}
        runtimes={data.runtimes.runtimes}
        onBack={() => setImporting(false)}
      />
    );

  const start = (): void => {
    changes.clear();
    setAdding(true);
  };

  const open = (next: RuntimeAct): void => {
    changes.clear();
    setAct(next);
  };

  const acting = act === null ? undefined : data.runtimes.runtimes.find(item => item.name === act.name);
  const dialog =
    act === null || acting === undefined ? null : act.kind === 'rename' ? (
      <RenameRuntimeDialog
        runtime={acting}
        runtimes={data.runtimes.runtimes}
        machineName={machineName}
        changes={changes}
        onClose={() => setAct(null)}
        onRenamed={name => {
          setAct(null);
          // The page follows the runtime to its new name; the list simply reads again.
          if (detail === acting.name) openDetail(name);
          void reload();
        }}
      />
    ) : (
      <RemoveRuntimeDialog
        runtime={acting}
        runtimes={data.runtimes.runtimes}
        machine={machine}
        machineName={machineName}
        changes={changes}
        connection={connection}
        createClient={createClient}
        onClose={() => setAct(null)}
        onMachineChanged={() => (onRefresh ?? onRetry)()}
        onRemoved={() => {
          setAct(null);
          if (detail === acting.name) openDetail(null);
          void reload();
        }}
      />
    );

  const grouped = groupSkipped(changes.skipped, data.runtimes.runtimes);
  const runtime = detail === null ? undefined : data.runtimes.runtimes.find(item => item.name === detail);
  if (runtime !== undefined)
    return (
      <>
        <RuntimePage
          runtime={runtime}
          data={data}
          machine={machine}
          machineName={machineName}
          online={online}
          connection={connection}
          onBack={() => openDetail(null)}
          refusal={refusal}
          onAct={open}
          changes={changes}
          reload={reload}
          skipped={grouped.byRuntime.get(runtime.name) ?? []}
        />
        {dialog}
      </>
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
            <span className="flex flex-wrap gap-2">
              <Button type="button" data-import-conversations-open="" onClick={() => setImporting(true)}>
                Import conversations…
              </Button>
              <Button type="button" variant="primary" data-add-runtime="" onClick={start}>
                <Plus size={16} aria-hidden="true" />
                Add runtime
              </Button>
            </span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {runtimes.map(item => (
              <li key={item.name}>
                <RuntimeRow
                  runtime={item}
                  data={data}
                  machine={machine}
                  machineName={machineName}
                  online={online}
                  refusal={refusal}
                  onAct={open}
                  changes={changes}
                  reload={reload}
                  skipped={grouped.byRuntime.get(item.name) ?? []}
                />
              </li>
            ))}
          </ul>
          <SkippedLine name="elsewhere" items={grouped.elsewhere} />
          {refusal === null ? null : (
            <p className="m-0 text-meta leading-base text-warn" data-runtime-actions-refused="">
              Rename and Remove are off here: {refusal}
            </p>
          )}
        </>
      )}
      {dialog}
    </section>
  );
}
