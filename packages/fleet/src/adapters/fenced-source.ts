import type { StateHomeFence } from '../lib/state-home-fence.ts';
import {
  copyTreeOutsideStateHomes,
  type GuardDisk,
  type GuardLinkOptions,
  type GuardRule,
  judgeOutsideStateHomes,
  openOutsideStateHomes,
  resolveImmutableRoots,
  resolveStateHomes,
  type StateHomes,
} from '../lib/state-home-guard.ts';
import { NodeGuardDisk } from './node-guard-disk.ts';

/**
 * A fleet component's source, through the one state-home guard (`../lib/state-home-guard.ts`): nothing the
 * provisioner copies or links into a runtime — the model's context — is inside the daemon's state home, judged
 * as named, at every link hop (a runtime's `auth.json` is a link IN the home that lands outside it, on the host
 * login), by real path and by identity, and every file is read through the descriptor that was checked.
 *
 * A HARD LINK IS REFUSED, WITH ONE EXCEPTION. A file with two names is the same inode under both, so nothing
 * tells whether its other name is inside the state home — and a hard link to `api-token` left in some folder is
 * exactly how a source would carry it out. The Nix store is the exception: it hard-links identical files
 * (`auto-optimise-store`), so a source linked out of it routinely has several names, and the store is
 * root-owned and immutable, so none of them can be a name in the state home — which the guard PROVES
 * (`resolveImmutableRoots`: a root-owned chain nobody this process is can write) rather than assumes. A store
 * that fails the proof (a single-user Nix install, owned by its user) gets no exception: every hard link is
 * refused there.
 */

/** Where a source may be a hard link: the Nix store, root-owned and immutable. */
export const HARD_LINK_ROOTS: readonly string[] = ['/nix/store'];

/** The most one source may bring — per file, in all, and in entries (files and folders): a runtime, not a disk. */
const MAX_SOURCE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 100_000;

/** The provisioner's fence: the state homes, the asset tree open inside them, and where a hard link may be. */
export interface SourceFence extends StateHomeFence {
  /** Defaults to {@link HARD_LINK_ROOTS}. A root is used only once proven immutable, so naming one grants nothing. */
  readonly hardLinkRoots?: readonly string[];
  /** The home's key files and folders, judged by identity wherever they are met (`resolveStateHomes`). */
  readonly pinned?: readonly string[];
}

/** The fence as the disk has it now. */
export interface ResolvedSourceFence {
  readonly homes: StateHomes;
  readonly links: GuardLinkOptions;
  readonly disk: GuardDisk;
}

/** A source the guard refused: the message names the rule and the home, never what the source holds. */
export class FencedSourceError extends Error {
  constructor(
    source: string,
    readonly rule: GuardRule,
    home?: string,
  ) {
    super(`refusing to provision from ${source}: ${FencedSourceError.why(rule, home)}`);
    this.name = 'FencedSourceError';
  }

  private static why(rule: GuardRule, home: string | undefined): string {
    switch (rule) {
      case 'state-home':
        return `it is inside this daemon's state home (${home ?? 'FY_HOME'}), which holds this machine's credentials, so no component may copy or link it into a runtime`;
      case 'hard-link':
        return "it is a hard link, and another of its names could be inside this daemon's state home — copy it and name the copy";
      case 'changed':
        return 'it changed while it was being checked';
      case 'not-found':
        return 'it does not exist';
      case 'loop':
        return 'it links back into itself';
      case 'too-many':
        return 'it holds too many files and folders, or too many bytes';
      default:
        return `the state-home guard refused it (${rule})`;
    }
  }
}

/**
 * Resolves the configured fence. A home that cannot be resolved throws (the apply is refused, fail closed), and so
 * does an asset tree that is, or holds, a home; an asset tree that does not exist yet holds no source, so it is no
 * opening.
 */
export async function resolveSourceFence(
  fence: SourceFence,
  disk: GuardDisk = new NodeGuardDisk(),
): Promise<ResolvedSourceFence> {
  const openings: string[] = [];
  for (const directory of fence.open) {
    if ((await disk.realpath(directory).catch(() => undefined)) !== undefined) openings.push(directory);
  }
  // A store that cannot be proven immutable (absent, or writable by this user) is no exception at all.
  const immutable = await resolveImmutableRoots(fence.hardLinkRoots ?? HARD_LINK_ROOTS, disk).catch(() => undefined);
  return {
    homes: await resolveStateHomes(
      { homes: fence.homes, openings, ...(fence.pinned === undefined ? {} : { pinned: fence.pinned }) },
      disk,
    ),
    links: { hops: 'every', hardLinks: immutable === undefined ? 'refuse' : { allowUnder: immutable } },
    disk,
  };
}

/**
 * Whether `source` — a file or a folder — may be provisioned, and its real path. Throws
 * {@link FencedSourceError} when the guard refuses it. A folder is judged without opening it (its contents are
 * judged one by one when it is copied); a file is opened too, so the hard-link rule and the swap check apply to
 * what a link to it will reach.
 */
export async function assertSourceUnfenced(resolved: ResolvedSourceFence, source: string): Promise<string> {
  const judged = await judgeOutsideStateHomes(source, resolved.homes, resolved.disk, resolved.links);
  if (!judged.ok) throw new FencedSourceError(source, judged.rule, judged.home);
  if (judged.value.identity.kind === 'directory') return judged.value.real;
  const opened = await openOutsideStateHomes(source, resolved.homes, resolved.disk, resolved.links);
  if (!opened.ok) throw new FencedSourceError(source, opened.rule, opened.home);
  await opened.value.close();
  return opened.value.path;
}

/**
 * The text of one component document, read through the guard: `undefined` when it is absent, not a file, over
 * `maxBytes` or unreadable, and {@link FencedSourceError} when the guard holds it inside the state home.
 */
export async function readFencedSource(
  resolved: ResolvedSourceFence,
  source: string,
  maxBytes: number,
): Promise<string | undefined> {
  const opened = await openOutsideStateHomes(source, resolved.homes, resolved.disk, resolved.links);
  if (!opened.ok) {
    if (opened.rule === 'state-home' || opened.rule === 'hard-link')
      throw new FencedSourceError(source, opened.rule, opened.home);
    return undefined;
  }
  try {
    return await opened.value.readText(maxBytes);
  } catch {
    return undefined;
  } finally {
    await opened.value.close();
  }
}

/**
 * Copies `source` — a file, or a folder and everything in it, every link followed — to the new path `to`,
 * refusing the whole copy when any hop or file is inside the state home. What a refusal leaves at `to` is the
 * caller's to discard (the provisioner stages the copy beside its destination for exactly that).
 */
export async function copyFencedSource(resolved: ResolvedSourceFence, source: string, to: string): Promise<void> {
  const copied = await copyTreeOutsideStateHomes(source, to, resolved.homes, resolved.disk, {
    ...resolved.links,
    maxFileBytes: MAX_SOURCE_FILE_BYTES,
    maxTotalBytes: MAX_SOURCE_TOTAL_BYTES,
    maxFiles: MAX_SOURCE_ENTRIES,
  });
  if (!copied.ok) throw new FencedSourceError(source, copied.rule, copied.home);
}
