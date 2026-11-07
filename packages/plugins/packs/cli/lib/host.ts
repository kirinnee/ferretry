import { resolve } from 'node:path';
import type { CliContext, Manifest } from '@ferretry/kernel/manifest';

/**
 * What a verb needs of the terminal beyond `client` and `io`: the names `fy` lets a verb read (`FY_SESSION_ID`, `PWD`),
 * where it was run, a clock, a sleep and a file read. The shell's `CliContext` is to carry these (lead decision 21,
 * kernel item L); on this base it carries only `manifest`, `client` and `io`, so every one is absent and a verb that
 * needs one says so plainly:
 *
 * - `fy pack` with no id cannot find the calling ferret (no `FY_SESSION_ID`): name the ferret.
 * - `guide clean-up --prompt-file` cannot read the file: pass `--prompt`.
 * - `guide clean-up` / `guide write` look at their run once instead of waiting on it (no sleep).
 * - `fy pack` dates its rows against the daemon's own reading time (`PackTable.at`), not a terminal clock.
 *
 * Nothing here reaches the process, the file system, a timer or the clock directly.
 */
export interface PackHost {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly cwd?: string | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
}

/** The host parts the shell's context gives a verb: none yet (see {@link PackHost}). */
export function hostOf<M extends Manifest>(_context: CliContext<M>): PackHost {
  return {};
}

/** The ferret this runs inside (`FY_SESSION_ID`); `undefined` in a person's shell, or when the shell gives no env. */
export function ambientFerret(host: PackHost): string | undefined {
  const own = host.env?.FY_SESSION_ID?.trim();
  return own === undefined || own === '' ? undefined : own;
}

/** A folder the caller typed, made absolute against where `fy` was run (as typed when the shell does not say). */
export function absoluteOf(host: PackHost): (path: string) => string {
  const base = host.cwd ?? host.env?.PWD;
  return path => (base === undefined || path.startsWith('/') ? path : resolve(base, path));
}
