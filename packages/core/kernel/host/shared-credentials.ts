/**
 * SHARED CREDENTIALS: ONE sign-in file of the `credentials` root's owner (Logins' Codex `auth.json`) handed to ONE named
 * receiver, which links it into its own agent home. It is built the way shared trees are (`./shared-trees.ts`: mint ->
 * carry -> materialize through a kernel table), with these differences:
 *
 * - it is a FILE, never a folder, and it is only ever the minter's own `credentials/<folder>/<file>`;
 * - it is bound to one receiving plugin: any other holder of the object can do nothing with it;
 * - the receiver cannot choose where it lands: `<its scoped home>/<file>`, under the same name, and nowhere else;
 * - it is SINGLE-USE: the first successful link spends it, so a second link, a link after the first was removed and a link
 *   into another ferret's home are refused (`not_shared`); a fresh mint is the only way to place one again;
 * - it is the ONE exemption to the private-place fence's "a pinned inode is never a link target" rule, and only for the
 *   identity the mint table holds.
 *
 * The rules here are pure and shared by the real roots port (`./roots.ts`) and the testing host (`../testing/host.ts`).
 */
import { posix } from 'node:path';
import type { RootName, SharedCredential } from '../contract/ports.ts';
import { isPlainFileName } from './root-rules.ts';
import { refuseShared } from './shared-trees.ts';

/** One plain folder segment under the `credentials` root: the login's own folder (never `.`/`..`, a path or empty). */
export function isCredentialFolder(folder: unknown): folder is string {
  return typeof folder === 'string' && isPlainFileName(folder);
}

/** Whether `file` is a basename the minter's manifest lists in `permissions.shareCredentials` (`'*'` matches nothing). */
export function credentialFileListed(listed: readonly string[] | undefined, file: unknown): file is string {
  return typeof file === 'string' && isPlainFileName(file) && Array.isArray(listed) && listed.includes(file);
}

/** Whether `receiver` is a plugin id: the same plain-segment shape a folder has. */
export function isCredentialReceiver(receiver: unknown): receiver is string {
  return typeof receiver === 'string' && isPlainFileName(receiver);
}

/**
 * Whether `to` is exactly `<scopedBase>/<file>`: one level, the credential's own name. `scopedBase` is the handle's
 * scoped folder (one ferret's home), which the caller proved exists as a scope; `to` is the lexical path the handle gave.
 */
export function credentialPlacement(scopedBase: string, file: string, to: string): boolean {
  return posix.join(scopedBase, file) === to;
}

/** What a host knows of the sign-in file: its kind, its names, and the device and inode that name it whatever path reached it. */
export interface CredentialFacts {
  readonly kind: string;
  readonly links: number;
  readonly device: bigint;
  readonly inode: bigint;
}

/** Why a sign-in file cannot be shared: not a regular file with exactly one name. One rule for both hosts (mint AND link time). */
export function credentialFileRefusal(found: Pick<CredentialFacts, 'kind' | 'links'>): 'not_own' | undefined {
  return found.kind === 'file' && found.links === 1 ? undefined : 'not_own';
}

/** Whether `now` is the very inode that was minted (same device and inode): a rename-over, a re-sign-in or a swap is not. */
export function isMintedInode(
  minted: Pick<CredentialFacts, 'device' | 'inode'>,
  now: Pick<CredentialFacts, 'device' | 'inode'>,
): boolean {
  return minted.device === now.device && minted.inode === now.inode;
}

/**
 * Whether a placed link, once made, is the link that was meant: the real path it resolves to is the minted file's real
 * path, and the inode there is the minted one. A link that fails this is taken back and refused `changed`.
 */
export function placedLinkHolds(
  minted: { readonly real: string } & Pick<CredentialFacts, 'device' | 'inode'>,
  landed: { readonly real: string } & Pick<CredentialFacts, 'device' | 'inode'>,
): boolean {
  return minted.real === landed.real && isMintedInode(minted, landed);
}

/** One minted credential: what the host needs to reach it again, and whether its minter is still running. */
interface Minted<Entry> {
  readonly entry: Entry;
  readonly receiver: string;
  readonly life: { live: boolean };
  /** Whether a link is being made with it right now. A second claim while one is in flight is refused. */
  inFlight: boolean;
}

/** A credential held for one link attempt: `spend` when the link stays, `release` when nothing was made. */
export interface CredentialClaim<Entry> {
  readonly entry: Entry;
  spend(): void;
  release(): void;
}

/**
 * The kernel's table of minted credentials (the `SharedTrees` / `ChildEnvironment` pattern): a frozen object with no
 * enumerable field, known only by identity. A copy or a JSON round trip is not in the table; a minter that stopped
 * revokes every credential it minted. It serialises as `{ credential: <file name> }` and nothing else.
 */
export class SharedCredentials<Entry> {
  readonly #minted = new WeakMap<object, Minted<Entry>>();

