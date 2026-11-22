import type { FencedPath, HeldRoot, KernelPorts, PinnedWorkingDirectory, SpawnBudget } from '@ferretry/kernel/contract';
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
import type { FilePlace } from './routes.ts';

/** Why a folder was not held: nothing verified is there, the privacy policy said no, or the build's time ran out first. */
export type PinRefusal = 'unavailable' | 'private' | 'spent';

/** What a read that may outlast the budget gave: its answer, or nothing because the budget ran out first. */
type Timed<T> = { readonly done: true; readonly value: T } | { readonly done: false };

/** Thrown INSIDE a pin's work when the budget is gone before its next I/O: nothing is started, and the caller is told "spent". */
class BudgetSpent extends Error {
  constructor() {
    super('the build ran out of time');
    this.name = 'BudgetSpent';
  }
}

/**
 * The work a build's pins started and has not seen stop yet. A pin STOPS WAITING at the deadline, but what it started keeps
 * running until its current I/O returns; the cache holds its build slot until then, so late work is counted, not forgotten.
 */
class Outstanding {
  private readonly running = new Set<Promise<unknown>>();
  track(work: Promise<unknown>): void {
    const done = work.then(
      () => undefined,
      () => undefined,
    );
    this.running.add(done);
    void done.then(() => this.running.delete(done));
  }
  /** Resolves when everything tracked so far, and whatever it tracked in turn, has stopped. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }
}

/**
 * The browser, asked only while the budget has time: every call checks it FIRST and starts no I/O once it is gone, and a
 * sign-in look is handed the budget so its listing stops where the budget stops. The privacy policy reads through this, so
 * each of its stages (the home, where the private folders are, every ancestor's sign-in look) is a place the time is checked.
 */
function budgeted(browser: FolderBrowser, budget: SpawnBudget): FolderBrowser {
  const spend = (): void => {
    if (budget.expired()) throw new BudgetSpent();
  };
  return {
    home: async () => {
      spend();
      return await browser.home();
    },
    realPaths: async paths => {
      spend();
      return await browser.realPaths(paths);
    },
    leaf: async path => {
      spend();
      return await browser.leaf(path);
    },
    open: async (path, verdict) => {
      spend();
      return await browser.open(path, verdict);
    },
    holdsSignIn: async path => {
      spend();
      return await browser.holdsSignIn(path, budget);
    },
  };
}

/**
 * Runs `work` only while `budget` has time, and stops WAITING for it when the time is gone. A late answer is handed to
 * `late` (a held descriptor it must close) and never reaches the caller. The work itself checks the budget before each of
 * its own stages (`budgeted`, and the explicit checks in the hold), so after the deadline it starts nothing new; `track`
 * remembers it until it has actually stopped.
 */
async function within<T>(
  clock: Pick<KernelPorts['clock'], 'after'>,
  budget: SpawnBudget,
  work: () => Promise<T>,
  outstanding: Outstanding,
  late: (value: T) => void = () => undefined,
): Promise<Timed<T>> {
  if (budget.expired()) return { done: false };
  let cancel: () => void = () => undefined;
  const spent = new Promise<Timed<T>>(resolve => {
    cancel = clock.after(milliseconds(Math.max(1, Math.ceil(budget.remainingMs()))), () => resolve({ done: false }));
  });
  const running = work().then(
    (value): Timed<T> => ({ done: true, value }),
    (error: unknown): Timed<T> => {
      if (error instanceof BudgetSpent) return { done: false };
      throw error;
    },
  );
  outstanding.track(running);
  try {
    const outcome = await Promise.race([running, spent]);
    if (!outcome.done)
      running.then(
        result => result.done && late(result.value),
        () => undefined,
      );
    return outcome;
  } finally {
    cancel();
  }
}

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
   * be proved either way, `'partial'` when its sign-in look saw only part of its names (a differently spelled marker past
   * the bound is not ruled out: the folder is skipped and the answer says it is not whole). A descendant is judged exactly
   * like a nested repository, so a folder's privacy does not depend on whether Git happens to know it.
   */
  descendant(real: string): Promise<'private' | 'unreadable' | 'partial' | 'spent' | undefined>;
  /**
   * Resolves when every read these pins started has actually stopped. A pin stops WAITING at the deadline, but the read it
   * had in flight finishes on its own (and starts nothing after, and closes what it was handed): the build gives this to
   * the cache so the build's slot stays held, and counted, until then.
   */
  settled?(): Promise<void>;
}

type Kernel = Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>;

/**
 * Holds a folder open through the kernel's `imports` root and judges what is REALLY held.
 *
 * The same sequence the folder explorer uses (`folders/adapter.ts` `hold`): resolve the real path, judge it, hold it, judge
 * the held object's own real path again — so a name swapped for a link between the two lands on the second verdict. It is
 * not shared with the explorer because that one hands back a listing object and this one needs the held root itself (its
 * descriptor is what Git is started in).
 */
