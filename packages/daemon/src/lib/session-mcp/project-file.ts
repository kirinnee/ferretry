/**
 * A project's `.mcp.json`, as data: read it, add one server to it, write it back, and say the change
 * as a diff a person can approve. Pure — the bytes come from and go to a port.
 *
 * WHAT IS PRESERVED. Every key the file already has — other servers, other top-level keys a later
 * Claude Code may add, their order — survives an add untouched. Only `mcpServers.<name>` is set, so
 * the diff a person approves is exactly one server's lines, plus the brace lines around a new file.
 *
 * WHAT IS REFUSED. A file that is not JSON, or whose `mcpServers` is not an object, is not repaired:
 * rewriting it would silently drop whatever the owner meant, so the add is refused with the reason.
 */

import type { SessionMcpDiffLine, SessionMcpServer } from '@ferretry/protocol';

/** The file's own JSON, with `mcpServers` known to be an object when present. */
export type McpProjectDocument = Readonly<Record<string, unknown>>;

export class McpProjectFileError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses the file's text. `null` (no file) is an empty document. */
export const parseMcpProjectFile = (text: string | null): McpProjectDocument => {
  if (text === null || text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpProjectFileError(
      '.mcp.json is not valid JSON, so Ferretry will not rewrite it. Fix it, then try again.',
    );
  }
  if (!isRecord(parsed))
    throw new McpProjectFileError('.mcp.json is not a JSON object, so Ferretry will not rewrite it.');
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))
    throw new McpProjectFileError(
      '.mcp.json has an "mcpServers" that is not an object, so Ferretry will not rewrite it.',
    );
  return parsed;
};

/** The servers a document declares, name-sorted, with how each is reached. */
export const projectServers = (
  document: McpProjectDocument,
): { readonly name: string; readonly transport: 'command' | 'url' }[] => {
  const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
  return Object.entries(servers)
    .map(([name, entry]) => ({
      name,
      transport: isRecord(entry) && typeof entry.url === 'string' ? ('url' as const) : ('command' as const),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

export const hasProjectServer = (document: McpProjectDocument, name: string): boolean =>
  isRecord(document.mcpServers) && Object.hasOwn(document.mcpServers, name);

/** One server as Claude Code's `.mcp.json` spells it. */
export const projectEntry = (server: SessionMcpServer): Record<string, unknown> =>
  server.transport === 'url'
    ? { type: 'http', url: server.url }
    : {
        command: server.command,
        args: [...server.args],
        ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
      };

/** The document with `name` set to `server`, every other key kept in its place. */
export const withProjectServer = (
  document: McpProjectDocument,
  name: string,
  server: SessionMcpServer,
): McpProjectDocument => {
  const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
  return { ...document, mcpServers: { ...servers, [name]: projectEntry(server) } };
};

/** The bytes written: two-space JSON and a final newline, the way editors and Claude Code write it. */
export const renderMcpProjectFile = (document: McpProjectDocument): string => `${JSON.stringify(document, null, 2)}\n`;

/** Unchanged lines kept on each side of a change; longer unchanged runs fold into one `…` line. */
const CONTEXT = 3;

/**
 * A line diff of `before` → `after` (longest common subsequence), with long unchanged runs folded.
 * The files are small — a handful of servers — so the quadratic table is never large.
 */
export const lineDiff = (before: string, after: string): SessionMcpDiffLine[] => {
  const left = before === '' ? [] : before.replace(/\n$/u, '').split('\n');
  const right = after.replace(/\n$/u, '').split('\n');
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1)
    for (let j = right.length - 1; j >= 0; j -= 1)
      (table[i] as number[])[j] =
        left[i] === right[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((table[i + 1] as number[])[j] as number, (table[i] as number[])[j + 1] as number);
  const lines: SessionMcpDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push({ kind: 'context', text: left[i] as string });
      i += 1;
      j += 1;
    } else if (
      j < right.length &&
      (i >= left.length || ((table[i] as number[])[j + 1] as number) > ((table[i + 1] as number[])[j] as number))
    ) {
      lines.push({ kind: 'add', text: right[j] as string });
      j += 1;
    } else {
      lines.push({ kind: 'remove', text: left[i] as string });
      i += 1;
    }
  }
  return foldContext(lines);
};

const foldContext = (lines: readonly SessionMcpDiffLine[]): SessionMcpDiffLine[] => {
  const changed = lines.map(line => line.kind !== 'context');
  const keep = lines.map((_, index) => {
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k += 1)
      if (changed[k]) return true;
    return false;
  });
  const folded: SessionMcpDiffLine[] = [];
  lines.forEach((line, index) => {
    if (keep[index]) folded.push(line);
    else if (folded.at(-1)?.text !== '…' || folded.at(-1)?.kind !== 'context')
      folded.push({ kind: 'context', text: '…' });
  });
  return folded;
};
