import { type BigIntStats, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { DirectoryWatchOpen, DirectoryWatchUnavailable, FileStamp } from '../../lib/file-events/ports.ts';

/** The `stat` calls both file-event sources make, injected so a test can make the platform refuse. */
export interface StampPrimitives {
  statSync(path: string): BigIntStats;
  stat(path: string): Promise<BigIntStats>;
}

export const nodeStampPrimitives: StampPrimitives = {
  statSync: path => statSync(path, { bigint: true }),
  stat: async path => await stat(path, { bigint: true }),
};

const stampOf = (stats: BigIntStats): FileStamp => ({
  ino: stats.ino,
  birthNs: stats.birthtimeNs,
  size: stats.size,
  mtimeNs: stats.mtimeNs,
});

/** The path's stamp, or `undefined` for anything `stat` refuses. */
export async function stampAt(primitives: StampPrimitives, path: string): Promise<FileStamp | undefined> {
  return await primitives.stat(path).then(stampOf, () => undefined);
}

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const LIMIT_CODES = new Set(['EMFILE', 'ENFILE', 'ENOSPC', 'ENOMEM']);
const UNSUPPORTED_CODES = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM']);

/** Why a watch could not open, from the error code the platform gave. */
export function unavailableFor(code: string | undefined, detail: string): DirectoryWatchOpen {
  if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
  const reason: DirectoryWatchUnavailable =
    code !== undefined && LIMIT_CODES.has(code)
      ? 'limit'
      : code !== undefined && UNSUPPORTED_CODES.has(code)
        ? 'unsupported'
        : 'failed';
  return { kind: 'unavailable', reason, detail };
}

export const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/**
 * The directory's identity, taken BEFORE its watch opens — so a directory replaced in between reads as
 * replaced, never as the one the watch is on — or why there is no directory to watch.
 */
export function directoryIdentity(
  primitives: StampPrimitives,
  directory: string,
): { readonly identity: FileStamp } | { readonly refused: DirectoryWatchOpen } {
  let stats: BigIntStats;
  try {
    stats = primitives.statSync(directory);
  } catch (error) {
    return { refused: unavailableFor(codeOf(error), describeError(error)) };
  }
  if (!stats.isDirectory()) return { refused: { kind: 'missing' } };
  return { identity: stampOf(stats) };
}
