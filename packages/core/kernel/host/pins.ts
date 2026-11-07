import type {
  HeldRoot,
  PinnedOpenOptions,
  PinnedWorkingDirectory,
  PinOptions,
  SessionRootPinner,
} from '../contract/pinned.ts';

/** What the kernel remembers of a pin it minted: whose it is, and the descriptor alias a child starts in (Linux). */
interface MintedPin {
  readonly plugin: string;
  readonly alias?: string;
}

/**
 * The pins the kernel's roots minted, by the identity of their `policyCwd` object. A spawn with a pinned cwd is
 * refused unless THIS plugin's root minted it, so a plugin cannot hand the kernel a hand-made `install()` (which
 * could `chdir` anywhere) and have a child started there. Weak, so a dropped pin is forgotten with it.
 */
export class PinRegistry {
  private readonly minted = new WeakMap<object, MintedPin>();

  constructor(private readonly pinner: () => SessionRootPinner) {}

  /** Pins `cwd`, and hands back the same root whose `policyCwd` is always an object this registry knows. */
  async pin(plugin: string, cwd: string, options?: PinOptions): Promise<HeldRoot> {
    const root = await this.pinner().pin(cwd, options);
    const policy = root.policyCwd;
    // Linux names the held descriptor by a path alias (`/proc/<pid>/fd/<n>`); it is kept here and given to the
    // child as its cwd, so a plugin only ever holds the object.
    const cwdObject: PinnedWorkingDirectory =
      typeof policy === 'string' ? Object.freeze({ describe: root.rootReal, install: () => () => {} }) : policy;
    this.minted.set(cwdObject, typeof policy === 'string' ? { plugin, alias: policy } : { plugin });
    return Object.freeze({
      rootReal: root.rootReal,
      policyCwd: cwdObject,
      open: (rel: string, openOptions?: PinnedOpenOptions) => root.open(rel, openOptions),
      probe: () => root.probe(),
      close: () => root.close(),
    });
  }

  /** The pin's record when `plugin` minted it; `undefined` for anything else. */
  lookup(plugin: string, cwd: PinnedWorkingDirectory): MintedPin | undefined {
    const found = this.minted.get(cwd);
    return found?.plugin === plugin ? found : undefined;
  }
}
