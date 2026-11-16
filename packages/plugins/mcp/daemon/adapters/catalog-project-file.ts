import { posix } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import {
  CatalogItemRefusal,
  McpProjectFileChanged,
  type McpProjectFileReading,
  type McpProjectFiles,
} from '@ferretry/plugin-catalogs/contract';

/** The largest project file this reads. A real one is a few hundred bytes. */
const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
/** A new file's permission bits: readable by everyone, writable by its owner (what a checkout's own files have). */
const NEW_FILE_MODE = 0o644;
const PROJECT_FILE = '.mcp.json';

const withoutTrailingSlash = (path: string): string => path.replace(/(?<=.)\/+$/u, '');

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async (bytes: Uint8Array): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));

const refusal = (message: string): CatalogItemRefusal => new CatalogItemRefusal('catalog_install_conflict', message);

/**
 * A project's `.mcp.json` as a catalog install reads and writes it (v4's `FileMcpProjectFiles`): the one file outside
 * Ferretry's own state it writes, only ever at the root of a project or worktree the daemon already knows, through the
 * kernel's `project-files` root scoped to that one folder and to that one name (MCP's declared `.mcp.json`). The root
 * refuses a link at any level and a file with a second name, so the file is never read or replaced through one.
 *
 * COMPARE, THEN SWAP: a write re-reads the file and refuses unless it still hashes to the etag the person's preview
 * showed. A file that did not exist is created exclusively (so two first adds cannot both win); an existing one is
 * replaced atomically in its own mode.
 */
export class CatalogMcpProjectFile implements McpProjectFiles {
  constructor(
    private readonly roots: () => Promise<readonly string[]>,
    private readonly open: (root: string) => RootHandle,
  ) {}

  async read(path: string): Promise<McpProjectFileReading> {
    const { handle, at } = await this.#place(path);
    const bytes = await this.#bytes(handle, at, path);
    return bytes === null
      ? { text: null, etag: null }
      : { text: new TextDecoder().decode(bytes), etag: await digest(bytes) };
  }

  async replace(path: string, text: string, expected: string | null): Promise<string> {
    const { handle, at } = await this.#place(path);
    const current = await this.#bytes(handle, at, path);
    if ((current === null ? null : await digest(current)) !== expected) throw new McpProjectFileChanged();
    const bytes = new TextEncoder().encode(text);
    try {
      if (current === null) await handle.writeBytes(at, bytes, { mode: NEW_FILE_MODE, exclusive: true });
      else await handle.writeBytes(at, bytes, { replaceExisting: true });
    } catch (error) {
      if (current === null && (await handle.lstat(at).catch(() => undefined)) !== undefined)
        throw new McpProjectFileChanged();
      throw refusal(`${path} could not be written (${error instanceof Error ? error.message : 'refused'}).`);
    }
    return await digest(bytes);
  }

  /** The root handle and the one name inside it, once `path` is `<a root the daemon knows>/.mcp.json`. */
  async #place(path: string): Promise<{ readonly handle: RootHandle; readonly at: FencedPath }> {
    const root = withoutTrailingSlash(posix.dirname(path));
    if (
      posix.basename(path) !== PROJECT_FILE ||
      !(await this.roots()).some(known => withoutTrailingSlash(known) === root)
    )
      throw refusal(`${path} is not the .mcp.json of a project Ferretry knows, so it will not be read or replaced.`);
    const handle = this.open(root);
    const at = handle.resolve(PROJECT_FILE);
    if (!at.ok) throw refusal(`${path} cannot be reached, so it will not be read or replaced.`);
    return { handle, at: at.value };
  }

  async #bytes(handle: RootHandle, at: FencedPath, path: string): Promise<Uint8Array | null> {
    let found: Awaited<ReturnType<RootHandle['lstat']>>;
    try {
      found = await handle.lstat(at);
    } catch {
      throw refusal(`${path} is a link, or not a regular file, so Ferretry will not read or replace it.`);
    }
    if (found === undefined) return null;
    if (found.kind === 'symlink')
      throw refusal(
        `${path} is a symbolic link, and Ferretry will not follow it out of the project. Replace it with the file itself.`,
      );
    if (found.kind !== 'file') throw refusal(`${path} is not a regular file, so Ferretry will not read or replace it.`);
    if (found.size > MAX_PROJECT_FILE_BYTES)
      throw refusal(`${path} is larger than 1 MiB, so Ferretry will not read or replace it.`);
    try {
      return await handle.readBytes(at, MAX_PROJECT_FILE_BYTES);
    } catch {
      throw refusal(`${path} is a link, or not a regular file, so Ferretry will not read or replace it.`);
    }
  }
}
