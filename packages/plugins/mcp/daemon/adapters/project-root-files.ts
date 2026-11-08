/**
 * The ONE file MCP may read at a registered project root or a live managed worktree that no ferret works in: its
 * `.mcp.json` (lead ruling (B)). Read-only, that name only, no listing, through the kernel's `imports` root scoped to
 * that folder — never the file system directly.
 *
 * What the kernel's scoped root refuses, every call: `..`, a path that resolves out of the project root
 * (`link_escape`), anything inside the fence (the live home, every `-before-` folder), a device or other special file,
 * and a file with a second hard link. `imports` is read-only, so a write could not land even if this let one through.
 *
 * What this adds, before every stat and read:
 * - every name but `.mcp.json` at the root itself is refused before the kernel is asked, and so is every list, write,
 *   copy, folder-make, pin and remove;
 * - a `.mcp.json` that is a LINK (wherever it points, inside the root included) is refused: the kernel's `lstat` names
 *   the leaf itself;
 * - a project root that is a link, or sits under one, is refused: its kernel `realPath` must be the root as named.
 *   So a project registered through a link (the folder or any parent) reads no `.mcp.json`: register its real path.
 *
 * GAP (declared): every narrowing above is THIS adapter's. The kernel's `imports` root takes any absolute folder
 * outside the fence, so a slip here could read any file there (a harness home's `.claude.json` beside a project
 * included). Closing it needs a kernel root scoped to one file (a contract change of the kernel's `RootsPort`).
 */
import type { FencedPath, FolderRefusal, RootHandle } from '@ferretry/kernel/contract';
import { err, type Result } from '@ferretry/std';
import { McpDocumentUnreadable } from '../lib/inventory/service.ts';
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

const refuse = (what: string) => async (): Promise<never> => {
  throw new McpFileOnlyRefusal(what);
};

/**
 * A kernel root handle narrowed to the one `.mcp.json` at its base: `resolve` answers only that name, the reads take
 * only the path it answered and only while that path is a regular file (not a link) under a root that is its own real
 * path, and everything else refuses.
 */
export function mcpFileOnly(handle: RootHandle): RootHandle {
  let allowed: FencedPath | undefined;
  /** The leaf as it is (`undefined` when there is none), once the path, the leaf and the root have all checked. */
  const checked = async (path: FencedPath) => {
    if (allowed === undefined || path !== allowed) throw new McpFileOnlyRefusal('read any other file');
    const leaf = await handle.lstat(path);
    if (leaf === undefined) return undefined;
    if (leaf.kind === 'symlink')
      throw new McpDocumentUnreadable(
        `${path} is a link; Ferretry reads a project's ${PROJECT_MCP_FILE} only as a file.`,
      );
    if (leaf.kind !== 'file') throw new McpDocumentUnreadable(`${path} is not a regular file.`);
    const base = handle.resolve('');
    if (!base.ok || (await handle.realPath(base.value)) !== base.value)
      throw new McpDocumentUnreadable(
        `${path} is under a link; Ferretry reads a project's ${PROJECT_MCP_FILE} only at the project's real folder.`,
      );
    return leaf;
  };
  const file = async (path: FencedPath): Promise<FencedPath> => {
    if ((await checked(path)) === undefined) throw new McpDocumentUnreadable(`${path} is not there.`);
    return path;
  };
  return {
    name: handle.name,
    internal: handle.internal,
    resolve: (relative: string): Result<FencedPath, FolderRefusal> => {
      if (relative !== PROJECT_MCP_FILE) return err('outside');
      const resolved = handle.resolve(PROJECT_MCP_FILE);
      if (resolved.ok) allowed = resolved.value;
      return resolved;
    },
    stat: async path => ((await checked(path)) === undefined ? undefined : await handle.stat(path)),
    lstat: async path => await checked(path),
    readText: async (path, limitBytes) => await handle.readText(await file(path), limitBytes),
    readBytes: async (path, limitOrWindow) => await handle.readBytes(await file(path), limitOrWindow),
    readTail: async (path, maxBytes) => await handle.readTail(await file(path), maxBytes),
    realPath: refuse('resolve a path'),
    list: refuse('list a folder'),
    entries: refuse('list a folder'),
    writeText: refuse('write'),
    writeBytes: refuse('write'),
    copyTree: refuse('copy'),
    ensurePrivateDirectory: refuse('make a folder'),
    makeDirectory: refuse('make a folder'),
    pin: refuse('hold a folder open'),
    publish: refuse('publish'),
    readDurable: refuse('readDurable'),
    syncDirectory: refuse('syncDirectory'),
    fileIdentity: refuse('fileIdentity'),
    remove: refuse('remove'),
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
