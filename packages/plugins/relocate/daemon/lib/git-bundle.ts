import type { KernelPorts } from '@ferretry/kernel/contract';

/** What the snapshot asks of one working tree. Git runs only to list, diff and bundle; it never writes the tree. */
export interface WorkingTree {
  /** `HEAD`'s commit and the branch it is on (absent on a detached `HEAD`), or `undefined` for a folder that is no work tree. */
  head(): Promise<{ readonly head: string; readonly branch?: string } | undefined>;
  /**
   * The commits of `HEAD` that no remote-tracking ref holds, as a git bundle; `undefined` when there are none (the target
   * already has them from the project's remote). An error names no path.
   */
  commits(maxBytes: number): Promise<Uint8Array | undefined>;
  /** Uncommitted changes to tracked files (staged or not) as one binary diff against `HEAD`; empty when there are none. */
  changes(maxBytes: number): Promise<Uint8Array>;
  /** The paths git neither tracks nor ignores, relative to the tree, in git's own order. */
  untracked(): Promise<readonly string[]>;
  /** The top-level names git ignores (`node_modules/`, `.env`): shown to the person, never read. */
  ignoredTopLevel(): Promise<readonly string[]>;
  /** One untracked file's bytes (a plain file, no link, at most `limitBytes`), or `undefined` when it is not one. */
  read(path: string, limitBytes: number): Promise<Uint8Array | undefined>;
}

/** A refusal a person can read: git could not answer, or an output was larger than the move allows. */
class WorkingTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkingTreeError';
  }
}

const decoder = new TextDecoder();

/** NUL-separated git output as names: the one spelling that survives a newline or a quote in a file name. */
function names(bytes: Uint8Array): readonly string[] {
  return decoder
    .decode(bytes)
    .split('\0')
    .filter(name => name !== '');
}

/**
 * The working tree at `folder`, through the kernel's spawn and its `imports` root (the folder is the owner's own, outside
 * Ferretry's home: links resolved, device files refused). `-C` names the tree; `--no-ext-diff --no-textconv` keep a repository's
 * own configuration from running a program for a diff.
 */
export function kernelWorkingTree(kernel: Pick<KernelPorts, 'roots' | 'spawn'>, folder: string): WorkingTree {
  const git = async (args: readonly string[], maxBytes: number) =>
    await kernel.spawn.runBytes('git', ['-C', folder, ...args], {
      maxStdoutBytes: maxBytes,
      killOnOutputLimit: true,
      sealed: true,
    });
  const ok = async (args: readonly string[], maxBytes = 1024 * 1024): Promise<Uint8Array> => {
    const done = await git(args, maxBytes);
    if (done.stdoutTruncated)
      throw new WorkingTreeError('a part of this ferret’s working tree is larger than a move can carry');
    if (done.exitCode !== 0)
      throw new WorkingTreeError(`git ${args[0] ?? ''} could not read this ferret’s working tree`);
    return done.stdout;
  };
  return {
    head: async () => {
      const done = await git(['rev-parse', '--verify', '-q', 'HEAD'], 4096);
      if (done.exitCode !== 0) return undefined;
      const head = decoder.decode(done.stdout).trim();
      const named = await git(['symbolic-ref', '--short', '-q', 'HEAD'], 4096);
      const branch = named.exitCode === 0 ? decoder.decode(named.stdout).trim() : '';
      return { head, ...(branch === '' ? {} : { branch }) };
    },
    commits: async maxBytes => {
      const done = await git(['bundle', 'create', '-', 'HEAD', '--not', '--remotes'], maxBytes);
      if (done.stdoutTruncated)
        throw new WorkingTreeError('this ferret’s unpushed commits are larger than a move can carry');
      // git refuses an empty bundle: nothing here the remote lacks.
      if (done.exitCode !== 0) return undefined;
      return done.stdout;
    },
    changes: async maxBytes => await ok(['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], maxBytes),
    untracked: async () => names(await ok(['ls-files', '--others', '--exclude-standard', '-z'], 8 * 1024 * 1024)),
    ignoredTopLevel: async () =>
      names(
        await ok(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], 8 * 1024 * 1024),
      ),
    read: async (path, limitBytes) => {
      const handle = kernel.roots.root('imports', { subfolder: folder });
      const fenced = handle.resolve(path);
      if (!fenced.ok) return undefined;
      const stat = await handle.lstat(fenced.value);
      if (stat?.kind !== 'file' || stat.links > 1 || stat.size > limitBytes) return undefined;
      return await handle.readBytes(fenced.value, limitBytes);
    },
  };
}
