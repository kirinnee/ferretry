/**
 * Adding an MCP server for one ferret: the wire contract, and the one rule both ends must agree on.
 *
 * TWO SCOPES, TWO OWNERS. A server is added either to the PROJECT — the repo's `.mcp.json`, which
 * Claude Code reads itself and which is shared with everyone on the repo — or to the LOGIN, which is a
 * fleet MCP component appended to the profile this ferret's runtime launches with, so every ferret on
 * that login gets it. The daemon owns both writes; the caller names one intent and never sends a file.
 *
 * A PROJECT WRITE IS A COMPARE-AND-SWAP. The preview answers with the file's current `etag` (the
 * SHA-256 of its bytes, or `null` when there is no file) and the diff the write would make; the add
 * presents that etag back, and a file that changed in between is refused rather than overwritten. A
 * person approved a diff, so the daemon writes exactly that diff or nothing.
 *
 * NO SECRET VALUE CROSSES THIS CONTRACT. An environment value may be plain (a URL, a region) or a
 * reference — `${secret:NAME}` on a login, resolved into the child's environment at launch by the fleet,
 * or `${NAME}` in a project file, which Claude Code expands from its own environment. A value that
 * looks like a raw key is refused by {@link mcpEnvRefusal}, which BOTH ends run: the form says it as the
 * person types, and the daemon refuses the same request if a different client sends it.
 */
import { z } from 'zod';

/** The file a project-scope server is written to, at the root of the ferret's checkout. */
export const SESSION_MCP_PROJECT_FILE = '.mcp.json';

/** Where an added server lives. */
export const SessionMcpScopeSchema = z.enum(['project', 'login']);
export type SessionMcpScope = z.infer<typeof SessionMcpScopeSchema>;

/**
 * A server's name, as both Claude Code's `.mcp.json` key and a fleet component name accept it: a letter
 * or digit, then letters, digits, `-` and `_`, at most 64 characters.
 */
export const SessionMcpNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u,
    'use letters, digits, - and _ (at most 64), starting with a letter or digit',
  );

/** An environment variable's name: upper case, digits and `_`, not starting with a digit. */
export const SessionMcpEnvNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/u, 'use NAME=value, with an upper-case NAME');

export const SessionMcpEnvSchema = z.record(SessionMcpEnvNameSchema, z.string().max(4096));
export type SessionMcpEnv = z.infer<typeof SessionMcpEnvSchema>;

const HTTP_URL = /^https?:\/\/[^\s]+$/u;

/** How the CLI reaches the server: a command it runs (stdio), or a web address (HTTP). */
export const SessionMcpServerSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('command'),
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64),
    env: SessionMcpEnvSchema,
  }),
  z.strictObject({
    transport: z.literal('url'),
    // A plain pattern rather than `z.url()`: that accepts `javascript:` and `data:` too.
    url: z.string().max(2048).regex(HTTP_URL, 'use an http:// or https:// address'),
    /** Login scope only: the server signs in through Ferretry's MCP OAuth (docs/mcp-oauth.md). */
    oauth: z.boolean(),
  }),
]);
export type SessionMcpServer = z.infer<typeof SessionMcpServerSchema>;

/**
 * What the person asked for, before the daemon has read anything. The SCOPE IS THE PATH, not a field:
 * a project write is governed by `filesystem.configure` and a login write by `fleet.configure`, and a
 * route declares exactly one capability, so one route per scope is what lets the boundary decide.
 */
export const SessionMcpPreviewRequestSchema = z.strictObject({
  name: SessionMcpNameSchema,
  server: SessionMcpServerSchema,
});
export type SessionMcpPreviewRequest = z.infer<typeof SessionMcpPreviewRequestSchema>;

/** The SHA-256 of a file's bytes, lower-case hex. */
export const SessionMcpEtagSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * The add itself. A project add carries the etag its preview answered with — `null` meaning "there
 * was no file" — and is refused when the file no longer matches.
 */
export const SessionMcpAddRequestSchema = SessionMcpPreviewRequestSchema.extend({
  etag: SessionMcpEtagSchema.nullable().optional(),
});
export type SessionMcpAddRequest = z.infer<typeof SessionMcpAddRequestSchema>;

/** One line of the change a project add would make, in the order the file reads. */
export const SessionMcpDiffLineSchema = z.strictObject({
  kind: z.enum(['context', 'add', 'remove']),
  text: z.string(),
});
export type SessionMcpDiffLine = z.infer<typeof SessionMcpDiffLineSchema>;

