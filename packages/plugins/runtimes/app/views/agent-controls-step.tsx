/**
 * The first run's "Agent controls" step (v4's New machine setup): what ferrets on this machine may control, and the
 * runtime a new ferret uses when it names none. Both save through the ordinary preview-and-apply panel, so the step
 * changes nothing until Save; the Runtimes tab shows the same default-runtime control.
 */

import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { useState } from 'react';
import { AgentControlSection } from '../features/fleet/machine/agent-control-section.tsx';
import { DefaultRuntimeControl } from '../features/fleet/runtimes/default-runtime.tsx';
import { useMachineData } from '../features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../features/fleet/shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../features/fleet/shell/machine-tab.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { machineSettingsView } from './machine-settings-host.tsx';

function AgentControlsStep({ client, machine, machineName, checking, onRetry, onRefresh }: MachineTabProps) {
  const changes = useAccountChanges({ client });
  const { data, reload } = useMachineData(client);
  const [picked, setPicked] = useState<string | null>(null);
  if (machine === null)
    return (
      <p role="status" className="m-0 text-cell text-muted" data-onboarding-reading="controls">
        {checking ? `Checking ${machineName}…` : `${machineName}’s controls show once it answers.`}
      </p>
    );
  const refreshed = (): void => {
    (onRefresh ?? onRetry)();
    void reload();
  };
  return (
    <div className="flex min-w-0 flex-col gap-5" data-onboarding-step-body="controls">
      <p className="m-0 text-cell leading-base text-muted">
        What ferrets on {machineName} may control, and the runtime a new ferret uses.
      </p>
      <AgentControlSection
        key={Object.values(machine.agentControl).join(',')}
        machine={machine}
        machineName={machineName}
        changes={changes}
        onSaved={refreshed}
      />
      <DefaultRuntimeControl
        key={machine.defaultRuntime ?? ''}
        machine={machine}
        machineName={machineName}
        runtimes={data?.runtimes.runtimes ?? []}
        changes={changes}
        picked={picked}
        onPick={setPicked}
        onSaved={refreshed}
      />
    </div>
  );
}

/** The Agent controls step's body, drawn once the machine's own view is read. */
export const createAgentControlsStep = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <AgentControlsStep {...props} />);
