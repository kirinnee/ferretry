import type { RootHandle } from '@ferretry/kernel/contract';
import type { SessionId } from '../../lib/session-id.ts';

/** What a store that keeps a ferret's private session files needs of its root besides the calls it makes. */
export type SessionsRootIdentity = Pick<RootHandle, 'name' | 'internal' | 'resolve' | 'ensurePrivateDirectory'>;

/**
 * Refuses, at construction, a root a session's private files must never sit on.
 *
 * These files are a plaintext credential, an irreversible-act ledger whose compare-and-set wedges on an owner's root,
 * and the assigned task. They live on the `sessions` root: internal, private (`0700`/`0600`), one minted ferret folder
 * per handle. A `work` handle, or any other owner's root, is the person's own folder tree: nothing may be written there
 * on a session's behalf, so a store handed one throws.
 */
export function assertSessionsRoot(root: Pick<RootHandle, 'name' | 'internal'>, owner: string): void {
  if (!root.internal || root.name !== 'sessions')
    throw new Error(`${owner} keeps a session's private files on the internal sessions root only (got ${root.name})`);
}

/** One handle belongs to one ferret: a call that names another session is refused rather than written to this folder. */
export function assertOwnSession(own: SessionId, asked: SessionId, owner: string): void {
  if (own !== asked) throw new Error(`${owner} was asked about session ${asked} through the folder of ${own}`);
}

/**
 * The ferret's own folder on the `sessions` root, made `0700` before the first thing is read or written through its
 * handle, and held to `0700` if it already existed wider. The kernel refuses a read below a scoped folder that is not
 * there yet (`outside`), so without this a never-launched session could not even be asked whether it has an
 * environment or an effect on record. Idempotent; only a success is remembered.
 */
export class OwnFolder {
  private done: Promise<void> | undefined;

  constructor(private readonly root: SessionsRootIdentity) {}

  async ensure(): Promise<void> {
    this.done ??= this.make().catch((error: unknown) => {
      this.done = undefined;
      throw error;
    });
    await this.done;
  }

  private async make(): Promise<void> {
    const own = this.root.resolve('.');
    if (!own.ok) throw new Error(`the ferret's session folder is outside its root (${own.error})`);
    await this.root.ensurePrivateDirectory(own.value);
  }
}
