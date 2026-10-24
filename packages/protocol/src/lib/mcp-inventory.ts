/**
 * Every MCP server a ferret actually sees, from every scope, and what checking one found
 * (docs/mcp-scopes.md).
 *
 * A ferret's harness reads MCP servers from more places than Ferretry writes:
 *
 * | Scope       | Claude Code                                        | Codex                                           |
 * | ----------- | -------------------------------------------------- | ----------------------------------------------- |
 * | `ferretry`  | Ferretry's own tools server (`--mcp-config`)       | `mcp_servers.ferretry` (launch override)        |
 * | `component` | a fleet MCP component, in the home's `mcpServers`  | a fleet MCP component, in the home's config     |
 * | `user`      | anything else in the home's `.claude.json`         | anything else in the home's `config.toml`       |
 * | `project`   | the repo's `.mcp.json`, once approved              | the repo's `.codex/config.toml`, once trusted   |
 * | `local`     | the home's `projects[<root>].mcpServers`           | —                                               |
 *
 * "The home" is the RUNTIME's config directory under the fleet, never the person's own `~/.claude`.
 *
 * NO SECRET VALUE CROSSES THIS CONTRACT. A server's `target` is its address without a query, or the
 * program it runs without its arguments or environment; a check answers tool NAMES and a sentence.
 */
import { z } from 'zod';
import { McpOAuthConnectionSchema } from './mcp-oauth.ts';

export const McpScopeSchema = z.enum(['ferretry', 'component', 'user', 'project', 'local']);
export type McpScope = z.infer<typeof McpScopeSchema>;

/** Highest first: the scope whose same-named server a harness uses (Claude: local › project › user). */
export const MCP_SCOPE_PRECEDENCE: readonly McpScope[] = ['ferretry', 'local', 'project', 'user', 'component'];

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/**
 * Whether a project server may run for one runtime: approved (Claude's `enabledMcpjsonServers`, or a
 * trusted Codex project), pending (nobody has answered the harness's question yet — it never
 * connects), or disabled (somebody said no, or `enabled = false`).
 */
export const McpApprovalSchema = z.enum(['approved', 'pending', 'disabled']);
export type McpApproval = z.infer<typeof McpApprovalSchema>;

export const McpHarnessSchema = z.enum(['claude', 'codex']);

/** One runtime that sees a server, and — for a project server — whether that runtime may run it. */
export const McpRuntimeUseSchema = z.strictObject({
  runtime: z.string().min(1),
  approval: McpApprovalSchema.optional(),
});
export type McpRuntimeUse = z.infer<typeof McpRuntimeUseSchema>;

/** How Ferretry signs in to a server: the subject its sign-in is filed under, and whether it must. */
export const McpSignInTargetSchema = z.strictObject({
  /** What `/v1/fleet/mcp-auth/:component` takes: a component name, or a project server's subject. */
  subject: z.string().min(1).max(256),
  /** A component marked `auth: oauth` must; a project server may (a check says whether it asks). */
  required: z.boolean(),
  /** Why Ferretry cannot deliver a sign-in to this harness here, when it cannot. */
  unsupported: z.string().max(512).optional(),
});
export type McpSignInTarget = z.infer<typeof McpSignInTargetSchema>;

export const McpInventoryServerSchema = z.strictObject({
  /** Stable for the same declaration: what a check names. */
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  scope: McpScopeSchema,
  harness: McpHarnessSchema,
  transport: McpTransportSchema,
  /** The address without its query, or the program without its arguments. */
  target: z.string().max(2048),
  /** The file that declares it, absolute on the machine; absent for Ferretry's own tools server. */
  source: z.string().max(4096).optional(),
  /** The project a `project` or `local` server belongs to. */
  project: z.strictObject({ root: z.string().min(1), name: z.string().min(1).optional() }).optional(),
  /** Which runtimes see it, each with its approval when it is a project server. */
  runtimes: z.array(McpRuntimeUseSchema).readonly(),
  /** A higher-precedence scope declares the same name, so the harness uses that one instead. */
  shadowedBy: McpScopeSchema.optional(),
  /** Absent for a server Ferretry cannot sign in to (a command, or Ferretry's own). */
  signIn: McpSignInTargetSchema.optional(),
  connection: McpOAuthConnectionSchema.optional(),
});
export type McpInventoryServer = z.infer<typeof McpInventoryServerSchema>;

