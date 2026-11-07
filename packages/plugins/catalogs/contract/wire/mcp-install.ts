import { z } from 'zod';
export const SessionMcpScopeSchema = z.enum(['project', 'login']);

export type SessionMcpScope = z.infer<typeof SessionMcpScopeSchema>;

export const SessionMcpEnvNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/u, 'use NAME=value, with an upper-case NAME');

export const SessionMcpEnvSchema = z.record(SessionMcpEnvNameSchema, z.string().max(4096));

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
    // A plain pattern rather than `z.url()`: that accepts `javascript:` and `data:` too.
    url: z.string().max(2048).regex(HTTP_URL, 'use an http:// or https:// address'),
    /** Login scope only: the server signs in through Ferretry's MCP OAuth (docs/mcp-oauth.md). */
    oauth: z.boolean(),
  }),
]);

export type SessionMcpServer = z.infer<typeof SessionMcpServerSchema>;

export const SessionMcpDiffLineSchema = z.strictObject({
  kind: z.enum(['context', 'add', 'remove']),
  text: z.string(),
});

export type SessionMcpDiffLine = z.infer<typeof SessionMcpDiffLineSchema>;

export const RAW_KEY_PREFIXES =
  /^(?:sk-|sk_live_|sk_test_|rk_live_|AKIA|ASIA|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abposr]-|AIza|hf_|pk_live_)/u;

const SECRET_SOUNDING_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/u;

const SECRET_REFERENCE = /^\$\{secret:[A-Za-z0-9_.-]+\}$/u;

const ENV_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}$/u;

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
