/**
 * Said, whatever the verb, when one of the owner's commands (`fy rules`, `fy plan`, `fy copy`, `fy input`) runs inside
 * a ferret's pane or with an agent's credential. Neutral on purpose: a read is refused there as well as a change, and
 * `--as-owner` does not lift it.
 */
export const OWNER_COMMAND_REFUSAL = "this is the owner's command; a ferret's pane can't run it";

/**
 * Throws {@link OWNER_COMMAND_REFUSAL} inside a ferret's pane, before anything is asked of the daemon: `ownSessionId` is
 * `FY_SESSION_ID`, and `agentCredential` the agent's credential in the pane's environment (see `paneCredentialValue`).
 */
export function refuseOwnerCommandInPane(caller: {
  readonly ownSessionId: string | undefined;
  readonly agentCredential: string | undefined;
}): void {
  if ((caller.ownSessionId?.trim() ?? '') !== '' || (caller.agentCredential?.trim() ?? '') !== '')
    throw new Error(OWNER_COMMAND_REFUSAL);
}
