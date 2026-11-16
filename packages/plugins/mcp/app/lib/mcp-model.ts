/**
 * How an MCP server is described to a person, wherever it is listed: its scope label, where it stands, and what can be
 * done about it. Pure. The ferret's MCP panel and Settings › MCP servers both speak through this, so a server reads the
 * same in both places.
 */

import { chipsFor, type ContextChip, matchesQuery, type PlainFailure } from '@ferretry/app/ui';
import type { McpCheckResult, McpInventoryServer, McpScope } from '../../contract/index.ts';
import { mcpSignInStatus } from './sign-in-model.ts';

// ── Scope ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The four words a person sees. A Ferretry component and Ferretry's own tools server are both "Ferretry":
 * Ferretry put them there. "User" is the runtime's own config, written by something else.
 */
export const MCP_SCOPE_LABEL: Readonly<Record<McpScope, string>> = {
  ferretry: 'Ferretry',
  component: 'Ferretry',
  user: 'User',
  project: 'Project',
  local: 'Local',
};

export const MCP_SCOPE_TITLE: Readonly<Record<McpScope, string>> = {
  ferretry: 'Ferretry’s own tools server, started with every ferret',
  component: 'A Ferretry component in this runtime’s profile (Settings › Components)',
  user: 'Written into this runtime’s own config by something other than Ferretry',
  project: 'The repo’s own file (.mcp.json, or .codex/config.toml), shared with everyone on the repo',
  local: 'This runtime’s own setting for this project only (Claude’s local scope)',
};

// ── MCP status ───────────────────────────────────────────────────────────────────────────────────

export type McpTone = 'ok' | 'warn' | 'err' | 'none';

export interface McpRowStatus {
  /** A few words: "Connected · 4 tools", "Needs sign-in", "Not approved in this project". */
  readonly label: string;
  readonly tone: McpTone;
  /** One more sentence, when there is something to explain. */
  readonly detail?: string;
  /** Whether Check is offered. */
  readonly canCheck: boolean;
  /** Whether Sign in is offered, and with which words. */
  readonly signIn?: 'Sign in' | 'Sign in again';
  /** Why there is no Sign in for a server that asks for one. */
  readonly signInUnsupported?: string;
  /** Whether the row counts under "Needs attention". */
  readonly attention: boolean;
}

const tools = (count: number): string => (count === 1 ? '1 tool' : `${count} tools`);

const approvalOf = (server: McpInventoryServer): 'approved' | 'pending' | 'disabled' | undefined => {
  if (server.scope !== 'project') return undefined;
  const approvals = server.runtimes.map(use => use.approval);
  if (approvals.includes('approved')) return 'approved';
  if (approvals.includes('pending') || approvals.length === 0) return 'pending';
  return 'disabled';
};

const NOT_APPROVED =
  'The ferret asks before it starts a server from the repo. Answer its “New MCP server found” question to use it.';
const DISABLED = 'Somebody turned this server off for this project, so the ferret never starts it.';

/**
 * Where one server stands: the last check when there is one (it is the freshest fact), else what the
 * listing knows — its approval, its sign-in, whether another scope overrides it.
 */
export function mcpRowStatus(
  server: McpInventoryServer,
  check: McpCheckResult | undefined,
  nowMs: number,
): McpRowStatus {
  if (server.scope === 'ferretry')
    return { label: 'Built in', tone: 'ok', detail: 'Started with every ferret.', canCheck: false, attention: false };

  const approval = approvalOf(server);
  const unsupported = server.signIn?.unsupported;
  const signedIn = mcpSignInStatus(server.connection, nowMs);
  const again = signedIn.signedInBefore ? ('Sign in again' as const) : ('Sign in' as const);
  const offer = (wanted: boolean): Pick<McpRowStatus, 'signIn' | 'signInUnsupported'> =>
    !wanted || server.signIn === undefined
      ? {}
      : unsupported === undefined
        ? { signIn: again }
        : { signInUnsupported: unsupported };

  if (server.shadowedBy !== undefined)
    return {
      label: `Overridden by ${MCP_SCOPE_LABEL[server.shadowedBy]}`,
      tone: 'none',
      detail: `A ${MCP_SCOPE_LABEL[server.shadowedBy]} server with the same name is the one this ferret uses.`,
      canCheck: true,
      attention: false,
    };

  if (check !== undefined) {
    const message = check.message === undefined ? {} : { detail: check.message };
    switch (check.outcome) {
      case 'connected':
        return {
          label: `Connected · ${tools(check.toolCount ?? 0)}`,
          tone: approval === undefined || approval === 'approved' ? 'ok' : 'warn',
          ...message,
          canCheck: true,
          attention: approval === 'pending',
        };
      case 'needs-sign-in':
        return { label: 'Needs sign-in', tone: 'warn', ...message, canCheck: true, ...offer(true), attention: true };
      case 'not-approved':
        return {
          label: approval === 'disabled' ? 'Disabled in this project' : 'Not approved in this project',
          tone: 'warn',
          detail: check.message ?? (approval === 'disabled' ? DISABLED : NOT_APPROVED),
          canCheck: true,
          attention: true,
        };
      case 'error':
        return { label: 'Couldn’t connect', tone: 'err', ...message, canCheck: true, attention: true };
    }
  }

  if (approval === 'disabled')
    return { label: 'Disabled in this project', tone: 'none', detail: DISABLED, canCheck: true, attention: false };
  if (approval === 'pending')
    return {
      label: 'Not approved in this project',
      tone: 'warn',
      detail: NOT_APPROVED,
      canCheck: true,
      attention: true,
    };

  if (server.connection !== undefined) {
    const needs = signedIn.tone === 'warn';
    return {
      label: signedIn.title,
      tone: needs ? 'warn' : signedIn.tone === 'ok' ? 'ok' : 'none',
      ...(signedIn.detail === undefined ? {} : { detail: signedIn.detail }),
      canCheck: true,
      ...offer(needs),
      attention: needs,
    };
  }
  if (server.signIn?.required === true)
    return { label: 'Needs sign-in', tone: 'warn', canCheck: true, ...offer(true), attention: true };
  return { label: 'Not checked yet', tone: 'none', canCheck: true, attention: false };
}

