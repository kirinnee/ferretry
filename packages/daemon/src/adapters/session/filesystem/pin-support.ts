import type { BigIntStats, Stats } from 'node:fs';
import path from 'node:path';
import {
  type ComponentIdentity,
  type FsEntryType,
  FsError,
  type FsErrorCode,
  type PinnedFileKind,
  type PinnedMetadata,
} from '../../../lib/session/filesystem/index.ts';

/**
 * The judgements every descriptor-backed pinner makes IDENTICALLY, kept in one place so two platforms
 * cannot drift into two containment rules.
 *
 * Nothing here touches the filesystem: each function turns something already read — an error, a
 * `Stats`, a resolved path — into the vocabulary the domain gates speak. The platform-specific part of
 * a pinner is only HOW it opens a component from an already-open parent; what the result MEANS is
 * this file, and a difference of opinion here would be a difference in what is served.
 */

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Every way the kernel says "there is nothing usable at that name". */
export function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENAMETOOLONG';
}

/** A walked component's identity, from a `bigint` `fstat` so its device and inode are exact. */
export function componentIdentity(metadata: BigIntStats): ComponentIdentity {
  return { dev: metadata.dev, ino: metadata.ino, ctimeMs: Number(metadata.ctimeMs), mode: Number(metadata.mode) };
}

export function pinnedMetadata(metadata: BigIntStats): PinnedMetadata {
  const type = metadata.isDirectory() ? 'dir' : metadata.isFile() ? 'file' : 'other';
  return {
    type,
    size: Number(metadata.size),
    mtime: metadata.mtime.toISOString(),
    mode: Number(metadata.mode),
    links: Number(metadata.nlink),
  };
}

export function contains(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(`${rootReal}${path.sep}`);
}

/**
 * Root-relative CANONICAL path of a contained target, in the slash-joined shape the gates expect.
 *
 * This is what stops an in-root symlinked directory from laundering a denied or ignored target: `alias ->
 * .git` passes containment (its target IS inside the root) while the lexical path `alias/config` matches
 * no denylist entry and no ignore rule.
 */
export function canonicalRel(rootReal: string, targetReal: string): string | undefined {
  if (targetReal === rootReal) return undefined;
  return targetReal
    .slice(rootReal.length + 1)
    .split(path.sep)
    .join('/');
}

export function direntType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsEntryType | undefined {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return undefined; // fifo, socket, device — nothing a viewer can show
}

/** Where a probe's walk goes: the directories to hold open, root-most first, and the leaf to describe. */
export interface ProbeSegments {
  readonly directories: readonly string[];
  readonly leaf: string;
}

/**
 * `rel` as a probe walks it, or `undefined` for a name no walk accepts.
 *
 * An empty, `.` or `..` component is refused here rather than handed to the kernel: the walk opens one
 * component at a time from its parent, and `..` is the one name that walks OUT of a held directory.
 */
export function probeSegments(rel: string): ProbeSegments | undefined {
  const segments = rel.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined;
  const leaf = segments.pop();
  return leaf === undefined ? undefined : { directories: segments, leaf };
}

export function sameDirectory(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** The refusals that say a name holds nothing a read would serve — as opposed to proving nothing. */
const UNSUPPORTED_REFUSALS: ReadonlySet<FsErrorCode> = new Set([
  'not_found',
  'not_a_directory',
  'not_a_file',
  'escapes_root',
]);

/** A probe's verdict on a directory step that refused: the same split a read's refusal makes. */
export function refusedKind(error: unknown): PinnedFileKind {
  return error instanceof FsError && UNSUPPORTED_REFUSALS.has(error.code) ? 'unsupported' : 'unreadable';
}

/** A probe's verdict on a leaf from its OWN metadata, so a link is a link and never its target. */
export function leafKind(metadata: Stats | BigIntStats): PinnedFileKind {
  return metadata.isFile() ? 'file' : 'unsupported';
}

/** A probe's verdict on a leaf that could not be described: gone is a kind, anything else is not. */
export function leafErrorKind(error: unknown): PinnedFileKind {
  return isMissing(error) ? 'unsupported' : 'unreadable';
}
