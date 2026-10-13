import type { Command } from 'commander';
import { registerComponentCommands } from '../component/commands.ts';
import { registerCredentialCommands } from '../credential/commands.ts';
import { registerMachineCommands } from '../machine/commands.ts';
import { registerProfileCommands } from '../profile/commands.ts';
import { registerRuntimeCommands } from '../runtime/commands.ts';
import { registerSetupCommands } from '../setup/commands.ts';
import type { AccountCommandDeps } from './account-ports.ts';
import { registerFleetMigrate } from './migrate.ts';

/**
 * Mounts every account-model command group (docs/design/account-model.md §6.2) with one set of
 * collaborators: `setup`, `machine`, `runtimes`/`runtime`, `credentials`/`credential`,
 * `profiles`/`profile`, `components`/`component`, and `fleet migrate` on the existing fleet group.
 */
export function registerAccountModelCommands(program: Command, deps: AccountCommandDeps): void {
  registerSetupCommands(program, deps);
  registerMachineCommands(program, deps);
  registerRuntimeCommands(program, deps);
  registerCredentialCommands(program, deps);
  registerProfileCommands(program, deps);
  registerComponentCommands(program, deps);
  // The fleet group is registered first; `migrate` joins it rather than starting a second one.
  registerFleetMigrate(program.commands.find(command => command.name() === 'fleet') ?? program.command('fleet'), deps);
}
