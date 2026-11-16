/**
 * Reads a verb's typed words the way the old commander commands did: `--kebab-name` becomes `kebabName`, a repeated
 * option is a list, a switch is a boolean. The shell's parser cannot know which options take a value, so each verb asks
 * for the shape it wants.
 */
import type { VerbInvocation } from '@ferretry/kernel/manifest';

const camel = (name: string): string => name.replace(/-([a-z0-9])/gu, (_, letter: string) => letter.toUpperCase());

const entries = (invocation: VerbInvocation): Map<string, string | boolean | readonly string[]> =>
  new Map(Object.entries(invocation.options).map(([name, value]) => [camel(name), value]));

/** The last string given for an option, if any. */
export function text(invocation: VerbInvocation, name: string): string | undefined {
  const value = entries(invocation).get(name);
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
}

/** Every string given for an option, in the order given. */
export function list(invocation: VerbInvocation, name: string): readonly string[] {
  const value = entries(invocation).get(name);
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/** Whether a switch is on (`--name`, `--name=true`). */
export function on(invocation: VerbInvocation, name: string): boolean {
  const value = entries(invocation).get(name);
  return value === true || value === 'true';
}

/** A list option or undefined when never passed (so an edit can tell "absent" from "blank"). */
export function listOrUndefined(invocation: VerbInvocation, name: string): readonly string[] | undefined {
  const given = list(invocation, name);
  return given.length === 0 ? undefined : given;
}

/** `--json` is on every verb. */
export const wantsJson = (invocation: VerbInvocation): boolean => on(invocation, 'json');
