/**
 * SHARED TREES (kernel batch #10, rulings #52 Q2 + Q5): one folder an owner plugin hands, read-only, to the plugin that
 * receives it (Skills' skill folder in a launch part → the harness that materializes it in a ferret home). The rules
 * here are pure and shared by the real roots port (`./roots.ts`) and the testing host (`../testing/host.ts`), so a
 * plugin's unit test meets exactly what production decides: who may mint, from what, into what, and when a link is
 * made instead of a copy.
 */
import type { FerretId } from '../contract/ids.ts';
import type { RootName, SharedTree } from '../contract/ports.ts';
import type { StateFileDef } from '../contract/define.ts';
import { isKernelMadeRoot } from './internal-roots.ts';

/**
 * When `copyShared` may make a LINK instead of a copy. ONE declared switch, a typed value and never text a person or
 * a plugin writes (the owner's answer to !A466 picks it; the batch rule is the default):
 *
 * - `link-internal` (#52 Q5, the default): a link only from an INTERNAL source (the minter's own state, Skills'
 *   `installed/*`). A project folder (an owner's root) is always copied, so the harness child can never write into the
 *   owner's project through its home.
 * - `link-own`: also a link from an owner's-root source when that root is the RECEIVING ferret's OWN work folder (the
 *   skill's project is the folder the ferret already works in) and the link lands in that same ferret's own home.
 *   Every other project folder is still copied.
 *
 * Copy is the fallback in every case the rule does not allow: a refused link is never an error.
 */
export type SharedTreeLinkRule = 'link-internal' | 'link-own';

/** The rule in effect when the host is given none. */
export const SHARED_TREE_LINK_RULE: SharedTreeLinkRule = 'link-internal';

/**
 * The roots a minter may share a folder of. `work` (an owner's project skills) and `imports` (an owner-named folder):
 * both owner's roots, so a tree from them is never linked under `link-internal`. Never the sign-in material
 * (`credentials`), a ferret's session folder (`sessions`, a plaintext session credential), Runtimes' `fleet`, a harness
 * home or history, a download, a worktree or another plugin's agent homes.
 */
const SHAREABLE_ROOTS: ReadonlySet<RootName> = new Set(['work', 'imports']);

/** Where a shared tree came from, as the link rule reads it. */
export type SharedOrigin =
  /** One name of the minter's own opaque named tree: an INTERNAL source. */
  | { readonly kind: 'state' }
  /** A folder of one of the minter's own root handles: an OWNER'S root. `ferret` is a `work` handle's scope. */
  | { readonly kind: 'root'; readonly root: RootName; readonly ferret?: FerretId };

/** The handle a tree is materialized into: its root, and the scope it was made with. */
export interface SharedReceiver {
  readonly root: RootName;
  readonly ferret?: FerretId;
  readonly subfolder?: string;
}

/** Why a shared tree was refused. One closed list, the same on both hosts. */
export type SharedRefusal =
  /** The minter's manifest does not declare `permissions.shareTrees`. */
  | 'not_permitted'
  /** The source is not the minter's own (another plugin's handle, an undeclared or non-opaque state def, a bad name). */
  | 'not_own'
  /** The source root is not one a folder may be shared from. */
  | 'not_shareable'
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

/** Whether a folder of this root may be shared at all. */
export function shareableRoot(name: RootName): boolean {
  return SHAREABLE_ROOTS.has(name);
}

/** Whether a tree may be materialized into this root: an internal root the kernel makes (`agent-homes`, …). */
export function receivingRoot(name: RootName): boolean {
  return isKernelMadeRoot(name);
}

/** A state name segment: today's collection-name rule (`state-port.ts`), never `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u;

/**
 * The folder, relative to the minter's state folder, that one name of one of its OWN declared opaque named trees
 * names (`installed/*` + `abc` → `installed/abc`); `undefined` when the def is not one it declared exactly, is not an
 * opaque named tree, or the name is not path-safe plain segments.
 */
export function ownStateTree(declared: readonly StateFileDef[], def: StateFileDef, name: string): string | undefined {
  const known = declared.find(entry => entry.name === def.name);
  if (known === undefined || known.path !== def.path || known.store !== def.store || known.format !== def.format)
    return undefined;
  if (known.store !== 'opaque' || !known.path.endsWith('/*')) return undefined;
  if (name === '' || !name.split('/').every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..'))
    return undefined;
  return known.path.slice(0, -1) + name;
}

/** The first segment of a relative scope (`F12/sessions` → `F12`). */
const firstSegment = (subfolder: string | undefined): string | undefined =>
  subfolder === undefined || subfolder === '' ? undefined : subfolder.split('/')[0];

/**
 * THE link rule: whether `copyShared(…, { link: true })` makes a link for this tree into this handle, under `rule`.
 * Anything it does not allow is copied.
 */
export function sharedLinkAllowed(rule: SharedTreeLinkRule, origin: SharedOrigin, receiver: SharedReceiver): boolean {
  if (!receivingRoot(receiver.root)) return false;
  if (origin.kind === 'state') return true;
  if (rule !== 'link-own') return false;
  // The skill's project is the receiving ferret's OWN work folder, and the link lands in that ferret's OWN home.
  return (
    origin.root === 'work' &&
    origin.ferret !== undefined &&
    receiver.root === 'agent-homes' &&
    receiver.ferret === origin.ferret &&
    firstSegment(receiver.subfolder) === origin.ferret
  );
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
