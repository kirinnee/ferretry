/**
 * THE HISTORY-POOL DOOR (`RootHandle.linkHistory`): one entry of a harness home (`<ferret home>/projects`, `history.jsonl`)
 * made a symlink to the SAME entry of ONE pool the harness plugin owns (`state/<plugin>/history-pool/<entry>`), so every
 * ferret on a harness reads and continues any other ferret's conversations (v4's behaviour, the owner's ask).
 *
 * It is the one link the kernel allows inside `agent-homes` besides `linkCredential` (`./shared-credentials.ts`,
 * `credentialHomeLinkVerdict`, which is unchanged for every other caller), and it is narrower than either: the caller
 * names a home and an entry, and chooses nothing else. The target is the caller's own declared pool (never a path it
 * gave), the name is one the manifest lists and the kernel's deny list allows, and the place is the top of one ferret home.
 * The rules here are pure and shared by the real roots port (`./roots.ts`) and the testing host (`../testing/host.ts`).
 */
import { dirname, basename, relative } from 'node:path';
import type { HistoryPoolEntryDecl, HistoryPoolPermission } from '../manifest/types.ts';
import { declaredHistoryEntry, historyPoolNameRefusal, poolStateFolder } from '../manifest/history-pool.ts';
import type { StateFileDef } from '../contract/define.ts';
import { ownStateTree } from './shared-trees.ts';

/** Why the history-pool door refused. One closed list, the same on both hosts. */
export type HistoryPoolRefusal =
  /** The caller's manifest does not declare `permissions.historyPool` (or declares one the kernel does not honour). */
  | 'not_permitted'
  /** The handle is not an `agent-homes` handle: the door links into a harness home and nowhere else. */
  | 'not_internal'
  /** The entry is on the kernel's fixed deny list or is not one plain, non-hidden name, whatever the manifest says. */
  | 'denied'
  /** The entry is a legal name, but the manifest's closed list does not name it. */
  | 'not_listed'
  /** `home` is not exactly one ferret home folder at the top of `agent-homes`. */
  | 'not_home'
  /** The pool is not the caller's own declared, opaque, non-private state tree. */
  | 'not_own'
  /** Anything (a folder, a file, a link) is already at the name in the home: the door never overwrites. */
  | 'exists';

export class HistoryPoolError extends Error {
  constructor(readonly refusal: HistoryPoolRefusal) {
    super(`history pool refused: ${refusal}`);
    this.name = 'HistoryPoolError';
  }
}

export const refuseHistory = (refusal: HistoryPoolRefusal): never => {
  throw new HistoryPoolError(refusal);
};

/** Whether a link may be made through this root: `agent-homes` only (never `fleet`, `credentials`, `sessions`, `downloads`). */
export function historyRoot(name: string): boolean {
  return name === 'agent-homes';
}

/**
 * The entry the door will link: the manifest declares `permissions.historyPool`, the name passes the kernel's fixed rules
 * (`denied`) and the manifest's closed list names it exactly (`not_listed`). The permission is judged FIRST, so a plugin
 * without it learns nothing about which names are legal.
 */
export function historyEntryFor(permission: HistoryPoolPermission | undefined, entry: unknown): HistoryPoolEntryDecl {
  if (permission === undefined) return refuseHistory('not_permitted');
  if (typeof entry !== 'string' || historyPoolNameRefusal(entry) !== undefined) return refuseHistory('denied');
  return declaredHistoryEntry(permission, entry) ?? refuseHistory('not_listed');
}

/**
 * The pool folder one entry lives in, relative to the plugin's state folder (`history-pool/projects`), or `undefined`
 * when the declaration's `state` is not one of the plugin's OWN opaque `<one plain folder>/*` trees (`not_own`). The
 * caller still asks `holdsPrivate` of the answer. The kernel names the target from this, never from the caller.
 */
export function poolEntryFolder(
  permission: HistoryPoolPermission,
  states: readonly StateFileDef[],
  entry: string,
): string | undefined {
  const def = states.find(candidate => candidate.name === permission.state);
  if (def === undefined || poolStateFolder(permission, states) === undefined) return undefined;
  return ownStateTree(states, def, entry);
}

/** The whole pool, subject to exactly the ownership rule used for a linked entry. */
export function ownHistoryPool(permission: HistoryPoolPermission | undefined, states: readonly StateFileDef[]): string {
  if (permission === undefined) return refuseHistory('not_permitted');
  const entry = poolEntryFolder(permission, states, 'projects');
  return entry === undefined ? refuseHistory('not_own') : dirname(entry);
}

/** Pure lexical move policy, shared by both hosts. The root has already fenced both absolute names. */
export function historyMoveNames(
  permission: HistoryPoolPermission | undefined,
  top: string,
  from: string,
  pool: string,
  to: string,
): void {
  if (permission === undefined) refuseHistory('not_permitted');
  const source = relative(top, from).split('/');
  const ferret = source[0];
  const entry = source[1];
  if (ferret === undefined || entry === undefined || !isFerretHome(top, `${top}/${ferret}`)) refuseHistory('not_home');
  historyEntryFor(permission, entry);
  const target = relative(pool, to).split('/');
  const normal = target[0] === entry;
  const conflict = target[0] === '.conflicts' && target[1] === ferret && target[2] === entry;
  const parts = conflict ? target.slice(1) : target;
  if ((!normal && !conflict) || !parts.every(part => /^[A-Za-z0-9_-][A-Za-z0-9._%~-]*$/u.test(part)))
    refuseHistory('denied');
}

/**
 * Whether `lexicalHome` is exactly ONE ferret home: a folder directly under the top of `agent-homes` (`top`, the root's
 * own folder `state/<plugin>/agent-homes`). The home itself, anything deeper and anything outside are not. Both are
 * absolute, normalised paths the handle already proved lexical.
 */
export function isFerretHome(top: string, lexicalHome: string): boolean {
  return lexicalHome !== top && dirname(lexicalHome) === top && basename(lexicalHome) !== '';
}

/**
 * The credential rule for the pool: a sign-in is never placed in, or taken from, the history pool. `pool` is the pool's
 * own folder (`undefined` when the plugin declares none, and then there is nothing to protect); `ends` are the real paths
 * a credential link names (the place it would land at, the file it points at). Any end at or below the pool is
 * `link_escape`. `credentialHomeLinkVerdict` itself is unchanged: this is a second, independent rule beside it.
 */
export function poolCredentialVerdict(pool: string | undefined, ends: readonly string[]): 'link_escape' | undefined {
  if (pool === undefined) return undefined;
  return ends.some(end => end === pool || end.startsWith(`${pool}/`)) ? 'link_escape' : undefined;
}
