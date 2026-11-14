/**
 * Where a machine's setup moves between machines: **Export settings** (a zip of its configuration files, no secrets) and
 * **Copy settings from another machine**, as a Settings tab; and the same Copy as the first run's "Start from…" step,
 * where the person picks a fresh setup or a copy of another machine's.
 */

import { RadioChoices } from '@ferretry/app/ui';
import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { useState } from 'react';
import { CopySettings } from '../features/fleet/setup/copy-settings.tsx';
import { ExportSettings } from '../features/fleet/setup/export-settings.tsx';
import { useAccountChanges } from '../features/fleet/shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../features/fleet/shell/machine-tab.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { machineSettingsView } from './machine-settings-host.tsx';

function Heading({ children }: { readonly children: string }) {
  return <h3 className="m-0 text-row font-semibold text-fg">{children}</h3>;
}

/** Settings › Export & copy. */
function TransferTab({ client, machineName, machine }: MachineTabProps) {
  const changes = useAccountChanges({ client });
  return (
    <div className="flex min-w-0 flex-col gap-8" data-setup-transfer="">
      <ExportSettings client={client} machineName={machineName} />
      <section className="flex min-w-0 flex-col gap-3" data-copy-settings="">
        <Heading>Copy settings from another machine</Heading>
        <CopySettings client={client} machineName={machineName} hasSetup={machine?.setUp === true} changes={changes} />
      </section>
    </div>
  );
}

/** The first run's "Start from…" step. */
function StartStep({ client, machineName, machine }: MachineTabProps) {
  const changes = useAccountChanges({ client });
  const [start, setStart] = useState<'fresh' | 'clone'>('fresh');
  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body="start">
      <RadioChoices
        legend="Start from"
        legendHidden
        name="onboarding-start"
        value={start}
        onChoose={setStart}
        options={[
          { id: 'fresh', title: 'A fresh setup', detail: 'Walk through each step.' },
          {
            id: 'clone',
            title: 'Clone settings from another machine',
            detail:
              'Copy the Warden, learning, voice, agent controls, profiles and runtimes. Secrets and login tokens are never copied.',
          },
        ]}
      />
      {start === 'clone' ? (
        <CopySettings
          client={client}
          machineName={machineName}
          hasSetup={machine?.setUp === true}
          changes={changes}
          onDone={() => setStart('fresh')}
          doneLabel="Continue setup"
        />
      ) : null}
    </div>
  );
}

export const createTransferSettings = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <TransferTab {...props} />);

export const createStartStep = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <StartStep {...props} />);
