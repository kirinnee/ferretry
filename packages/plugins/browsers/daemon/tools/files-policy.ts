import {
  AGENT_TOOL_MAX_DOWNLOAD_BYTES,
  AGENT_TOOL_MAX_UPLOAD_CALL_BYTES,
  AGENT_TOOL_MAX_UPLOAD_FILE_BYTES,
  AGENT_TOOL_MAX_UPLOAD_FILES,
} from './limits.ts';

/**
 * Safety policy for reclaiming an expired session's non-daemon files.
 *
 * The session journal is authoritative, so this module deliberately defines
 * daemon-owned material as a whitelist.  A name which merely looks temporary
 * must never be reclaimed by inference.
 */

const DAEMON_OWNED_SCRATCH_ENTRIES: ReadonlySet<string> = new Set([
  'attachments',
  'channel',
  'checks',
  'chat.jsonl',
  'config.json',
  'events.jsonl',
  'kill.json',
  'last-snapshot.txt',
  'launch.sh',
  'liveness.yaml',
  'logs',
  'markers',
  'raw',
  'snapshots',
  'state.json',
  'summary.md',
  'system.md',
  'turns',
]);

/** An in-flight atomic write of one of the daemon's documents is also owned. */
function isDaemonOwnedScratchEntry(name: string): boolean {
  if (DAEMON_OWNED_SCRATCH_ENTRIES.has(name)) return true;
  const base = name.split('.tmp.')[0];
  return name.includes('.tmp.') && base !== undefined && DAEMON_OWNED_SCRATCH_ENTRIES.has(base);
}

/**
 * The pure decisions of the agent file tools (`browser.upload`, `browser.download`, `browser.pdf`): which
 * path an agent may name, what a saved file is called, and how much one call may carry.
 *
 * THE ONE RULE: an agent reaches a file only INSIDE the folder its own session works in. This module
 * decides the lexical half (no `..`, nothing outside the folder, nothing under `.git`, none of the
 * daemon's own scratch entries); {@link ./files.ts} decides the half that needs the disk, where
 * a symlink can lead out of the folder.
 */

export const AGENT_FILE_LIMITS = {
  files: AGENT_TOOL_MAX_UPLOAD_FILES,
  fileBytes: AGENT_TOOL_MAX_UPLOAD_FILE_BYTES,
  callBytes: AGENT_TOOL_MAX_UPLOAD_CALL_BYTES,
  downloadBytes: AGENT_TOOL_MAX_DOWNLOAD_BYTES,
  /** The longest file name an audit record or a saved file keeps. */
  nameChars: 120,
} as const;

/** How long a download or a PDF the browser staged stays claimable. */
export const STAGED_FILE_TTL_MS = 15 * 60_000;

/** Where a download is saved when the agent names no place. */
export const DEFAULT_SAVE_FOLDER = 'downloads';

const SEGMENT_SPLIT = /[\\/]+/u;
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
};

const RESERVED_CHARS = '<>:"|?*';

/** The segments of a path under the folder, for the checks that look at a name rather than a place. */
function segmentsOf(path: string): readonly string[] {
  return path.split(SEGMENT_SPLIT).filter(segment => segment !== '' && segment !== '.');
}

/**
 * A path under the folder that no tool may touch: anything inside `.git`, and the daemon's own scratch
 * entries at the folder's top level. Compared without regard to case, for filesystems that fold it.
 */
export function forbiddenInside(relativePath: string): string | undefined {
  const [first, ...rest] = segmentsOf(relativePath);
  if (first === undefined) return undefined;
  if (first.toLowerCase() === '.git' || rest.some(segment => segment.toLowerCase() === '.git'))
    return 'paths inside .git are not available to the file tools';
  if (isDaemonOwnedScratchEntry(first)) return `${first} belongs to the daemon and is not available to the file tools`;
  return undefined;
}

/** A file name safe to keep: a leaf, no control characters, no leading dots, at most {@link AGENT_FILE_LIMITS.nameChars}. */
export function sanitizeFileName(raw: string, fallback: string): string {
  const leaf = raw.split(SEGMENT_SPLIT).at(-1) ?? '';
  const cleaned = Array.from(leaf, char => (isControl(char) || RESERVED_CHARS.includes(char) ? '_' : char))
    .join('')
    .replace(/^[.\s]+/u, '')
    .trim();
  if (cleaned === '') return fallback;
  if (cleaned.length <= AGENT_FILE_LIMITS.nameChars) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  return `${cleaned.slice(0, AGENT_FILE_LIMITS.nameChars - extension.length)}${extension}`;
}

/** What an upload's size caps allow: the per-file and per-call ceilings, as one sentence when broken. */
export function uploadSizeProblem(sizes: readonly number[]): string | undefined {
  if (sizes.length > AGENT_FILE_LIMITS.files) return `at most ${String(AGENT_FILE_LIMITS.files)} files in one upload`;
  if (sizes.some(size => size > AGENT_FILE_LIMITS.fileBytes))
    return `a file over ${mebibytes(AGENT_FILE_LIMITS.fileBytes)} cannot be uploaded`;
  if (sizes.reduce((total, size) => total + size, 0) > AGENT_FILE_LIMITS.callBytes)
    return `one upload carries at most ${mebibytes(AGENT_FILE_LIMITS.callBytes)} in all`;
  return undefined;
}

const mebibytes = (bytes: number): string => `${String(Math.round(bytes / (1024 * 1024)))} MiB`;

/** A size in plain words for a sentence an agent reads. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
