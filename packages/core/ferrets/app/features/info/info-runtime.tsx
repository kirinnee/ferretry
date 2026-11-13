/**
 * Info › Runtime: what this ferret runs as — the CLI, the runtime and login, the model it was started with, and how
 * it is run.
 *
 * The pickers that CHANGE the model and effort are another surface's (Runtimes' composer switches); `controls` is the
 * slot a host hands them in through, and Info draws nothing in their place when it is absent. The facts a CLI reports
 * about itself (the model it is actually answering with, its effort, its launch instructions, the capability
 * switches) and the lists other plugins own (MCP, skills, instruction files) are not on the ferret record, so no row
 * claims them here. The model and effort it was LAUNCHED with are the ferret's own and are drawn.
 */

import type { ReactNode } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import { harnessLabel, INFO_HINT, loginScope } from './info-model.ts';
import { InfoChip, InfoRow, InfoSection } from './info-parts.tsx';
import { type InfoRelaunchRead, InfoRelaunchRow } from './info-relaunch.tsx';

export interface InfoRuntimeProps {
  readonly ferret: FerretSummary;
  /** The model and effort pickers, when a host has them. */
  readonly controls?: ReactNode;
  /** Whether a Restart would relaunch it on different settings. Absent: no Settings row. */
  readonly relaunch?: InfoRelaunchRead;
  /** The Restart the Settings row offers when it is behind. */
  readonly onRestart?: () => Promise<boolean>;
}

export function InfoRuntime({ ferret, controls, relaunch, onRestart }: InfoRuntimeProps) {
  const login = ferret.login ?? ferret.runtime;
  return (
    <InfoSection>
      <InfoRow label="CLI">{harnessLabel(ferret)}</InfoRow>
      {ferret.runtime === undefined ? null : (
        <InfoRow hint={INFO_HINT.runtime} label="Runtime">
          <span className="font-mono" data-info-runtime="">
            {ferret.runtime}
          </span>
        </InfoRow>
      )}
      <InfoRow hint={INFO_HINT.login} label="Login">
        {login === undefined ? (
          <span className="fy-info-muted">The CLI’s own</span>
        ) : (
          <>
            <span className="font-mono">{login}</span>
            <InfoChip>{loginScope(ferret)}</InfoChip>
          </>
        )}
      </InfoRow>
      <InfoRow hint={INFO_HINT.model} label="Model">
        {ferret.model === undefined ? (
          <span className="fy-info-muted">The CLI’s own default</span>
        ) : (
          <span className="font-mono" data-info-model="">
            {ferret.model}
          </span>
        )}
      </InfoRow>
      {ferret.effort === undefined ? null : (
        <InfoRow hint={INFO_HINT.effort} label="Effort">
          <span className="font-mono" data-info-effort="">
            {ferret.effort}
          </span>
          {ferret.fast === true ? <InfoChip>fast mode</InfoChip> : null}
        </InfoRow>
      )}
      {controls === undefined ? null : <InfoRow label="Change">{controls}</InfoRow>}
      {relaunch === undefined ? null : (
        <InfoRelaunchRow read={relaunch} {...(onRestart === undefined ? {} : { onRestart })} />
      )}
      <InfoRow hint={INFO_HINT.mode} label="Mode">
        {ferret.mode ?? <span className="fy-info-muted">Not recorded</span>}
      </InfoRow>
      <InfoRow hint={INFO_HINT.runner} label="Runner">
        {ferret.runner}
      </InfoRow>
    </InfoSection>
  );
}
