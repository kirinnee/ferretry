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
   * Codex has no such command — in a live session effort is only settable from
   * inside its modal picker, and a start puts it on the argv instead
   * (`startupEffort`) — so a request to set it as a command is refused rather
   * than typed into the conversation as a message.
   */
  readonly effortIsRuntimeCommand: boolean;
  /**
   * A reasoning level put on a START's launch argv must be checked against the login's live model
   * catalog first, because nothing else checks it.
   *
   * Codex accepts any `-c model_reasoning_effort=…` and a level the model does not take only surfaces as
   * a failed first turn. Claude's own CLI checks `--effort`: an unknown level is warned about and the
   * session starts on its default, exactly as `/effort` treated one.
   */
  readonly launchEffortNeedsCatalogCheck: boolean;
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
   * Fast mode is switched by a command that FLIPS it, with no way to name the state wanted.
   *
   * Codex's `/fast` takes no argument: `/fast on` is typed into the conversation as a message and
   * costs a model turn. Claude's `/fast on` and `/fast off` name the state. A flip is only safe to
   * type when the current state is known, so the planner refuses one it cannot place.
   */
  readonly fastIsToggle: boolean;
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
    launchEffortNeedsCatalogCheck: false,
    modelSwitchNeedsPicker: false,
    reportsTokenCounter: true,
    fastIsToggle: false,
    mintsOwnSessionIds: false,
    supportsRemoteControl: true,
  },
  codex: {
    effortIsRuntimeCommand: false,
    launchEffortNeedsCatalogCheck: true,
    modelSwitchNeedsPicker: true,
    reportsTokenCounter: false,
    fastIsToggle: true,
    mintsOwnSessionIds: true,
    supportsRemoteControl: false,
  },
};

/** The quirks of one harness. */
export function harnessQuirks(harness: HarnessKind): HarnessQuirks {
  return QUIRKS[harness];
}
