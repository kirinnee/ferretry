import { describe, it } from 'bun:test';
import should from 'should';
import { planSnapshotGcRoots } from '../../../src/lib/daemon/gc-roots';
import type { HeldGcRoot } from '../../../src/lib/daemon/ports';

/**
 * The decision that makes a root's lifetime its snapshot's lifetime.
 *
 * One root per daemon could protect exactly one source closure, so every promotion of a Nix-built
 * snapshot quietly withdrew protection from the one before it: the older snapshot kept its verified
 * executable and lost the loader and shared libraries it needs to run, and the rollback the snapshot
 * store exists to guarantee stopped working after the next `nix-collect-garbage`. Everything below is
 * that failure, written as a table.
 */

const ROOTS = '/state/ferretry/nix/snapshots/fyd';
const NEWER = `sha256-${'a'.repeat(64)}`;
const OLDER = `sha256-${'b'.repeat(64)}`;
const NEWER_STORE = '/nix/store/q1w2e3r4t5y6u7i8o9p0asdfghjklzxc-ferretry-0.125.0';
const OLDER_STORE = '/nix/store/zxcvbnmasdfghjklq1w2r3y4i5p6a7s8-ferretry-0.124.0';

function held(...names: readonly string[]): readonly HeldGcRoot[] {
  return names.map(name => ({ name, path: `${ROOTS}/${name}` }));
}

describe('snapshot garbage-collection root plan', () => {
  it('should give every retained store-built snapshot its own root', () => {
    // Act
    const plan = planSnapshotGcRoots({
      rootDirectory: ROOTS,
      closures: [
        { snapshotId: NEWER, storePath: NEWER_STORE },
        { snapshotId: OLDER, storePath: OLDER_STORE },
      ],
      held: [],
      launching: NEWER,
      complete: true,
    });

    // Assert — two snapshots, two roots. The older one is a rollback candidate, and a rollback
    // candidate that cannot run is not one.
    should(plan.pin).deepEqual([
      { snapshotId: NEWER, storePath: NEWER_STORE, rootPath: `${ROOTS}/${NEWER}` },
      { snapshotId: OLDER, storePath: OLDER_STORE, rootPath: `${ROOTS}/${OLDER}` },
    ]);
    should(plan.release).be.empty();
  });

  it('should leave a retained snapshot that already holds a root alone', () => {
    // Act
    const plan = planSnapshotGcRoots({
      rootDirectory: ROOTS,
      closures: [
        { snapshotId: NEWER, storePath: NEWER_STORE },
        { snapshotId: OLDER, storePath: OLDER_STORE },
      ],
      held: held(NEWER, OLDER),
      launching: undefined,
      complete: true,
    });

    // Assert — registering a root runs a Nix command, and doing it for every retained snapshot on
    // every lifecycle verb would make a start slower the longer a host has been running.
    should(plan.pin).be.empty();
    should(plan.release).be.empty();
  });

  it('should re-register the snapshot about to be launched even when a root for it exists', () => {
    // Act
    const plan = planSnapshotGcRoots({
      rootDirectory: ROOTS,
      closures: [
        { snapshotId: NEWER, storePath: NEWER_STORE },
        { snapshotId: OLDER, storePath: OLDER_STORE },
      ],
      held: held(NEWER, OLDER),
      launching: NEWER,
      complete: true,
    });

    // Assert — a root is a link plus a registration Nix keeps elsewhere, and only the link is ours to
    // observe. A copied, restored or half-written link looks exactly like a live root, so the one
    // closure that is about to be executed is registered again rather than guessed at.
    should(plan.pin).deepEqual([{ snapshotId: NEWER, storePath: NEWER_STORE, rootPath: `${ROOTS}/${NEWER}` }]);
  });

  it('should release a root whose snapshot the store no longer retains', () => {
    // Act
    const plan = planSnapshotGcRoots({
      rootDirectory: ROOTS,
      closures: [{ snapshotId: NEWER, storePath: NEWER_STORE }],
      held: held(NEWER, OLDER),
      launching: undefined,
      complete: true,
    });

    // Assert — the only lifetime that ends a root. The closure is being held for a rollback candidate
    // that does not exist, and nothing can ever run it again.
    should(plan.release).deepEqual([`${ROOTS}/${OLDER}`]);
  });

  it('should release an entry no snapshot identity accounts for, and report the path it was found at', () => {
    // Act
    const plan = planSnapshotGcRoots({
      rootDirectory: ROOTS,
      closures: [],
      held: [{ name: 'left-behind', path: '/somewhere/else/left-behind' }],
      launching: undefined,
      complete: true,
    });

    // Assert — the path travels back from discovery rather than being re-derived here, so a root that
    // was written under one rule can never be looked for under another.
    should(plan.release).deepEqual(['/somewhere/else/left-behind']);
  });

  it('should release nothing at all when the inventory is not the whole retained set', () => {
    // Arrange — an entry that could not be read is a snapshot that is STILL THERE, and a root with no
    // matching closure is indistinguishable from one whose snapshot merely could not be read.
    const plan = planSnapshotGcRoots({
      rootDirectory: ROOTS,
      closures: [{ snapshotId: NEWER, storePath: NEWER_STORE }],
      held: held(NEWER, OLDER),
      launching: NEWER,
      complete: false,
    });

    // Assert — protection is still ADDED, because that can only ever be safe; nothing is withdrawn.
    should(plan.pin).deepEqual([{ snapshotId: NEWER, storePath: NEWER_STORE, rootPath: `${ROOTS}/${NEWER}` }]);
    should(plan.release).be.empty();
  });

  it('should ask for nothing for a snapshot built outside the store', () => {
    // Act — a brew or GoReleaser install is not collectable, so nothing has to hold it.
    const plan = planSnapshotGcRoots({
      rootDirectory: ROOTS,
      closures: [{ snapshotId: NEWER, storePath: undefined }],
      held: [],
      launching: NEWER,
      complete: true,
    });

    // Assert
    should(plan.pin).be.empty();
    should(plan.release).be.empty();
  });
});
