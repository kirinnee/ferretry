import type { FencedPath, HeldRoot, KernelPorts, PinnedWorkingDirectory } from '@ferretry/kernel/contract';
import {
  gitEnvironment,
  HARDENED_GIT_ARGUMENTS,
  type TreeGit,
  type TreeGitRunner,
  treeGit,
} from '@ferretry/core-ferrets/contract';
import { milliseconds } from '@ferretry/std';
import { folderPolicy } from '../folders/policy.ts';
import type { FolderBrowser, FolderVerdict } from '../folders/port.ts';

/** Why a folder was not held: nothing verified is there, or the privacy policy said no. */
export type PinRefusal = 'unavailable' | 'private';

type PinResult = { readonly ok: true; readonly root: HeldRoot } | { readonly ok: false; readonly reason: PinRefusal };

/** The two ways the indexer holds a folder, both judged by the one privacy policy (`folders/policy.ts`). */
export interface FolderPins {
  /** The project folder itself: it must not be a link, and every folder from the home down is judged. */
  project(path: string): Promise<PinResult>;
  /** A repository inside a project folder already held: judged as a child (its own sign-in file, its own real place). */
  nested(path: string): Promise<PinResult>;
}

type Kernel = Pick<KernelPorts, 'roots' | 'paths' | 'spawn'>;

/**
 * Holds a folder open through the kernel's `imports` root and judges what is REALLY held.
 *
 * The same sequence the folder explorer uses (`folders/adapter.ts` `hold`): resolve the real path, judge it, hold it, judge
 * the held object's own real path again — so a name swapped for a link between the two lands on the second verdict. It is
 * not shared with the explorer because that one hands back a listing object and this one needs the held root itself (its
 * descriptor is what Git is started in).
 */
function holder(kernel: Pick<KernelPorts, 'roots'>, verdict: FolderVerdict) {
  return async (path: string): Promise<PinResult> => {
    const named = kernel.roots.root('imports', { subfolder: path });
    const fenced = named.resolve('');
    if (!fenced.ok) return { ok: false, reason: 'unavailable' };
    let real: string;
    try {
      real = await named.realPath(fenced.value);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const first = await verdict(real);
    if (first !== undefined) return { ok: false, reason: first === 'private' ? 'private' : 'unavailable' };
    const handle = kernel.roots.root('imports', { subfolder: real });
    const target = handle.resolve('');
    if (!target.ok) return { ok: false, reason: 'unavailable' };
    let root: HeldRoot;
    try {
      // A person's read of their own folder: no state-home fence beneath it (the root itself is checked by the root).
      root = await handle.pin(target.value, { fence: 'none' });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const second = await verdict(root.rootReal);
    if (second !== undefined) {
      await root.close().catch(() => undefined);
      return { ok: false, reason: second === 'private' ? 'private' : 'unavailable' };
    }
    return { ok: true, root };
  };
}

/**
 * The pins one build uses, over the kernel. The policy is read once per build (where each private folder really is),
 * not once per folder.
 */
export function kernelPins(kernel: Kernel, browser: FolderBrowser): () => Promise<FolderPins> {
  return async () => {
    const policy = await folderPolicy(browser, await browser.home());
    return {
      project: async path => {
        // What a link at the project folder reaches is not the project.
        if ((await browser.leaf(path)) !== 'present') return { ok: false, reason: 'unavailable' };
        return holder(kernel, policy.verdict)(path);
      },
      nested: holder(kernel, policy.child),
    };
  };
}

/** The default Git child's limits; the index asks for its own byte cap and gives the child what is left of its budget. */
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_GIT_STDOUT_BYTES = 1024 * 1024;
const GIT_STDERR_BYTES = 64 * 1024;

/**
 * The Git questions a file index asks, run as kernel children inside a held folder.
 *
 * The arguments and the scrubbed environment are the shared tree index's (`@ferretry/core-ferrets/contract`): a project's
 * list and a ferret's agree on what Git ignores because there is one definition of how Git is held at arm's length. The
 * cwd is always a directory held by this plugin's own root (the kernel refuses any other).
 */
export function kernelGit(kernel: Pick<KernelPorts, 'spawn'>): TreeGit {
  const runner: TreeGitRunner = {
    run: async invocation =>
      await kernel.spawn.runBytes('git', [...HARDENED_GIT_ARGUMENTS, ...invocation.args], {
        cwd: invocation.cwd as FencedPath | PinnedWorkingDirectory,
        env: gitEnvironment({}, true, invocation.readsGlobalConfig === true),
        timeout: milliseconds(invocation.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS),
        maxStdoutBytes: invocation.maxStdoutBytes ?? DEFAULT_GIT_STDOUT_BYTES,
        maxStderrBytes: GIT_STDERR_BYTES,
      }),
  };
  return treeGit(runner);
}
