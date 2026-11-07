import { resolve } from 'node:path';
import type { CliContext, Manifest } from '@ferretry/kernel/manifest';

/**
 * What a verb needs of the terminal beyond `client` and `io`. The shell's context is to carry these (lead decision 21:
 * clock, sleep, env, and the fy-shell's allowed names); until it does, every one is optional and a verb that needs an
 * absent one says so plainly. Nothing here reaches the process, the file system or the clock directly.
 */
export interface PackHost {
  /** The names `fy` lets a verb read (`FY_SESSION_ID`, `PWD`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Where `fy` was run. */
  readonly cwd?: string | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly readFile?: ((path: string) => Promise<string>) | undefined;
  readonly fileExists?: ((path: string) => Promise<boolean>) | undefined;
}

/** The host fields of a CLI context, wherever the shell put them. */
export function hostOf<M extends Manifest>(context: CliContext<M>): PackHost {
  return context as unknown as PackHost;
}

/** A sleep with no timer: an abort signal that fires after `milliseconds`. Used only when the shell gave none. */
const signalSleep = async (milliseconds: number): Promise<void> => {
  const signal = AbortSignal.timeout(Math.max(1, milliseconds));
  await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
};

export const sleepOf = (host: PackHost): ((milliseconds: number) => Promise<void>) => host.sleep ?? signalSleep;

/** A monotonic reading for deadlines; the shell's clock when it gave one. */
export const nowMsOf = (host: PackHost): (() => number) => host.nowMs ?? (() => performance.now());

/** The ferret this runs inside (`FY_SESSION_ID`); `undefined` in a person's shell. */
export function ambientFerret(host: PackHost): string | undefined {
  const own = host.env?.FY_SESSION_ID?.trim();
  return own === undefined || own === '' ? undefined : own;
}

/** A folder the caller typed, made absolute against where `fy` was run. */
export function absoluteOf(host: PackHost): (path: string) => string {
  const base = host.cwd ?? host.env?.PWD;
  return path => (base === undefined || path.startsWith('/') ? path : resolve(base, path));
}
