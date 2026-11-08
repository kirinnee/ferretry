import { type AgentControlKind, type AgentControlReader } from '@ferretry/kernel/contract';
import type { AgentControl, FerretId } from '../../../contract/index.ts';

/** Which switch of "What agents may control" answers each kind (today's `FIELD`, copied). */
export const SWITCH_OF_KIND: Readonly<Record<AgentControlKind, keyof AgentControl>> = {
  terminal: 'terminals',
  browser: 'browsers',
  files: 'files',
  settings: 'ferretrySettings',
  scripts: 'pageScripts',
};

/**
 * The ONE reader of the owner's switches, handed to the kernel (and through it to every plugin that guards a kind of
 * control): it answers from `FerretsPort.agentControl`, which reads `limits.yaml` fresh on every call, so a change
 * applies to the ferret's very next action and no plugin reads that configuration itself.
 */
export function agentControlReader(agentControl: (ferret: FerretId) => Promise<AgentControl>): AgentControlReader {
  return { allows: async (ferret, kind) => (await agentControl(ferret))[SWITCH_OF_KIND[kind]] === true };
}