export const SessionMcpPreviewSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('project'),
    /** The file, absolute on the ferret's machine. */
    path: z.string().min(1),
    etag: SessionMcpEtagSchema.nullable(),
    /** The server already exists in the file and would be replaced. */
    replaces: z.boolean(),
    diff: z.array(SessionMcpDiffLineSchema),
  }),
  z.strictObject({
    scope: z.literal('login'),
    /** The runtime this ferret runs as, which names its login. */
    runtime: z.string().min(1),
    /** The profile the component is appended to. */
    profile: z.string().min(1),
    /** A component of that name exists already and would be replaced. */
    replaces: z.boolean(),
    /** How many ferrets on this machine run that runtime, this one included. */
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

/** A server the project file declares, as Info › Folder › MCP lists it. */
export const SessionMcpProjectServerSchema = z.strictObject({
  name: z.string().min(1),
  transport: z.enum(['command', 'url']),
});

/**
 * The project's servers, for Info. `project` is null when the ferret's folder is not a checkout a
 * project write could reach, with the sentence that says why.
 */
export const SessionMcpListingSchema = z.strictObject({
  project: z
    .strictObject({
      path: z.string().min(1),
      etag: SessionMcpEtagSchema.nullable(),
      servers: z.array(SessionMcpProjectServerSchema),
    })
    .nullable(),
  /** Why there is no project scope here, when there is none. */
  projectUnavailable: z.string().min(1).optional(),
});
export type SessionMcpListing = z.infer<typeof SessionMcpListingSchema>;

// ── The one rule both ends run ──────────────────────────────────────────────────────────────────

/** Prefixes real providers put on their keys. */
export const RAW_KEY_PREFIXES =
  /^(?:sk-|sk_live_|sk_test_|rk_live_|AKIA|ASIA|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abposr]-|AIza|hf_|pk_live_)/u;
/** A name that announces a credential. */
export const SECRET_SOUNDING_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/u;
/** A reference: Ferretry's secret store, or the environment. */
const SECRET_REFERENCE = /^\$\{secret:[A-Za-z0-9_.-]+\}$/u;
const ENV_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}$/u;

/**
 * Why one environment value may not be written, or null when it may.
 *
 * - A `${secret:NAME}` reference is fine on a login and refused in a project file: the repo is shared
 *   and Claude Code reads the file itself, so nothing would ever fill it in.
 * - A value that looks like a raw key — a known provider prefix, or a long unbroken value under a name
 *   that says KEY / TOKEN / SECRET — is refused everywhere, with the way to store it instead.
 */
export const mcpEnvRefusal = (scope: SessionMcpScope, name: string, value: string): string | null => {
  const trimmed = value.trim();
  if (SECRET_REFERENCE.test(trimmed))
    return scope === 'project'
      ? `${name}: a project's .mcp.json is shared with the repo and read by Claude Code itself, so Ferretry cannot fill in \${secret:…} there. Use \${${name}} and give the ferret that variable, or add the server to This login.`
      : null;
  if (ENV_REFERENCE.test(trimmed)) return null;
  const looksRaw =
    RAW_KEY_PREFIXES.test(trimmed) ||
    (SECRET_SOUNDING_NAME.test(name) && trimmed.length >= 16 && !/[\s/]/u.test(trimmed));
  if (!looksRaw) return null;
  return scope === 'project'
    ? `${name} looks like a raw secret, and .mcp.json is shared with everyone on the repo. Use \${${name}} instead, or add the server to This login with \${secret:${name}}.`
    : `${name} looks like a raw secret. Run \`fy secret set ${name}\` and use \${secret:${name}} instead.`;
};

/** The first refusal over a whole server, or null. Arguments are checked for provider keys too. */
export const mcpServerRefusal = (scope: SessionMcpScope, server: SessionMcpServer): string | null => {
  if (server.transport === 'url')
    return scope === 'project' && server.oauth
      ? 'A project’s .mcp.json has no sign-in switch. Add the server, then sign in to it from its row in Tools: Ferretry keeps the token for this project and hands it to Claude Code.'
      : null;
  for (const [name, value] of Object.entries(server.env)) {
    const refusal = mcpEnvRefusal(scope, name, value);
    if (refusal !== null) return refusal;
  }
  for (const argument of server.args)
    if (RAW_KEY_PREFIXES.test(argument.trim()))
      return 'An argument looks like a raw secret. Put it in an environment variable that references the secret instead.';
  return null;
};
