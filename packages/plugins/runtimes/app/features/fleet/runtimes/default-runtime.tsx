/**
 * "Default for new agents" on the Runtimes tab: the runtime a start uses when it names none. It is a
 * property of the runtime list, so it sits at the top of that list as ONE row — label, a native select
 * (keyboard and phone picker for free), hint — instead of a card per runtime.
 *
 * Picking one never saves by itself: it shows the ordinary apply panel inline ("Save default runtime" /
 * "Keep <current>"), the same `machine.settings` change the Machine tab used to make. A row's "Make
 * default" fills the same pick, so there is one way to apply it.
 */

import type { MachineView, RuntimeView } from '../../../../contract/index.ts';
import { useId } from 'react';
import { Button } from '../../../ui.ts';
import { machineSettings } from '../machine/machine-settings.ts';
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
  readonly machine: MachineView;
  readonly machineName: string;
  readonly runtimes: readonly RuntimeView[];
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
  const save = (): void => {
    if (picked === null) return;
    void changes.apply(machineSettings(machine, { defaultRuntime: picked })).then(result => {
      if (result.kind === 'refused') return;
      onPick(null);
      onSaved();
    });
  };

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
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save default runtime"
          onSubmit={save}
        >
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
        </ChangeApplyPanel>
      ) : null}
    </div>
  );
}
