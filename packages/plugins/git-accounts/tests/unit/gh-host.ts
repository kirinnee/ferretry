/** What a test host needs for B9's `gh` lookup: a daemon `PATH` and the executables the kernel finds on it. */
import type { HostFactsPort } from '@ferretry/kernel/contract';
import { testClient } from './run-folder.ts';

const GH_PATH = '/usr/bin';
export const GH_REAL = `${GH_PATH}/gh`;

/** `testHost` options that make the real `gh` findable at `/usr/bin/gh` (the daemon's `PATH` is `path`). */
export function ghHost(path: string = GH_PATH, executables: readonly string[] = [GH_REAL]) {
  return {
    searchPath: path,
    executables,
    bindProgram: async (program: string) => testClient(program),
    hostFacts: { launchGuard: () => ({ active: false, searchPath: path }) } as unknown as HostFactsPort,
  };
}
