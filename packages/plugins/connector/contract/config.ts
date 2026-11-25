/**
 * `config/connector.yaml`: the connector's settings (docs/mcp-connector.md "Configuration"). One file replaces v4's
 * `connector` block of `config/daemon.json`; the keys are the same.
 *
 * The kernel checks the file against this schema and keeps the LAST GOOD version in effect when an edit does not
 * pass, so a typo cannot half-start the connector. Every rule below therefore says its own sentence.
 */
import { z } from 'zod';

/** The port the connector's own listener binds on `127.0.0.1` when the file names none. v4's, so a `cloudflared` set up for it keeps working. */
export const CONNECTOR_DEFAULT_PORT = 7461;

/** Claude's hosted-apps OAuth callback, verbatim from Anthropic's connector documentation (docs/mcp-connector.md "Sources"). */
export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Why a URL may not be used, or `undefined` when it may. `https`, or `http` on a loopback host only. */
function urlProblem(text: string, what: string, origin: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `${what} is not a URL`;
  }
  if (url.username !== '' || url.password !== '') return `${what} must not carry a user name or password`;
  if (url.hash !== '') return `${what} must not have a #fragment`;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
    return `${what} must be https:// (http:// only on this machine's loopback address)`;
  if (origin && (url.pathname !== '/' || url.search !== '' || text.trim().replace(/\/$/u, '') !== url.origin))
    return `${what} must be an origin only, like https://mcp.example.com — no path or query`;
  return undefined;
}

export const ConnectorConfigSchema = z
  .strictObject({
    /** The owner's switch. Off by default; turning it on is a loosening the owner confirms. */
    enabled: z.boolean().default(false),
    /**
     * The public origin the operator published the listener at, no path: the issuer. Absent means the issuer is this
     * machine's built-in tunnel hostname once that is known. A configured address ALWAYS wins and is never overwritten.
     */
    publicUrl: z.string().trim().min(1).max(512).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    /** Redirect URIs beyond Claude's own, exact strings (an MCP inspector, a second client). */
    extraRedirectUris: z.array(z.string().trim().min(1).max(512)).max(10).default([]),
  })
  .superRefine((value, context) => {
    const publicProblem = value.publicUrl === undefined ? undefined : urlProblem(value.publicUrl, '"publicUrl"', true);
    if (publicProblem !== undefined) context.addIssue({ code: 'custom', path: ['publicUrl'], message: publicProblem });
    value.extraRedirectUris.forEach((extra, index) => {
      const problem = urlProblem(extra, `"extraRedirectUris" entry ${JSON.stringify(extra)}`, false);
      if (problem !== undefined)
        context.addIssue({ code: 'custom', path: ['extraRedirectUris', index], message: problem });
    });
  });
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

/**
 * Which edits widen who can reach this machine, so the owner confirms them (docs/config-files.md): switching it on,
 * a redirect URI that was not allowed before, and any change of the published address (the issuer changes with it, so
 * a new address is a new place Claude is told to sign in). A tighter edit, or a new port, loosens nothing. A file that
 * did not exist reads as the defaults, which are off.
 */
export function connectorLoosens(
  before: ConnectorConfig | undefined,
  after: ConnectorConfig | undefined,
): readonly string[] {
  if (after === undefined) return [];
  const reasons: string[] = [];
  if (after.enabled && before?.enabled !== true) reasons.push('Turns the Claude connector on.');
  const known = new Set(before?.extraRedirectUris ?? []);
  for (const uri of after.extraRedirectUris)
    if (!known.has(uri)) reasons.push(`Lets ${uri} complete a Claude connector sign-in.`);
  if (after.publicUrl !== before?.publicUrl && (after.publicUrl !== undefined || before?.publicUrl !== undefined))
    reasons.push('Changes the address the Claude connector is published at.');
  return reasons;
}
