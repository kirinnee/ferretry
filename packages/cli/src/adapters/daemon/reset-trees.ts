import { lstat, rm } from 'node:fs/promises';
import type { IResetTreePort, ResetTreeMeasure } from '../../lib/daemon/ports.ts';
import { walkTree } from './state-tree.ts';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/**
 * The two trees a reset destroys, measured and then removed.
 *
 * **EVERY FAILURE THROWS**, which is the opposite of the retired-artifact port sitting next to it and
 * is the whole reason both exist. Retiring an artifact an earlier release left is tidying: it may never
 * fail a lifecycle verb, so it reports its problems as values. A reset has already told somebody
 * exactly what it was going to remove and has already stopped their daemon — a removal that quietly
 * did not happen leaves them believing they are on a clean slate when they are on the half-state this
 * verb exists to stop people reaching by hand.
 *
 * **A ROOT THAT IS ITSELF A SYMBOLIC LINK IS REFUSED.** Removing the link would unlink one entry and
 * leave every byte of the tree behind, while this reported a clean slate — a lie with no error in it.
 * `FY_HOME` bans links anyway, so a linked root means the operator pointed one somewhere unusual, and
 * the honest answer is to say so and stop rather than to follow it into somebody's real data.
 *
 * Links INSIDE a tree are a different case and are handled the other way: counted, unlinked, never
 * followed, and reported to the caller so a person is told which ones before they authorize anything.
 */
export class FileResetTrees implements IResetTreePort {
  async measure(root: string): Promise<ResetTreeMeasure> {
    if (!(await this.#present(root))) return { kind: 'absent' };
    const walk = await walkTree(root, { unseal: false });
    return { kind: 'measured', files: walk.files, bytes: walk.bytes, escapingLinks: walk.escapingLinks };
  }

  async remove(root: string): Promise<ResetTreeMeasure> {
    if (!(await this.#present(root))) return { kind: 'absent' };
    const walk = await walkTree(root, { unseal: true });
    await rm(root, { recursive: true, force: true });
    return { kind: 'measured', files: walk.files, bytes: walk.bytes, escapingLinks: walk.escapingLinks };
  }

  /** Is there a tree here at all, and is it one this may act on? `lstat`, so a link is seen as a link. */
  async #present(root: string): Promise<boolean> {
    let state: Awaited<ReturnType<typeof lstat>>;
    try {
      state = await lstat(root);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    if (state.isSymbolicLink()) {
      throw new Error(
        `refusing to reset ${root}: it is a symbolic link, so removing it would leave the data it points at behind`,
      );
    }
    if (!state.isDirectory()) {
      throw new Error(`refusing to reset ${root}: it is not a directory`);
    }
    return true;
  }
}
