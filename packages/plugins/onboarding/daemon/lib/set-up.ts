import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';

/**
 * "Set up" is "at least one runtime exists" (Runtimes' `MachineView.setUp`), read through Runtimes' `list`. Runtimes off
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
