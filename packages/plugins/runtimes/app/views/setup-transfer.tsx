/**
 * Where a machine's setup moves between machines: **Export settings** (a zip of its configuration files, no secrets) and
 * **Copy settings from another machine**, as a Settings tab; and the same Copy as the first run's "Start from…" step,
 * where the person picks "Start fresh" or "Copy from another machine": two stacked cards, the example on the right
 * (`StepDemo`), one short line each. Neither card writes: a fresh start has nothing to save, and a copy is its own
 * reviewed change (the Copy panel opens below the cards and marks the step done when it lands).
 */

import { ChoiceCards, StepDemo } from '@ferretry/app';
import { Copy, Sparkles } from 'lucide-react';
import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';
import { CopySettings } from '../features/fleet/setup/copy-settings.tsx';
import { ExportSettings } from '../features/fleet/setup/export-settings.tsx';
import { StartDemo } from '../features/fleet/setup/start-demo.tsx';
import { useAccountChanges } from '../features/fleet/shell/apply-change-panel.tsx';
import type { MachineTabProps } from '../features/fleet/shell/machine-tab.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { machineSettingsView } from './machine-settings-host.tsx';

function Heading({ children }: { readonly children: string }) {
  return <h3 className="m-0 px-1 text-meta font-semibold uppercase tracking-wide text-muted">{children}</h3>;
}

/** Settings › Export & copy. */
function TransferTab({ client, machineName, machine }: MachineTabProps) {
  const changes = useAccountChanges({ client });
  return (
    <div className="fy-fleet flex min-w-0 flex-col gap-8" data-setup-transfer="">
      <ExportSettings client={client} machineName={machineName} />
      <section className="flex min-w-0 flex-col gap-3" data-copy-settings="">
        <Heading>Copy settings from another machine</Heading>
        <CopySettings client={client} machineName={machineName} hasSetup={machine?.setUp === true} changes={changes} />
      </section>
    </div>
  );
}

/** The first run's "Start fresh / Copy from another machine" page. */
function StartStep({ client, machineName, machine, step }: MachineTabProps) {
  const changes = useAccountChanges({ client });
  const [start, setStart] = useState<'fresh' | 'clone'>('fresh');
  const [unmarked, setUnmarked] = useState(false);
  // Under the setup flow the page decides at once: it always shows (the person may copy or start fresh).
  useEffect(() => {
    step?.ready();
  }, [step]);
  // A copy that landed completes this step through onboarding, the way the steps screen's Done does; if that answer is
  // not saved the person is told, and can press Done on the step themselves.
  const markDone = (): void => {
    setUnmarked(false);
    // Drawn as a step, the host records the answer (and moves on); drawn alone, the page answers onboarding itself.
    if (step !== undefined) {
      step.done();
      return;
    }
    void client
      .call('POST /v1/onboarding/steps/:plugin/:stepId', {
        params: { plugin: 'runtimes', stepId: 'start' },
        body: { state: 'done' },
      })
      .catch(() => setUnmarked(true));
  };
  return (
    <div className="flex min-w-0 flex-col gap-4" data-onboarding-step-body="start">
      <ChoiceCards
        label="Start from"
        layout="stack"
        value={start}
        onChange={id => setStart(id === 'clone' ? 'clone' : 'fresh')}
        options={[
          { id: 'fresh', title: 'Start fresh', icon: <Sparkles size={18} />, line: 'Step by step.' },
          {
            id: 'clone',
            title: 'Copy from another machine',
            icon: <Copy size={18} />,
            line: 'Settings only.',
          },
        ]}
      />
      <StepDemo>
        <StartDemo mode={start} />
      </StepDemo>
      {start === 'clone' ? (
        <CopySettings
          client={client}
          machineName={machineName}
          hasSetup={machine?.setUp === true}
          changes={changes}
          onCopied={markDone}
          onDone={() => setStart('fresh')}
          doneLabel="Continue setup"
          compact
        />
      ) : null}
      {unmarked ? (
        <p role="alert" className="m-0 text-cell leading-base text-warn" data-start-unmarked="">
          The copy landed, but this step could not be marked done. Press Done on it below.
        </p>
      ) : null}
    </div>
  );
}

export const createTransferSettings = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <TransferTab {...props} />);

export const createStartStep = (client: LiveRuntimesClient): AppComponent<PanelProps> =>
  machineSettingsView(client, props => <StartStep {...props} />);
