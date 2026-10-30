import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import {
  AGENT_TOOL_MAX_DOWNLOAD_BYTES,
  AGENT_TOOL_MAX_PATH_CHARS,
  AGENT_TOOL_MAX_UPLOAD_CALL_BYTES,
  AGENT_TOOL_MAX_UPLOAD_FILE_BYTES,
  AGENT_TOOL_MAX_UPLOAD_FILES,
} from '@ferretry/protocol';
import { isDaemonOwnedScratchEntry } from '../scratch/policy.ts';

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

/** Why a file tool could not do what was asked, in a code the agent-tool path maps to its own. */
export class AgentFileError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'AgentFileError';
  }
}

const SEGMENT_SPLIT = /[\\/]+/u;
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
};
const hasControl = (text: string): boolean => Array.from(text).some(isControl);
const RESERVED_CHARS = '<>:"|?*';

/** Whether `path` is the folder itself or something under it — compared as paths, not as strings. */
export function isWithin(root: string, path: string): boolean {
  const from = relative(root, path);
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

/** The segments of a path under the folder, for the checks that look at a name rather than a place. */
export function segmentsOf(path: string): readonly string[] {
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

/**
 * The absolute path an agent's request names, from the text alone — or a refusal. Nothing here touches the
 * disk, so a symlink is invisible to it: the caller resolves the real path and asks again.
 */
export function lexicalTarget(folder: string, requested: string): string {
  if (requested.length === 0 || requested.length > AGENT_TOOL_MAX_PATH_CHARS || hasControl(requested))
    throw new AgentFileError('bad_request', 'that is not a usable path');
  if (segmentsOf(requested).includes('..'))
    throw new AgentFileError('forbidden', 'a path with ".." is refused: name it from the session folder down');
  const candidate = isAbsolute(requested) ? normalize(requested) : resolve(folder, requested);
  if (!isWithin(folder, candidate))
    throw new AgentFileError('forbidden', 'that path is outside this session’s folder, so it is refused');
  const refusal = forbiddenInside(relative(folder, candidate));
  if (refusal !== undefined) throw new AgentFileError('forbidden', refusal);
  return candidate;
}

/** The same rule, once symlinks are resolved: the real path must still be under the folder's real path. */
export function realTarget(realFolder: string, realPath: string): string {
  if (!isWithin(realFolder, realPath))
    throw new AgentFileError('forbidden', 'that path leads outside this session’s folder, so it is refused');
  const refusal = forbiddenInside(relative(realFolder, realPath));
  if (refusal !== undefined) throw new AgentFileError('forbidden', refusal);
  return realPath;
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

/** The file's extension, lowercase and short — the one thing besides its size an audit record keeps of a download. */
export function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 17) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/u.test(extension) ? extension : undefined;
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

export const mebibytes = (bytes: number): string => `${String(Math.round(bytes / (1024 * 1024)))} MiB`;

/** A size in plain words for a sentence an agent reads. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A saved file's place relative to the folder, written with forward slashes. */
export const relativeWords = (folder: string, path: string): string => relative(folder, path).split(sep).join('/');
