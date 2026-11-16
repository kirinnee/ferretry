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

import type { SessionMcpServer } from './boundary.ts';

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

/** One server as Claude Code's `.mcp.json` spells it. */
export const projectEntry = (server: SessionMcpServer): Record<string, unknown> =>
  server.transport === 'url'
    ? { type: 'http', url: server.url }
    : {
        command: server.command,
        args: [...server.args],
        ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
      };

/** The bytes written: two-space JSON and a final newline, the way editors and Claude Code write it. */
export const renderMcpProjectFile = (document: McpProjectDocument): string => `${JSON.stringify(document, null, 2)}\n`;