/** A file that could not be read as the harness reads it, said rather than skipped. */
export const McpInventoryProblemSchema = z.strictObject({
  source: z.string().min(1),
  message: z.string().min(1).max(1024),
});
export type McpInventoryProblem = z.infer<typeof McpInventoryProblemSchema>;

export const McpInventorySchema = z.strictObject({
  servers: z.array(McpInventoryServerSchema).readonly(),
  problems: z.array(McpInventoryProblemSchema).readonly(),
});
export type McpInventory = z.infer<typeof McpInventorySchema>;

// ── Check ────────────────────────────────────────────────────────────────────────────────────────

/** Check one server from an inventory. With `sessionId`, as that ferret would reach it. */
export const McpCheckRequestSchema = z.strictObject({
  id: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256).optional(),
});
export type McpCheckRequest = z.infer<typeof McpCheckRequestSchema>;

/**
 * - `connected`: it answered `initialize` and `tools/list`.
 * - `needs-sign-in`: it answered 401.
 * - `not-approved`: a project command nobody approved; Ferretry does not run it either.
 * - `error`: anything else, said in `message`.
 */
export const McpCheckOutcomeSchema = z.enum(['connected', 'needs-sign-in', 'not-approved', 'error']);
export type McpCheckOutcome = z.infer<typeof McpCheckOutcomeSchema>;

/** At most this many tool names come back; `toolCount` is the whole count. */
export const MCP_CHECK_TOOL_NAMES = 100;

/** How long a check waits for a server, end to end. */
export const MCP_CHECK_TIMEOUT_MS = 10_000;

export const McpCheckResultSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  transport: McpTransportSchema,
  outcome: McpCheckOutcomeSchema,
  /** What the server calls itself, from `initialize`. */
  serverName: z.string().max(256).optional(),
  toolCount: z.number().int().nonnegative().optional(),
  tools: z.array(z.string().max(256)).max(MCP_CHECK_TOOL_NAMES).readonly().optional(),
  /** The failure, in words that quote no token. */
  message: z.string().max(1024).optional(),
  elapsedMs: z.number().int().nonnegative(),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type McpCheckResult = z.infer<typeof McpCheckResultSchema>;

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

export const MCP_INVENTORY_PATH = '/v1/mcp';
export const MCP_CHECK_PATH = '/v1/mcp/check';

/**
 * The separator in a project server's sign-in subject. A fleet component name may never contain it
 * (`SafeNameSchema` refuses `..`), so a subject is never mistaken for a component, and it needs no
 * escaping in a URL path segment.
 */
export const MCP_PROJECT_SUBJECT_SEPARATOR = '..';

/** The short digest naming a project in a subject: lower-case hex. */
const PROJECT_KEY = /^[0-9a-f]{8,64}$/u;

/**
 * The subject a project server's sign-in is filed under: its name, then the project it belongs to.
 * `projectKey` is the daemon's short digest of the project's root, so every worktree of one project
 * shares the sign-in, and two projects with a same-named server do not.
 */
export const mcpProjectSubject = (name: string, projectKey: string): string =>
  `${name}${MCP_PROJECT_SUBJECT_SEPARATOR}${projectKey}`;

/** The name and project key in a project subject, or null for anything else (a component name). */
export const parseMcpProjectSubject = (
  subject: string,
): { readonly name: string; readonly projectKey: string } | null => {
  const at = subject.lastIndexOf(MCP_PROJECT_SUBJECT_SEPARATOR);
  if (at <= 0) return null;
  const projectKey = subject.slice(at + MCP_PROJECT_SUBJECT_SEPARATOR.length);
  return PROJECT_KEY.test(projectKey) ? { name: subject.slice(0, at), projectKey } : null;
};
