import { isWithinDirectory } from './policy.ts';
import { WorktreeError } from './errors.ts';

/** One daemon's folder admissions, shared by start, every resume and checkout moves. */
export class FerretFolderGuard {
  private readonly moving = new Set<string>();
  private readonly launching = new Map<object, string>();

  async launch<T>(folder: string, refused: () => T, launch: () => Promise<T>): Promise<T> {
    if ([...this.moving].some(root => isWithinDirectory(root, folder))) return refused();
    const admission = {};
    this.launching.set(admission, folder);
    try {
      return await launch();
    } finally {
      this.launching.delete(admission);
    }
  }

  async move<T>(folder: string, move: () => Promise<T>): Promise<T> {
    if ([...this.moving].some(root => isWithinDirectory(root, folder) || isWithinDirectory(folder, root)))
      throw new WorktreeError('unsafe_move', 'cannot move: another move is in progress');
    if ([...this.launching.values()].some(cwd => isWithinDirectory(folder, cwd)))
      throw new WorktreeError('unsafe_move', 'cannot move: a ferret is starting or resuming in this checkout');
    this.moving.add(folder);
    try {
      return await move();
    } finally {
      this.moving.delete(folder);
    }
  }
}
