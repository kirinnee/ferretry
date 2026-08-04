import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ComponentIdentity, FsEntryType, PinnedMetadata } from '../../../lib/session/filesystem/index.ts';

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

export function componentIdentity(metadata: Stats): ComponentIdentity {
  return { dev: metadata.dev, ino: metadata.ino, ctimeMs: metadata.ctimeMs, mode: metadata.mode };
}

export function pinnedMetadata(metadata: Stats): PinnedMetadata {
  const type = metadata.isDirectory() ? 'dir' : metadata.isFile() ? 'file' : 'other';
  return { type, size: metadata.size, mtime: metadata.mtime.toISOString(), mode: metadata.mode };
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
