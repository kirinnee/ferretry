/**
 * Per-harness workarounds, declared once.
 *
 * The source spread `harness === 'claude'` checks across thousands of lines, and
 * each one re-decided a property of the harness on the spot. That is how they
 * drifted: two call sites disagreeing about whether Codex can set reasoning
 * effort is not a bug in either of them, it is a missing table. This is the
 * table. Every decision that depends on which harness is running reads it rather
 * than testing the name.
 */

import type { HarnessKind } from '../../core/inventory.ts';

export interface HarnessQuirks {
  /**
   * Reasoning effort is a native slash command the harness handles locally.
   *
   * Codex has no such command — effort is only settable from inside its modal
   * picker — so a request to set it as a command is refused rather than typed
   * into the conversation as a message.
   */
  readonly effortIsRuntimeCommand: boolean;
  /**
   * Changing the model of a live session requires driving a modal picker with
   * keystrokes, because the harness offers no command that takes the model as an
   * argument.
   */
  readonly modelSwitchNeedsPicker: boolean;
  /**
   * The harness renders a token counter the monitor can read as proof of
   * progress. Codex renders none, so a Codex session that looks frozen has to be
   * judged on other life signs.
   */
  readonly reportsTokenCounter: boolean;
  /**
   * The harness mints its own session ids that only exist after launch, so they
   * are discovered by diffing its state directory rather than assigned.
   */
  readonly mintsOwnSessionIds: boolean;
  /**
   * The harness can expose a remote-control surface a person drives from outside
   * the terminal. Codex has no such flag.
   */
  readonly supportsRemoteControl: boolean;
}

const QUIRKS: Readonly<Record<HarnessKind, HarnessQuirks>> = {
  claude: {
    effortIsRuntimeCommand: true,
    modelSwitchNeedsPicker: false,
    reportsTokenCounter: true,
    mintsOwnSessionIds: false,
    supportsRemoteControl: true,
  },
  codex: {
    effortIsRuntimeCommand: false,
    modelSwitchNeedsPicker: true,
    reportsTokenCounter: false,
    mintsOwnSessionIds: true,
    supportsRemoteControl: false,
  },
};

/** The quirks of one harness. */
export function harnessQuirks(harness: HarnessKind): HarnessQuirks {
  return QUIRKS[harness];
}
