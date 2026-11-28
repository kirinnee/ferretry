import { gitEnvironment, HARDENED_GIT_ARGUMENTS } from '@ferretry/core-ferrets/contract';
import type { KernelPorts, RootIdentity } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { approvedRemote } from './remote.ts';
import { auditTree } from './tree-audit.ts';

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
  /** An exclusively created, private checkout. Existing repository objects/config/refs are READ ONLY. */
  prepare(
    source: { readonly repo: string } | { readonly remote: string },
    folder: string,
  ): Promise<{ readonly repo: string; readonly folder: string; cleanup(): Promise<void> }>;
  /** Prove the full history and the patched index before any checkout or launch; detach from borrowed objects. */
  audit(repo: string, head: string, diff?: Uint8Array): Promise<void>;
  finish(repo: string): Promise<void>;
  /** Whether `repo` holds this commit. */
  hasCommit(repo: string, sha: string): Promise<boolean>;
  /** Whether `repo` has a local branch of this name. */
  branchExists(repo: string, branch: string): Promise<boolean>;
  /** Puts the commits of a `git bundle` into `repo`'s objects and names `head` by `ref`. Refuses a bundle whose base this repo lacks. */
  importCommits(repo: string, bundle: Uint8Array, head: string, ref: string): Promise<void>;
  /** A new working tree at `path` (which must not exist), on a NEW branch at `head`, or detached at it when no branch is named. */
  addWorktree(repo: string, path: string, at: { readonly head: string; readonly branch?: string }): Promise<void>;
  /** Applies a binary diff to the working files of `tree` (the index is left alone). */
  applyDiff(tree: string, diff: Uint8Array): Promise<void>;
  /** Makes a NEW file below `tree`, and its folders; refuses a name that is already there. */
  writeNewFile(tree: string, relative: string, bytes: Uint8Array): Promise<void>;
  /** Whether nothing is at `path`, a link included. `false` for a path whose folder is missing. */
  isFree(path: string): Promise<boolean>;
}

const GIT_TIMEOUT_MS = 60_000;
const READ_BYTES = 64 * 1024;

