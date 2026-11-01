import { lstat, readlink } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { ROOT_PROGRAM_FOLDERS, type ReplaceableDisk, replaceableBy } from './replaceable-file.ts';

/**
 * A PROGRAM FROM THE OWNER'S OWN NIX PROFILE (docs/secure-copy.md, owner decision !A182).
 *
 * The profile is the owner's: `~/.nix-profile` and the generations behind it are links this account owns, so ANY
 * process running as the owner — every ferret — can point them at another store path, and anyone may add a store
 * path. A program proved this way is therefore only "the program the owner's profile names right now", never "a
 * program root placed". It earns exactly what the owner allowed (secure-copy `allowProfileTargets`) and nothing else.
 *
 * The proof is still strict about the PATH: the entry `<profile>/bin/<name>` is walked one part at a time as the
 * kernel walks it, every link it meets must sit inside the profile chain (`~/.nix-profile`, the per-user profile
 * folders Nix keeps, or the store), and the walk must end at the very store file the process runs. A program in
 * `~/bin`, a link that leaves the chain, or a store path the profile does not name is never proved.
 */

/** The owner's profile: the entries to try for a name, and where a link on the way may live. */
export interface ProfileChain {
  /** `<profile>/bin` folders, tried in order. */
  readonly bins: readonly string[];
  /** Folders (with their trailing `/`) a link met on the walk may sit in. */
  readonly linksIn: readonly string[];
}

const NIX_STORE = '/nix/store/';
/** Links followed before a walk is given up on; the kernel's own limit is 40. */
const MAX_LINKS = 40;
const NAME = /^[A-Za-z0-9._+-]{1,64}$/u;
const ACCOUNT = /^[A-Za-z0-9._-]+$/u;

/** The profile chain of an account with this home folder and name; `undefined` when either cannot be one. */
export function profileChainOf(home: string | undefined, account: string | undefined): ProfileChain | undefined {
  if (home === undefined || !isAbsolute(home) || home === '/' || account === undefined || !ACCOUNT.test(account))
    return undefined;
  const root = home.replace(/\/+$/u, '');
  return {
    bins: [`${root}/.nix-profile/bin`],
    linksIn: [
      `${root}/.nix-profile/`,
      `${root}/.local/state/nix/profiles/`,
      `/nix/var/nix/profiles/per-user/${account}/`,
      NIX_STORE,
    ],
  };
}

/** Whether `path` itself, or anything under it, is one of `folders` (each given with its trailing `/`). */
const inside = (path: string, folders: readonly string[]): boolean =>
  folders.some(folder => `${path}/`.startsWith(folder));

/**
 * Where `entry` leads, walked one part at a time with every link followed by hand, or `undefined` when a link on the
 * way sits outside the chain, a part cannot be looked at, or the links do not end.
 */
export async function walkProfileEntry(
  entry: string,
  chain: ProfileChain,
  disk: ReplaceableDisk,
): Promise<string | undefined> {
  if (!isAbsolute(entry)) return undefined;
  let done = '';
  let rest = entry.split('/');
  let links = 0;
  while (rest.length > 0) {
    const [part = '', ...after] = rest;
    rest = after;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      done = done.slice(0, Math.max(0, done.lastIndexOf('/')));
      continue;
    }
    const next = `${done}/${part}`;
    const status = await disk.lstat(next).catch(() => undefined);
    if (status === undefined) return undefined;
    if (!status.isSymbolicLink()) {
      done = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS || !inside(next, chain.linksIn)) return undefined;
    const target = await disk.readlink(next).catch(() => undefined);
    if (target === undefined) return undefined;
    if (isAbsolute(target)) done = '';
    rest = [...target.split('/'), ...rest];
  }
  return done === '' ? '/' : done;
}

/** The program a process running `executable` is, proved through the profile chain, or `undefined`. */
export async function profileProgramOf(
  executable: string,
  chain: ProfileChain,
  disk: ReplaceableDisk,
): Promise<{ readonly name: string; readonly path: string } | undefined> {
  if (!executable.startsWith(NIX_STORE) || executable.endsWith(' (deleted)')) return undefined;
  const name = basename(executable);
  if (!NAME.test(name)) return undefined;
  for (const bin of chain.bins)
    if ((await walkProfileEntry(`${bin}/${name}`, chain, disk)) === executable) return { name, path: executable };
  return undefined;
}

/**
 * Whether this machine finds `program` ONLY in the owner's profile: no root-controlled folder holds it (one this account
 * cannot replace), and the profile's entry walks into the store. What a rule into it is labelled with.
 */
export async function onlyInProfile(
  program: string,
  chain: ProfileChain | undefined,
  account: number | undefined,
  disk: ReplaceableDisk = { lstat, readlink },
  folders: readonly string[] = ROOT_PROGRAM_FOLDERS,
): Promise<boolean> {
  if (chain === undefined || !NAME.test(program)) return false;
  for (const folder of folders) {
    const entry = `${folder}/${program}`;
    if ((await disk.lstat(entry).catch(() => undefined)) === undefined) continue;
    if (!(await replaceableBy(account, entry, disk, folders))) return false;
  }
  for (const bin of chain.bins)
    if ((await walkProfileEntry(`${bin}/${program}`, chain, disk))?.startsWith(NIX_STORE) === true) return true;
  return false;
}

/** This machine's account: where a terminal rule's program lives, for the rules list. */
export function machineProgramHomes(
  home: string | undefined,
  account: string | undefined,
  uid: number | undefined,
): { profileOnly(program: string): Promise<boolean> } {
  const chain = profileChainOf(home, account);
  return { profileOnly: async program => await onlyInProfile(program, chain, uid) };
}
