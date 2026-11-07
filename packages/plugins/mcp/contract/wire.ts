/**
 * MCP's wire schemas, copied from today's `@ferretry/protocol` (`mcp-inventory.ts`, `mcp-oauth.ts`, `session-mcp.ts`)
 * and `@ferretry/fleet` (`McpComponentSchema`). Strict objects throughout.
 *
 * Copied: every schema and constant of the three protocol files. Stripped (port work, `daemon/lib`): the pure helpers
 * `sha256Hex`, `mcpOAuthServerKey`, `mcpOAuthSecretNames`, `isSignInSecretName`, `mcpOAuthRedirectPath`,
 * `mcpProjectSubject`, `parseMcpProjectSubject`, `mcpEnvRefusal`, `mcpServerRefusal` (the one rule both ends run:
 * the port copies it back next to the schemas it guards, G180).
 *
 * Inlined foreign pieces (so no contract imports another plugin's): `SecretNameSchema` (Vault), the harness key
 * (`claude` → `claude-code`, the plugin id), the env grammar and the secure-URL rule of the fleet's component schema.
 */
import { z } from 'zod';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';

// ─── foreign pieces, inlined ─────────────────────────────────────────────────────────────────────────────────────

/** Vault's secret name (today's `SecretNameSchema`; 64 is today's `MAX_SECRET_NAME_LENGTH`). */
export const SecretNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u, 'a secret name is uppercase letters, digits and underscores');

const NonEmptyString = z.string().min(1);

// ─── OAuth sign-in (docs/mcp-oauth.md) ───────────────────────────────────────────────────────────────────────────

/** The page every callback lives under on whatever origin serves the app. */
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/mcp-callback';
/** The loopback (paste) redirect: `http://localhost:<port>/callback`. */
export const MCP_OAUTH_LOOPBACK_HOST = 'localhost';
export const MCP_OAUTH_LOOPBACK_PATH = '/callback';

export const McpOAuthStartRequestSchema = z.strictObject({ redirectUri: z.string().min(1).max(512).optional() });
export type McpOAuthStartRequest = z.infer<typeof McpOAuthStartRequestSchema>;

/** The address the provider sent the browser to. It carries a code, so it travels only in a POST body. */
export const McpOAuthCompleteRequestSchema = z.strictObject({ callback: z.string().min(1).max(8192) });
export type McpOAuthCompleteRequest = z.infer<typeof McpOAuthCompleteRequestSchema>;

export const McpOAuthRedirectModeSchema = z.enum(['pwa', 'paste']);
export type McpOAuthRedirectMode = z.infer<typeof McpOAuthRedirectModeSchema>;

export const McpOAuthFlowSchema = z.strictObject({
  flowId: z.string().min(1).max(128),
  component: z.string().min(1).max(256),
  /** The provider's page to open. Holds the state and the PKCE challenge, never the verifier. */
  authorizeUrl: z.url(),
  mode: McpOAuthRedirectModeSchema,
  redirectUri: z.url(),
  issuer: z.string().min(1).max(512),
  expiresAt: z.iso.datetime({ offset: true }),
  note: z.string().max(512).optional(),
});
export type McpOAuthFlow = z.infer<typeof McpOAuthFlowSchema>;

export const McpOAuthStateSchema = z.enum(['signed-in', 'expired', 'needs-sign-in']);
export type McpOAuthState = z.infer<typeof McpOAuthStateSchema>;

/** No field here can carry a token in either direction (S174). `secrets` lists NAMES only. */
export const McpOAuthConnectionSchema = z.strictObject({
  component: z.string().min(1).max(256),
  state: McpOAuthStateSchema,
  issuer: z.string().min(1).max(512).optional(),
  signedInAt: z.iso.datetime({ offset: true }).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  renewable: z.boolean(),
  scope: z.string().max(2048).optional(),
  secrets: z.array(SecretNameSchema).readonly(),
});
export type McpOAuthConnection = z.infer<typeof McpOAuthConnectionSchema>;

export const McpOAuthConnectionListSchema = z.strictObject({
  connections: z.array(McpOAuthConnectionSchema).readonly(),
});
export type McpOAuthConnectionList = z.infer<typeof McpOAuthConnectionListSchema>;

