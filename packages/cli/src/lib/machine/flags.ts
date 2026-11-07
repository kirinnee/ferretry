import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { optionOn } from '../argv.ts';
import { MachineCommandError, type MachineHarness, type MachineWriteOptions } from './ports.ts';

/** The write flags as the verb carries them: `--dry-run`, `-y`/`--yes`, `--json`. */
export function writeFlags(invocation: VerbInvocation): MachineWriteOptions {
  return {
    ...(optionOn(invocation, 'dry-run') ? { dryRun: true } : {}),
    ...(optionOn(invocation, 'yes') || optionOn(invocation, 'y') ? { yes: true } : {}),
    ...(optionOn(invocation, 'json') ? { json: true } : {}),
  };
}

/**
 * Every value of a repeatable option, in the order given. The shell reads one value per `--name`, so a list is
 * `--skip mcp/notes --skip hooks/guard`; a value-less `--name` is refused rather than read as an empty list.
 */
export function optionList(invocation: VerbInvocation, name: string): readonly string[] {
  const value = invocation.options[name];
  if (value === undefined || value === false) return [];
  if (value === true) throw new MachineCommandError(`--${name} needs an item after it.`);
  return typeof value === 'string' ? [value] : [...value];
}

/** A harness as a person typed it: `claude` for Claude Code, or `codex`. */
export function parseHarness(value: string): MachineHarness {
  const harness = value.trim().toLowerCase();
  if (harness === 'claude' || harness === 'claude-code') return 'claude-code';
  if (harness === 'codex') return 'codex';
  throw new MachineCommandError(`"${value}" is not a tool this machine knows: use claude or codex.`);
}

/** A local file a person named, refused in words when it cannot be read. */
export async function readLocalFile(read: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    return await read(path);
  } catch {
    throw new MachineCommandError(`Could not read ${path}.`);
  }
}

/**
 * Refuses a word the verb has no place for, BEFORE anything is read or sent. The shell reads one value per `--name`, so
 * the old variadic form `--skip a b` leaves `b` behind as a positional; dropping it silently would apply the rest of the
 * command without it. `expected` is how many positionals the verb takes.
 */
export function refuseLeftoverWords(
  invocation: VerbInvocation,
  expected: number,
  verb: string,
  binaryName: string,
): void {
  const left = invocation.args.slice(expected);
  if (left.length === 0) return;
  throw new MachineCommandError(
    `${binaryName} ${verb} has no place for ${left.map(word => `"${word}"`).join(', ')}. Nothing was applied. ` +
      `A list option is repeated, one value each time (--skip a --skip b), not given several values (--skip a b).`,
  );
}

/**
 * Refuses a switch that took the word after it as its value (`--yes claude`): the shell cannot tell a switch from an
 * option with a value, so the word would be lost and the switch left off. Nothing is run.
 */
export function refuseSwallowingSwitches(
  invocation: VerbInvocation,
  switches: readonly string[],
  binaryName: string,
): void {
  for (const name of switches) {
    const value = invocation.options[name];
    const text = typeof value === 'string' ? value : Array.isArray(value) ? (value[0] as string) : undefined;
    if (text === undefined || text === 'true' || text === 'false') continue;
    throw new MachineCommandError(
      `--${name} is a switch and took "${text}" as its value, so it is not on and "${text}" was not read as an ` +
        `argument. Nothing was applied. Write the arguments first (${binaryName} machine … ${text} --${name}), or end ` +
        `the switches with --.`,
    );
  }
}

/** The switches every machine write takes. */
export const WRITE_SWITCHES = ['dry-run', 'yes', 'y', 'json'] as const;
