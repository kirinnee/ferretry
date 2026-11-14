import path from 'node:path';
import type {
  FencedPath,
  FerretId,
  PinnedWorkingDirectory,
  RootHandle,
  SpawnBytesResult,
} from '@ferretry/kernel/contract';
import type { GitByteSpawn } from '../git/runner.ts';
import type { GitWorkingDirectory, WorktreeDirectoryPinner, WorktreeFileSystem } from '../../lib/worktrees/ports.ts';

/**
 * The managed-worktree module's host IO, over the kernel's roots (today's `NodeWorktreeFileSystem`, Git spawn and
 * directory pinner, which a subsystem may not own: `banned-globals`).
 *
 * Every absolute path the module names is routed to the ROOT that may reach it, and the root's own fence judges it:
 *
 * - a path inside the managed folder (`<home>-worktrees`, the `worktrees` root) goes to that root;
 * - any other path (the repository a checkout is made from) must be inside a ferret's own folder, and goes to that
 *   ferret's `work` root (outside the daemon's fence, no link followed out of it).
 *
 * A path no root reaches is refused in words, never reached by name. That is the one place this is narrower than
 * today's daemon, which could name any folder: a checkout is made only from a repository a ferret works in.
 */

/** The ferrets standing in folders: where the `work` roots are. */
interface FerretFolder {
  readonly id: FerretId;
  readonly folder: string;
}

export interface KernelWorktreeHostInputs {
  readonly worktrees: RootHandle;
  readonly work: (ferret: FerretId) => RootHandle;
  readonly ferrets: () => readonly FerretFolder[];
  readonly spawn: {
    runBytes(
      program: string,
      args: readonly string[],
      options: {
        readonly cwd?: FencedPath | PinnedWorkingDirectory;
        readonly env?: Readonly<Record<string, string>>;
        readonly stdin?: string | Uint8Array;
        readonly timeout?: import('@ferretry/std').Duration;
        readonly maxStdoutBytes?: number;
        readonly maxStderrBytes?: number;
      },
    ): Promise<SpawnBytesResult>;
  };
}

export interface KernelWorktreeHostIo {
  readonly git: GitByteSpawn;
  readonly fileSystem: WorktreeFileSystem;
  readonly pinner: WorktreeDirectoryPinner;
  readonly managedRoot: string;
}

const within = (parent: string, child: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** The host IO, or `undefined` when the `worktrees` root has no folder to name (this daemon then hosts no checkouts). */
export function createKernelWorktreeHostIo(input: KernelWorktreeHostInputs): KernelWorktreeHostIo | undefined {
  const managed = input.worktrees.resolve('.');
  if (!managed.ok) return undefined;
  const managedRoot: string = managed.value;

  const route = (target: string): { readonly root: RootHandle; readonly fenced: FencedPath } => {
    if (!path.isAbsolute(target)) throw new Error(`a managed-worktree path must be absolute: ${target}`);
    const candidates: RootHandle[] = [];
    if (within(managedRoot, target)) candidates.push(input.worktrees);
    else
      for (const ferret of input.ferrets()) if (within(ferret.folder, target)) candidates.push(input.work(ferret.id));
    for (const root of candidates) {
      const resolved = root.resolve(target);
      if (resolved.ok) return { root, fenced: resolved.value };
    }
    throw new Error(`this daemon may not reach ${target}: a managed checkout is made only from a ferret's own folder`);
  };

  const fileSystem: WorktreeFileSystem = {
    makeDirectory: async (target, mode) => {
      const { root, fenced } = route(target);
      await root.makeDirectory(fenced, { mode });
    },
    realPath: async target => {
      const { root, fenced } = route(target);
      return await root.realPath(fenced);
    },
    type: async target => {
      const { root, fenced } = route(target);
      // A root names no leaf of its own: its own folder is looked at with `stat` (it is no link the fence let in).
      const own = root.resolve('.');
      if (own.ok && own.value === fenced) return (await root.stat(fenced))?.kind ?? 'missing';
      const stat = await root.lstat(fenced);
      return stat === undefined ? 'missing' : stat.kind;
    },
    readText: async target => {
      const { root, fenced } = route(target);
      return await root.readText(fenced);
    },
    writeText: async (target, content, mode) => {
      const { root, fenced } = route(target);
      await root.writeText(fenced, content, { mode, exclusive: true });
    },
  };

  const pinner: WorktreeDirectoryPinner = {
    pin: async cwd => {
      const { root, fenced } = route(cwd);
      const held = await root.pin(fenced);
      return { rootReal: held.rootReal, policyCwd: held.policyCwd, close: async () => await held.close() };
    },
  };

  const git: GitByteSpawn = {
    runBytes: async (program, args, options) => {
      const cwd: GitWorkingDirectory | undefined = options.cwd;
      // A pin is already the kernel's own; a folder named by string is judged by the root that reaches it.
      const fenced = cwd === undefined || typeof cwd !== 'string' ? cwd : route(cwd).fenced;
      const { cwd: _named, ...rest } = options;
      return await input.spawn.runBytes(program, args, {
        ...rest,
        ...(fenced === undefined ? {} : { cwd: fenced }),
      });
    },
  };

  return { git, fileSystem, pinner, managedRoot };
}
