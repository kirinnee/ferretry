/**
 * The Add MCP server form's draft, as data: what the person typed, turned into the one request the daemon accepts, with
 * the first reason it cannot be sent yet. Pure.
 *
 * The secret rule is the CONTRACT's (`mcpServerRefusal`), not a copy of it: the form says a raw key is refused as the
 * person types, and the daemon refuses the same request if anything else sends it.
 */
import type { RestartResult } from '@ferretry/core-ferrets/contract';
import {
  mcpServerRefusal,
  SessionMcpNameSchema,
  type SessionMcpPreviewRequest,
  type SessionMcpScope,
  type SessionMcpServer,
} from '../../contract/index.ts';

type McpTransport = 'command' | 'url';

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

/** Splits a command line into words, honouring double and single quotes and backslashes. */
export function splitCommandLine(line: string): readonly string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const [index, char] of [...line].entries()) {
    const last = index === line.length - 1;
    if (escaped) {
      word += char;
      escaped = false;
    } else if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && !last) escaped = true;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && !last) {
      escaped = true;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** The environment lines as a record, or the first line that is not `NAME=value`. */
export const parseEnvLines = (text: string): { readonly env: Record<string, string> } | { readonly error: string } => {
  const env: Record<string, string> = {};
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) return { error: `Line ${index + 1}: use NAME=value, with an upper-case NAME.` };
    env[match[1] as string] = (match[2] as string).trim();
  }
  return { env };
};

type DraftResult =
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

/** What a reload did for the one ferret it was asked for. Only `restarted` is a reload that happened. */
export type ReloadOutcome =
  | { readonly kind: 'restarted' }
  | { readonly kind: 'queued'; readonly sentence: string }
  | { readonly kind: 'failed'; readonly sentence: string };

const QUEUED_WHY = {
  'mid-turn': 'it is working on a turn',
  'in-flight': 'it has work a restart would lose',
  'own-session': 'its own turn has to end first',
} as const;

const SKIPPED_WHY = {
  'not-running': 'is not running',
  'not-found': 'was not found',
  'not-outdated': 'is already up to date',
} as const;

/**
 * Reads Ferrets' answer for ONE ferret, in words, and never as success unless it restarted: queued is "reloads at its
 * next idle moment", skipped and failed are failures, and an answer that names the ferret in none of the four lists is a
 * failure too (a restart nobody reported is not a restart that happened).
 */
export function reloadOutcome(result: RestartResult, ferretId: string, name: string): ReloadOutcome {
  if (result.restarted.some(row => row.id === ferretId)) return { kind: 'restarted' };
  const queued = result.queued.find(row => row.id === ferretId);
  if (queued !== undefined)
    return {
      kind: 'queued',
      sentence: `${name} reloads at its next idle moment (${queued.detail ?? QUEUED_WHY[queued.reason]}).`,
    };
  const skipped = result.skipped.find(row => row.id === ferretId);
  if (skipped !== undefined)
    return { kind: 'failed', sentence: `${name} was not reloaded: it ${SKIPPED_WHY[skipped.reason]}.` };
  const failed = result.failed.find(row => row.id === ferretId);
  if (failed !== undefined) return { kind: 'failed', sentence: `${name} could not be reloaded: ${failed.reason}` };
  return { kind: 'failed', sentence: `Ferretry did not say whether ${name} reloaded.` };
}

/** The folder a project's `.mcp.json` sits in, by name (`/work/ferretry/.mcp.json` → `ferretry`); null when the path names none. */
export function projectFolderName(mcpJsonPath: string): string | null {
  const parts = mcpJsonPath.split('/').filter(part => part !== '');
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
}
