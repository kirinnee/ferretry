/**
 * A project's `.mcp.json`: the one file outside this plugin's state it writes, and only ever at the root of a project
 * or worktree the daemon already knows (`lib/session/service.ts` decides the path; this decides nothing about it).
 *
 * Through the ferret's `work` root: the handle resolves links before every read and write and refuses one that leaves
 * the folder, a device file, and anything inside the fence. COMPARE, THEN SWAP: a write re-reads the file and refuses
 * unless it still hashes to the etag the person's preview showed. The write is the root's atomic temp-and-rename.
 */
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { McpProjectFileError } from '../lib/session/project-file.ts';
import { McpProjectFileChanged, type McpProjectFileReading, type McpProjectFiles } from '../lib/session/service.ts';

/** The largest project file this reads. A real one is a few hundred bytes. */
const MAX_PROJECT_FILE_BYTES = 1024 * 1024;

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

async function digest(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/** A ferret's `work` root and the absolute folder it is rooted at: paths in and out are absolute, the handle gets relative ones. */
export interface FerretRoot {
  readonly root: RootHandle;
  readonly base: string;
}

function fenced(held: FerretRoot, path: string) {
  const base = held.base.replace(/\/+$/u, '');
  if (path !== base && !path.startsWith(`${base}/`)) return undefined;
  const resolved = held.root.resolve(path.slice(base.length).replace(/^\//u, ''));
  return resolved.ok ? resolved.value : undefined;
}

export class RootMcpProjectFiles implements McpProjectFiles {
  constructor(
    private readonly workRoot: (ferret: string) => Promise<FerretRoot>,
    private readonly sha256: (text: string) => Promise<string> = digest,
  ) {}

  async read(ferret: string, path: string): Promise<McpProjectFileReading> {
    const place = await this.#place(ferret, path);
    const text = await this.#text(place.held.root, place.resolved, path);
    return text === null ? { text: null, etag: null } : { text, etag: await this.sha256(text) };
  }

  async replace(ferret: string, path: string, text: string, expected: string | null): Promise<string> {
    // One root and one resolution for the compare AND the swap: the write goes where the comparison looked.
    const { held, resolved } = await this.#place(ferret, path);
    const current = await this.#text(held.root, resolved, path);
    if ((current === null ? null : await this.sha256(current)) !== expected) throw new McpProjectFileChanged();
    await held.root.writeText(resolved, text);
    return await this.sha256(text);
  }

  /** The ferret's root and the name inside it that `path` is, or a refusal when `path` is not inside the folder. */
  async #place(ferret: string, path: string) {
    const held = await this.workRoot(ferret);
    const resolved = fenced(held, path);
    if (resolved === undefined)
      throw new McpProjectFileError(`${path} is outside the ferret's folder, so Ferretry will not read or replace it.`);
    return { held, resolved };
  }

  async #text(root: RootHandle, resolved: FencedPath, path: string): Promise<string | null> {
    let info: Awaited<ReturnType<RootHandle['stat']>>;
    try {
      info = await root.stat(resolved);
    } catch {
      throw new McpProjectFileError(`${path} is not a regular file, so Ferretry will not read or replace it.`);
    }
    if (info === undefined) return null;
    if (info.kind !== 'file')
      throw new McpProjectFileError(`${path} is not a regular file, so Ferretry will not read or replace it.`);
    if (info.size > MAX_PROJECT_FILE_BYTES)
      throw new McpProjectFileError(`${path} is larger than 1 MiB, so Ferretry will not read or replace it.`);
    return await root.readText(resolved, MAX_PROJECT_FILE_BYTES);
  }
}
