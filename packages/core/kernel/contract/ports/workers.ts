import type { StateFileDef } from '../define.ts';
import type { FerretId } from '../ids.ts';
import type { Cancel } from './clock.ts';
import type { RootName } from './roots.ts';

/** How a worker ended: its exit code, and the uncaught error's message when one ended it. */
export interface WorkerExit {
  readonly code: number;
  readonly reason?: string;
}

export interface WorkerHandle {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  onMessage(listener: (message: unknown) => void): Cancel;
  /** Called once when the worker ends (a crash included), so a dead worker is seen rather than waited on. */
  onExit(listener: (exit: WorkerExit) => void): Cancel;
  terminate(): Promise<void>;
}

/** A declared `sqlite` / `sqlite-cache` state file a worker may open (a collection member names its `name`). */
export type WorkerStateGrant = StateFileDef | { readonly def: StateFileDef; readonly name: string };

/**
 * One of THIS plugin's declared roots a worker may READ: the name, or the name with the scope its handle takes (a
 * `subfolder` / `ferret` stays on the main thread; the worker only ever names the root). One grant per root name.
 */
export type WorkerRootGrant =
  | RootName
  | { readonly name: RootName; readonly scope?: { readonly ferret?: FerretId; readonly subfolder?: string } };

export interface WorkerStartOptions {
  readonly name?: string;
  /**
   * Declared sqlite state files the worker opens itself with `workerState().sqlite(def, name?)` from
   * `@ferretry/kernel/worker` (today's version archive runs bun:sqlite on a worker thread). The kernel resolves each
   * inside this plugin's state folder; an undeclared or non-sqlite file refuses the start. No path is passed in.
   */
  readonly state?: readonly WorkerStateGrant[];
  /**
   * Roots the worker READS with `rootPort(name)` from `@ferretry/kernel/worker`, whatever the manifest says about
   * writing: the worker side has no write, remove, copy, pin or real-path operation at all, and no path crosses into
   * the thread. Only roots THIS plugin's manifest declares (`permissions.roots`); an undeclared one refuses the start.
   * Every read is served by the main thread through the plugin's own root handle, so each is fenced as a main-thread
   * read is, links and `..` included. Paths are relative to the root: an absolute path is
   * refused `outside`, even one that falls inside it.
   *
   * GAP: this bounds what a worker gets THROUGH this port, no more. A worker is an in-process thread, not a sandbox:
   * it can still `import 'node:fs'`, call the global `fetch` or start a `Worker` of its own. What stops plugin code
   * doing that is the repo's lints (`banned-globals`, `fetch-binding`, `no-sync-io`) and the worker bundle diet
   * test, not this grant; the `state` grant above has the same limit. "Cannot widen" means: through the grant
   * channel, a forged message or a second `rootPort` gets nothing more than was granted.
   */
  readonly roots?: readonly WorkerRootGrant[];
  /**
   * HTTP from the worker with `fetchPort()` from `@ferretry/kernel/worker`, to ONLY the hosts THIS plugin's manifest
   * declares in `permissions.network`: `true` for all of them, or a list that must be a subset. Each request passes
   * the very guard `kernel.fetch` does (allowlist, no followed redirect), so a redirect to another host is a response
   * the worker would have to ask for again, and is refused then. Undeclared refuses the start. A worker may not set
   * the `Host` header, and a request body is capped at 8 MiB (`too_large`), as a response is.
   *
   * GAP: as for `roots`, the grant bounds the fetch THROUGH `fetchPort()` only; the thread is in-process, so
   * nothing but the lints and the diet test keep plugin code off the global `fetch`. On the main thread,
   * `kernel.fetch` still forwards a `Host` header a plugin sets (the guard judges the URL's host, as before);
   * only the worker channel refuses it.
   */
  readonly network?: true | readonly string[];
  /**
   * The worker's whole environment. Absent, a worker sees the process environment (a Bun `Worker` copies it); given,
   * it sees only these variables, `{}` being none. `fyd --check` starts its probes with `{}`.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface WorkersPort {
  /** A Bun worker thread from the subsystem's own package (a module URL resolved from the half). */
  start(moduleUrl: URL, options?: WorkerStartOptions): WorkerHandle;
}
