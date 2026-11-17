/**
 * Reads a verb's typed words the way the old commander commands did: `--kebab-name` becomes `kebabName`, a repeated
 * option is a list, a switch is a boolean. The shell's parser cannot know which options take a value, so each verb asks
 * for the shape it wants.
 */
import type { VerbInvocation } from '@ferretry/kernel/manifest';

const kebab = (name: string): string => name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`);

/**
 * The value an option holds under the camel name a verb asks for (`fooBar`), typed as `--foo-bar` (or `--fooBar`).
 * Looked up by name, never by walking every option, so the shell can see which options a verb reads.
 */
const heldValue = (invocation: VerbInvocation, name: string): string | boolean | readonly string[] | undefined =>
  invocation.options[kebab(name)] ?? invocation.options[name];

/** The last string given for an option, if any. */
export function text(invocation: VerbInvocation, name: string): string | undefined {
  const value = heldValue(invocation, name);
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
}

/** Every string given for an option, in the order given. */
export function list(invocation: VerbInvocation, name: string): readonly string[] {
  const value = heldValue(invocation, name);
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/** Whether a switch is on (`--name`, `--name=true`). */
export function on(invocation: VerbInvocation, name: string): boolean {
  const value = heldValue(invocation, name);
  return value === true || value === 'true';
}

/** A list option or undefined when never passed (so an edit can tell "absent" from "blank"). */
export function listOrUndefined(invocation: VerbInvocation, name: string): readonly string[] | undefined {
  const given = list(invocation, name);
  return given.length === 0 ? undefined : given;
}

/** `--json` is on every verb. */
export const wantsJson = (invocation: VerbInvocation): boolean => on(invocation, 'json');
