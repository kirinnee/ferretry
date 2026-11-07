import type { Command } from 'commander';
import { registerComponentCommands } from '../component/commands.ts';
import { registerCredentialCommands } from '../credential/commands.ts';
import { registerMachineCommands } from '../machine/commands.ts';
import { registerProfileCommands } from '../profile/commands.ts';
import { registerRuntimeCommands } from '../runtime/commands.ts';
import type { AccountCommandDeps } from './account-ports.ts';

/**
 * Mounts every account-model command group (docs/design/account-model.md §6.2) with one set of
 * collaborators: `machine`, `runtimes`/`runtime`, `credentials`/`credential`,
 * `profiles`/`profile`, `components`/`component`. Setting a machine up mounts onto the daemon group
 * instead (`daemon setup`, `daemon import`; `../setup/commands.ts`), registered after it.
 */
export function registerAccountModelCommands(program: Command, deps: AccountCommandDeps): void {
  registerMachineCommands(program, deps);
  registerRuntimeCommands(program, deps);
  registerCredentialCommands(program, deps);
  registerProfileCommands(program, deps);
  registerComponentCommands(program, deps);
}
