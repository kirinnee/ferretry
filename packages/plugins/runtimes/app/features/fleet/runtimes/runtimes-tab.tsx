/**
 * The Runtimes tab (docs/design/account-model.md §4.2): what you launch on this machine — each a login
 * plus a profile — and each runtime's own page: its login, its profile's layers newest on top, its
 * model set, the fixed layer Ferretry adds last for an agent runtime, and Launch.
 *
 * Today's "Import conversations…" button is a link to Conversation's `links` screen (V-0285): the verb is now
 * Conversation's `fy link`, so the screen that lists, previews and keeps conversations is Conversation's to draw.
 *
 * Launch never starts anything by itself. It opens the ordinary New session form with this runtime
 * picked, so the person still chooses the folder and says what they want; it is a click, never a load.
 */

import { daemonHomeHref } from '@ferretry/app';
import type { MachineView, RuntimeView } from '../../../../contract/index.ts';
import { ChevronLeft, ChevronRight, Lock, Plus, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cn } from '../../../ui.ts';
import { Badge, Button } from '../../../ui.ts';
import { HARNESS_NAMES } from '../components/component-model.ts';
import { credentialEmail } from '../../../lib/logins-view.ts';
import { CONVERSATIONS_HREF } from '../../../lib/conversations-link.ts';
import { type MoveFerret, moveFerretWith } from '../../../lib/move-ferret.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { type AccountChanges, useAccountChanges } from '../shell/apply-change-panel.tsx';
import { DisableSwitch, type DisableSwitchParts } from '../shell/disable-switch.tsx';
import { currentDaemon, followInApp, harnessHref, tabHref } from '../shell/machine-route.ts';
import type { MachineTabProps } from '../shell/machine-tab.ts';
import { skippedItems } from '../shell/skipped-model.ts';
import { AddRuntime } from './add-runtime.tsx';
import { DefaultRuntimeControl } from './default-runtime.tsx';
import { isDefaultRuntime } from './default-runtime-model.ts';
import { type MachineData, machineDetailHash, useMachineData, useMachineDetail } from './machine-data.ts';
import {
  RemoveRuntimeDialog,
  RenameRuntimeDialog,
  RuntimeActionButtons,
  RuntimeActionsMenu,
} from './runtime-actions.tsx';
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
const runtimeWord = (runtime: RuntimeView) => runtime.credential.status ?? 'checking';

const loginLine = (runtime: RuntimeView, data: MachineData): string => {
  const credential = data.credentials.logins.find(item => item.id === runtime.credential.id);
  const email = credential === undefined ? 'Unknown login' : credentialEmail(credential);
  return runtime.credential.label === undefined ? email : `${email} (${runtime.credential.label})`;
};

/**
 * The link to the New session form with this runtime picked, by its wrapper. A hint only: the form decides.
 *
 * GAP(ferrets): no manifest declares the new-ferret page (`/new`) yet, so this link opens nothing until Ferrets' app
 * half draws it; the launch button stays, because the address is the contract the page will read.
 */
export const launchHref = (daemon: string | null, wrapper: string): string =>
  `${daemon === null ? '' : daemonHomeHref(daemon)}/new?agent=${encodeURIComponent(wrapper)}`;

function MissingHarness({ runtime }: { readonly runtime: RuntimeView }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-1 text-cell text-warn" data-runtime-missing-harness="">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{HARNESS_NAMES[runtime.harness]} isn’t installed here</span> ·{' '}
      <a
        href={harnessHref(currentDaemon(), runtime.harness)}
        onClick={followInApp}
        className="font-semibold text-accent underline"
      >
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
  readonly runtime: RuntimeView;
  readonly data: MachineData;
  readonly machine: MachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  readonly onBack: () => void;
  /** Why this browser may not rename or remove it, or `null`. */
  readonly refusal: string | null;
  readonly onAct: (act: RuntimeAct) => void;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
}

/** A card's second and later lines start under the name: the status glyph's width (w-4) plus the gap (gap-2). */
const ROW_INDENT = 'pl-6';

