/**
 * The documents a runtime's harness reads its MCP servers from — `.claude.json`, `settings.json`, `config.toml`, a
 * project's `.mcp.json` — read and parsed through a kernel root handle (a root refuses a link that leaves it and a
 * device file). Read-only: Claude's local scope is written by the Claude Code harness, not here.
 */
import type { FerretRoot } from './project-files.ts';
import { McpDocumentUnreadable, type McpHarnessDocuments } from '../lib/inventory/service.ts';

/** Larger than any real one: a busy `.claude.json` runs to a few hundred kilobytes. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;

/**
 * Any file-system refusal as a document that cannot be read — by path and cause, never by content. Left to throw, one
 * locked `.mcp.json` (macOS answers `EPERM` for a folder the daemon holds no privacy grant for) failed the whole
 * inventory, and the owner lost every server over one file.
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

/** Parses a document's text; the half binds JSON and TOML. */
export type DocumentParser = (text: string, format: 'json' | 'toml') => unknown;

export class RootMcpHarnessDocuments implements McpHarnessDocuments {
  /** `open(path)` is the ferret root that holds the document, or throws when no ferret folder does. */
  constructor(
    private readonly open: (path: string) => FerretRoot,
    private readonly parse: DocumentParser,
  ) {}

  async read(path: string, format: 'json' | 'toml'): Promise<unknown> {
    let text: string;
    try {
      const held = this.open(path);
      const root = held.root;
      const base = held.base.replace(/\/+$/u, '');
      const given = path.startsWith(`${base}/`) ? root.resolve(path.slice(base.length + 1)) : undefined;
      if (given === undefined || !given.ok) throw new McpDocumentUnreadable(`${path} is outside what Ferretry may read.`);
      const resolved = given.value;
      const info = await root.stat(resolved);
      if (info === undefined) return null;
      if (info.kind !== 'file') throw new McpDocumentUnreadable(`${path} is not a regular file.`);
      if (info.size > MAX_DOCUMENT_BYTES) throw new McpDocumentUnreadable(`${path} is too large to read.`);
      text = await root.readText(resolved, MAX_DOCUMENT_BYTES);
    } catch (error) {
      throw unreadableDocument(path, error);
    }
    if (text.trim() === '') return null;
    try {
      return this.parse(text, format);
    } catch {
      // The parser's message can quote the document, which may hold a key: say only what it is.
      throw new McpDocumentUnreadable(
        `${path} is not valid ${format === 'json' ? 'JSON' : 'TOML'}, so its MCP servers cannot be read.`,
      );
    }
  }
}
