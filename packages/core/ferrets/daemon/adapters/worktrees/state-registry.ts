import type { StatePort } from '@ferretry/kernel/contract';
import { WorktreesFile } from '../../../contract/index.ts';
import {
  emptyManagedWorktreeState,
  type ManagedWorktreeRegistry,
  type ManagedWorktreeRegistryState,
  managedWorktreeDocument,
  parseManagedWorktreeRegistry,
  WorktreeError,
} from '../../lib/worktrees/index.ts';

/**
 * The managed-worktree registry, as one JSON document in Ferrets' state (`state/ferrets/worktrees.json`).
 *
 * SERIALIZED BY THE STATE PORT'S CHAIN. A `write` reads, applies the caller's change and saves inside
 * `update`'s per-file chain — so two concurrent requests queue instead of interleaving a read-modify-write
 * and losing one of them — and the kernel makes each save all-or-nothing (today: write-and-rename).
 *
 * ATOMIC IS NOT THE SAME AS CRASH-CONSISTENT, and this store deliberately does not pretend
 * otherwise: it can only make each SAVE all-or-nothing. What happens if the daemon dies between a
 * save and the Git mutation it describes is decided one layer up, by the intent records the domain
 * writes first and reconciles later — see `daemon/lib/worktrees/registry.ts`.
 *
 * MISSING IS NOT DAMAGED. No file means this daemon has never made a worktree, which is an ordinary
 * first state. A file that will not parse is evidence something else happened to it, and reporting
 * that as an empty registry would let the next create hand out a destination whose predecessor
 * nobody can account for — and let a removal refuse to find a checkout that is plainly on disk.
 */
export class StateManagedWorktreeRegistry implements ManagedWorktreeRegistry {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<ManagedWorktreeRegistryState> {
    const read = await this.state.read(WorktreesFile);
    if (!read.ok) throw damaged();
    return read.value === undefined ? emptyManagedWorktreeState() : parseManagedWorktreeRegistry(read.value);
  }

  async write(mutate: (current: ManagedWorktreeRegistryState) => ManagedWorktreeRegistryState): Promise<void> {
    const written = await this.state.update(WorktreesFile, current =>
      managedWorktreeDocument(
        mutate(current === undefined ? emptyManagedWorktreeState() : parseManagedWorktreeRegistry(current)),
      ),
    );
    if (!written.ok) throw damaged();
  }
}

const damaged = (): WorktreeError =>
  new WorktreeError('registry_damaged', 'the managed-worktree registry is damaged and cannot be read');
