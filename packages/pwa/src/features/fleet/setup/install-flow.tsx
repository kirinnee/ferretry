/**
 * Install one tool from Settings, or from a runtime's "isn't installed here" note
 * (docs/design/account-model.md §4.8): the first run's install panel on its own. The command comes
 * from the machine's setup scan, so it is the exact one the machine will run.
 */

import type { FleetSetupScan } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { readFleetSetupScan } from '../setup-api.ts';
import { MachineStepper } from '../shell/machine-stepper.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { type StepperState, startStepper } from '../shell/stepper-model.ts';
import { missingTools } from './first-run-model.ts';
import type { InstallPhase } from './install-model.ts';
import { useSetupAccess } from './setup-access.ts';
import { SetupNote } from './setup-ui.tsx';
import { SETUP_HARNESS_NAMES, type SetupHarness } from './setup-words.ts';
import { ToolInstall } from './tool-install.tsx';

export const INSTALL_FLOW_KIND = 'install';

export interface InstallToolProps extends MachineTabProps {
  readonly harness: SetupHarness;
  /** Back to Settings: after Done, or when the person leaves. */
  readonly onLeave: () => void;
}

export function InstallTool(props: InstallToolProps) {
  const { harness, machineName, connection, createClient, online, checking, onRetry, onLeave } = props;
  const access = useSetupAccess({ connection, createClient });
  const name = SETUP_HARNESS_NAMES[harness];
  const [scan, setScan] = useState<FleetSetupScan | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [phase, setPhase] = useState<InstallPhase>({ kind: 'choose' });
  const [stepper, setStepper] = useState<StepperState>(() =>
    startStepper({
      kind: INSTALL_FLOW_KIND,
      title: `Install ${name}`,
      steps: [{ id: 'install', label: 'Install' }],
      leave: { question: 'Stop installing?', consequence: 'Nothing is installed.', stopLabel: 'Stop' },
      leaveWithoutConfirm: true,
    }),
  );

  const latest = useRef(access);
  latest.current = access;
  const read = useCallback((): void => {
    setIssue(null);
    void latest.current
      .read(client => readFleetSetupScan(client))
      .then(answer => {
        if (answer.kind === 'done') setScan(answer.value);
        else setIssue(answer.sentence);
      });
  }, []);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    read();
  }, [read]);

  const body = (): ReactNode => {
    if (issue !== null)
      return (
        <SetupNote live tone="warn" name="scan-failed" title={`Couldn’t look at ${machineName}`}>
          <span>{issue}</span>
        </SetupNote>
      );
    if (scan === null)
      return (
        <p role="status" className="m-0 text-cell text-muted">
          Looking at what’s on {machineName}…
        </p>
      );
    const tool = missingTools(scan.tools).filter(candidate => candidate.harness === harness);
    const finish = (
      <div className="mt-4">
        <Button type="button" variant="primary" data-install-finish="" onClick={onLeave}>
          Done
        </Button>
      </div>
    );
    if (tool.length === 0 && phase.kind !== 'done')
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <SetupNote tone="ok" name="already-installed" title={`${name} is installed on ${machineName}`} />
          {finish}
        </div>
      );
    return (
      <div className="flex min-w-0 flex-col gap-3" data-install-flow={harness}>
        {phase.kind === 'done' ? null : (
          <p className="m-0 text-cell leading-base text-fg">
            {name} isn’t installed on {machineName}. Ferretry can install it.
          </p>
        )}
        <ToolInstall
          machineName={machineName}
          tools={tool}
          access={access}
          phase={phase}
          onPhase={setPhase}
          onInstalled={() => onRetry()}
          onSkip={onLeave}
        />
        {phase.kind === 'done' ? finish : null}
      </div>
    );
  };

  return (
    <MachineStepper
      state={stepper}
      onChange={next => (next === null ? onLeave() : setStepper(next))}
      machineName={machineName}
      online={online}
      checking={checking}
      onRetry={onRetry}
    >
      {body()}
    </MachineStepper>
  );
}