/** One server's last Check, as the row and the chips read it. */
export type McpCheckState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'done'; readonly result: McpCheckResult }
  | { readonly kind: 'failed'; readonly failure: PlainFailure };

/** The finished check's answer for one server, when there is one. */
export const checkResultOf = (checks: ReadonlyMap<string, McpCheckState>, id: string): McpCheckResult | undefined => {
  const state = checks.get(id);
  return state?.kind === 'done' ? state.result : undefined;
};

/** What a check found besides its status line: the tool names, when it connected. */
export const checkedTools = (check: McpCheckResult | undefined): readonly string[] =>
  check?.outcome === 'connected' ? (check.tools ?? []) : [];

export const MCP_TRANSPORT_LABEL: Readonly<Record<McpInventoryServer['transport'], string>> = {
  stdio: 'command',
  http: 'HTTP',
  sse: 'SSE',
};

/** Ferretry first, then Local, Project, User — the order the harness weighs them — then by name. */
const SCOPE_ORDER: readonly McpScope[] = ['ferretry', 'local', 'project', 'user', 'component'];

export const sortedMcpServers = (servers: readonly McpInventoryServer[]): McpInventoryServer[] =>
  [...servers].sort(
    (left, right) =>
      SCOPE_ORDER.indexOf(left.scope) - SCOPE_ORDER.indexOf(right.scope) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  );

// ── The panel's filter: search and the Needs attention chip ──────────────────────────────────────

export type McpChip = 'all' | 'attention';

const MCP_CHIPS: readonly McpChip[] = ['all', 'attention'];
const MCP_CHIP_LABEL: Readonly<Record<McpChip, string>> = { all: 'All', attention: 'Needs attention' };

const mcpMatches = (server: McpInventoryServer, query: string): boolean =>
  matchesQuery(query, server.name, MCP_SCOPE_LABEL[server.scope], server.target);

const needsAttention = (
  server: McpInventoryServer,
  checks: ReadonlyMap<string, McpCheckState>,
  nowMs: number,
): boolean => mcpRowStatus(server, checkResultOf(checks, server.id), nowMs).attention;

/** The chips, counted under the current search. A Check's answer moves a server in or out of attention. */
export const mcpChips = (
  servers: readonly McpInventoryServer[],
  query: string,
  checks: ReadonlyMap<string, McpCheckState>,
  nowMs: number,
): ContextChip<McpChip>[] =>
  chipsFor(
    MCP_CHIPS,
    MCP_CHIP_LABEL,
    servers.filter(server => mcpMatches(server, query)),
    (server, chip) => chip === 'all' || needsAttention(server, checks, nowMs),
  );

export const visibleMcpServers = (
  servers: readonly McpInventoryServer[],
  query: string,
  chip: McpChip,
  checks: ReadonlyMap<string, McpCheckState>,
  nowMs: number,
): McpInventoryServer[] =>
  servers.filter(server => mcpMatches(server, query) && (chip === 'all' || needsAttention(server, checks, nowMs)));

export const MCP_SEARCH_LABEL = 'Search MCP servers';
export const MCP_EMPTY = 'This ferret has no MCP servers.';
