/**
 * "What agents may control" (T): five on/off switches on one machine. Nothing saves by itself: a change shows the
 * ordinary apply panel ("Save what agents may control" / "Undo"), the same `machine.settings` change as every other
 * machine setting, which carries the whole control set so one switch never clobbers another.
 */

import { SetupSection } from '@ferretry/app/ui';
import { useState } from 'react';
import type { AgentControl, MachineView } from '../../../../contract/index.ts';
import { Button } from '../../../ui.ts';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { AGENT_CONTROL_KINDS, AGENT_CONTROL_WORDS } from './agent-control-words.ts';
import { machineSettings } from './machine-settings.ts';
import { SwitchRow } from './switch-row.tsx';

export function AgentControlSection({
  machine,
  machineName,
  changes,
  onSaved,
}: {
  readonly machine: MachineView;
  readonly machineName: string;
  readonly changes: AccountChanges;
  readonly onSaved: () => void;
}) {
  const current = machine.agentControl;
  const [draft, setDraft] = useState<AgentControl>(current);
  const pending = AGENT_CONTROL_KINDS.some(kind => draft[kind] !== current[kind]);
  const save = (): void => {
    void changes.apply(machineSettings(machine, { agentControl: draft })).then(result => {
      if (result.kind !== 'applied') return;
      onSaved();
    });
  };
  return (
    <SetupSection title="What agents may control" name="agent-control">
      <ul className="kt-groupcard m-0 list-none p-0" aria-label="What agents may control" data-agent-control="">
        {AGENT_CONTROL_KINDS.map(kind => (
          <SwitchRow
            key={kind}
            checked={draft[kind]}
            label={AGENT_CONTROL_WORDS[kind].title}
            {...(AGENT_CONTROL_WORDS[kind].hint === undefined ? {} : { hint: AGENT_CONTROL_WORDS[kind].hint })}
            explanation={AGENT_CONTROL_WORDS[kind].detail}
            onChange={on => {
              setDraft({ ...draft, [kind]: on });
              changes.clear();
            }}
          />
        ))}
      </ul>
      <p className="m-0 text-meta leading-base text-muted" data-agent-control-hint="">
        Applies to an agent’s next action on {machineName}; nothing already running is interrupted.
      </p>
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save what agents may control"
          onSubmit={save}
        >
          <Button type="button" data-agent-control-undo="" onClick={() => setDraft(current)}>
            Undo
          </Button>
        </ChangeApplyPanel>
      ) : null}
    </SetupSection>
  );
}
