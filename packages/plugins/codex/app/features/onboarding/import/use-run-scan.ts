/**
 * The scan this run's import pages share (the kit's one read per run). The run key is held in the plugin's segment memory, so
 * every page of the run asks the same store and a new run reads the machine afresh. Names only: the scan carries no value.
 */
import { type HarnessScan, useHarnessScan, type ToolModel } from '@ferretry/plugin-runtimes/import-kit';
import { useEffect, useState } from 'react';
import type { OnboardingClient, StepHost } from '../onboarding-api.ts';
import { newRunKey, RUN_KEY } from './import-memory.ts';

export function useRunScan(
  client: OnboardingClient,
  step: StepHost,
): HarnessScan & { readonly model: ToolModel | null } {
  const [run] = useState(() => {
    const held = step.segment[RUN_KEY];
    return typeof held === 'string' ? held : newRunKey();
  });
  useEffect(() => {
    if (step.segment[RUN_KEY] !== run) step.remember({ [RUN_KEY]: run });
  }, [step, run]);
  return useHarnessScan(client, 'codex', run);
}