export const McpOAuthCompletionSchema = z.strictObject({
  component: z.string().min(1).max(256),
  connection: McpOAuthConnectionSchema,
});
export type McpOAuthCompletion = z.infer<typeof McpOAuthCompletionSchema>;

export const McpOAuthSignedOutSchema = z.strictObject({
  component: z.string().min(1).max(256),
  removed: z.boolean(),
  revoked: z.boolean(),
});
export type McpOAuthSignedOut = z.infer<typeof McpOAuthSignedOutSchema>;

export const McpOAuthFlowCancelledSchema = z.strictObject({
  flowId: z.string().min(1).max(128),
  cancelled: z.boolean(),
});
export type McpOAuthFlowCancelled = z.infer<typeof McpOAuthFlowCancelledSchema>;

// ─── inventory and check (docs/mcp-scopes.md) ────────────────────────────────────────────────────────────────────

export const McpScopeSchema = z.enum(['ferretry', 'component', 'user', 'project', 'local']);
export type McpScope = z.infer<typeof McpScopeSchema>;

/** Highest first: the scope whose same-named server a harness uses (Claude: local › project › user). */
export const MCP_SCOPE_PRECEDENCE: readonly McpScope[] = ['ferretry', 'local', 'project', 'user', 'component'];

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpApprovalSchema = z.enum(['approved', 'pending', 'disabled']);
export type McpApproval = z.infer<typeof McpApprovalSchema>;

export const McpRuntimeUseSchema = z.strictObject({
  runtime: z.string().min(1),
  approval: McpApprovalSchema.optional(),
});
export type McpRuntimeUse = z.infer<typeof McpRuntimeUseSchema>;

export const McpSignInTargetSchema = z.strictObject({
  /** What `/v1/mcp/auth/:component` takes: a component name, or a project server's subject. */
  subject: z.string().min(1).max(256),
  required: z.boolean(),
  unsupported: z.string().max(512).optional(),
});
export type McpSignInTarget = z.infer<typeof McpSignInTargetSchema>;

/** NO SECRET VALUE CROSSES THIS CONTRACT: `target` is an address without its query, or a program without its arguments. */
export const McpInventoryServerSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  scope: McpScopeSchema,
  harness: HarnessKeySchema,
  transport: McpTransportSchema,
  target: z.string().max(2048),
  source: z.string().max(4096).optional(),
  project: z.strictObject({ root: z.string().min(1), name: z.string().min(1).optional() }).optional(),
  runtimes: z.array(McpRuntimeUseSchema).readonly(),
  shadowedBy: McpScopeSchema.optional(),
  signIn: McpSignInTargetSchema.optional(),
  connection: McpOAuthConnectionSchema.optional(),
});
export type McpInventoryServer = z.infer<typeof McpInventoryServerSchema>;

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

/** `POST /v1/mcp/check`: with `sessionId`, as that ferret would reach it (the field keeps today's name; it holds a ferret id). */
export const McpCheckRequestSchema = z.strictObject({
  id: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256).optional(),
});
export type McpCheckRequest = z.infer<typeof McpCheckRequestSchema>;

export const McpCheckOutcomeSchema = z.enum(['connected', 'needs-sign-in', 'not-approved', 'error']);
export type McpCheckOutcome = z.infer<typeof McpCheckOutcomeSchema>;

export const MCP_CHECK_TOOL_NAMES = 100;
export const MCP_CHECK_TIMEOUT_MS = 10_000;

export const McpCheckResultSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  transport: McpTransportSchema,
  outcome: McpCheckOutcomeSchema,
  serverName: z.string().max(256).optional(),
  toolCount: z.number().int().nonnegative().optional(),
  tools: z.array(z.string().max(256)).max(MCP_CHECK_TOOL_NAMES).readonly().optional(),
  message: z.string().max(1024).optional(),
  elapsedMs: z.number().int().nonnegative(),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type McpCheckResult = z.infer<typeof McpCheckResultSchema>;

/** The separator in a project server's sign-in subject; a component name may never contain it. */
export const MCP_PROJECT_SUBJECT_SEPARATOR = '..';

// ─── adding a server for one ferret (docs/mcp-scopes.md) ─────────────────────────────────────────────────────────