/** The checkout over the kernel: git through `kernel.spawn` inside a held directory, files through the `imports` root. */
export function kernelCheckout(kernel: Pick<KernelPorts, 'roots' | 'spawn'>): Checkout {
  const alternates = new Map<string, string>();
  const quarantines = new Map<string, () => Promise<void>>();
  const verify = async (folder: string) => {
    for (const [quarantine, check] of quarantines)
      if (folder === quarantine || folder.startsWith(`${quarantine}/`)) await check();
  };
  const parentOf = (path: string): { readonly parent: string; readonly name: string } => {
    const cut = path.lastIndexOf('/');
    return { parent: cut <= 0 ? '/' : path.slice(0, cut), name: path.slice(cut + 1) };
  };

  const git = async (
    folder: string,
    args: readonly string[],
    options: { readonly stdin?: Uint8Array; readonly maxStdoutBytes?: number } = {},
  ) => {
    await verify(folder);
    const handle = kernel.roots.root('imports', { subfolder: folder });
    const self = handle.resolve('');
    if (!self.ok) throw new CheckoutError('this folder cannot be fenced for git');
    const held = await handle.pin(self.value, { fence: 'none', write: true });
    try {
      await verify(folder);
      const done = await kernel.spawn.runBytes(
        'git',
        [
          ...HARDENED_GIT_ARGUMENTS,
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'protocol.ssh.allow=always',
          '-c',
          'core.sshCommand=ssh -F /dev/null',
          '-c',
          'core.attributesFile=/dev/null',
          '-c',
          'init.templateDir=',
          '-c',
          'submodule.recurse=false',
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          ...args,
        ],
        {
          cwd: held.policyCwd,
          env: {
            ...gitEnvironment({}, true),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_LFS_SKIP_SMUDGE: '1',
            ...(alternates.has(folder) ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.get(folder) as string } : {}),
          },
          timeout: milliseconds(GIT_TIMEOUT_MS),
          maxStdoutBytes: options.maxStdoutBytes ?? READ_BYTES,
          maxStderrBytes: READ_BYTES,
          killOnOutputLimit: true,
          sealed: true,
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        },
      );
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
    options?: { readonly stdin?: Uint8Array; readonly maxStdoutBytes?: number },
  ): Promise<Uint8Array> => {
    const done = await git(folder, args, options);
    if (done.exitCode !== 0 || done.stdoutTruncated) throw new CheckoutError(failure);
    return done.stdout;
  };

  return {
    prepare: async (source, folder) => {
      const { name } = parentOf(folder);
      // The kernel provisions this parent, outside the daemon's state home. Never stage beside an untrusted project.
      const handle = kernel.roots.root('worktrees');
      const path = handle.resolve(name);
      if (!path.ok || handle.createDirectory === undefined)
        throw new CheckoutError('the quarantine folder cannot be created with a bound identity');
      const identity: RootIdentity = await handle.createDirectory(path.value);
      const stage = path.value;
      const repo = `${stage}/repository`;
      const check = async () => {
        const actual = await handle.fileIdentity(path.value);
        if (actual?.device !== identity.device || actual.inode !== identity.inode)
          throw new CheckoutError('the quarantine folder changed; it was kept');
      };
      quarantines.set(stage, check);
      const cleanup = async () => {
        alternates.delete(repo);
        quarantines.delete(stage);
        await check();
        await handle.remove(path.value, { expectedIdentity: identity });
      };
      try {
        await check();
        if ('remote' in source) {
          if (!approvedRemote(source.remote))
            throw new CheckoutError('only an approved https or ssh project address may be cloned');
          await must(
            stage,
            ['clone', '--no-checkout', '--template=', '--', source.remote, repo],
            'the network project could not be cloned',
          );
        } else {
          // The ONLY commands in an existing project are read-only probes. Its config is never copied or used for checkout.
          const objects = new TextDecoder()
            .decode(
              await must(
                source.repo,
                ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
                'the project objects could not be located',
              ),
            )
            .trim();
          if (!objects.startsWith('/') || /[\n\r:\0]/u.test(objects))
            throw new CheckoutError('the project objects cannot be borrowed safely');
          await must(stage, ['init', '--template=', '--', repo], 'the quarantine repository could not be made');
          alternates.set(repo, objects);
        }
        return { repo, folder: stage, cleanup };
      } catch (error) {
        try {
          await cleanup();
        } catch {
          throw new CheckoutError('preparing the quarantine failed and its cleanup failed; the quarantine was kept');
        }
        throw error;
      }
    },

    audit: async (repo, head, diff) => {
      await auditTree(
        async (args, stdin) =>
          await must(repo, args, 'the moved git tree or patch is unsafe', {
            ...(stdin === undefined ? {} : { stdin }),
            maxStdoutBytes: 8 * 1024 * 1024,
          }),
        head,
        diff,
      );
    },

    finish: async repo => {
      await must(repo, ['repack', '-a', '-d'], 'the quarantined objects could not be made independent');
      alternates.delete(repo);
      await must(repo, ['fsck', '--no-reflogs', '--connectivity-only'], 'the quarantined objects are incomplete');
      await verify(repo);
      for (const stage of quarantines.keys()) if (repo.startsWith(`${stage}/`)) quarantines.delete(stage);
    },
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
      await must(repo, ['rev-parse', '--verify', `${ref}^{commit}`], 'the moved commits are not here');
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

    applyDiff: async (tree, diff) => {
      await must(
        tree,
        ['apply', '--binary', '--whitespace=nowarn', '-'],
        'the uncommitted changes did not apply to the moved working tree',
        { stdin: diff },
      );
    },

    writeNewFile: async (tree, relative, bytes) => {
      await verify(tree);
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
  };
}
