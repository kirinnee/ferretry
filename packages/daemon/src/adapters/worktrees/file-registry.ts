import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  emptyManagedWorktreeState,
  type ManagedWorktreeRegistry,
  type ManagedWorktreeRegistryState,
  managedWorktreeDocument,
  parseManagedWorktreeRegistry,
  WorktreeError,
} from '../../lib/worktrees/index.ts';

/**
 * The managed-worktree registry, as one JSON document in this daemon's own state home.
 *
 * ATOMIC BY WRITE-AND-RENAME, and serialized by one in-flight chain. The bytes land under a
 * temporary name and become the registry in one rename, and a `write` reads, applies the caller's
 * change and saves inside the chain — so two concurrent requests queue instead of interleaving a
 * read-modify-write and losing one of them.
 *
 * ATOMIC IS NOT THE SAME AS CRASH-CONSISTENT, and this store deliberately does not pretend
 * otherwise: it can only make each SAVE all-or-nothing. What happens if the daemon dies between a
 * save and the Git mutation it describes is decided one layer up, by the intent records the domain
 * writes first and reconciles later — see `src/lib/worktrees/registry.ts`.
 *
 * MISSING IS NOT DAMAGED. No file means this daemon has never made a worktree, which is an ordinary
 * first state. A file that will not parse is evidence something else happened to it, and reporting
 * that as an empty registry would let the next create hand out a destination whose predecessor
 * nobody can account for — and let a removal refuse to find a checkout that is plainly on disk.
 */
export class FileManagedWorktreeRegistry implements ManagedWorktreeRegistry {
  /** The tail of the in-flight chain. Every mutation appends to it, so none overlaps another. */
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<ManagedWorktreeRegistryState> {
    const text = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (text === undefined) return emptyManagedWorktreeState();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new WorktreeError('registry_damaged', 'the managed-worktree registry is not readable JSON');
    }
    return parseManagedWorktreeRegistry(value);
  }

  async write(mutate: (current: ManagedWorktreeRegistryState) => ManagedWorktreeRegistryState): Promise<void> {
    const next = this.serial
      .catch(() => undefined)
      .then(async () => {
        await this.#save(mutate(await this.read()));
      });
    this.serial = next;
    await next;
  }

  async #save(state: ManagedWorktreeRegistryState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(managedWorktreeDocument(state), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.file);
  }
}
