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

/** The name the words use until Ferrets has answered with the real one. */
export const FALLBACK_FERRET_NAME = 'This ferret';

/** A name as it reads inside a sentence: the placeholder loses its capital, a real name keeps its own. */
const inSentence = (name: string): string => (name === FALLBACK_FERRET_NAME ? 'this ferret' : name);

/** A reason as a sentence ends: the daemon's words, with a full stop when they bring none. */
const closed = (reason: string): string => (/[.!?]$/u.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`);

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
      sentence: `${name} reloads at its next idle moment (${queued.detail?.trim() || QUEUED_WHY[queued.reason]}).`,
    };
  const skipped = result.skipped.find(row => row.id === ferretId);
  if (skipped !== undefined)
    return { kind: 'failed', sentence: `${name} was not reloaded: it ${SKIPPED_WHY[skipped.reason]}.` };
  const failed = result.failed.find(row => row.id === ferretId);
  if (failed !== undefined)
    return { kind: 'failed', sentence: `${name} could not be reloaded: ${closed(failed.reason)}` };
  return { kind: 'failed', sentence: `Ferretry did not say whether ${inSentence(name)} reloaded.` };
}

/** A ferret as the "other ferrets" choice needs it: who it is, the runtime it runs as, and whether it is alive. */
interface OtherCandidate {
  readonly id: string;
  readonly name: string;
  readonly runtime?: string | undefined;
  readonly state: 'starting' | 'working' | 'idle' | 'stopped';
}

/**
 * The ferrets a login-scope add also reaches that are alive now: the same runtime the server was written to, not this
 * ferret, and starting, working or idle (a stopped one picks the server up when it next starts, so there is nothing to
 * reload).
 */
export function otherLiveFerrets<Ferret extends OtherCandidate>(
  runtime: string,
  ferretId: string,
  ferrets: readonly Ferret[],
): readonly Ferret[] {
  return ferrets.filter(ferret => ferret.runtime === runtime && ferret.id !== ferretId && ferret.state !== 'stopped');
}

const SKIPPED_SHORT = {
  'not-running': 'not running',
  'not-found': 'not found',
  'not-outdated': 'already up to date',
} as const;

/** What a reload of several ferrets did, in words: one clause per kind that happened, and whether ALL of them restarted. */
export interface OthersOutcome {
  readonly sentence: string;
  readonly allRestarted: boolean;
}

/**
 * Reads Ferrets' answer for the OTHER ferrets as a count per outcome, never claiming more than `restarted` holds:
 * a ferret the answer names in none of the four lists is counted as not reported.
 */
export function othersOutcome(result: RestartResult, ids: readonly string[]): OthersOutcome {
  const among = <Row extends { readonly id: string }>(rows: readonly Row[]): readonly Row[] =>
    rows.filter(row => ids.includes(row.id));
  const restarted = among(result.restarted);
  const queued = among(result.queued);
  const skipped = among(result.skipped);
  const failed = among(result.failed);
  const reported = restarted.length + queued.length + skipped.length + failed.length;
  const unreported = Math.max(0, ids.length - reported);
  const clauses: string[] = [];
  if (restarted.length > 0) clauses.push(`${restarted.length} reloaded`);
  if (queued.length > 0)
    clauses.push(`${queued.length} ${queued.length === 1 ? 'waits for its' : 'wait for their'} next idle moment`);
  if (skipped.length > 0)
    clauses.push(
      `${skipped.length} not reloaded (${[...new Set(skipped.map(row => SKIPPED_SHORT[row.reason]))].join(', ')})`,
    );
  if (failed.length > 0)
    clauses.push(
      `${failed.length} could not be reloaded: ${failed.map(row => `${row.name ?? row.id}: ${row.reason}`).join('; ')}`,
    );
  if (unreported > 0) clauses.push(`Ferretry did not say whether ${unreported} reloaded`);
  return {
    sentence: `${closed(`Other ferrets: ${clauses.join(', ')}`)}`,
    allRestarted: restarted.length === ids.length,
  };
}

/** What a Reload press settled: whether the dialog may close, whether the person can try again, and what to say. */
export interface ReloadReport {
  readonly closes: boolean;
  /** This ferret did not reload and nothing is waiting for it: the Reload button stays. */
  readonly retry: boolean;
  readonly sentence: string;
}

/**
 * This ferret's outcome and the others' together. The dialog closes only when every ferret asked for restarted; a
 * reload that is waiting or partly done says so and stays.
 */
export function reloadReport(
  result: RestartResult,
  ferretId: string,
  name: string,
  otherIds: readonly string[],
): ReloadReport {
  const own = reloadOutcome(result, ferretId, name);
  const others = otherIds.length === 0 ? null : othersOutcome(result, otherIds);
  if (own.kind === 'restarted' && (others === null || others.allRestarted))
    return { closes: true, retry: false, sentence: '' };
  const ownSentence = own.kind === 'restarted' ? `${name} reloaded.` : own.sentence;
  return {
    closes: false,
    retry: own.kind === 'failed',
    sentence: others === null ? ownSentence : `${ownSentence} ${others.sentence}`,
  };
}

/** The folder a project's `.mcp.json` sits in, by name (`/work/ferretry/.mcp.json` → `ferretry`); null when the path names none. */
export function projectFolderName(mcpJsonPath: string): string | null {
  const parts = mcpJsonPath.split('/').filter(part => part !== '');
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
}