function holder(
  kernel: Pick<KernelPorts, 'roots' | 'clock'>,
  verdict: FolderVerdict,
  mustBeNamed: boolean,
  budget: SpawnBudget,
  outstanding: Outstanding,
) {
  const hold = holdWith(kernel, verdict, mustBeNamed, budget);
  return async (path: string): Promise<PinResult> => {
    // The whole hold (resolve, judge, pin, judge again) is one budgeted read: a folder pinned after the time is gone is
    // closed again, and the build is told the time ran out rather than that the folder was not there.
    const timed = await within(
      kernel.clock,
      budget,
      () => hold(path),
      outstanding,
      late => {
        if (late.ok) void late.root.close().catch(() => undefined);
      },
    );
    return timed.done ? timed.value : { ok: false, reason: 'spent' };
  };
}

/**
 * Every stage of the hold asks the budget BEFORE it starts: a `realPath` that comes back after the deadline starts no
 * sign-in verdict, a verdict that comes back after it pins nothing, and a descriptor that arrives after it is closed here.
 * (The verdicts are the policy's, read through `budgeted`, so each of their own stages is a check too.)
 */
function holdWith(
  kernel: Pick<KernelPorts, 'roots'>,
  verdict: FolderVerdict,
  mustBeNamed: boolean,
  budget: SpawnBudget,
) {
  const spent: PinResult = { ok: false, reason: 'spent' };
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
    if (budget.expired()) return spent;
    // A registered place is already canonical: a spelling that resolves anywhere else has a link in it, and what it reaches
    // is not the project the person registered (the leaf alone looks like a plain folder when an ANCESTOR is the link).
    if (mustBeNamed && real !== path.replace(/(?<=.)\/+$/u, '')) return { ok: false, reason: 'unavailable' };
    const first = await verdict(real);
    if (first !== undefined) return { ok: false, reason: first === 'private' ? 'private' : 'unavailable' };
    if (budget.expired()) return spent;
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
    // From here the descriptor is OURS until it is handed on: EVERY way out (a refusal, the time running out, a verdict that
    // throws, a late arrival) closes it, so a rejected project never leaves a held root behind.
    let handedOn = false;
    try {
      // A descriptor that arrives after the time is gone is never handed on, and no second verdict is started.
      if (budget.expired()) return spent;
      const second = root.rootReal === real ? await verdict(root.rootReal) : 'outside';
      if (second !== undefined) return { ok: false, reason: second === 'private' ? 'private' : 'unavailable' };
      if (budget.expired()) return spent;
      handedOn = true;
      return { ok: true, root };
    } finally {
      if (!handedOn) await root.close().catch(() => undefined);
    }
  };
}

/**
 * The pins one build uses, over the kernel. The policy is read once per build (where each private folder really is),
 * not once per folder.
 */
export function kernelPins(kernel: Kernel, browser: FolderBrowser): (budget: SpawnBudget) => Promise<FolderPins> {
  return async budget => {
    const outstanding = new Outstanding();
    const guarded = budgeted(browser, budget);
    // Reading the policy lists folders (where each private one really is), so it is spent from the build's own budget too,
    // and it asks the budget between its stages: a home that arrives late starts no read of where the private folders are.
    const read = await within(
      kernel.clock,
      budget,
      async () => await folderPolicy(guarded, await guarded.home()),
      outstanding,
    );
    if (!read.done) {
      const spent = async (): Promise<{ ok: false; reason: 'spent' }> => ({ ok: false, reason: 'spent' });
      return {
        project: spent,
        nested: spent,
        descendant: async () => 'spent',
        settled: () => outstanding.settled(),
      };
    }
    const policy = read.value;
    return {
      project: holder(kernel, policy.verdict, true, budget, outstanding),
      nested: holder(kernel, policy.child, false, budget, outstanding),
      descendant: async real => {
        // One look at a folder (it lists every name for a sign-in file) is bounded by what is left of the build's time.
        const timed = await within(kernel.clock, budget, () => policy.childLook(real), outstanding);
        if (!timed.done) return 'spent';
        const { verdict, complete } = timed.value;
        if (verdict === 'private') return 'private';
        // A look that finished only because the time ran out saw nothing it can vouch for.
        if (budget.expired() && (verdict !== undefined || !complete)) return 'spent';
        if (verdict !== undefined) return 'unreadable';
        return complete ? undefined : 'partial';
      },
      settled: () => outstanding.settled(),
    };
  };
}

/** A Git child that ran out of time, told apart from one that failed: the index reports the first as the budget, not as damage. */
export class GitTimedOut extends Error {
  constructor(action: string) {
    super(`${action} timed out`);
    this.name = 'GitTimedOut';
  }
}

/**
 * Where a registered path really is: the home it is judged against, and what the path resolves to (every link at any
 * component followed). The routes decide the outside-home gate on it, and a cached index is answered only while the
 * registered path still resolves to ITSELF, so a place that became a link is not served from memory.
 */
export function placeOf(browser: Pick<FolderBrowser, 'home' | 'realPaths'>): FilePlace {
  return {
    home: () => browser.home(),
    resolve: async path => (await browser.realPaths([path])).at(0),
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
  return treeGit(runner, (action, execution) =>
    execution.timedOut
      ? new GitTimedOut(action)
      : new Error(`${action} failed: ${execution.stderr.trim() || `exit ${String(execution.exitCode)}`}`),
  );
}
