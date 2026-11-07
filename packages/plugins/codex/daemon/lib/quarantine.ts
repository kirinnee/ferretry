/**
 * What the daemon does when it cannot prove a Codex picker was closed.
 *
 * The pane is live, a modal may still be open, and the daemon has no way to tell
 * what it is. Every route that types into that pane must therefore be closed
 * until a human has looked, and the closure has to be DURABLE — a decision held
 * only in memory is undone by the next daemon restart, which is exactly when
 * nobody is watching.
 *
 * The reason strings name the binary rather than hardcoding it, because the
 * binary name is single-sourced from the CLI package and a message that tells a
 * user to run a command that does not exist is worse than no message.
 */

/** Marks the durable quarantine so input gates can recognise this specific cause
 *  and refuse with an instruction that fits it. */
export const CODEX_PICKER_QUARANTINE_KIND = 'codex_picker_cleanup';

const QUARANTINE_REASON =
  'Codex picker cleanup could not confirm the exact pane returned to an idle prompt; ' +
  'the session was quarantined to prevent input into an unknown modal';

/** The durable state a quarantine writes, plus the evidence for the event. */
export interface PickerQuarantine {
  readonly needsHumanKind: typeof CODEX_PICKER_QUARANTINE_KIND;
  readonly reason: string;
  /** The instruction a human sees on the session. */
  readonly needsHuman: string;
  readonly evidence: {
    readonly driveError: string;
    readonly cleanupError: string;
  };
}

/** A failure's message, whatever it was thrown as. */
export function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Build the quarantine for a drive that failed and a cleanup that could not be
 * confirmed.
 *
 * Both failures are recorded. The source reported only the cleanup error on the
 * session while putting the drive error solely in an event payload, so the
 * session itself never said what had originally gone wrong.
 */
export function quarantineUnconfirmedPicker(
  binaryName: string,
  driveFailure: unknown,
  cleanupFailure: unknown,
): PickerQuarantine {
  return {
    needsHumanKind: CODEX_PICKER_QUARANTINE_KIND,
    reason: QUARANTINE_REASON,
    needsHuman: `${QUARANTINE_REASON}; run \`${binaryName} resume\` or \`${binaryName} stop\` before sending more input`,
    evidence: {
      driveError: failureMessage(driveFailure),
      cleanupError: failureMessage(cleanupFailure),
    },
  };
}

/** True when a session is holding the picker quarantine and must accept no
 *  input. Read from durable state, so it survives a daemon restart. */
export function isPickerQuarantined(state: { readonly needsHumanKind?: string }): boolean {
  return state.needsHumanKind === CODEX_PICKER_QUARANTINE_KIND;
}

/** Why a send or a runtime control was refused on a quarantined session. */
export function pickerInputRefusal(binaryName: string): string {
  return (
    'input is blocked because Codex picker cleanup was not confirmed; ' +
    `run \`${binaryName} resume <session>\` or \`${binaryName} stop <session>\` ` +
    'before sending or retrying runtime control'
  );
}

/**
 * The message the caller of a failed switch gets.
 *
 * Two outcomes, because they need different actions from a human: the pane was
 * stopped, so the session is inert and can be resumed; or stopping ALSO failed,
 * so a live pane is still out there holding an unknown modal.
 */
export function pickerFailureReport(quarantine: PickerQuarantine, stopFailure: unknown | undefined): string {
  const preamble =
    `Codex picker drive failed: ${quarantine.evidence.driveError}; ` +
    `picker cleanup failed: ${quarantine.evidence.cleanupError}; `;
  return stopFailure === undefined
    ? `${preamble}session was stopped for safety and must be resumed before retrying runtime control`
    : `${preamble}session remains quarantined because its tmux pane could not be stopped: ${failureMessage(stopFailure)}`;
}