/** The file a project-scope server is written to, at the root of the ferret's checkout. */
export const SESSION_MCP_PROJECT_FILE = '.mcp.json';

export const SessionMcpScopeSchema = z.enum(['project', 'login']);
export type SessionMcpScope = z.infer<typeof SessionMcpScopeSchema>;

export const SessionMcpNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u,
    'use letters, digits, - and _ (at most 64), starting with a letter or digit',
  );

export const SessionMcpEnvNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/u, 'use NAME=value, with an upper-case NAME');
export const SessionMcpEnvSchema = z.record(SessionMcpEnvNameSchema, z.string().max(4096));
export type SessionMcpEnv = z.infer<typeof SessionMcpEnvSchema>;

const HTTP_URL = /^https?:\/\/[^\s]+$/u;

export const SessionMcpServerSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('command'),
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64),
    env: SessionMcpEnvSchema,
  }),
  z.strictObject({
    transport: z.literal('url'),
    url: z.string().max(2048).regex(HTTP_URL, 'use an http:// or https:// address'),
    /** Login scope only: the server signs in through Ferretry's MCP OAuth. */
    oauth: z.boolean(),
  }),
]);
export type SessionMcpServer = z.infer<typeof SessionMcpServerSchema>;

/** The SCOPE IS THE PATH, not a field: a route declares exactly one capability (G176). */
export const SessionMcpPreviewRequestSchema = z.strictObject({
  name: SessionMcpNameSchema,
  server: SessionMcpServerSchema,
});
export type SessionMcpPreviewRequest = z.infer<typeof SessionMcpPreviewRequestSchema>;

export const SessionMcpEtagSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** A project add carries the etag its preview answered with (compare-and-swap, G177). */
export const SessionMcpAddRequestSchema = SessionMcpPreviewRequestSchema.extend({
  etag: SessionMcpEtagSchema.nullable().optional(),
});
export type SessionMcpAddRequest = z.infer<typeof SessionMcpAddRequestSchema>;

export const SessionMcpDiffLineSchema = z.strictObject({
  kind: z.enum(['context', 'add', 'remove']),
  text: z.string(),
});
export type SessionMcpDiffLine = z.infer<typeof SessionMcpDiffLineSchema>;

export const SessionMcpPreviewSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('project'),
    path: z.string().min(1),
    etag: SessionMcpEtagSchema.nullable(),
    replaces: z.boolean(),
    diff: z.array(SessionMcpDiffLineSchema),
  }),
  z.strictObject({
    scope: z.literal('login'),
    runtime: z.string().min(1),
    profile: z.string().min(1),
    replaces: z.boolean(),
    ferrets: z.number().int().nonnegative(),
  }),
]);
export type SessionMcpPreview = z.infer<typeof SessionMcpPreviewSchema>;

export const SessionMcpAddedSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('project'),
    name: SessionMcpNameSchema,
    path: z.string().min(1),
    etag: SessionMcpEtagSchema,
  }),
  z.strictObject({
    scope: z.literal('login'),
    name: SessionMcpNameSchema,
    runtime: z.string().min(1),
    profile: z.string().min(1),
  }),
]);
export type SessionMcpAdded = z.infer<typeof SessionMcpAddedSchema>;

export const SessionMcpProjectServerSchema = z.strictObject({
  name: z.string().min(1),
  transport: z.enum(['command', 'url']),
});

export const SessionMcpListingSchema = z.strictObject({
  project: z
    .strictObject({
      path: z.string().min(1),
      etag: SessionMcpEtagSchema.nullable(),
      servers: z.array(SessionMcpProjectServerSchema),
    })
    .nullable(),
  projectUnavailable: z.string().min(1).optional(),
});
export type SessionMcpListing = z.infer<typeof SessionMcpListingSchema>;

// ─── config: config/mcp/<name>.yaml (today's McpComponentSchema) ─────────────────────────────────────────────────

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Variables configuration may never set: Ferretry sets them (today's `RESERVED_ENV_NAMES`). */
export const RESERVED_ENV_NAMES = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
] as const;

