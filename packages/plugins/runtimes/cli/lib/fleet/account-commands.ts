import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { AccountCommandError, type AccountWriteOptions } from './account-ports.ts';

/** The flags as the shell parsed them (`--dry-run` is `dry-run`; `-y` is `y`), read without guessing a type. */
type Options = VerbInvocation['options'];

/** A switch that is on: `--name`, `--name=true`. `--no-name` and absence are off. */
export function flagOn(options: Options, ...names: readonly string[]): boolean {
  return names.some(name => options[name] === true || options[name] === 'true');
}

/** A switch the person turned off with `--no-name`; `undefined` when they said nothing. */
export function flagSet(options: Options, name: string): boolean | undefined {
  const value = options[name];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/** The last value of a flag that takes one. */
export function flagText(options: Options, name: string): string | undefined {
  const value = options[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  return undefined;
}

/** Every value of a repeatable flag, in the order given. */
export function flagList(options: Options, name: string): string[] {
  const value = options[name];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return [...(value as readonly string[])];
  return [];
}

/** The write flags as the shell parsed them. */
export const writeFlags = (options: Options): AccountWriteOptions => ({
  ...(flagOn(options, 'dry-run') ? { dryRun: true } : {}),
  ...(flagOn(options, 'yes', 'y') ? { yes: true } : {}),
  ...(flagOn(options, 'json') ? { json: true } : {}),
});

/** A tool as a person typed it. `claude` is Claude Code. */
export function parseHarness(value: string): HarnessKey {
  const harness = value.trim().toLowerCase();
  if (harness === 'claude' || harness === 'claude-code') return 'claude-code';
  if (harness === 'codex') return 'codex';
  throw new AccountCommandError(`"${value}" is not a tool this machine knows: use claude or codex.`);
}

/** A required positional, or a refusal naming what is missing. */
export function positional(invocation: VerbInvocation, index: number, what: string): string {
  const value = invocation.args[index];
  if (value === undefined || value === '') throw new AccountCommandError(`Say which ${what}.`);
  return value;
}
