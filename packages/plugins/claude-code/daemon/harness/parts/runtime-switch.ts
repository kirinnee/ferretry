import type { HarnessRuntimeSwitch } from '@ferretry/core-ferrets/contract';
import { CLAUDE_RUNTIME_SWITCH } from '../../lib/harness/runtime-switch.ts';
import type { ClaudeCore } from './core.ts';

/** Takes no pane (the one `Harness.runtimeSwitch` offers one), as the class always did: nothing is held per ferret. */
export const runtimeSwitchPart = (_core: ClaudeCore): { readonly runtimeSwitch: () => HarnessRuntimeSwitch } => ({
  /**
   * Live model, effort and fast-mode switching of a running ferret (`Harness.runtimeSwitch`). Claude Code switches by typed
   * command, so there is no picker to drive and nothing per ferret to hold: the same switch serves every pane.
   */
  runtimeSwitch(): HarnessRuntimeSwitch {
    return CLAUDE_RUNTIME_SWITCH;
  },
});
