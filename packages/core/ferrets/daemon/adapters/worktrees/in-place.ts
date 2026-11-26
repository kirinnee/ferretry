import path from 'node:path';
import type { ManagedWorktreeOperations } from '../../lib/worktrees/service.ts';
import type {
  GitRunner,
  GitWorkingDirectory,
  WorktreeClock,
  WorktreeDirectoryPinner,
  WorktreeFileSystem,
} from '../../lib/worktrees/ports.ts';
import type {
  ManagedWorktree,
  ManagedWorktreeIntent,
  ManagedWorktreeInspection,
  WorktreeAdoptionIdentity,
} from '../../lib/worktrees/types.ts';
import { WorktreeError } from '../../lib/worktrees/errors.ts';
import { GitRepoWorktreeRows } from './repo-git.ts';
import type { RepoCheckoutPin, RepoWorktreeAccess } from './repo-access.ts';
import { GitWorktreeGateway } from './git-gateway.ts';
import { ManagedWorktreeAdapter } from './service.ts';
import { WorktreeOperationQueue } from './queue.ts';

const refused = (reason: string) => new WorktreeError('unsafe_remove', `cannot adopt: ${reason}`);
const markerOf = (record: { readonly gitDir: string }) => path.join(record.gitDir, 'worktree-owner');
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const identityOf = (pin: RepoCheckoutPin): WorktreeAdoptionIdentity => ({
  checkout: `${pin.identity.device}:${pin.identity.inode}`,
  gitDirectory: `${pin.gitIdentity.device}:${pin.gitIdentity.inode}`,
  commonDirectory: `${pin.commonIdentity.device}:${pin.commonIdentity.inode}`,
});
const unknownInspection = (record: ManagedWorktree, error: unknown): ManagedWorktreeInspection => ({
  live: { detached: false, undetermined: [reasonOf(error)] },
  decision: {
    path: record.path,
    branch: record.branch,
    removable: false,
    blockers: [{ code: 'undetermined_evidence', message: reasonOf(error) }],
  },
});

/** In-place adoption and every later read reuse the repository listing's authorized, held Git path. */
export class InPlaceWorktrees {
  constructor(
    private readonly base: ManagedWorktreeOperations,
    private readonly runner: GitRunner,
    private readonly access: RepoWorktreeAccess,
    private readonly files: WorktreeFileSystem,
    private readonly clock: WorktreeClock,
    private readonly stateHomeHolding: (folder: string) => Promise<string | undefined>,
  ) {}

