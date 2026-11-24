import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { harnessWords, supportedHarnessKeys } from '../../../contract/harness-words.ts';
import { AccountCommandError, type AccountWriteOptions } from './account-ports.ts';

/** The flags as the shell parsed them (`--dry-run` is `dry-run`; `-y` is `y`), read without guessing a type. */
type Options = VerbInvocation['options'];

/** A switch that is on: `--name`, `--name=true`. `--no-name` and absence are off. */
export function flagOn(options: Options, ...names: readonly string[]): boolean {
  return names.some(name => options[name] === true || options[name] === 'true');
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
  const word = value.trim().toLowerCase();
  const keys = supportedHarnessKeys();
  const named = keys.find(key => key === word || harnessWords(key)?.commandWord === word);
  if (named !== undefined) return named;
  const commands = keys.map(key => harnessWords(key)?.commandWord ?? key);
  throw new AccountCommandError(`"${value}" is not a tool this machine knows: use ${commands.join(' or ')}.`);
}

/** A required positional, or a refusal naming what is missing. */
export function positional(invocation: VerbInvocation, index: number, what: string): string {
  const value = invocation.args[index];
  if (value === undefined || value === '') throw new AccountCommandError(`Say which ${what}.`);
  return value;
}
