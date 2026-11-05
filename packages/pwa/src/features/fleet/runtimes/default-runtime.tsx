/**
 * "Default for new agents" on the Runtimes tab: the runtime a start uses when it names none. It is a
 * property of the runtime list, so it sits at the top of that list as ONE row — label, a native select
 * (keyboard and phone picker for free), hint — instead of a card per runtime.
 *
 * Picking one never saves by itself: it shows the ordinary apply panel inline ("Save default runtime" /
 * "Keep <current>"), the same `machine.settings` change the Machine tab used to make. A row's "Make
 * default" fills the same pick, so there is one way to apply it.
 */

import type { FleetMachineView, FleetRuntimeView } from '@ferretry/protocol';
import { useContext, useEffect, useId, useLayoutEffect, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { readFleetRuntimes } from '../catalog-api.ts';
import { MachineEditContext, machineSettings } from '../machine/machine-settings.ts';
import type { SetupAccess } from '../setup/setup-access.ts';
import { SetupSection } from '../setup/setup-ui.tsx';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import {
  AUTOMATIC_DEFAULT,
  agentRuntimes,
  DEFAULT_RUNTIME_HINT,
  DEFAULT_RUNTIME_LABEL,
  defaultOptionLabel,
  keepDefaultLabel,
} from './default-runtime-model.ts';

export interface DefaultRuntimeControlProps {
  readonly machine: FleetMachineView;
  readonly machineName: string;
  readonly runtimes: readonly FleetRuntimeView[];
  readonly changes: AccountChanges;
  /** The runtime picked but not saved, or `null` while the select shows what is saved. */
  readonly picked: string | null;
  readonly onPick: (name: string | null) => void;
  /** A save went through: the machine and its runtimes are read again. */
  readonly onSaved: () => void;
}

export function DefaultRuntimeControl({
  machine,
  machineName,
  runtimes,
  changes,
  picked,
  onPick,
  onSaved,
}: DefaultRuntimeControlProps) {
  const id = useId();
  const candidates = agentRuntimes(runtimes);
  const current = machine.defaultRuntime;
  const shown = picked ?? current ?? '';
  const pending = picked !== null && picked !== current;
  // In setup the page saves every section at once; this one only says what it changed.
  const report = useContext(MachineEditContext);
  useLayoutEffect(() => {
    if (report === null || !pending) return undefined;
    report('defaultRuntime', { defaultRuntime: picked });
    return () => report('defaultRuntime', null);
  }, [report, pending, picked]);
  const save = (): void => {
    if (picked === null) return;
    void changes.apply(machineSettings(machine, { defaultRuntime: picked })).then(result => {
      if (result.kind === 'refused') return;
      onPick(null);
      onSaved();
    });
  };

  const keep = (
    <Button
      type="button"
      data-default-runtime-undo=""
      onClick={() => {
        changes.clear();
        onPick(null);
      }}
    >
      {keepDefaultLabel(current)}
    </Button>
  );

  if (candidates.length === 0)
    return (
      <p className="m-0 text-cell text-muted" data-default-runtime-empty="">
        {machineName} has no agent runtime yet. Add an agent runtime, then pick it here.
      </p>
    );

  return (
    <div className="flex min-w-0 flex-col gap-2" data-default-runtime="">
      <div className="flex min-w-0 flex-col gap-1 md:flex-row md:flex-wrap md:items-center md:gap-3">
        <label htmlFor={id} className="shrink-0 text-cell font-semibold text-fg">
          {DEFAULT_RUNTIME_LABEL}
        </label>
        <select
          id={id}
          aria-describedby={`${id}-hint`}
          className="kt-input w-full min-w-0 md:w-auto md:min-w-64 md:max-w-full"
          data-default-runtime-select=""
          value={shown}
          onChange={event => {
            changes.clear();
            const value = event.target.value;
            onPick(value === '' || value === current ? null : value);
          }}
        >
          {current === null ? <option value="">{AUTOMATIC_DEFAULT}</option> : null}
          {candidates.map(runtime => (
            <option
              key={runtime.name}
              value={runtime.name}
              disabled={runtime.disabled !== undefined && runtime.name !== shown}
            >
              {defaultOptionLabel(runtime, machine)}
            </option>
          ))}
        </select>
        <p className="m-0 text-meta leading-base text-muted" data-default-runtime-hint="" id={`${id}-hint`}>
          {DEFAULT_RUNTIME_HINT}
        </p>
      </div>
      {!pending ? null : report !== null ? (
        <div>{keep}</div>
      ) : (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save default runtime"
          onSubmit={save}
        >
          {keep}
        </ChangeApplyPanel>
      )}
    </div>
  );
}

/**
 * The same control for a place that has no runtimes list around it (the first-run Controls step): it
 * reads the runtimes itself, once, and keeps its own pick. Hidden while that read has not answered.
 */
export function DefaultRuntimeSection({
  machine,
  machineName,
  access,
  onSaved,
}: {
  readonly machine: FleetMachineView;
  readonly machineName: string;
  readonly access: SetupAccess;
  readonly onSaved: () => void;
}) {
  const [runtimes, setRuntimes] = useState<readonly FleetRuntimeView[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const { read, changes } = access;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the machine's own facts change, not on every render
  useEffect(() => {
    setRuntimes(null);
    void read(client => readFleetRuntimes(client)).then(result => {
      if (result.kind === 'done') setRuntimes(result.value.runtimes);
    });
  }, [machine.name, machine.runtimeCount, read]);
  if (runtimes === null) return null;
  return (
    <SetupSection title={DEFAULT_RUNTIME_LABEL} name="default-runtime">
      <DefaultRuntimeControl
        machine={machine}
        machineName={machineName}
        runtimes={runtimes}
        changes={changes}
        picked={picked}
        onPick={setPicked}
        onSaved={onSaved}
      />
    </SetupSection>
  );
}