/** A malformed `${secret:…}` is refused rather than exported verbatim; a raw secret is never a value (`${secret:NAME}` only). */
const MALFORMED_SECRET = /\$\{secret:(?![A-Z][A-Z0-9_]{0,63}\})[^}]*\}?/u;

export const McpEnvSchema = z.record(z.string(), z.string()).check(ctx => {
  for (const [name, value] of Object.entries(ctx.value)) {
    if (!POSIX_ENV_NAME.test(name))
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" must be a POSIX environment variable name`,
        input: name,
        path: [name],
      });
    else if ((RESERVED_ENV_NAMES as readonly string[]).includes(name))
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" is reserved: Ferretry sets it`,
        input: name,
        path: [name],
      });
    if (MALFORMED_SECRET.test(value))
      ctx.issues.push({
        code: 'custom',
        message:
          'not a secret reference: a secret name is uppercase letters, digits and underscores, as in ${secret:WORK_KEY}',
        input: value,
        path: [name],
      });
  }
});

/** A client registered by hand with the provider; its secret is a reference, never the value. */
export const McpOAuthClientSchema = z.strictObject({
  clientId: NonEmptyString.max(512),
  clientSecret: z
    .string()
    .regex(
      /^\$\{secret:[A-Z][A-Z0-9_]{0,63}\}$/u,
      'a client secret is written as a ${secret:NAME} reference to the secret store, never as the value',
    )
    .optional(),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
});

/** Where an item came from, as this machine VERIFIED it (a catalog install). Provenance only. */
export const InstalledFromSchema = z.strictObject({
  publisher: NonEmptyString,
  publisherName: NonEmptyString,
  catalogId: NonEmptyString,
  catalogName: NonEmptyString,
  itemId: NonEmptyString,
  kind: z.enum(['skill', 'mcp']),
  name: NonEmptyString,
  version: z.number().int().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

/** One MCP server: exactly one of `command` (a server to start) or `url` (a server to reach). */
export const McpItemSchema = z
  .strictObject({
    command: NonEmptyString.optional(),
    args: z.array(z.string()).optional(),
    env: McpEnvSchema.optional(),
    url: z.url().optional(),
    auth: z.literal('oauth').optional(),
    oauth: McpOAuthClientSchema.optional(),
    harness: HarnessKeySchema.optional(),
    clonedFrom: NonEmptyString.optional(),
    clonedFromDaemon: NonEmptyString.optional(),
    clonedFromKey: NonEmptyString.optional(),
    installedFrom: InstalledFromSchema.optional(),
  })
  .check(ctx => {
    const server = ctx.value;
    const issue = (message: string, path: string[]): void => {
      ctx.issues.push({ code: 'custom', message, input: server, path });
    };
    if ((server.command === undefined) === (server.url === undefined)) {
      issue('an MCP server needs exactly one of "command" (a server to start) or "url" (a server to reach)', []);
      return;
    }
    if (server.url !== undefined && (server.args !== undefined || server.env !== undefined))
      issue('"args" and "env" start a command: a server reached at a "url" takes neither', [
        server.args === undefined ? 'env' : 'args',
      ]);
    if (server.auth !== undefined && server.url === undefined)
      issue('"auth" signs in to a server reached at a "url": a server Ferretry starts has nothing to sign in to', [
        'auth',
      ]);
    if (server.oauth !== undefined && server.auth !== 'oauth')
      issue('"oauth" names the client a sign-in uses: it needs "auth: oauth" on a server reached at a "url"', [
        'oauth',
      ]);
    if (server.auth !== undefined && server.url !== undefined) {
      const parsed = new URL(server.url);
      if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))))
        issue('"auth" sends a token to this server, so its "url" must be https:// (plain http only on this machine)', [
          'url',
        ]);
    }
  });
export type McpItem = z.infer<typeof McpItemSchema>;

// ─── state: state/mcp/inventory.json ─────────────────────────────────────────────────────────────────────────────

/** The last inventory read, kept so the app paints at once. A cache of facts that are re-read; never a secret. */
export const McpInventoryFileSchema = z.strictObject({
  format: z.literal(1),
  readAt: z.iso.datetime({ offset: true }),
  inventory: McpInventorySchema,
});
export type McpInventoryFile = z.infer<typeof McpInventoryFileSchema>;
