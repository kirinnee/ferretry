import { HARDENED_GIT_ARGUMENTS, gitEnvironment, establishGlobalConfig } from '@ferretry/core-ferrets/contract';
import { milliseconds } from '@ferretry/std';
import { namesASecret } from './path-policy.ts';
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
  return new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .split('\0')
    .filter(name => name !== '');
}

/**
 * The working tree at `folder`, through the kernel's spawn and its `imports` root (the folder is the owner's own, outside
 * Ferretry's home: links resolved, device files refused). Git starts inside a held directory; `--no-ext-diff --no-textconv` keep a repository's
 * own configuration from running a program for a diff.
 */
export function kernelWorkingTree(kernel: Pick<KernelPorts, 'roots' | 'spawn' | 'clock'>, folder: string): WorkingTree {
  const handle = kernel.roots.root('imports', { subfolder: folder });
  const cwd = handle.resolve('');
  if (!cwd.ok) throw new WorkingTreeError('this working folder cannot be fenced');
  // Reuse the shared tree-git contract, exactly as Projects does; never inherit tool credentials.
  const git = async (args: readonly string[], maxBytes: number, deadline?: number, readsGlobalConfig = false) => {
    let timeoutMs = deadline === undefined ? 10_000 : Math.min(10_000, deadline - kernel.clock.nowMs());
    if (timeoutMs <= 0) throw new WorkingTreeError('git exceeded the move’s read deadline');
    const held = await handle.pin(cwd.value, { fence: 'none' });
    try {
      if (deadline !== undefined) {
        timeoutMs = Math.min(timeoutMs, deadline - kernel.clock.nowMs());
        if (timeoutMs <= 0) throw new WorkingTreeError('git exceeded the move’s read deadline');
      }
      const done = await kernel.spawn.runBytes('git', [...HARDENED_GIT_ARGUMENTS, ...args], {
        cwd: held.policyCwd,
        env: gitEnvironment({}, true, readsGlobalConfig),
        timeout: milliseconds(timeoutMs),
        maxStdoutBytes: maxBytes,
        maxStderrBytes: 64 * 1024,
        killOnOutputLimit: true,
        sealed: true,
      });
      if (done.timedOut || done.stderrTruncated || (deadline !== undefined && kernel.clock.nowMs() >= deadline))
        throw new WorkingTreeError('git could not read this ferret’s working tree within its limits');
      return done;
    } finally {
      await held.close();
    }
  };
  const ok = async (
    args: readonly string[],
    maxBytes = 1024 * 1024,
    deadline?: number,
    readsGlobalConfig = false,
  ): Promise<Uint8Array> => {
    const done = await git(args, maxBytes, deadline, readsGlobalConfig);
    if (done.stdoutTruncated)
      throw new WorkingTreeError('a part of this ferret’s working tree is larger than a move can carry');
    if (done.exitCode !== 0 || done.stderr.trim() !== '')
      throw new WorkingTreeError(`git ${args[0] ?? ''} could not read this ferret’s working tree`);
    return done.stdout;
  };
  const globalRules = async () => {
    const deadline = kernel.clock.nowMs() + 10_000;
    const budget = {
      expired: () => kernel.clock.nowMs() >= deadline,
      remainingMs: () => Math.max(0, deadline - kernel.clock.nowMs()),
    };
    await establishGlobalConfig(
      { run: async invocation => await git(invocation.args, invocation.maxStdoutBytes ?? 1024 * 1024, deadline, true) },
      cwd.value,
      budget,
      () => new WorkingTreeError('git could not read this working tree’s ignore rules'),
    );
    if (budget.expired()) throw new WorkingTreeError('git exceeded the move’s read deadline');
  };
  // Audit all reachable trees, not just the tip: a pack can contain deleted credentials.
  // Bounded enumeration fails closed for large/unsupported histories, links and submodules.
  const audit = async (head: string): Promise<readonly string[]> => {
    const deadline = kernel.clock.nowMs() + 10_000;
    if ((await ok(['for-each-ref', '--format=%(refname)', 'refs/replace/'], 4096, deadline)).length > 0)
      throw new WorkingTreeError('replacement history cannot be verified safely for a move');
    // Git applies clean/process filters while hashing working files, even with textconv/external diff off.
    // No wildcard disables these repository-defined programs: refuse the repository before asking for a diff.
    const filters = await git(['config', '--get-regexp', '^filter\\.'], 4096, deadline);
    if (
      filters.exitCode !== 1 ||
      filters.stdout.length !== 0 ||
      filters.stdoutTruncated ||
      filters.stderr.trim() !== ''
    )
      throw new WorkingTreeError('repository content filters cannot be run safely for a move');
    const revisions = decoder
      .decode(await ok(['rev-list', '--max-count=513', head], 64 * 1024, deadline))
      .trim()
      .split('\n');
    if (revisions.length > 512) throw new WorkingTreeError('this history is too large to verify safely for a move');
    const paths = new Set<string>();
    const check = (records: Uint8Array) => {
      for (const record of names(records)) {
        const tab = record.indexOf('\t');
        const mode = record.slice(0, 6);
        const path = record.slice(tab + 1);
        if (tab < 0 || !['100644', '100755'].includes(mode) || namesASecret(path))
          throw new WorkingTreeError(
            'this working tree contains a private path, link or submodule and cannot move safely',
          );
        paths.add(path);
        if (paths.size > 20_000) throw new WorkingTreeError('this working tree has too many paths to verify safely');
      }
    };
    for (const revision of revisions) check(await ok(['ls-tree', '-r', '-z', revision], 8 * 1024 * 1024, deadline));
    check(await ok(['ls-files', '--stage', '-z'], 8 * 1024 * 1024, deadline));
    for (const path of paths) {
      if (kernel.clock.nowMs() >= deadline) throw new WorkingTreeError('git exceeded the move’s read deadline');
      const fenced = handle.resolve(path);
      if (!fenced.ok) throw new WorkingTreeError('a tracked path cannot be confined to this working tree');
      const stat = await handle.lstat(fenced.value);
      if (stat !== undefined && (stat.kind !== 'file' || stat.links > 1))
        throw new WorkingTreeError('a tracked path is not a plain file with one name and cannot move safely');
    }
    return [...paths];
  };
  const verifiedHead = async () => {
    const head = decoder.decode(await ok(['rev-parse', '--verify', 'HEAD'], 4096)).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new WorkingTreeError('git returned an invalid commit');
    return head;
  };
  return {
    head: async () => {
      const done = await git(['rev-parse', '--verify', '-q', 'HEAD'], 4096);
      if (done.exitCode !== 0) {
        if (done.exitCode === 128 && done.stderr.includes('not a git repository')) return undefined;
        throw new WorkingTreeError('git could not read this ferret’s working tree');
      }
      const prefix = await ok(['rev-parse', '--show-prefix'], 4096);
      if (decoder.decode(prefix).trim() !== '')
        throw new WorkingTreeError('the ferret must work at the repository root to move safely');
      const top = decoder.decode(await ok(['rev-parse', '--show-toplevel'], 4096)).trim();
      if (top !== (await handle.realPath(cwd.value)))
        throw new WorkingTreeError('git resolved a different working tree');
      const head = decoder.decode(done.stdout).trim();
      const named = await git(['symbolic-ref', '--short', '-q', 'HEAD'], 4096);
      if (named.exitCode !== 0 && named.exitCode !== 1)
        throw new WorkingTreeError('git could not read this ferret’s branch');
      const branch = named.exitCode === 0 ? decoder.decode(named.stdout).trim() : '';
      return { head, ...(branch === '' ? {} : { branch }) };
    },
    commits: async maxBytes => {
      const head = await verifiedHead();
      await audit(head);
      const pending = await ok(['rev-list', '--max-count=1', head, '--not', '--remotes'], 4096);
      if (pending.length === 0) return undefined;
      const done = await git(['bundle', 'create', '-', 'HEAD', '--not', '--remotes'], maxBytes);
      if (done.stdoutTruncated)
        throw new WorkingTreeError('this ferret’s unpushed commits are larger than a move can carry');
      if (done.exitCode !== 0) throw new WorkingTreeError('git bundle could not read this ferret’s working tree');
      if (!decoder.decode(done.stdout.slice(0, 4096)).includes(`${head} HEAD\n`))
        throw new WorkingTreeError('the working tree changed during the move');
      return done.stdout;
    },
    changes: async maxBytes => {
      const head = await verifiedHead();
      const paths = await audit(head);
      if (paths.length === 0) return new Uint8Array();
      const diff = await ok(
        ['diff', '--binary', '--no-renames', '--no-ext-diff', '--no-textconv', head, '--', ...paths],
        maxBytes,
      );
      if (/^(?:old mode|new mode|new file mode|deleted file mode) (?!100644|100755)/mu.test(decoder.decode(diff)))
        throw new WorkingTreeError('a tracked file became a link or submodule during the move');
      return diff;
    },
    untracked: async () => {
      await globalRules();
      return names(await ok(['ls-files', '--others', '--exclude-standard', '-z'], 8 * 1024 * 1024, undefined, true));
    },
    ignoredTopLevel: async () => {
      await globalRules();
      return names(
        await ok(
          ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
          8 * 1024 * 1024,
          undefined,
          true,
        ),
      );
    },
    read: async (path, limitBytes) => {
      const handle = kernel.roots.root('imports', { subfolder: folder });
      const fenced = handle.resolve(path);
      if (!fenced.ok) return undefined;
      const stat = await handle.lstat(fenced.value);
      if (stat?.kind !== 'file' || stat.links > 1 || stat.size > limitBytes) return undefined;
      const bytes = await handle.readBytes(fenced.value, limitBytes + 1);
      if (bytes.length > limitBytes) throw new WorkingTreeError(`${path} grew beyond the move’s file limit`);
      return bytes;
    },
  };
}
