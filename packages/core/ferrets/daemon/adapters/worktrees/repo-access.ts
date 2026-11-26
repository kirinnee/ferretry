import path from 'node:path';
import type { FencedPath, HeldRoot, RootHandle, RootIdentity } from '@ferretry/kernel/contract';
import { WorktreeError } from '../../lib/worktrees/errors.ts';
import type { GitWorkingDirectory } from '../../lib/worktrees/ports.ts';

export interface RepoDirectoryPin {
  readonly rootReal: string;
  readonly cwd: GitWorkingDirectory;
  readonly identity: RootIdentity;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface RepoCheckoutPin extends RepoDirectoryPin {
  readonly gitDirectory: string;
  readonly gitIdentity: RootIdentity;
  readonly commonIdentity: RootIdentity;
}

export interface RepoWorktreeAccess {
  commonDirectory(folder: string): Promise<string>;
  repository(commonDirectory: string): Promise<RepoDirectoryPin>;
  checkout(folder: string, repository: RepoDirectoryPin): Promise<RepoCheckoutPin>;
}

type Route = (target: string) => { readonly root: RootHandle; readonly fenced: FencedPath };

const refused = () =>
  new WorktreeError(
    'invalid_common_directory',
    'repository metadata is outside the authorized roots or its identity changed',
  );
const same = (a: RootIdentity | undefined, b: RootIdentity): boolean => a?.device === b.device && a.inode === b.inode;

/** Reads metadata through the held walk, never through a link or an unbounded file. */
async function text(held: HeldRoot, relative: string): Promise<string | undefined> {
  let target: Awaited<ReturnType<HeldRoot['open']>>;
  try {
    target = await held.open(relative);
  } catch (error) {
    if ((error as { code?: string }).code === 'not_found') return undefined;
    throw error;
  }
  try {
    if (target.metadata.type !== 'file') throw refused();
    const bytes = await target.read(4096);
    if (bytes === undefined) throw refused();
    return new TextDecoder().decode(bytes).trim();
  } finally {
    await target.close();
  }
}

/** Authorize and HOLD repository and checkout identities before the first Git process. */
export function createRepoWorktreeAccess(route: Route): RepoWorktreeAccess {
  const hold = async (folder: string): Promise<{ pin: RepoDirectoryPin; held: HeldRoot }> => {
    const { root, fenced } = route(folder);
    const held = await root.pin(fenced);
    try {
      if (held.rootReal !== path.resolve(folder)) throw refused();
      const target = await held.open('');
      let identity: RootIdentity;
      try {
        const leaf = target.identities.at(-1);
        if (leaf === undefined || target.metadata.type !== 'dir') throw refused();
        identity = { device: leaf.dev, inode: leaf.ino };
      } finally {
        await target.close();
      }
      const pin: RepoDirectoryPin = {
        rootReal: held.rootReal,
        cwd: held.policyCwd,
        identity,
        verify: async () => {
          const current = await root.pin(fenced);
          try {
            const target = await current.open('');
            try {
              const leaf = target.identities.at(-1);
              if (
                current.rootReal !== held.rootReal ||
                leaf === undefined ||
                !same({ device: leaf.dev, inode: leaf.ino }, identity)
              )
                throw refused();
            } finally {
              await target.close();
            }
          } finally {
            await current.close();
          }
        },
        close: async () => await held.close(),
      };
      await pin.verify();
      return { pin, held };
    } catch (error) {
      await held.close();
      throw error;
    }
  };
  return {
    commonDirectory: async folder => {
      try {
        const { pin, held } = await hold(folder);
        let metadata: Awaited<ReturnType<typeof hold>> | undefined;
        try {
          const git = route(path.join(folder, '.git'));
          if ((await git.root.lstat(git.fenced))?.kind === 'directory')
            throw new WorktreeError('unsafe_remove', 'the main checkout cannot be adopted');
          const pointer = await text(held, '.git');
          // Adoption accepts only a linked checkout. A directory .git (the main checkout) is refused.
          if (pointer === undefined || !pointer.startsWith('gitdir: ')) throw refused();
          const gitDirectory = path.resolve(folder, pointer.slice(8));
          metadata = await hold(gitDirectory);
          const common = await text(metadata.held, 'commondir');
          if (common === undefined) throw refused();
          await pin.verify();
          await metadata.pin.verify();
          return path.resolve(gitDirectory, common);
        } finally {
          await metadata?.pin.close();
          await pin.close();
        }
      } catch (error) {
        if (error instanceof WorktreeError) throw error;
        throw new WorktreeError(
          'invalid_common_directory',
          'adoption requires an authorized, existing linked checkout; for a gone/prunable checkout, inspect git worktree list and use git worktree prune',
        );
      }
    },
    repository: async folder => {
      try {
        const { pin, held } = await hold(folder);
        try {
          // A real common directory cannot redirect Git to a second common directory.
          if ((await text(held, 'commondir')) !== undefined) throw refused();
          return {
            ...pin,
            verify: async () => {
              await pin.verify();
              if ((await text(held, 'commondir')) !== undefined) throw refused();
            },
          };
        } catch (error) {
          await pin.close();
          throw error;
        }
      } catch {
        throw refused();
      }
    },
    checkout: async (folder, repository) => {
      const { pin, held } = await hold(folder);
      let metadata: Awaited<ReturnType<typeof hold>> | undefined;
      try {
        const gitPath = path.join(folder, '.git');
        const routed = route(gitPath);
        const kind = await routed.root.lstat(routed.fenced);
        let gitDirectory: string;
        let pointer: string | undefined;
        if (kind?.kind === 'directory') gitDirectory = gitPath;
        else if (kind?.kind === 'file') {
          pointer = await text(held, '.git');
          if (pointer === undefined || !pointer.startsWith('gitdir: ')) throw refused();
          gitDirectory = path.resolve(folder, pointer.slice(8));
        } else throw refused();
        metadata = await hold(gitDirectory);
        const commonPointer = await text(metadata.held, 'commondir');
        const common = commonPointer === undefined ? gitDirectory : path.resolve(gitDirectory, commonPointer);
        if (common !== repository.rootReal) throw refused();
        await repository.verify();
        const git = metadata;
        const verify = async () => {
          await pin.verify();
          await git.pin.verify();
          await repository.verify();
          if ((await text(git.held, 'commondir')) !== commonPointer) throw refused();
          if (pointer !== undefined && (await text(held, '.git')) !== pointer) throw refused();
        };
        await verify();
        return {
          ...pin,
          gitDirectory,
          gitIdentity: git.pin.identity,
          commonIdentity: repository.identity,
          verify,
          close: async () => {
            await git.pin.close();
            await pin.close();
          },
        };
      } catch (error) {
        await metadata?.pin.close();
        await pin.close();
        throw error;
      }
    },
  };
}
