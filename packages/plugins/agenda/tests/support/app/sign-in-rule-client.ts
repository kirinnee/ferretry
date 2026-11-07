/** Refusals as a machine's client throws them, for the suites that fake Accounts' sign-in rule routes. */

/** An error the way the daemon client throws one: its message, with the status and code it carried. */
export const refused = (message: string, extra: { status?: number; code?: string } = {}): Error =>
  Object.assign(new Error(message), extra);
