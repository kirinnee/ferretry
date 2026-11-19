/** An install outcome as the wire carries it: the harness by its wire key, and never the path a tool landed in (§4.1 rule 8). */
import type { ToolInstallOutcome as ToolInstallOutcomeOnWire } from '../../../contract/index.ts';
import { harnessKey } from './foreign.ts';
import type { ToolInstallOutcome } from './tool-install.ts';

export function toolOutcomeOnWire(outcome: ToolInstallOutcome): ToolInstallOutcomeOnWire {
  const harness = harnessKey(outcome.harness);
  if (outcome.outcome === 'already-installed') return { harness, outcome: 'already-installed' };
  if (outcome.outcome === 'installed')
    return { harness, outcome: 'installed', command: outcome.command, output: outcome.output };
  return { ...outcome, harness };
}