  async adoptExisting(
    folder: string,
    token: string,
    onPlanned: (record: ManagedWorktree, identity: WorktreeAdoptionIdentity) => Promise<void>,
  ): Promise<ManagedWorktree> {
    if (!path.isAbsolute(folder) || path.resolve(folder) !== folder)
      throw refused('an absolute checkout root is required');
    if ((await this.stateHomeHolding(folder)) !== undefined) throw refused('the checkout is inside a state home');
    const commonDir = await this.access.commonDirectory(folder);
    return await this.#read(async reader => {
      const rows = await reader.rows(commonDir);
      const row = rows.find(entry => entry.path === folder);
      if (row === undefined || row === rows[0] || row.bare || row.prunable !== undefined)
        throw refused('the path must be an existing linked worktree, never the main checkout');
      const held = await reader.holdCheckout(folder);
      try {
        return await reader.inCheckout(
          folder,
          undefined,
          async runner => {
            const checkout = await new GitWorktreeGateway(runner, this.files, this.clock).inspect(folder);
            if (
              checkout.kind !== 'linked_worktree' ||
              checkout.worktreeRoot !== folder ||
              checkout.commonDir !== commonDir ||
              checkout.gitDir === undefined ||
              checkout.repositoryRoot === undefined ||
              checkout.branch === undefined ||
              checkout.head === undefined ||
              checkout.detached
            )
              throw refused('the linked checkout identity or branch could not be proved');
            const record: ManagedWorktree = {
              version: 1,
              origin: 'adopted',
              adoptionIdentity: identityOf(held),
              path: folder,
              branch: checkout.branch,
              repositoryRoot: checkout.repositoryRoot,
              commonDir,
              gitDir: checkout.gitDir,
              ownershipToken: token,
              createdAt: this.clock.nowIso(),
              initialHead: checkout.head,
              branchPreexisted: true,
              sourceCwd: folder,
              relativeCwd: '',
            };
            // Exclusive marker creation cannot overwrite somebody else's ownership. Intent first makes a
            // crash after this marker recoverable without treating an arbitrary pre-existing marker as ours.
            if ((await this.files.type(markerOf(record))) !== 'missing')
              throw refused('an ownership marker already exists');
            await onPlanned(record, identityOf(held));
            await held.verify();
            if ((await this.stateHomeHolding(folder)) !== undefined)
              throw refused('the checkout is inside a state home');
            await this.files.writeText(markerOf(record), token, 0o600);
            return record;
          },
          false,
          held,
        );
      } finally {
        await held.close();
      }
    });
  }

  operations(): ManagedWorktreeOperations {
    return {
      create: async input => await this.base.create(input),
      examine: async input =>
        input.managed.origin === 'adopted' || input.reviewIdentity
          ? await this.#scoped(input.managed, async adapter => await adapter.examine(input)).catch(error =>
              unknownInspection(input.managed, error),
            )
          : await this.base.examine(input),
      remove: async input =>
        input.managed.origin === 'adopted' || input.expectedIdentity !== undefined
          ? await this.#scoped(input.managed, async adapter => await adapter.remove(input), true)
          : await this.base.remove(input),
      presence: async entry => {
        if (entry.origin !== 'adopted') return await this.base.presence(entry);
        try {
          if ((await this.files.type(entry.path)) === 'missing') return { kind: 'absent' };
          return await this.#scoped(entry, async adapter => await adapter.presence(entry));
        } catch (error) {
          return { kind: 'unverified', reason: reasonOf(error) };
        }
      },
      adopt: async intent =>
        intent.origin === 'adopted'
          ? await this.#scoped(intent, async adapter => await adapter.adopt(intent)).catch(error => ({
              kind: 'unverified' as const,
              reason: reasonOf(error),
            }))
          : await this.base.adopt(intent),
    };
  }

  async #read<T>(read: (reader: GitRepoWorktreeRows) => Promise<T>): Promise<T> {
    const reader = new GitRepoWorktreeRows(this.runner, this.access);
    try {
      return await read(reader);
    } finally {
      await reader.close();
    }
  }

  async #scoped<T>(
    record: ManagedWorktree | ManagedWorktreeIntent,
    use: (adapter: ManagedWorktreeAdapter) => Promise<T>,
    removesCheckout = false,
  ): Promise<T> {
    if ((await this.stateHomeHolding(record.path)) !== undefined) throw refused('the checkout is inside a state home');
    return await this.#read(async reader => {
      await reader.rows(record.commonDir);
      const recoveryIdentity = record.adoptionIdentity;
      const recovery = recoveryIdentity === undefined ? undefined : await reader.holdCheckout(record.path);
      try {
        if (recovery !== undefined && recoveryIdentity !== undefined) {
          const current = identityOf(recovery);
          if (
            current.checkout !== recoveryIdentity.checkout ||
            current.gitDirectory !== recoveryIdentity.gitDirectory ||
            current.commonDirectory !== recoveryIdentity.commonDirectory
          )
            throw refused('the checkout or repository identity changed since adoption was authorized');
        }
        const pins = new Map<GitWorkingDirectory, RepoCheckoutPin>();
        const pinner: WorktreeDirectoryPinner = {
          pin: async folder => {
            const held = await reader.holdCheckout(folder);
            pins.set(held.cwd, held);
            return {
              rootReal: held.rootReal,
              identity: `${held.identity.device}:${held.identity.inode}`,
              policyCwd: held.cwd,
              close: async () => {
                pins.delete(held.cwd);
                await held.close();
              },
            };
          },
        };
        const runner: GitRunner = {
          run: async invocation => {
            const cwd = invocation.cwd;
            const held = cwd === undefined ? undefined : pins.get(cwd);
            const folder = typeof cwd === 'string' ? cwd : held?.rootReal;
            if (folder === undefined) throw refused('the Git working directory is not authorized');
            if (folder === record.path) await recovery?.verify();
            return await reader.inCheckout(
              folder,
              invocation.signal,
              async scoped => await scoped.run(invocation),
              invocation.args[0] === 'worktree' && invocation.args[1] === 'remove',
              held,
            );
          },
        };
        const result = await use(
          new ManagedWorktreeAdapter(
            new GitWorktreeGateway(runner, this.files, this.clock),
            this.files,
            this.clock,
            new WorktreeOperationQueue(),
            pinner,
          ),
        );
        if (!removesCheckout) await recovery?.verify();
        return result;
      } finally {
        await recovery?.close();
      }
    });
  }
}
