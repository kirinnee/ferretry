import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';

/**
 * "Set up" is "Runtimes `list()` names at least one runtime": v4's "a runtime exists", counted through `list()`. v4
 * counted every runtime key, so a runtime `list()` leaves out (an unknown harness, or every login-derived one while
 * Logins is unreadable) is not counted here; Runtimes publishes no read that counts them (a ports-pending GAP).
 * Runtimes off or unreadable is false: the first run then behaves as on a machine nobody has set up.
 */
export async function machineIsSetUp(runtimes: Pick<RuntimesApi, 'list'> | undefined): Promise<boolean> {
  if (runtimes === undefined) return false;
  try {
    return (await runtimes.list()).length > 0;
  } catch {
    return false;
  }
}
