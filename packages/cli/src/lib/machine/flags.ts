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
