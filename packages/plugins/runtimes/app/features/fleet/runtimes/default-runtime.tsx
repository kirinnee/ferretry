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
import { Badge, Button, SelectBox } from '../../../ui.ts';
import { machineSettings } from '../machine/machine-settings.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { Block, FleetGroup } from '../shell/fleet-group.tsx';
import {
  AUTOMATIC_DEFAULT,
  DEFAULT_RUNTIME_HINT,
  DEFAULT_RUNTIME_LABEL,
  defaultOptionLabel,
  keepDefaultLabel,
  runtimeStateWords,
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
  const candidates = runtimes;
  const current = machine.defaultRuntime;
  const shown = picked ?? current ?? '';
  const pending = picked !== null && picked !== current;
  const shownRuntime = candidates.find(runtime => runtime.name === shown);
  const currentRuntime = candidates.find(runtime => runtime.name === current);
  // "Keep" says the runtime in the words the list shows it in; a default the roster no longer holds is named as stored.
  const currentWords = currentRuntime === undefined ? current : defaultOptionLabel(currentRuntime, candidates);
  const stateWords = shownRuntime === undefined ? null : runtimeStateWords(shownRuntime, machine);
  const save = (): void => {
    if (picked === null) return;
    void changes.apply(machineSettings(machine, { defaultRuntime: picked })).then(result => {
      if (result.kind !== 'applied') return;
      onPick(null);
      onSaved();
    });
  };

  if (candidates.length === 0)
    return (
      <p className="m-0 text-cell text-muted" data-default-runtime-empty="">
        {machineName} has no runtime yet. Add a login, then pick its runtime here.
      </p>
    );

  return (
    <div data-default-runtime="">
      <FleetGroup label={DEFAULT_RUNTIME_LABEL} name="default-runtime">
        <Block>
          {/* The select is as wide as its longest option up to 24rem, and never wider than the panel it sits in; the picked runtime's state is a badge beside it, never part of an option's name. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <span className="contents" data-default-runtime-select="">
              <SelectBox
                id={id}
                label={DEFAULT_RUNTIME_LABEL}
                aria-describedby={`${id}-hint`}
                className="min-w-0 w-full max-w-sm"
                value={shown}
                onChange={value => {
                  changes.clear();
                  onPick(value === '' || value === current ? null : value);
                }}
                options={[
                  ...(current === null ? [{ value: '', label: AUTOMATIC_DEFAULT }] : []),
                  ...candidates.map(runtime => ({
                    value: runtime.name,
                    label: defaultOptionLabel(runtime, candidates),
                    disabled: runtime.disabled !== undefined && runtime.name !== shown,
                  })),
                ]}
              />
            </span>
            {stateWords === null ? null : (
              <Badge
                tone={
                  stateWords === 'ready'
                    ? 'ok'
                    : stateWords === 'checking' || stateWords === 'refresh due'
                      ? 'pend'
                      : 'warn'
                }
                data-default-runtime-state=""
              >
                {stateWords}
              </Badge>
            )}
          </div>
          <p className="m-0 text-meta leading-base text-muted" data-default-runtime-hint="" id={`${id}-hint`}>
            {DEFAULT_RUNTIME_HINT}
          </p>
          {(machine.notices ?? []).map(notice => (
            <p className="m-0 text-meta leading-base text-warn" data-default-runtime-notice="" key={notice}>
              {notice}
            </p>
          ))}
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
                {keepDefaultLabel(currentWords)}
              </Button>
            </ChangeApplyPanel>
          ) : null}
        </Block>
      </FleetGroup>
    </div>
  );
}
