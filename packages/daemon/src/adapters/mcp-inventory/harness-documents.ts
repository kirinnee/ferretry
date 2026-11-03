/**
 * The documents a runtime's harness reads its MCP servers from — `.claude.json`, `settings.json`,
 * `config.toml`, a project's `.mcp.json` — read and parsed, and Claude's local scope written back.
 *
 * Read-only apart from {@link FileClaudeLocalScope}, which writes only the runtime's OWN `.claude.json`
 * under the fleet, never the person's `~/.claude.json`: the paths come from the fleet manifest.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { parseSettings } from '@ferretry/fleet';
import { isFerretryLocalEntry } from '../../lib/mcp-inventory/declarations.ts';
import type { ClaudeLocalScope, LocalScopeServer } from '../../lib/mcp-inventory/project-sign-in.ts';
import { McpDocumentUnreadable, type McpHarnessDocuments } from '../../lib/mcp-inventory/service.ts';

/** Larger than any real one: a busy `.claude.json` runs to a few hundred kilobytes. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Any file-system refusal as a document that cannot be read — by path and cause, never by content. Left
 * to throw, one locked `.mcp.json` (macOS answers `EPERM` for a folder the daemon holds no privacy grant
 * for) failed the whole inventory with the daemon's blanket "failed to handle this request", and the
 * owner lost every server over one file.
 */
export function unreadableDocument(path: string, error: unknown): McpDocumentUnreadable {
  if (error instanceof McpDocumentUnreadable) return error;
  const code = codeOf(error);
  if (code === 'EACCES') return new McpDocumentUnreadable(`${path} cannot be read by the daemon.`);
  if (code === 'EPERM')
    return new McpDocumentUnreadable(
      `${path} cannot be read by the daemon: the operating system refused access (on macOS, that folder may need Full Disk Access for the daemon).`,
    );
  return new McpDocumentUnreadable(`${path} could not be read${code === undefined ? '' : ` (${code})`}.`);
}

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

/**
 * Where a document may be read from: `confinedTo` is the folder it must really lie in. The parent is resolved
 * and must be that folder or inside it, the file is opened with `O_NOFOLLOW`, and a file with a second hard
 * link is refused. A repo can plant a link to any file the daemon can read; this stops the read following it.
 */
async function confinedParent(path: string, confinedTo: string): Promise<'inside' | 'absent'> {
  const outside = new McpDocumentUnreadable(`${path} is a link or lies outside its folder, so it was not read.`);
  let boundary: string;
  try {
    boundary = await realpath(confinedTo);
  } catch {
    throw outside;
  }
  let parent: string;
  try {
    parent = await realpath(dirname(path));
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return 'absent';
    throw unreadableDocument(path, error);
  }
  if (!isWithin(boundary, parent)) throw outside;
  return 'inside';
}

async function readText(
  path: string,
  confinedTo?: string,
): Promise<{ readonly text: string; readonly mode: number } | null> {
  if (confinedTo !== undefined && (await confinedParent(path, confinedTo)) === 'absent') return null;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK: a FIFO planted at the path must not hang the read.
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (confinedTo === undefined ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return null;
    if (confinedTo !== undefined && codeOf(error) === 'ELOOP')
      throw new McpDocumentUnreadable(`${path} is a link or lies outside its folder, so it was not read.`);
    throw unreadableDocument(path, error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new McpDocumentUnreadable(`${path} is not a regular file.`);
    if (confinedTo !== undefined && info.nlink > 1)
      throw new McpDocumentUnreadable(`${path} has another hard link, so it was not read.`);
    if (info.size > MAX_DOCUMENT_BYTES) throw new McpDocumentUnreadable(`${path} is too large to read.`);
    return { text: await handle.readFile('utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    throw unreadableDocument(path, error);
  } finally {
    await handle.close();
  }
}

export class FileMcpHarnessDocuments implements McpHarnessDocuments {
  async read(path: string, format: 'json' | 'toml'): Promise<unknown> {
    return await this.readWithin(path, format, undefined);
  }

  protected async readWithin(path: string, format: 'json' | 'toml', confinedTo: string | undefined): Promise<unknown> {
    const read = await readText(path, confinedTo);
    if (read === null || read.text.trim() === '') return null;
    try {
      return parseSettings(read.text, format);
    } catch {
      // The parser's message can quote the document, which may hold a key: say only what it is.
      throw new McpDocumentUnreadable(
        `${path} is not valid ${format === 'json' ? 'JSON' : 'TOML'}, so its MCP servers cannot be read.`,
      );
    }
  }
}

/**
 * The same documents, for a COPY: a path under one of the `boundaries` (a registered project folder, the
 * fleet) is read confined to it, never through a link and never as a shared hard link. A path under none
 * is the person's own configuration and is read as the inventory reads it.
 */
export class ConfinedMcpHarnessDocuments extends FileMcpHarnessDocuments {
  constructor(private readonly boundaries: () => Promise<readonly string[]>) {
    super();
  }

  override async read(path: string, format: 'json' | 'toml'): Promise<unknown> {
    const covering = (await this.boundaries())
      .filter(boundary => path.startsWith(boundary.endsWith(sep) ? boundary : `${boundary}${sep}`))
      .toSorted((left, right) => right.length - left.length)[0];
    return await this.readWithin(path, format, covering);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `projects[<root>].mcpServers` in a runtime's `.claude.json`: Ferretry's own entries replaced, every
 * other key kept as it was read.
 *
 * Written whole, beside the target and renamed over it, keeping its mode. Claude Code rewrites this file
 * too; a write of Claude's that lands between this read and the rename is lost (the materialiser's
 * `replaceKeys` write has the same window). What is lost is Claude's own state, never a token, and the
 * next launch writes Ferretry's entries again.
 */
export class FileClaudeLocalScope implements ClaudeLocalScope {
  async reconcile(path: string, root: string, servers: Readonly<Record<string, LocalScopeServer>>): Promise<void> {
    const read = await readText(path);
    let document: Record<string, unknown> = {};
    if (read !== null && read.text.trim() !== '') {
      try {
        const parsed = JSON.parse(read.text) as unknown;
        if (!isRecord(parsed)) return;
        document = parsed;
      } catch {
        // Not ours to repair: Claude will say so itself.
        return;
      }
    }
    const projects = isRecord(document.projects) ? document.projects : {};
    const project = isRecord(projects[root]) ? projects[root] : {};
    const existing = isRecord(project.mcpServers) ? project.mcpServers : {};
    const kept = Object.fromEntries(Object.entries(existing).filter(([, entry]) => !isFerretryLocalEntry(entry)));
    const next = {
      ...document,
      projects: { ...projects, [root]: { ...project, mcpServers: { ...kept, ...servers } } },
    };
    const temporary = `${path}.fy-${randomUUID()}.tmp`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      read?.mode ?? 0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } finally {
      // Gone already after a rename; left only when the rename failed.
      await rm(temporary, { force: true });
    }
  }
}
