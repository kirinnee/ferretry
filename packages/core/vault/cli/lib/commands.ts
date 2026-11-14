import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, verbHandler } from '../shell.ts';
import type { SecretController } from './secret-controller.ts';

/**
 * Mounts `fy secret set <name>`.
 *
 * `set` takes NO value argument. That is deliberate and it is the whole point of the command: a credential typed on a
 * command line is in the shell history of whoever typed it and readable in `/proc/<pid>/cmdline` by every account on
 * the box while it runs. The verb's shape is ONE word, the name; a second word is refused as "too many arguments" and
 * any option as "unknown option", before the controller runs (S33). The value comes in on stdin (S1).
 */
export function secretVerbs(
  controller: SecretController,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
): { readonly 'secret set': VerbHandler } {
  return {
    'secret set': verbHandler(io, exit, { command: 'set', args: ['name'] }, async read => {
      await controller.set(read.args[0] ?? '');
    }),
  };
}
