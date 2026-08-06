import { daemonSnapshotGcRoot } from './layout.ts';
import type { HeldGcRoot } from './ports.ts';

/**
 * Which garbage-collection roots the retained snapshots require, and which held roots have outlived
 * theirs.
 *
 * The rule this file exists to state: **a root's lifetime is its snapshot's lifetime.** A single root
 * per daemon can hold exactly one source closure, so promoting a second Nix-built snapshot re-pointed
 * it and quietly withdrew protection from the first — the older snapshot kept its verified executable
 * and lost the loader and shared libraries that executable still needs, which made the rollback the
 * snapshot store exists to guarantee unrunnable after the next `nix-collect-garbage`. Every retained
 * snapshot therefore gets its own root, keeps it while the snapshot is retained, and loses it only
 * when the snapshot itself is gone.
 */

/** One retained snapshot and the Nix store closure its copied executable still needs at runtime. */
export interface SnapshotClosure {
  readonly snapshotId: string;
  /**
   * The store path its verified manifest recorded, or `undefined` when the snapshot was built from an
   * installation outside the store, which Nix cannot collect and nothing has to hold.
   */
  readonly storePath: string | undefined;
}

/**
 * A root that must exist: the snapshot it belongs to, the closure it holds, and where it goes.
 *
 * Reachable only through the plan below, so a caller cannot assemble one and register a root this
 * file never decided on.
 */
interface SnapshotGcRootPin {
  readonly snapshotId: string;
  readonly storePath: string;
  readonly rootPath: string;
}

export interface SnapshotGcRootPlan {
  readonly pin: readonly SnapshotGcRootPin[];
  /**
   * Roots whose snapshot is no longer retained.
   *
   * Released because nothing can ever run that snapshot again, so the closure is held for a rollback
   * candidate that does not exist. This is the ONLY reason a root is released — never a stop, and
   * never an uninstall, both of which used to withdraw protection from snapshots that were still
   * sitting in the store waiting to be promoted.
   */
  readonly release: readonly string[];
}

export interface SnapshotGcRootRequest {
  readonly rootDirectory: string;
  /** Every snapshot the store still retains, whatever its source. */
  readonly closures: readonly SnapshotClosure[];
  /** The roots actually present, reported with the paths they were found at. */
  readonly held: readonly HeldGcRoot[];
  /**
   * The snapshot this command is about to launch, if any.
   *
   * Re-pinned even when a root for it already exists. A root is a symbolic link plus a registration
   * Nix keeps elsewhere, and only the link is ours to observe — a link copied, restored from a backup
   * or left by a half-finished write looks exactly like a live root. Re-registering the one closure
   * that is about to be executed costs a single command and removes the guess; the retained rollback
   * candidates are pinned once and then trusted, because doing that for all of them would run a Nix
   * command per snapshot on every lifecycle verb.
   */
  readonly launching: string | undefined;
}

/**
 * Reconcile the root set with the retained snapshot set.
 *
 * Total: absent, extra and duplicate roots all have an answer, and a snapshot with no store source
 * simply asks for nothing.
 */
export function planSnapshotGcRoots(request: SnapshotGcRootRequest): SnapshotGcRootPlan {
  const held = new Set(request.held.map(root => root.name));
  const retained = new Set(request.closures.map(closure => closure.snapshotId));
  const pin = request.closures.flatMap<SnapshotGcRootPin>(closure =>
    closure.storePath === undefined || (held.has(closure.snapshotId) && closure.snapshotId !== request.launching)
      ? []
      : [
          {
            snapshotId: closure.snapshotId,
            storePath: closure.storePath,
            rootPath: daemonSnapshotGcRoot(request.rootDirectory, closure.snapshotId),
          },
        ],
  );
  return { pin, release: request.held.filter(root => !retained.has(root.name)).map(root => root.path) };
}
