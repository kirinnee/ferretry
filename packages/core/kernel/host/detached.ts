/**
 * `SpawnOptions.detached` (kernel batch #15): one rule, shared by the real host and the testing host, so both refuse
 * alike and say the same sentence.
 *
 * A detached child outlives the daemon: its own session and process group, stdio ignored, unreferenced. That is new
 * authority (a process outside the daemon's lifecycle), so it is bounded before anything starts:
 * - only `start` (`run` / `runBytes` wait for the child, which a detached one is never waited on);
 * - only a program the manifest lists BY NAME in `permissions.detached` AND declares in `permissions.spawn`;
 *   `'*'`, a pattern or an `{ items }` entry names nothing here, for a core piece too;
 * - never for a ferret (its limits must not be escaped), never with extra pipes, stdin, a pinned working directory,
 *   a timeout or an abort signal (nothing would hold the other end), and never with a Vault `ChildEnvironment`
 *   handle: no secret may live past the daemon in an orphan.
 */
import type { ChildHandle, SpawnOptions } from '../contract/ports.ts';
import { programAmong, programName } from '../manifest/reach.ts';

/** Which spawn member is asked: only `start` may detach. */
export type DetachedCall = 'start' | 'run' | 'runBytes';

/** The names a `permissions.detached` list grants: plain strings with no `*` in them, nothing else. */
export function detachedNames(declared: readonly unknown[] | undefined): readonly string[] {
  return (declared ?? []).filter((entry): entry is string => typeof entry === 'string' && !entry.includes('*'));
}

/**
 * Whether `env` is plain values (an object literal of strings), never a Vault handle. A handle carries a `names`
 * array and a `toJSON` function, so it is never plain; anything else that is not a plain string record is refused too.
 */
export function plainEnvironment(env: unknown): boolean {
  if (typeof env !== 'object' || env === null) return false;
  if (Object.getPrototypeOf(env) !== Object.prototype) return false;
  return Object.values(env).every(value => typeof value === 'string');
}

/**
 * Why this detached start is refused, or `undefined` when it may go ahead. `spawnDeclared` is the answer of the
 * plugin's `permissions.spawn` rule for this program (a detached program is a subset of the spawnable ones).
 */
export function detachedRefusal(
  plugin: string,
  declared: readonly unknown[] | undefined,
  spawnDeclared: boolean,
  call: DetachedCall,
  program: string,
  options: SpawnOptions,
): string | undefined {
  const name = programName(program);
  if (call !== 'start')
    return `${plugin} may start a detached child only with start: ${call} waits for the child, and a detached one is never waited on.`;
  if (!programAmong(detachedNames(declared), program) || !spawnDeclared)
    return `${plugin} may not start ${name} detached: its manifest does not declare it in permissions.detached and permissions.spawn.`;
  if (options.forFerret !== undefined)
    return `${plugin} may not start ${name} detached for a ferret: a detached child would escape the ferret's limits.`;
  if (options.extraPipes !== undefined)
    return `${plugin} may not start ${name} detached with extra pipes: nothing would hold the daemon's ends.`;
  if (options.stdin !== undefined)
    return `${plugin} may not start ${name} detached with stdin: a detached child's streams are ignored.`;
  if (options.cwd !== undefined && typeof options.cwd !== 'string')
    return `${plugin} may not start ${name} detached in a held-open folder: the hold ends with the daemon, the child does not.`;
  if (options.timeout !== undefined || options.signal !== undefined)
    return `${plugin} may not start ${name} detached with a timeout or an abort signal: the kernel does not wait on a detached child.`;
  if (options.env !== undefined && !plainEnvironment(options.env))
    return `${plugin} may not start ${name} detached with a secret environment: no secret may outlive the daemon in an orphan.`;
  return undefined;
}

/** The sentence a port that offers no detached start says (every wrapper but the host's detached-aware one). */
export const detachedNotOffered = (plugin: string, program: string): string =>
  `${plugin} may not start ${programName(program)} detached through this port.`;

/**
 * The handle a detached start answers: its pid and nothing else the daemon holds. Its streams are empty and closed,
 * `write` and `kill` throw (it is not the daemon's child any more), `exited` is `null` at once and there are no pipes.
 */
export function detachedHandle(pid: number): ChildHandle {
  const closed = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start: controller => controller.close(),
    });
  return {
    pid,
    stdout: closed(),
    stderr: closed(),
    write: () => {
      throw new Error('A detached child has no stdin: its streams are ignored.');
    },
    kill: () => {
      throw new Error('A detached child is not the daemon’s to signal: it outlives the daemon.');
    },
    exited: Promise.resolve(null),
    pipes: [],
    closePipes: () => undefined,
  };
}

/**
 * Whether a spawn asks for a detached child: only an exact `true` does. `undefined` is an ordinary child; any other
 * value (`false` included, which the type does not allow) is refused outright rather than read as either answer.
 */
export function detachedAsked<T extends { readonly detached?: unknown }>(
  options: T | undefined,
): options is T & { readonly detached: true } {
  const asked = options?.detached;
  if (asked === undefined) return false;
  if (asked !== true) throw new Error('SpawnOptions.detached is true or absent, never another value.');
  return true;
}
