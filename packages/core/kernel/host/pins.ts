import type {
  HeldRoot,
  PinnedOpenOptions,
  PinnedWorkingDirectory,
  PinOptions,
  SessionRootPinner,
  PinnedRoot,
} from '../contract/pinned.ts';

/**
 * A held root as the registry hands it to the roots, before they add its fence verdict ({@link HeldRoot.fenced}): the
 * registry knows no home, so only the root that asked for the pin can say what beneath it is fenced.
 */
export type UnjudgedRoot = Omit<HeldRoot, 'fenced'>;

/** What the kernel remembers of a pin it minted: whose it is, and the descriptor alias a child starts in (Linux). */
interface MintedPin {
  readonly plugin: string;
  readonly alias?: string;
  /** The minting root's authority; absent is undetermined and grants no subprocess access. */
  readonly authority?: 'read' | 'write';
  readonly writeCheck?: () => boolean;
  readonly hold: { readonly root: PinnedRoot; refs: number };
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
  async pin(
    plugin: string,
    cwd: string,
    options?: PinOptions,
    authority?: 'read' | 'write',
    writeCheck?: () => boolean,
  ): Promise<UnjudgedRoot> {
    const root = await this.pinner().pin(cwd, options);
    const hold = { root, refs: 1 };
    let closed = false;
    const policy = root.policyCwd;
    // Linux names the held descriptor by a path alias (`/proc/<pid>/fd/<n>`); it is kept here and given to the
    // child as its cwd, so a plugin only ever holds the object.
    const cwdObject: PinnedWorkingDirectory =
      typeof policy === 'string' ? Object.freeze({ describe: root.rootReal, install: () => () => {} }) : policy;
    this.minted.set(cwdObject, {
      plugin,
      authority,
      writeCheck,
      hold,
      ...(typeof policy === 'string' ? { alias: policy } : {}),
    });
    return Object.freeze({
      rootReal: root.rootReal,
      policyCwd: cwdObject,
      open: (rel: string, openOptions?: PinnedOpenOptions) => root.open(rel, openOptions),
      probe: () => root.probe(),
      close: async () => {
        if (closed) return;
        closed = true;
        this.minted.delete(cwdObject);
        if (--hold.refs === 0) await root.close();
      },
    });
  }

  /** A temporary WRITE token on the SAME descriptor. Retained until use ends, revoked even when use throws. */
  async withWritePin<T>(
    plugin: string,
    cwd: PinnedWorkingDirectory,
    judge: () => boolean,
    use: (cwd: PinnedWorkingDirectory) => Promise<T>,
  ): Promise<T> {
    const source = this.minted.get(cwd);
    if (source?.plugin !== plugin || judge() !== true) throw new TypeError('write pin authority is unavailable');
    const policy = source.hold.root.policyCwd;
    const token: PinnedWorkingDirectory = Object.freeze({
      describe: source.hold.root.rootReal,
      install: () => (typeof policy === 'string' ? () => {} : policy.install()),
    });
    source.hold.refs++;
    this.minted.set(token, { ...source, authority: 'write', writeCheck: judge });
    try {
      return await use(token);
    } finally {
      this.minted.delete(token);
      if (--source.hold.refs === 0) await source.hold.root.close();
    }
  }

  /** The pin's record when `plugin` minted it; `undefined` for anything else. */
  lookup(plugin: string, cwd: PinnedWorkingDirectory): MintedPin | undefined {
    const found = this.minted.get(cwd);
    if (found?.plugin !== plugin) return undefined;
    if (found.writeCheck !== undefined) {
      try {
        if (found.writeCheck() === true) return found;
      } catch {
        /* unknown refuses write */
      }
      return { ...found, authority: 'read' };
    }
    return found;
  }
}
