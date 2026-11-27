import { gitEnvironment, HARDENED_GIT_ARGUMENTS } from '@ferretry/core-ferrets/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';

/** A git or filesystem step that failed on this machine: one plain sentence, never git's own text or a path of the other machine. */
export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutError';
  }
}

/**
 * What the importer asks of this machine's repositories and folders. Each member either does exactly what it says or throws a
 * `CheckoutError`; nothing is ever left half-made by one call except where it says so.
 */
export interface Checkout {
  /** Whether `repo` holds this commit. */
  hasCommit(repo: string, sha: string): Promise<boolean>;
  /** Whether `repo` has a local branch of this name. */
  branchExists(repo: string, branch: string): Promise<boolean>;
  /** Puts the commits of a `git bundle` into `repo`'s objects and names `head` by `ref`. Refuses a bundle whose base this repo lacks. */
  importCommits(repo: string, bundle: Uint8Array, head: string, ref: string): Promise<void>;
  /** A new working tree at `path` (which must not exist), on a NEW branch at `head`, or detached at it when no branch is named. */
  addWorktree(repo: string, path: string, at: { readonly head: string; readonly branch?: string }): Promise<void>;
  /** Takes back a working tree this machine made, however it was left. */
  removeWorktree(repo: string, path: string): Promise<void>;
  deleteRef(repo: string, ref: string): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  /** Applies a binary diff to the working files of `tree` (the index is left alone). */
  applyDiff(tree: string, diff: Uint8Array): Promise<void>;
  /** Makes a NEW file below `tree`, and its folders; refuses a name that is already there. */
  writeNewFile(tree: string, relative: string, bytes: Uint8Array): Promise<void>;
  /** Whether nothing is at `path`, a link included. `false` for a path whose folder is missing. */
  isFree(path: string): Promise<boolean>;
  /** Removes a folder this import made (a clone, or a working tree's leftovers). */
  removeFolder(path: string): Promise<void>;
}

const GIT_TIMEOUT_MS = 60_000;
const READ_BYTES = 64 * 1024;

/** The checkout over the kernel: git through `kernel.spawn` inside a held directory, files through the `imports` root. */
export function kernelCheckout(kernel: Pick<KernelPorts, 'roots' | 'spawn'>): Checkout {
  const parentOf = (path: string): { readonly parent: string; readonly name: string } => {
    const cut = path.lastIndexOf('/');
    return { parent: cut <= 0 ? '/' : path.slice(0, cut), name: path.slice(cut + 1) };
  };

  const git = async (
    folder: string,
    args: readonly string[],
    options: { readonly stdin?: Uint8Array; readonly maxStdoutBytes?: number } = {},
  ) => {
    const handle = kernel.roots.root('imports', { subfolder: folder });
    const self = handle.resolve('');
    if (!self.ok) throw new CheckoutError('this folder cannot be fenced for git');
    const held = await handle.pin(self.value, { fence: 'none' });
    try {
      const done = await kernel.spawn.runBytes('git', [...HARDENED_GIT_ARGUMENTS, ...args], {
        cwd: held.policyCwd,
        env: gitEnvironment({}, true),
        timeout: milliseconds(GIT_TIMEOUT_MS),
        maxStdoutBytes: options.maxStdoutBytes ?? READ_BYTES,
        maxStderrBytes: READ_BYTES,
        killOnOutputLimit: true,
        sealed: true,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
      if (done.timedOut) throw new CheckoutError('git did not answer in time');
      return done;
    } finally {
      await held.close();
    }
  };
  const must = async (
    folder: string,
    args: readonly string[],
    failure: string,
    options?: { readonly stdin?: Uint8Array },
  ): Promise<Uint8Array> => {
    const done = await git(folder, args, options);
    if (done.exitCode !== 0 || done.stdoutTruncated) throw new CheckoutError(failure);
    return done.stdout;
  };
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

  return {
    hasCommit: async (repo, sha) => (await git(repo, ['cat-file', '-e', `${sha}^{commit}`])).exitCode === 0,

    branchExists: async (repo, branch) =>
      (await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0,

    importCommits: async (repo, bundle, head, ref) => {
      await must(
        repo,
        ['bundle', 'unbundle', '-'],
        'the other machine’s commits could not be added here: this project lacks the commits they are built on',
        { stdin: bundle },
      );
      await must(repo, ['update-ref', ref, head], 'the moved commits could not be named here');
      if (
        text(await must(repo, ['rev-parse', '--verify', `${ref}^{commit}`], 'the moved commits are not here')) !== head
      )
        throw new CheckoutError('the moved commits are not the ones the other machine had');
    },

    addWorktree: async (repo, path, at) => {
      await must(
        repo,
        at.branch === undefined
          ? ['worktree', 'add', '--detach', '--', path, at.head]
          : ['worktree', 'add', '-b', at.branch, '--', path, at.head],
        'a working tree could not be made for the moved ferret',
      );
    },

    removeWorktree: async (repo, path) => {
      // `--force` because the working tree may hold the files this import wrote; it is ours, and being removed.
      await git(repo, ['worktree', 'remove', '--force', '--', path]);
      await git(repo, ['worktree', 'prune']);
    },

    deleteRef: async (repo, ref) => {
      await git(repo, ['update-ref', '-d', ref]);
    },

    deleteBranch: async (repo, branch) => {
      await git(repo, ['branch', '-D', '--', branch]);
    },

    applyDiff: async (tree, diff) => {
      await must(
        tree,
        ['apply', '--binary', '--whitespace=nowarn', '-'],
        'the uncommitted changes did not apply to the moved working tree',
        { stdin: diff },
      );
    },

    writeNewFile: async (tree, relative, bytes) => {
      const handle = kernel.roots.root('imports', { subfolder: tree });
      const fenced = handle.resolve(relative);
      if (!fenced.ok) throw new CheckoutError('a moved file would land outside its working tree');
      const folder = relative.includes('/') ? handle.resolve(relative.slice(0, relative.lastIndexOf('/'))) : undefined;
      if (folder?.ok === true) await handle.makeDirectory(folder.value, { mode: 0o755 });
      await handle.writeBytes(fenced.value, bytes, { exclusive: true, mode: 0o644 });
    },

    isFree: async path => {
      const { parent, name } = parentOf(path);
      const handle = kernel.roots.root('imports', { subfolder: parent });
      const fenced = handle.resolve(name);
      if (!fenced.ok) return false;
      try {
        return (await handle.lstat(fenced.value)) === undefined;
      } catch {
        return false;
      }
    },

    removeFolder: async path => {
      const { parent, name } = parentOf(path);
      const handle = kernel.roots.root('imports', { subfolder: parent });
      const fenced = handle.resolve(name);
      if (!fenced.ok) throw new CheckoutError('a folder this import made could not be fenced for removal');
      await handle.remove(fenced.value);
    },
  };
}
