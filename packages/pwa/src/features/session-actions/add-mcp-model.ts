/**
 * The Add MCP server form's draft, as data: what the person typed, turned into the one request the
 * daemon accepts, with the first reason it cannot be sent yet. Pure.
 *
 * The secret rule is the PROTOCOL's (`mcpServerRefusal`), not a copy of it: the form says a raw key is
 * refused as the person types, and the daemon refuses the same request if anything else sends it.
 */

import { splitCommandLine } from '../fleet/components/component-model.ts';
import {
  mcpServerRefusal,
  type SessionMcpPreviewRequest,
  type SessionMcpScope,
  SessionMcpNameSchema,
  type SessionMcpServer,
} from '@ferretry/protocol';

export type McpTransport = 'command' | 'url';

export interface McpDraft {
  readonly scope: SessionMcpScope;
  readonly transport: McpTransport;
  readonly name: string;
  /** The whole command line, as typed: `npx -y @sentry/mcp-server`. */
  readonly command: string;
  readonly url: string;
  /** One `NAME=value` per line. */
  readonly env: string;
  /** Login scope, URL only: sign in through Ferretry. */
  readonly oauth: boolean;
}

export const EMPTY_MCP_DRAFT: McpDraft = {
  scope: 'project',
  transport: 'command',
  name: '',
  command: '',
  url: '',
  env: '',
  oauth: false,
};

/** The environment lines as a record, or the first line that is not `NAME=value`. */
export const parseEnvLines = (text: string): { readonly env: Record<string, string> } | { readonly error: string } => {
  const env: Record<string, string> = {};
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) return { error: `Line ${index + 1}: use NAME=value, with an upper-case NAME.` };
    env[match[1] as string] = (match[2] as string).trim();
  }
  return { env };
};

export type DraftResult =
  | { readonly kind: 'ready'; readonly request: SessionMcpPreviewRequest }
  /** Not sendable yet. `reason` is shown only when it is the person's mistake, not an empty field. */
  | { readonly kind: 'incomplete'; readonly reason: string | null };

/** The request this draft would send, or why it cannot be sent. */
export const draftRequest = (draft: McpDraft): DraftResult => {
  const name = draft.name.trim();
  if (name === '') return { kind: 'incomplete', reason: null };
  if (!SessionMcpNameSchema.safeParse(name).success)
    return { kind: 'incomplete', reason: 'Name: use letters, digits, - and _, starting with a letter or digit.' };
  let server: SessionMcpServer;
  if (draft.transport === 'url') {
    const url = draft.url.trim();
    if (url === '') return { kind: 'incomplete', reason: null };
    if (!/^https?:\/\/\S+$/u.test(url))
      return { kind: 'incomplete', reason: 'URL: use an http:// or https:// address.' };
    server = { transport: 'url', url, oauth: draft.scope === 'login' && draft.oauth };
  } else {
    const [command, ...args] = splitCommandLine(draft.command);
    if (command === undefined) return { kind: 'incomplete', reason: null };
    const parsed = parseEnvLines(draft.env);
    if ('error' in parsed) return { kind: 'incomplete', reason: parsed.error };
    server = { transport: 'command', command, args, env: parsed.env };
  }
  const refusal = mcpServerRefusal(draft.scope, server);
  if (refusal !== null) return { kind: 'incomplete', reason: refusal };
  return { kind: 'ready', request: { name, server } };
};
