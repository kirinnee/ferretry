import type { Command } from 'commander';
import { AccountCommandError, type AccountHarness, type AccountWriteOptions } from './account-ports.ts';

/** The flags every account-model write carries. */
export function writeOptions(command: Command): Command {
  return command
    .option('--dry-run', 'show what would change, and change nothing')
    .option('-y, --yes', 'do not ask before a change that removes or replaces something (for scripts)')
    .option('--json', 'print the change and its outcome as JSON');
}

/** The read flag. */
export function readOptions(command: Command): Command {
  return command.option('--json', 'print the answer as JSON');
}

/**
 * A verb's flags together with its group's.
 *
 * commander hands a flag the group also declares to the GROUP, wherever it is typed — so
 * `machine clone x --json` sets the group's --json, not clone's. Reading both is what lets the flag
 * mean the same thing before and after the verb.
 */
export const mergedOptions = (command: Command): Record<string, unknown> => ({
  ...(command.parent?.opts() ?? {}),
  ...command.opts(),
});

/** commander's collector for a repeatable option. */
export const collect = (value: string, previous: readonly string[] = []): string[] => [...previous, value];

/** The write flags as commander parsed them. */
export const writeFlags = (options: Record<string, unknown>): AccountWriteOptions => ({
  ...(options.dryRun === true ? { dryRun: true } : {}),
  ...(options.yes === true ? { yes: true } : {}),
  ...(options.json === true ? { json: true } : {}),
});

/** A harness as a person typed it. */
export function parseHarness(value: string): AccountHarness {
  const harness = value.trim().toLowerCase();
  if (harness === 'claude' || harness === 'codex') return harness;
  throw new AccountCommandError(`"${value}" is not a tool this machine knows: use claude or codex.`);
}

/** A local file a person named, refused in words when it cannot be read. */
export async function readLocalFile(read: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    return await read(path);
  } catch {
    throw new AccountCommandError(`Could not read ${path}.`);
  }
}
