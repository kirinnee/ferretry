/**
 * Codex's workarounds, declared once.
 *
 * The source spread `harness === 'codex'` checks across thousands of lines, and each one re-decided a property of the
 * harness on the spot. That is how they drifted: two call sites disagreeing about whether Codex can set reasoning
 * effort is not a bug in either of them, it is a missing table. This is the table. Every decision that depends on
 * how Codex behaves reads it rather than testing a name.
 */

export interface HarnessQuirks {
  /**
   * Reasoning effort is a native slash command the harness handles locally.
   *
   * Codex has no such command — in a live session effort is only settable from inside its modal picker, and a start
   * puts it on the argv instead — so a request to set it as a command is refused rather than typed into the
   * conversation as a message.
   */
  readonly effortIsRuntimeCommand: false;
  /**
   * Changing the model of a live session requires driving a modal picker with keystrokes, because Codex offers no
   * command that takes the model as an argument.
   */
  readonly modelSwitchNeedsPicker: true;
  /**
   * Codex renders no token counter the monitor can read as proof of progress, so a Codex session that looks frozen
   * has to be judged on other life signs.
   */
  readonly reportsTokenCounter: false;
  /**
   * Fast mode is switched by a command that FLIPS it, with no way to name the state wanted.
   *
   * Codex's `/fast` takes no argument: `/fast on` is typed into the conversation as a message and costs a model
   * turn. A flip is only safe to type when the current state is known, so the planner refuses one it cannot place.
   */
  readonly fastIsToggle: true;
  /** Codex mints its own session ids that only exist after launch, so they are discovered, not assigned. */
  readonly mintsOwnSessionIds: true;
  /** Codex has no remote-control flag a person drives from outside the terminal. */
  readonly supportsRemoteControl: false;
}

export const CODEX_QUIRKS: HarnessQuirks = {
  effortIsRuntimeCommand: false,
  modelSwitchNeedsPicker: true,
  reportsTokenCounter: false,
  fastIsToggle: true,
  mintsOwnSessionIds: true,
  supportsRemoteControl: false,
};
