/**
 * The ONE file MCP may read at a registered project root or a live managed worktree that no ferret works in: its
 * `.mcp.json` (lead ruling (B)). Read-only, that name only, no listing, through the kernel's `imports` root scoped to
 * that folder — never the file system directly.
 *
 * What the kernel's scoped root refuses, every read: `..`, a `.mcp.json` (or a folder on the way) that is a link
 * leading out of the project root (`link_escape`), anything inside the fence (the live home, every `-before-` folder),
 * a device or other special file, and a file with a second hard link. `imports` is read-only, so a write could not
 * land even if this let one through. What this adds: every name but `.mcp.json` at the root itself is refused before
 * the kernel is asked, and so is every list, write and remove.
 *
 * GAP (kernel item N, `RootHandle.realPath`): the handle exposes no link test of its own, so a `.mcp.json` that is a
 * link to another file INSIDE the same project root, or a project root that is itself a link to a folder outside the
 * fence, is followed — as today's reader did. A link that leaves the root is refused.
 */
import type { FencedPath, FolderRefusal, RootHandle } from '@ferretry/kernel/contract';
import { err, type Result } from '@ferretry/std';
import type { FerretRoot } from './project-files.ts';

/** The only name read at a project root. */
export const PROJECT_MCP_FILE = '.mcp.json';

const withoutTrailingSlash = (path: string): string => path.replace(/(?<=.)\/+$/u, '');

/** The project-root `.mcp.json` path for a folder, as MCP names it everywhere (`<root>/.mcp.json`). */
export const projectMcpFilePath = (root: string): string => `${root.replace(/\/+$/u, '')}/${PROJECT_MCP_FILE}`;

class McpFileOnlyRefusal extends Error {
  constructor(what: string) {
    super(`MCP reads only ${PROJECT_MCP_FILE} at a project root; it does not ${what}.`);
    this.name = 'McpFileOnlyRefusal';
  }
}

/**
 * A kernel root handle narrowed to the one `.mcp.json` at its base: `resolve` answers only that name, the reads take
 * only the path it answered, and listing, writing and removing refuse.
 */
export function mcpFileOnly(handle: RootHandle): RootHandle {
  let allowed: FencedPath | undefined;
  const only = (path: FencedPath): FencedPath => {
    if (allowed === undefined || path !== allowed) throw new McpFileOnlyRefusal('read any other file');
    return path;
  };
  return {
    name: handle.name,
    resolve: (relative: string): Result<FencedPath, FolderRefusal> => {
      if (relative !== PROJECT_MCP_FILE) return err('outside');
      const resolved = handle.resolve(PROJECT_MCP_FILE);
      if (resolved.ok) allowed = resolved.value;
      return resolved;
    },
    readText: async (path, limitBytes) => await handle.readText(only(path), limitBytes),
    readBytes: async (path, limitBytes) => await handle.readBytes(only(path), limitBytes),
    stat: async path => await handle.stat(only(path)),
    list: async () => {
      throw new McpFileOnlyRefusal('list a folder');
    },
    writeText: async () => {
      throw new McpFileOnlyRefusal('write');
    },
    remove: async () => {
      throw new McpFileOnlyRefusal('remove');
    },
  };
}

/**
 * Which root holds `path`, when it is the `.mcp.json` of a known root (a registered project or a live managed
 * worktree): the kernel's `imports` root scoped to that folder, narrowed to that file. `undefined` for any other path,
 * which the caller reads (or refuses) as before.
 */
export const projectRootMcpFile =
  (open: (folder: string) => RootHandle) =>
  (path: string, knownRoots: readonly string[]): FerretRoot | undefined => {
    for (const known of knownRoots) {
      const root = withoutTrailingSlash(known);
      if (!root.startsWith('/') || root === '/' || projectMcpFilePath(root) !== path) continue;
      return { root: mcpFileOnly(open(root)), base: root };
    }
    return undefined;
  };
