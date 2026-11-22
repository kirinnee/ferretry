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
  /**
   * The project folder itself, which must BE the path it was registered under: a link at any component (the leaf or an
   * ancestor) reaches some other folder, so the resolved real path and the held object must both equal the registered one.
   */
  project(path: string): Promise<PinResult>;
  /** A repository inside a project folder already held: judged as a child (its own sign-in file, its own real place). */
  nested(path: string): Promise<PinResult>;
  /**
   * An ordinary folder below one already held (`real` is its place, held parent plus relative path): `undefined` to accept
   * it, `'private'` when the policy says so (a key store, a folder holding a sign-in file), `'unreadable'` when it could not
   * be proved either way. A descendant is judged exactly like a nested repository, so a folder's privacy does not depend on
   * whether Git happens to know it.
   */
  descendant(real: string): Promise<'private' | 'unreadable' | undefined>;
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
function holder(kernel: Pick<KernelPorts, 'roots'>, verdict: FolderVerdict, mustBeNamed: boolean) {
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
    // A registered place is already canonical: a spelling that resolves anywhere else has a link in it, and what it reaches
    // is not the project the person registered (the leaf alone looks like a plain folder when an ANCESTOR is the link).
    if (mustBeNamed && real !== path.replace(/(?<=.)\/+$/u, '')) return { ok: false, reason: 'unavailable' };
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
    const second = root.rootReal === real ? await verdict(root.rootReal) : 'outside';
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
      project: holder(kernel, policy.verdict, true),
      nested: holder(kernel, policy.child, false),
      descendant: async real => {
        const verdict = await policy.child(real);
        return verdict === undefined ? undefined : verdict === 'private' ? 'private' : 'unreadable';
      },
    };
  };
}

/**
 * Whether `path` still resolves to ITSELF (no link at any component, and a folder is there): the cheap check a cached index
 * must pass before it is answered, so a registered place that became a link is not served from memory.
 */
export function stillThatPlace(browser: Pick<FolderBrowser, 'realPaths'>): (path: string) => Promise<boolean> {
  return async path => (await browser.realPaths([path])).at(0) === path.replace(/(?<=.)\/+$/u, '');
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
