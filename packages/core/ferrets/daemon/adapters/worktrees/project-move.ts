import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  MoveProjectWorktreeRequest,
  MovedProjectWorktree,
  ProjectRepository,
  RepoWorktreeListResponse,
  RepoWorktreeRow,
  WorktreeMoveOffer,
} from '../../../contract/index.ts';
import { isPathSafeWorktreeGroup } from '../../../contract/index.ts';
import type { WorktreeHostIo, WorktreesNeeds } from '../../modules/worktrees.ts';
import type { ManagedWorktreeRegistry } from '../../lib/worktrees/registry.ts';
import type { ManagedWorktree, WorktreeAdoptionIdentity } from '../../lib/worktrees/types.ts';
import { isWithinDirectory } from '../../lib/worktrees/policy.ts';
import { isWorktreeSessionActive } from '../../lib/worktrees/service.ts';
import { WorktreeError } from '../../lib/worktrees/errors.ts';
import { KernelGitRunner } from '../git/runner.ts';
import { GitRepoWorktreeRows } from './repo-git.ts';
import type { RepoCheckoutPin } from './repo-access.ts';
import { GitWorktreeGateway } from './git-gateway.ts';
import { KernelWorktreeClock } from './filesystem.ts';

const hash = (text: string, length = 64): string => createHash('sha256').update(text).digest('hex').slice(0, length);
const slug = (text: string, max: number): string =>
  text
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'repo';
const idOf = (record: ManagedWorktree): string => hash(record.ownershipToken);
const identityOf = (pin: RepoCheckoutPin): WorktreeAdoptionIdentity => ({
  checkout: `${pin.identity.device}:${pin.identity.inode}`,
  gitDirectory: `${pin.gitIdentity.device}:${pin.gitIdentity.inode}`,
  commonDirectory: `${pin.commonIdentity.device}:${pin.commonIdentity.inode}`,
});
const sameIdentity = (a: WorktreeAdoptionIdentity, b: WorktreeAdoptionIdentity) =>
  a.checkout === b.checkout && a.gitDirectory === b.gitDirectory && a.commonDirectory === b.commonDirectory;
