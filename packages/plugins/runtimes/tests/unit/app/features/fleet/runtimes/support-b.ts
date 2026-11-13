/**
 * Fixtures for the Add runtime and profile suites: a login list built from longhand logins, the tool lists of a
 * machine with and without Codex installed, and the refusal a daemon answers a change with.
 */

import { type LoginList, LoginListSchema } from '@ferretry/plugin-logins/contract';
import { type MachineView, type RuntimeCatalog, RuntimeCatalogSchema } from '../../../../../../contract/index.ts';
import type { MachineData } from '../../../../../../app/features/fleet/runtimes/machine-data.ts';
import { machine, RUNTIMES, type runtime } from '../account-support.ts';

export const credentialsOf = (...items: Record<string, unknown>[]): LoginList =>
  LoginListSchema.parse({ format: 1, machine: 'studio-mac', logins: items });

/** A machine whose Claude Code is installed and whose Codex is not. */
export const NOT_INSTALLED_CODEX: MachineView = machine({
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: false },
  ],
});

export const withRuntime = (base: MachineData, ...made: ReturnType<typeof runtime>[]): MachineData => ({
  ...base,
  runtimes: RuntimeCatalogSchema.parse({ ...RUNTIMES, runtimes: [...RUNTIMES.runtimes, ...made] }) as RuntimeCatalog,
});

/** What the shell's client throws for an answer of 4xx: the daemon's sentence, with its status and code. */
export const refusal = (message: string, status: number, code: string): Error =>
  Object.assign(new Error(message), { status, code });
