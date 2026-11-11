/**
 * SHARED CREDENTIALS: ONE sign-in file of the `credentials` root's owner (Logins' Codex `auth.json`) handed to ONE named
 * receiver, which links it into its own agent home. It is built the way shared trees are (`./shared-trees.ts`: mint ->
 * carry -> materialize through a kernel table), with these differences:
 *
 * - it is a FILE, never a folder, and it is only ever the minter's own `credentials/<folder>/<file>`;
 * - it is bound to one receiving plugin: any other holder of the object can do nothing with it;
 * - the receiver cannot choose where it lands: `<its scoped home>/<file>`, under the same name, and nowhere else;
 * - it is the ONE exemption to the private-place fence's "a pinned inode is never a link target" rule, and only for the
 *   identity the mint table holds.
 *
 * The rules here are pure and shared by the real roots port (`./roots.ts`) and the testing host (`../testing/host.ts`).
 */
import { posix } from 'node:path';
import type { SharedCredential } from '../contract/ports.ts';
import { isPlainFileName } from './root-rules.ts';
import { refuseShared } from './shared-trees.ts';

/** One plain folder segment under the `credentials` root: the login's own folder (never `.`/`..`, a path or empty). */
export function isCredentialFolder(folder: unknown): folder is string {
  return typeof folder === 'string' && isPlainFileName(folder);
}

/** Whether `file` is a basename the minter's manifest lists in `permissions.shareCredentials` (`'*'` matches nothing). */
export function credentialFileListed(listed: readonly string[] | undefined, file: unknown): file is string {
  return typeof file === 'string' && isPlainFileName(file) && (listed ?? []).includes(file);
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
    this.#minted.set(credential, { entry, receiver, life });
    return credential as SharedCredential;
  }

  /** The entry a credential was minted for, or a refusal: not one the kernel minted, its minter stopped, or not `plugin`'s. */
  open(credential: SharedCredential, plugin: string): Entry {
    const minted = typeof credential === 'object' && credential !== null ? this.#minted.get(credential) : undefined;
    if (minted === undefined || !minted.life.live) return refuseShared('not_shared');
    if (minted.receiver !== plugin) return refuseShared('not_receiver');
    return minted.entry;
  }
}