function refuse(reason: string): never {
  throw new WorktreeError('unsafe_move', `cannot move: ${reason}`);
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface ProjectWorktreeHost {
  readonly recorded: ProjectRepository;
  readonly host: WorktreeHostIo;
}

/** A tracked checkout only: the project gives a group, while Git and the existing roots prove what may move. */
export class ProjectWorktreeMoves {
  constructor(
    private readonly needs: WorktreesNeeds,
    private readonly registry: ManagedWorktreeRegistry,
    private readonly projectHost: (project: string, commonDirectory?: string) => Promise<ProjectWorktreeHost>,
  ) {}

  /** Settle an authorized rename, repairing its Git back-pointer if necessary; checkout files are never moved again. */
  async reconcile(commonDirectory: string): Promise<void> {
    const records = (await this.registry.read()).worktrees;
    for (const record of records) {
      if (record.commonDir !== commonDirectory || record.pendingMove === undefined) continue;
      const pending = record.pendingMove;
      try {
        const host = this.#writeHost();
        if ((await host.fileSystem.type(pending.destination)) === 'missing') {
          await this.#read(host, record, async (_reader, held) => {
            if (!sameIdentity(identityOf(held), pending.identity))
              refuse('the interrupted move changed identity; all files are kept');
            await this.#clearPending(record);
          });
        } else await this.#recover(host, record);
      } catch {
        // An interrupted row must never hide the other checkouts. Its durable intent supplies the repair instruction.
      }
    }
  }

  async offers(project: string, list: RepoWorktreeListResponse): Promise<RepoWorktreeListResponse> {
    const { host, recorded } = await this.projectHost(project, list.commonDirectory);
    const records = (await this.registry.read()).worktrees;
    const terminals = await this.needs.terminalRoots().catch(() => undefined);
    const reader = new GitRepoWorktreeRows(new KernelGitRunner(host.git), host.repoAccess);
    try {
      await reader.rows(recorded.commonDirectory);
      const worktrees: RepoWorktreeRow[] = [];
      for (const row of list.worktrees) {
        const record = records.find(
          entry =>
            (entry.path === row.path || entry.pendingMove?.destination === row.path) && entry.removedAt === undefined,
        );
        const blocked = this.#rowReason(row, record, recorded, host.managedRoot, terminals);
        let move: WorktreeMoveOffer = {
          worktreeId: record === undefined ? hash(row.path) : idOf(record),
          reason: blocked,
        };
        if (blocked === undefined && record !== undefined) {
          try {
            await this.#authority(this.#writeHost(), record);
            const held = await reader.holdCheckout(record.path);
            try {
              const destination = this.#destination(host, recorded, record);
              if (record.adoptionIdentity !== undefined && !sameIdentity(record.adoptionIdentity, identityOf(held)))
                refuse('the adopted checkout identity changed');
              if (
                held.gitDirectory !== record.gitDir ||
                (await host.fileSystem.readText(path.join(record.gitDir, 'worktree-owner'))) !== record.ownershipToken
              )
                refuse('the ownership marker changed');
              if ((await host.fileSystem.type(destination)) !== 'missing') refuse('the destination already exists');
              move = {
                worktreeId: idOf(record),
                destination,
                reviewedIdentity: this.#review(
                  record,
                  held,
                  row.live.head ?? refuse('the checkout HEAD is unknown'),
                  destination,
                ),
              };
            } finally {
              await held.close();
            }
          } catch (error) {
            move = { worktreeId: idOf(record), reason: message(error) };
          }
        }
        worktrees.push({ ...row, move });
      }
      return { ...list, worktrees };
    } finally {
      await reader.close();
    }
  }

  async move(request: MoveProjectWorktreeRequest): Promise<MovedProjectWorktree> {
    const record = (await this.registry.read()).worktrees.find(
      entry => idOf(entry) === request.worktreeId && entry.removedAt === undefined,
    );
    if (record === undefined) refuse('that tracked worktree does not belong to this project');
    const { recorded } = await this.projectHost(request.project, record.commonDir);
    // Imports authorize reads only. Mutations use exactly the managed create/remove host's existing work/worktrees roots.
    const host = this.#writeHost();
    if (record.commonDir !== recorded.commonDirectory) refuse('that tracked worktree does not belong to this project');
    const destination = record.pendingMove?.destination ?? this.#destination(host, recorded, record);
    const apply = async () => {
      await this.#authority(host, record);
      if (record.pendingMove !== undefined) return await this.#recover(host, record);
      return await this.#read(host, record, async (reader, held) => {
        const head = await this.#verify(host, record, reader, held);
        if (this.#review(record, held, head, destination) !== request.reviewedIdentity)
          refuse('the reviewed checkout changed; refresh and review it again');
        await this.#parents(host, destination);
        if ((await host.fileSystem.type(destination)) !== 'missing') refuse('the destination already exists');
        const pending = { destination, identity: identityOf(held) };
        await this.registry.write(state => ({
          ...state,
          worktrees: state.worktrees.map(entry =>
            entry.path === record.path ? { ...entry, pendingMove: pending } : entry,
          ),
        }));
        // Read all safety facts again after the durable intent and immediately before the Git spawn.
        try {
          const currentHead = await this.#verify(host, record, reader, held);
          if (this.#review(record, held, currentHead, destination) !== request.reviewedIdentity)
            refuse('the reviewed checkout changed; refresh and review it again');
          if ((await host.fileSystem.type(destination)) !== 'missing') refuse('the destination already exists');
          const repository = await host.repoAccess.repository(record.commonDir);
          try {
            await repository.verify();
            await this.#idle(record.path);
            if ((await host.fileSystem.realPath(path.dirname(destination))) !== path.dirname(destination))
              refuse('the destination parent changed');
            await held.verify();
            const result = await new KernelGitRunner(host.git).run({
              cwd: repository.cwd,
              args: ['--git-dir=.', 'worktree', 'move', '--', record.path, destination],
            });
            if (result.exitCode !== 0 || result.timedOut)
              throw new Error(result.stderr || 'Git did not complete the move');
          } finally {
            await repository.close();
          }
        } catch (error) {
          if (
            (await host.fileSystem.type(record.path)) === 'directory' &&
            (await host.fileSystem.type(destination)) === 'missing'
          ) {
            await this.#clearPending(record);
            refuse(`nothing was moved; the original checkout is unchanged. ${message(error)}`);
          }
          // Git may have renamed the checkout before reporting a metadata error. Preserve it and its intent, never
          // copy/delete or roll back blindly. A retry proves the exact new incarnation before finishing the registry.
          refuse(`the move needs verification; all files are kept. Retry this confirmation. ${message(error)}`);
        }
        return await this.#recover(host, { ...record, pendingMove: pending });
      });
    };
    const guarded = async () =>
      this.needs.withTerminalRemoval === undefined
        ? await apply()
        : await this.needs.withTerminalRemoval(record.path, apply);
    // Git makes the destination launchable before it updates its back-pointer. Hold both paths until reconciliation
    // has settled the registry too; the admission brackets release both on every failure as well.
    const withMove = this.needs.withFerretMove;
    return withMove === undefined
      ? await guarded()
      : await withMove(record.path, async () => await withMove(destination, guarded));
  }

  #rowReason(
    row: RepoWorktreeRow,
    record: ManagedWorktree | undefined,
    project: ProjectRepository,
    managedRoot: string,
    terminals: readonly string[] | undefined,
  ): string | undefined {
    if (row.main || row.bare) return 'The main checkout cannot move.';
    if (isWithinDirectory(row.path, project.folder))
      return 'This is the registered project folder; move another linked checkout.';
    if (record?.pendingMove !== undefined)
      return `This move needs repair; all files are kept. Retry the confirmation, or run git worktree repair -- '${record.pendingMove.destination.replaceAll("'", "'\\''")}' from the repository.`;
    if (row.live.prunable !== undefined) return 'Its folder is missing on disk.';
    if (record === undefined || row.tracked === 'none') return 'Adopt it first to move it.';
    if (project.worktreeGroup === undefined) return 'This project has no common worktree root.';
    if (isWithinDirectory(path.join(managedRoot, project.worktreeGroup), row.path))
      return 'It is already in the project’s worktree root.';
    if (record.removalStartedAt !== undefined) return 'Another worktree operation needs verification.';
    if (row.live.locked !== undefined) return 'This worktree is locked.';
    if (row.live.detached || row.live.head === undefined || row.live.branch !== record.branch)
      return 'The recorded branch or HEAD changed.';
    const status = row.live.status;
    if (status === undefined || status.truncated) return 'The working tree status could not be verified.';
    if (status.staged || status.unstaged || status.untracked || status.conflicted || status.dirtySubmodule)
      return 'This checkout has uncommitted or untracked files.';
    if (row.ferrets === undefined) return 'The live ferret list could not be read.';
    if (row.ferrets.some(ferret => ferret.active)) return 'A live ferret is working in this checkout.';
    if (terminals === undefined) return 'The live terminal list could not be read.';
    if (terminals.some(folder => isWithinDirectory(row.path, folder)))
      return 'A live terminal is inside this checkout.';
    return undefined;
  }

  #writeHost(): WorktreeHostIo {
    return this.needs.io ?? refuse('the existing worktree write authority is unavailable');
  }

  async #authority(host: WorktreeHostIo, record: ManagedWorktree): Promise<void> {
    try {
      for (const folder of [record.pendingMove?.destination ?? record.path, record.gitDir, record.commonDir]) {
        const held = await host.pinner.pin(folder);
        await held.close();
      }
    } catch {
      refuse('the existing worktree write authority does not cover this checkout and its Git metadata');
    }
  }

  #destination(host: WorktreeHostIo, project: ProjectRepository, record: ManagedWorktree): string {
    if (isWithinDirectory(record.path, project.folder))
      refuse('this is the registered project folder; move another linked checkout');
    const group = project.worktreeGroup;
    if (group === undefined || !isPathSafeWorktreeGroup(group)) refuse('the project has no valid worktree group');
    if (isWithinDirectory(path.join(host.managedRoot, group), record.path))
      refuse('it is already in the project’s worktree root');
    return path.join(
      host.managedRoot,
      group,
      `${slug(path.basename(record.repositoryRoot), 32)}-${hash(record.commonDir, 10)}`,
      `${slug(record.branch, 48)}-${hash(record.branch, 8)}`,
    );
  }

  #review(record: ManagedWorktree, held: RepoCheckoutPin, head: string, destination: string): string {
    return hash(
      JSON.stringify([
        record.ownershipToken,
        record.path,
        record.branch,
        record.commonDir,
        identityOf(held),
        head,
        destination,
      ]),
    );
  }

  async #read<T>(
    host: WorktreeHostIo,
    record: ManagedWorktree,
    read: (reader: GitRepoWorktreeRows, held: RepoCheckoutPin) => Promise<T>,
  ): Promise<T> {
    const reader = new GitRepoWorktreeRows(new KernelGitRunner(host.git), host.repoAccess);
    try {
      const entries = await reader.rows(record.commonDir);
      const row = entries.find(entry => entry.path === record.path);
      if (row === undefined || row === entries[0] || row.bare || row.prunable !== undefined)
        refuse('only an existing linked worktree can move; never the main checkout');
      if (row.locked !== undefined) refuse('this worktree is locked');
      const held = await reader.holdCheckout(record.path);
      try {
        return await read(reader, held);
      } finally {
        await held.close();
      }
    } finally {
      await reader.close();
    }
  }

  async #verify(
    host: WorktreeHostIo,
    record: ManagedWorktree,
    reader: GitRepoWorktreeRows,
    held: RepoCheckoutPin,
  ): Promise<string> {
    if (record.removalStartedAt !== undefined) refuse('removal is in progress');
    if (this.needs.stateHomeHolding === undefined) refuse('the state home fence is unavailable');
    if ((await this.needs.stateHomeHolding(record.path)) !== undefined) refuse('the checkout is inside a state home');
    if (record.adoptionIdentity !== undefined && !sameIdentity(record.adoptionIdentity, identityOf(held)))
      refuse('the adopted checkout identity changed');
    if (
      held.gitDirectory !== record.gitDir ||
      (await host.fileSystem.readText(path.join(record.gitDir, 'worktree-owner'))) !== record.ownershipToken
    )
      refuse('the ownership marker changed');
    await this.#idle(record.path);
    return await reader.inCheckout(
      record.path,
      undefined,
      async runner => {
        const gateway = new GitWorktreeGateway(runner, host.fileSystem, new KernelWorktreeClock(this.needs.clock));
        const checkout = await gateway.inspect(record.path);
        if (
          checkout.kind !== 'linked_worktree' ||
          checkout.commonDir !== record.commonDir ||
          checkout.branch !== record.branch ||
          checkout.head === undefined ||
          checkout.detached ||
          checkout.locked !== undefined ||
          checkout.prunable !== undefined
        )
          refuse('the linked worktree identity, branch or lock changed');
        const status = await gateway.status(held.cwd);
        if (
          status.staged ||
          status.unstaged ||
          status.untracked ||
          status.conflicted ||
          status.dirtySubmodule ||
          status.truncated
        )
          refuse('the checkout has uncommitted or untracked files');
        return checkout.head;
      },
      held,
    );
  }

  async #parents(host: WorktreeHostIo, destination: string): Promise<void> {
    for (const directory of [host.managedRoot, path.dirname(path.dirname(destination)), path.dirname(destination)]) {
      const kind = await host.fileSystem.type(directory);
      if (kind !== 'directory' && kind !== 'missing') refuse('the destination parent is not a plain directory');
      await host.fileSystem.makeDirectory(directory, 0o700);
      if ((await host.fileSystem.realPath(directory)) !== directory) refuse('the destination parent changed identity');
    }
  }

  async #idle(folder: string): Promise<void> {
    const [sessions, terminals] = await Promise.all([
      this.needs.sessions().catch(() => undefined),
      this.needs.terminalRoots().catch(() => undefined),
    ]);
    if (sessions === undefined || terminals === undefined) refuse('the live ferret or terminal list could not be read');
    if (sessions.some(session => isWorktreeSessionActive(session) && isWithinDirectory(folder, session.cwd)))
      refuse('a live ferret is working in this checkout');
    if (terminals.some(root => isWithinDirectory(folder, root))) refuse('a live terminal is inside this checkout');
  }

  async #clearPending(record: ManagedWorktree): Promise<void> {
    await this.registry.write(state => ({
      ...state,
      worktrees: state.worktrees.map(entry => {
        if (entry.path !== record.path) return entry;
        const { pendingMove: _, ...rest } = entry;
        return rest;
      }),
    }));
  }

  async #recover(host: WorktreeHostIo, record: ManagedWorktree): Promise<MovedProjectWorktree> {
    const pending = record.pendingMove;
    if (pending === undefined) refuse('there is no recorded move to verify');
    const moved = { ...record, path: pending.destination };
    await this.#authority(host, record);
    const repository = await host.repoAccess.repository(record.commonDir);
    try {
      // The checkout's .git and admin commondir still prove membership even when Git's back-pointer is stale.
      const held = await host.repoAccess.checkout(pending.destination, repository);
      try {
        if (!sameIdentity(identityOf(held), pending.identity) || held.gitDirectory !== record.gitDir)
          refuse('the moved checkout identity cannot be proved; all files are kept');
        if ((await host.fileSystem.readText(path.join(record.gitDir, 'worktree-owner'))) !== record.ownershipToken)
          refuse('the moved ownership marker cannot be proved');
        if ((await host.fileSystem.type(record.path)) !== 'missing')
          refuse('the original path is occupied; all files are kept');
        const listed = await host.fileSystem.readText(path.join(record.gitDir, 'gitdir'));
        if (listed?.trim() !== path.join(pending.destination, '.git')) {
          await held.verify();
          const result = await new KernelGitRunner(host.git).run({
            cwd: repository.cwd,
            args: ['--git-dir=.', 'worktree', 'repair', '--', pending.destination],
          });
          if (result.exitCode !== 0 || result.timedOut)
            refuse(
              `the move needs repair; all files are kept. Run git worktree repair -- '${pending.destination.replaceAll("'", "'\\''")}' from the repository`,
            );
          await held.verify();
        }
      } finally {
        await held.close();
      }
    } finally {
      await repository.close();
    }
    await this.#read(host, moved, async (_reader, held) => {
      if (!sameIdentity(identityOf(held), pending.identity))
        refuse('the moved checkout identity cannot be proved; all files are kept');
      if ((await host.fileSystem.readText(path.join(record.gitDir, 'worktree-owner'))) !== record.ownershipToken)
        refuse('the moved ownership marker cannot be proved');
      const { pendingMove: _, ...settled } = moved;
      await this.registry.write(state => ({
        ...state,
        worktrees: state.worktrees.map(entry =>
          entry.path === record.path
            ? {
                ...settled,
                sourceCwd: isWithinDirectory(record.path, record.sourceCwd)
                  ? path.join(pending.destination, path.relative(record.path, record.sourceCwd))
                  : record.sourceCwd,
              }
            : entry,
        ),
      }));
    });
    return { from: record.path, to: pending.destination };
  }
}