  /** A new credential for `entry`, valid while `life.live`, openable only for `receiver`. `file` is all its JSON says. */
  mint(file: string, receiver: string, entry: Entry, life: { live: boolean }): SharedCredential {
    const credential = Object.create(null) as object;
    Object.defineProperty(credential, 'toJSON', { value: () => ({ credential: file }), enumerable: false });
    Object.freeze(credential);
    this.#minted.set(credential, { entry, receiver, life, inFlight: false });
    return credential as SharedCredential;
  }

  /** The entry a credential was minted for, or a refusal: not one the kernel minted, its minter stopped, or not `plugin`'s. */
  open(credential: SharedCredential, plugin: string): Entry {
    const minted = typeof credential === 'object' && credential !== null ? this.#minted.get(credential) : undefined;
    if (minted === undefined || !minted.life.live) return refuseShared('not_shared');
    if (minted.receiver !== plugin) return refuseShared('not_receiver');
    return minted.entry;
  }

  /**
   * Holds a credential for ONE link attempt, with the checks `open` makes. A credential already spent, or held by an
   * attempt still running, is `not_shared`: two links started together make one. `spend` removes it from the table for
   * good (the link stays); `release` gives it back after an attempt that made no link.
   */
  claim(credential: SharedCredential, plugin: string): CredentialClaim<Entry> {
    const entry = this.open(credential, plugin);
    const minted = this.#minted.get(credential as object);
    if (minted === undefined || minted.inFlight) return refuseShared('not_shared');
    minted.inFlight = true;
    return {
      entry,
      spend: () => {
        this.#minted.delete(credential as object);
      },
      release: () => {
        minted.inFlight = false;
      },
    };
  }
}

/**
 * The credential links the kernel PLACED, by what it recorded when it made them (the path the link sits at and a mark of
 * the link itself: its device and inode on disk, the text it holds in the test world), never by the link's name. A move
 * of one of them (the link, or any folder that holds it) is refused: single use stops a second link, so it is the placed
 * one that must not be carried into another ferret's home. Removing it (`unlink`, `remove`) stays allowed.
 */
export class PlacedCredentialLinks {
  readonly #placed = new Map<string, string>();

  /** Records the link just placed at `path`, with the `mark` the host reads from the link itself. */
  place(path: string, mark: string): void {
    this.#placed.set(path, mark);
  }

  /** Forgets a placed link at `path` and every one below it (a link or a folder was removed). */
  forgetUnder(path: string): void {
    for (const key of [...this.#placed.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.#placed.delete(key);
  }

  /** The recorded links a move of `from` would carry: `from` itself and every recorded one below it, each with its mark. */
  affected(from: string): readonly (readonly [string, string])[] {
    return [...this.#placed].filter(([key]) => key === from || key.startsWith(`${from}/`));
  }
}

/**
 * The rule for a move (`rename`): `placed` are the recorded links the move would carry that are STILL the recorded link
 * (the host compared the mark it reads now). None: the move is nobody's business here. Some: `link_escape`, nothing is
 * written. (The same name at both ends never reaches this: `renameNamesRefusal` refuses it first and moves nothing.)
 */
export function placedLinkMoveVerdict(placed: readonly unknown[]): 'link_escape' | undefined {
  return placed.length === 0 ? undefined : 'link_escape';
}

/**
 * The roots that are CREDENTIAL HOMES: `agent-homes` (each ferret's own harness home, where a shared sign-in is placed and
 * which the harness then reads as its config home) and `credentials` (every login's store). Whatever sits in one of them may
 * hold or reach a sign-in, so the whole root is judged as one place rather than guessed at folder by folder: a folder that
 * holds a placed credential, one that is about to, and every folder above either are all inside it.
 */
const CREDENTIAL_HOME_ROOTS: ReadonlySet<RootName> = new Set(['agent-homes', 'credentials']);

/** Whether a name in the root `name` is inside a credential home (see {@link CREDENTIAL_HOME_ROOTS}). */
export function inCredentialHome(name: RootName | undefined): boolean {
  return name !== undefined && CREDENTIAL_HOME_ROOTS.has(name);
}

/**
 * The rule for a LINK written by anything but `linkCredential` (`linkTo`, `copyTree` in link mode): `link_escape` when
 * the link's own place (`target`) or the thing it points at (`source`) is inside a credential home, so a second ferret
 * can never be handed the placed credential through an alias of its folder, and nothing is written. `undefined`: the rule
 * has nothing to say (the dedicated `linkCredential` is the one way a credential is linked, with its own checks). A root
 * that is not known (`undefined`) is judged by the caller's other refusals, never granted here.
 */
export function credentialHomeLinkVerdict(ends: {
  readonly source: RootName | undefined;
  readonly target: RootName | undefined;
}): 'link_escape' | undefined {
  return inCredentialHome(ends.source) || inCredentialHome(ends.target) ? 'link_escape' : undefined;
}
