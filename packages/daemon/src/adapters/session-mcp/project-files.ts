/**
 * A project's `.mcp.json` on disk: the one file outside this daemon's state home it writes, and only
 * ever at the root of a project or worktree the daemon already knows (`lib/session-mcp/service.ts`
 * decides the path; this decides nothing about it).
 *
 * NEVER THROUGH A LINK. Every open is `O_NOFOLLOW`, so a `.mcp.json` that is a symbolic link is refused
 * rather than followed out of the project, and the temporary file is created `O_EXCL` beside the target
 * so a planted name cannot redirect it either. `O_NONBLOCK` keeps a FIFO planted at the path from
 * hanging the read; anything that is not a regular file is refused.
 *
 * COMPARE, THEN SWAP. A write re-reads the file and refuses unless it still hashes to the etag the
 * person's preview showed. A file that did not exist is created with `link`, which fails if one appeared
 * in the meantime, so two first adds cannot both win; an existing file is replaced with `rename`, which
 * is atomic but leaves the short gap between the re-read and the rename unguarded — an editor saving in
 * that instant is overwritten, which the etag check narrows to that instant and cannot close.
 *
 * THE MODE IS KEPT. The replacement carries the old file's permission bits exactly; a new file gets
 * 0644, what a checkout's own files have.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { McpProjectFileError } from '../../lib/session-mcp/project-file.ts';
import {
  McpProjectFileChanged,
  type McpProjectFileReading,
  type McpProjectFiles,
} from '../../lib/session-mcp/service.ts';

/** The largest project file this reads. A real one is a few hundred bytes. */
const MAX_PROJECT_FILE_BYTES = 1024 * 1024;

/** A new file's permission bits: readable by everyone, writable by its owner. */
const NEW_FILE_MODE = 0o644;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const digest = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

interface FileBytes {
  readonly bytes: Uint8Array;
  readonly mode: number;
}

/** The file's bytes and mode, `null` when there is none. Refuses a link and anything but a regular file. */
async function readFileBytes(path: string): Promise<FileBytes | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    // Linux and macOS answer ELOOP for a link under O_NOFOLLOW; the BSDs answer EMLINK.
    if (codeOf(error) === 'ELOOP' || codeOf(error) === 'EMLINK')
      throw new McpProjectFileError(
        `${path} is a symbolic link, and Ferretry will not follow it out of the project. Replace it with the file itself.`,
      );
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new McpProjectFileError(`${path} is not a regular file, so Ferretry will not read or replace it.`);
    if (info.size > MAX_PROJECT_FILE_BYTES)
      throw new McpProjectFileError(`${path} is larger than 1 MiB, so Ferretry will not read or replace it.`);
    return { bytes: new Uint8Array(await handle.readFile()), mode: info.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

export class FileMcpProjectFiles implements McpProjectFiles {
  /** `uniqueId` names the temporary file; a test may also use it to act between the check and the swap. */
  constructor(private readonly uniqueId: () => string = randomUUID) {}

  async read(path: string): Promise<McpProjectFileReading> {
    const file = await readFileBytes(path);
    if (file === null) return { text: null, etag: null };
    return { text: new TextDecoder().decode(file.bytes), etag: digest(file.bytes) };
  }

  async replace(path: string, text: string, expected: string | null): Promise<string> {
    const current = await readFileBytes(path);
    if ((current === null ? null : digest(current.bytes)) !== expected) throw new McpProjectFileChanged();
    const mode = current?.mode ?? NEW_FILE_MODE;
    const bytes = new TextEncoder().encode(text);
    const temporary = join(dirname(path), `.${basename(path)}.${this.uniqueId()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    let placed = false;
    try {
      try {
        // Exactly the old bits: the mode `open` was given is filtered by the umask.
        await handle.chmod(mode);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (current === null)
        await link(temporary, path).catch((error: unknown) => {
          throw codeOf(error) === 'EEXIST' ? new McpProjectFileChanged() : error;
        });
      else {
        await rename(temporary, path);
        placed = true;
      }
    } finally {
      if (!placed) await rm(temporary, { force: true });
    }
    return digest(bytes);
  }
}
