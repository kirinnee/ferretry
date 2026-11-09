/**
 * SHARED TREES (kernel batch #10, rulings #52 Q2 + Q5, owner decision !A466): one folder of the minter's OWN internal state
 * (Skills' `installed/*`) handed, read-only, to the plugin that receives it (the harness that materializes it in a ferret
 * home). There is ONE link rule: a link is made whenever one is asked for, because every tree is internal state and every
 * destination is `agent-homes`; an owner's root (a project, an imports folder) is never shared at all. The rules
 * here are pure and shared by the real roots port (`./roots.ts`) and the testing host (`../testing/host.ts`), so a
 * plugin's unit test meets exactly what production decides: who may mint, from what, and into what.
 */
import type { RootName, SharedTree } from '../contract/ports.ts';
import type { StateFileDef } from '../contract/define.ts';
import { isInternalRootFolder } from './internal-roots.ts';

/** Why a shared tree was refused. One closed list, the same on both hosts. */
export type SharedRefusal =
  /** The minter's manifest does not declare `permissions.shareTrees`. */
  | 'not_permitted'
  /** The source is not the minter's own (another plugin's handle, an undeclared or non-opaque state def, a bad name). */
  | 'not_own'
  /** The tree is not one the kernel minted (forged, copied, rebuilt from JSON) or its minter stopped. */
  | 'not_shared'
  /** The destination is not an internal, writable root. */
  | 'not_internal';

export class SharedTreeError extends Error {
  constructor(readonly refusal: SharedRefusal) {
    super(`shared tree refused: ${refusal}`);
    this.name = 'SharedTreeError';
  }
}

export const refuseShared = (refusal: SharedRefusal): never => {
  throw new SharedTreeError(refusal);
};

/** Whether a tree may be materialized into this root: `agent-homes` only (never `credentials`, `sessions`, `fleet`, `downloads`). */
export function receivingRoot(name: RootName): boolean {
  return name === 'agent-homes';
}

/** A state name segment: today's collection-name rule (`state-port.ts`), never `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u;

/**
 * The folder, relative to the minter's state folder, that one name of one of its OWN declared opaque named trees
 * names (`installed/*` + `abc` → `installed/abc`); `undefined` when the def is not one it declared exactly, is not an
 * opaque named tree, or the name is not path-safe plain segments.
 */
export function ownStateTree(declared: readonly StateFileDef[], def: StateFileDef, name: string): string | undefined {
  if (typeof def !== 'object' || def === null || typeof name !== 'string') return undefined;
  const known = declared.find(entry => entry.name === def.name);
  if (known === undefined || known.path !== def.path || known.store !== def.store || known.format !== def.format)
    return undefined;
  if (known.store !== 'opaque' || !known.path.endsWith('/*')) return undefined;
  if (name === '' || !name.split('/').every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..'))
    return undefined;
  // A state tree is never a kernel-made root's folder (`credentials`, `sessions`, …): those are never shareable.
  if (isInternalRootFolder(known.path.split('/')[0] ?? '')) return undefined;
  return known.path.slice(0, -1) + name;
}

/**
 * Whether the state tree at `folder` (relative to the minter's state folder) is private, or holds a private place: it
 * is declared in the composed list (`state/<plugin>/<path>`, home-relative, a `*` segment standing for each member),
 * above it, below it, or at it. A tree the minter declared private is its own to keep, never one to hand to another
 * plugin's agent home.
 */
export function holdsPrivate(plugin: string, folder: string, privateFiles: readonly string[]): boolean {
  const tree = `state/${plugin}/${folder}`.split('/').filter(segment => segment !== '');
  return privateFiles.some(declared => {
    const segments = declared.split('/');
    const star = segments.findIndex(segment => segment.includes('*'));
    const head = star === -1 ? segments : segments.slice(0, star);
    const shared = Math.min(head.length, tree.length);
    // Nested by whole segments either way: one is a prefix of the other.
    return head.slice(0, shared).every((segment, at) => segment === tree[at]);
  });
}

/** One minted tree: what the host needs to reach it again, and whether its minter is still running. */
interface Minted<Entry> {
  readonly entry: Entry;
  readonly life: { live: boolean };
}

/**
 * The kernel's table of minted trees (the `ChildEnvironment` pattern): a tree is a frozen object with no enumerable
 * field, known only by identity. A copy or a JSON round trip is not in the table; a minter that stopped revokes every
 * tree it minted.
 */
export class SharedTrees<Entry> {
  readonly #minted = new WeakMap<object, Minted<Entry>>();

  /** A new tree for `entry`, valid while `life.live`. `label` (the folder's own name) is all its JSON says. */
  mint(label: string, entry: Entry, life: { live: boolean }): SharedTree {
    const tree = Object.create(null) as object;
    Object.defineProperty(tree, 'toJSON', { value: () => ({ shared: label }), enumerable: false });
    Object.freeze(tree);
    this.#minted.set(tree, { entry, life });
    return tree as SharedTree;
  }

  /** The entry a tree was minted for, or a refusal when it is not one (or its minter stopped). */
  open(tree: SharedTree): Entry {
    const minted = typeof tree === 'object' && tree !== null ? this.#minted.get(tree) : undefined;
    if (minted === undefined || !minted.life.live) return refuseShared('not_shared');
    return minted.entry;
  }
}
