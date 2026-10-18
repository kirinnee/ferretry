/**
 * Install what's missing (docs/design/account-model.md §4.3 step 1, §4.8, §8.6, E1, E2).
 *
 * One checkbox per missing tool, each showing the EXACT command the machine will run; then **Install n
 * tools**. The install is one request that answers when it is done, so while it runs the panel says
 * "this can take a minute" instead of freezing a button. A failure says why and gives the command to
 * run by hand, with **Retry** (E2).
 *
 * The gate is the shared one: `SetupAccess.act`; a caller off the machine is asked for its passkey by the
 * carrier when the daemon wants one.
 */

import type { FleetToolInstallResult } from '@ferretry/protocol';
import { Spinner } from '../../../components/spinner.tsx';
import { useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { installFleetTools } from '../setup-api.ts';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import {
  type InstallPhase,
  installedSentence,
  installingSentence,
  installLabel,
  type MissingTool,
  phaseAfter,
  runnableTools,
  toolCommand,
} from './install-model.ts';
import type { SetupAccess } from './setup-access.ts';
import { CheckChoices, SetupCommand, SetupNote } from './setup-ui.tsx';
import { SETUP_HARNESS_NAMES, type SetupHarness } from './setup-words.ts';

export interface ToolInstallProps {
  readonly machineName: string;
  /** The tools that are missing, with the plan the scan read for each. */
  readonly tools: readonly MissingTool[];
  readonly access: SetupAccess;
  readonly phase: InstallPhase;
  readonly onPhase: (phase: InstallPhase) => void;
  /** Called once every picked tool installed. */
  readonly onInstalled: (harnesses: readonly SetupHarness[]) => void;
  /** "Skip, continue without them", offered beside Retry. */
  readonly onSkip?: () => void;
  /** Said under "Installed …": what happens next. */
  readonly doneHint?: string;
}

export function ToolInstall({
  machineName,
  tools,
  access,
  phase,
  onPhase,
  onInstalled,
  onSkip,
  doneHint,
}: ToolInstallProps) {
  const runnable = runnableTools(tools);
  const [picked, setPicked] = useState<readonly SetupHarness[]>(() => runnable.map(tool => tool.harness));
  const { changes } = access;

  const install = (harnesses: readonly SetupHarness[]): void => {
    onPhase({ kind: 'running', harnesses });
    void access
      .act(
        async (client): Promise<FleetToolInstallResult> =>
          await installFleetTools(client, { harnesses: [...harnesses] }),
      )
      .then(result => {
        if (result.kind === 'refused') {
          onPhase({ kind: 'choose' });
          return;
        }
        const next = phaseAfter(harnesses, result.value.outcomes);
        onPhase(next);
        if (next.kind === 'done') onInstalled(next.installed);
      });
  };

  if (phase.kind === 'running')
    return (
      <SetupNote
        live
        name="installing"
        title={
          <span className="flex items-center gap-2">
            <Spinner size={16} />
            {installingSentence(phase.harnesses, machineName)}
          </span>
        }
      >
        <span>This can take a minute. {machineName} answers when it has finished.</span>
        {tools
          .filter(tool => phase.harnesses.includes(tool.harness))
          .map(tool => (
            <SetupCommand key={tool.harness}>{toolCommand(tool)}</SetupCommand>
          ))}
      </SetupNote>
    );

  if (phase.kind === 'done')
    return (
      <SetupNote live tone="ok" name="installed" title={installedSentence(phase.installed)}>
        {doneHint === undefined ? null : <span>{doneHint}</span>}
      </SetupNote>
    );

  if (phase.kind === 'failed')
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <SetupNote live tone="err" name="install-failed" title={`Couldn’t install on ${machineName}`}>
          {phase.failures.map(failure => (
            <span key={failure.harness}>
              {SETUP_HARNESS_NAMES[failure.harness]}: {failure.reason}
            </span>
          ))}
          <span>Run this yourself in a terminal on {machineName}, then tap Retry:</span>
          {phase.failures.map(failure => (
            <SetupCommand key={failure.harness}>{failure.manualCommand}</SetupCommand>
          ))}
        </SetupNote>
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Retry"
          onSubmit={() => install(phase.harnesses)}
        >
          {onSkip === undefined ? null : (
            <Button type="button" data-install-skip="" onClick={onSkip}>
              Skip, continue without them
            </Button>
          )}
        </ChangeApplyPanel>
      </div>
    );

  const manual = tools.filter(tool => tool.install.kind !== 'runnable');
  return (
    <div className="flex min-w-0 flex-col gap-3" data-tool-install="">
      {runnable.length === 0 ? null : (
        <CheckChoices
          legend="Tools to install"
          legendHidden
          name="install"
          values={picked}
          onToggle={(harness, on) =>
            setPicked(current => (on ? [...current, harness] : current.filter(candidate => candidate !== harness)))
          }
          options={runnable.map(tool => ({
            id: tool.harness,
            title: `Install ${SETUP_HARNESS_NAMES[tool.harness]}`,
            detail: 'Ferretry will run:',
            extra: <SetupCommand>{toolCommand(tool)}</SetupCommand>,
          }))}
        />
      )}
      {manual.map(tool =>
        tool.install.kind === 'runnable' ? null : (
          <SetupNote
            key={tool.harness}
            tone="warn"
            name="install-manual"
            title={`${SETUP_HARNESS_NAMES[tool.harness]} can’t be installed from here`}
          >
            <span>{tool.install.reason}</span>
            <span>Run this yourself in a terminal on {machineName}:</span>
            <SetupCommand>{tool.install.manualCommand}</SetupCommand>
          </SetupNote>
        ),
      )}
      {runnable.length === 0 ? null : (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel={installLabel(picked.length)}
          disabled={picked.length === 0}
          onSubmit={() => install(picked)}
        />
      )}
    </div>
  );
}
