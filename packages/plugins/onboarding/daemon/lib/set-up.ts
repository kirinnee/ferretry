import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';

/**
 * "Set up" is "Runtimes `list()` names at least one runtime", the v4 meaning (a runtime exists to start work with). It
 * is not Runtimes' `MachineView.setUp`, which also counts a runtime `list()` cannot name. Runtimes off
 * or unreadable is false: the first run then behaves as it does on a machine nobody has set up.
 */
export async function machineIsSetUp(runtimes: Pick<RuntimesApi, 'list'> | undefined): Promise<boolean> {
  if (runtimes === undefined) return false;
  try {
    return (await runtimes.list()).length > 0;
  } catch {
    return false;
  }
}