/** The switch on a runtime: its own, or its login's when that is what holds it off. */
function RuntimeSwitch({
  runtime,
  machineName,
  online,
  changes,
  reload,
  compact,
  detailsClassName,
  children,
}: {
  readonly runtime: RuntimeView;
  readonly machineName: string;
  readonly online: boolean;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
  readonly compact?: boolean;
  readonly detailsClassName?: string;
  readonly children?: (parts: DisableSwitchParts) => React.ReactNode;
}) {
  return (
    <DisableSwitch
      {...(compact === undefined ? {} : { compact })}
      {...(detailsClassName === undefined ? {} : { className: detailsClassName })}
      {...(children === undefined ? {} : { children })}
      target={{ kind: 'runtime', name: runtime.name }}
      disabled={runtime.disabled}
      login={{
        id: runtime.credential.id,
        href: tabHref(currentDaemon(), machineName, 'sign-ins', runtime.credential.id),
      }}
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
  onBack,
  refusal,
  onAct,
  changes,
  reload,
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

      <SkippedLine name={runtime.name} items={skippedItems(runtime)} />

      {installed ? null : (
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel" data-runtime-note="missing">
          <p className="m-0 text-row font-semibold text-fg">{HARNESS_NAMES[runtime.harness]} isn’t installed here</p>
          <p className="m-0 text-cell text-muted">Install it on {machineName} to launch this runtime.</p>
          <a
            href={harnessHref(currentDaemon(), runtime.harness)}
            onClick={followInApp}
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
            href={tabHref(currentDaemon(), machineName, 'sign-ins', runtime.credential.id)}
            onClick={followInApp}
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
          href={tabHref(currentDaemon(), machineName, 'sign-ins', runtime.credential.id)}
          onClick={followInApp}
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
          href={tabHref(currentDaemon(), machineName, 'profiles', runtime.profile)}
          onClick={followInApp}
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
            href={launchHref(currentDaemon(), runtime.wrapper)}
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
  onMakeDefault,
  changes,
  reload,
}: {
  readonly runtime: RuntimeView;
  readonly data: MachineData;
  readonly machine: MachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  readonly refusal: string | null;
  readonly onAct: (act: RuntimeAct) => void;
  /** Offered on an agent runtime that is not the default; absent while the machine has not answered. */
  readonly onMakeDefault?: (name: string) => void;
  readonly changes: AccountChanges;
  readonly reload: () => Promise<unknown>;
}) {
  const showMakeDefault =
    onMakeDefault !== undefined &&
    runtime.agent &&
    runtime.disabled === undefined &&
    !isDefaultRuntime(machine, runtime);
  const detailsLine = `${loginLine(runtime, data)} · ${runtime.profile} profile · ${runtimeDefaultModel(runtime)}`;
  return (
    <div className="flex flex-col gap-1">
      <div
        className="kt-panel relative flex min-w-0 flex-col gap-1 p-panel has-[a:hover]:border-accent"
        data-runtime-card={runtime.name}
      >
        <RuntimeSwitch
          compact
          detailsClassName={`${ROW_INDENT} empty:hidden`}
          runtime={runtime}
          machineName={machineName}
          online={online}
          changes={changes}
          reload={reload}
        >
          {({ toggle, details }) => (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <a
                  href={machineDetailHash(machineName, 'runtimes', runtime.name)}
                  className="flex min-h-control min-w-0 flex-1 items-start gap-2 py-1 text-left no-underline after:absolute after:inset-0 after:content-[''] hover:no-underline"
                  data-runtime-row={runtime.name}
                >
                  <AccountStatus
                    word={runtimeWord(runtime)}
                    className="min-h-[calc(var(--control-h)-0.5rem)] w-4 shrink-0 justify-center"
                  />
                  <span
                    className="flex min-h-[calc(var(--control-h)-0.5rem)] min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"
                    data-runtime-name-row=""
                  >
                    <span
                      className="max-w-full shrink-0 break-words font-mono text-row font-semibold text-fg"
                      data-runtime-name=""
                    >
                      {runtime.name}
                    </span>
                    {isDefaultRuntime(machine, runtime) ? (
                      <Badge tone="ok" className="shrink-0" data-runtime-default-badge="">
                        Default
                      </Badge>
                    ) : null}
                    {runtime.agent ? null : (
                      <Badge className="shrink-0" data-runtime-kind-badge="">
                        Not agent
                      </Badge>
                    )}
                  </span>
                </a>
                {toggle}
                <RuntimeActionsMenu
                  runtime={runtime}
                  refusal={refusal}
                  onRename={() => onAct({ kind: 'rename', name: runtime.name })}
                  onRemove={() => onAct({ kind: 'remove', name: runtime.name })}
                  {...(showMakeDefault ? { onMakeDefault: () => onMakeDefault(runtime.name) } : {})}
                />
              </div>
              <span
                className={`${ROW_INDENT} truncate text-cell text-muted`}
                title={detailsLine}
                data-runtime-details=""
              >
                <span className="font-mono">{loginLine(runtime, data)}</span> · {runtime.profile} profile ·{' '}
                {runtimeDefaultModel(runtime)}
              </span>
              {details}
            </>
          )}
        </RuntimeSwitch>
        <SkippedLine name={runtime.name} items={skippedItems(runtime)} className={ROW_INDENT} />
      </div>
      {harnessInstalled(machine, runtime.harness) ? null : <MissingHarness runtime={runtime} />}
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
  /**
   * Moves one ferret onto another runtime, restarting it there with its conversation. Absent, it is Ferrets' declared
   * move route over `client` (R-0355); a test supplies its own.
   */
  readonly moveFerret?: MoveFerret;
}

export function RuntimesTab({
  client,
  machineName,
  machine,
  online,
  pollMs,
  moveFerret: suppliedMove,
  onRetry,
  onRefresh,
}: MachineTabProps & RuntimesTabOptions) {
  const moveFerret = useMemo(() => suppliedMove ?? moveFerretWith(client), [suppliedMove, client]);
  const { state, data, reload } = useMachineData(client);
  const changes = useAccountChanges({ client });
  const [detail, openDetail] = useMachineDetail(machineName, 'runtimes');
  const [adding, setAdding] = useState(false);
  const [act, setAct] = useState<RuntimeAct | null>(null);
  const [pickedDefault, setPickedDefault] = useState<string | null>(null);
  const defaultRef = useRef<HTMLDivElement | null>(null);
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
        {...(pollMs === undefined ? {} : { pollMs })}
        onFinish={open => {
          setAdding(false);
          openDetail(open);
        }}
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
        moveFerret={moveFerret}
        onClose={() => setAct(null)}
        onMachineChanged={() => (onRefresh ?? onRetry)()}
        onRemoved={() => {
          setAct(null);
          if (detail === acting.name) openDetail(null);
          void reload();
        }}
      />
    );

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
          onBack={() => openDetail(null)}
          refusal={refusal}
          onAct={open}
          changes={changes}
          reload={reload}
        />
        {dialog}
      </>
    );

  const runtimes = data.runtimes.runtimes;
  // A row's Make default fills the control's pick, so the one apply panel is the only way to save it.
  const makeDefault = (name: string): void => {
    changes.clear();
    setPickedDefault(name);
    defaultRef.current?.scrollIntoView?.({ block: 'nearest' });
  };
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
          {machine === null ? null : (
            <div ref={defaultRef} className="scroll-mt-4 border-b border-border-soft pb-4">
              <DefaultRuntimeControl
                machine={machine}
                machineName={machineName}
                runtimes={runtimes}
                changes={changes}
                picked={pickedDefault}
                onPick={setPickedDefault}
                onSaved={() => {
                  (onRefresh ?? onRetry)();
                  void reload();
                }}
              />
            </div>
          )}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-cell text-muted" data-runtimes-count="">
              {runtimes.length} {runtimes.length === 1 ? 'runtime' : 'runtimes'} on {machineName}
            </p>
            <span className="flex flex-wrap gap-2">
              <Button type="button" variant="primary" data-add-runtime="" onClick={start}>
                <Plus size={16} aria-hidden="true" />
                Add runtime
              </Button>
              <a
                className="inline-flex min-h-control items-center text-cell font-semibold text-accent underline"
                href={CONVERSATIONS_HREF}
                data-import-conversations-link=""
                onClick={followInApp}
              >
                Import conversations
              </a>
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
                  {...(machine === null ? {} : { onMakeDefault: makeDefault })}
                  changes={changes}
                  reload={reload}
                />
              </li>
            ))}
          </ul>
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
