import type { FerretRuntimeRename } from '../../../contract/index.ts';

/**
 * What a ferret's session config says about its runtime: `agent` (the runtime name it launched as, or in an old record
 * the wrapper path) and `command[0]` (the wrapper it launched). Both are read tolerantly: a field that is not a
 * non-empty string is said to be absent, never guessed at.
 */
export function sessionRuntimeFacts(
  config: unknown,
): { readonly agent?: string; readonly executable?: string } | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  const document = config as Readonly<Record<string, unknown>>;
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
  const agent = text(document.agent);
  const executable = Array.isArray(document.command) ? text(document.command[0]) : undefined;
  return { ...(agent === undefined ? {} : { agent }), ...(executable === undefined ? {} : { executable }) };
}

/**
 * A session config re-pointed from the old runtime to the new one (v4's `renamedSessionConfig`), or `undefined` when it
 * does not name the old one. `agent` keeps its form — a name stays a name, a wrapper path becomes the new wrapper path —
 * and only `command[0]` moves in the argv, because the rest of it is what the ferret was launched with and still is.
 * Every other field is carried over untouched.
 */
export function repointedSessionConfig(
  current: unknown,
  rename: FerretRuntimeRename,
): Record<string, unknown> | undefined {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
  const document = current as Readonly<Record<string, unknown>>;
  const agent =
    document.agent === rename.from ? rename.to : document.agent === rename.fromWrapper ? rename.toWrapper : undefined;
  const command = Array.isArray(document.command) ? document.command : undefined;
  const movesCommand = command?.[0] === rename.fromWrapper;
  if (agent === undefined && !movesCommand) return undefined;
  return {
    ...document,
    ...(agent === undefined ? {} : { agent }),
    ...(movesCommand && command !== undefined ? { command: [rename.toWrapper, ...command.slice(1)] } : {}),
  };
}
