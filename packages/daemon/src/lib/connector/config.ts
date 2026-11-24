import { z } from 'zod';

/**
 * The connector's settings, from the `connector` block of `config/daemon.json` (docs/mcp-connector.md
 * "Configuration").
 *
 * TOTAL AND FAIL-CLOSED: every input — absent, `enabled: false`, a typo, a URL with a path — answers a value, and
 * every value but a fully valid enabled block is `disabled` with the sentence a person reads in `fy connector`, the
 * app and the boot log. Nothing here can refuse the daemon's boot (the document reads the block as `unknown`).
 */

/** The port the connector listener binds on `127.0.0.1` when the block names none. */
export const CONNECTOR_DEFAULT_PORT = 7461;

/** Claude's hosted-apps OAuth callback, verbatim from Anthropic's connector documentation (docs/mcp-connector.md "Sources"). */
export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

export type ConnectorSettings =
  | {
      readonly kind: 'enabled';
      /** The public origin, no trailing slash: the issuer. */
      readonly publicUrl: string;
      readonly port: number;
      /** Claude's callback first, then the operator's extras, de-duplicated, exact strings. */
      readonly redirectUris: readonly string[];
    }
  | { readonly kind: 'disabled'; readonly reason: string };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const ConnectorBlockSchema = z.strictObject({
  enabled: z.boolean().default(false),
  publicUrl: z.string().trim().min(1).max(512).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  extraRedirectUris: z.array(z.string().trim().min(1).max(512)).max(10).default([]),
});

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

export function connectorSettings(block: unknown): ConnectorSettings {
  if (block === undefined)
    return { kind: 'disabled', reason: 'The connector is off: config/daemon.json has no "connector" block.' };
  const parsed = ConnectorBlockSchema.safeParse(block);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    return {
      kind: 'disabled',
      reason: `The connector is off: config/daemon.json "connector"${where === '' ? '' : `.${where}`} is not valid (${issue?.message ?? 'unreadable'}).`,
    };
  }
  const value = parsed.data;
  if (!value.enabled)
    return { kind: 'disabled', reason: 'The connector is off: config/daemon.json "connector.enabled" is not true.' };
  if (value.publicUrl === undefined)
    return {
      kind: 'disabled',
      reason: 'The connector is off: set config/daemon.json "connector.publicUrl" to the public https:// address.',
    };
  const publicProblem = urlProblem(value.publicUrl, '"connector.publicUrl"', true);
  if (publicProblem !== undefined) return { kind: 'disabled', reason: `The connector is off: ${publicProblem}.` };
  for (const extra of value.extraRedirectUris) {
    const problem = urlProblem(extra, `"connector.extraRedirectUris" entry ${JSON.stringify(extra)}`, false);
    if (problem !== undefined) return { kind: 'disabled', reason: `The connector is off: ${problem}.` };
  }
  return {
    kind: 'enabled',
    publicUrl: new URL(value.publicUrl).origin,
    port: value.port ?? CONNECTOR_DEFAULT_PORT,
    redirectUris: [...new Set([CLAUDE_REDIRECT_URI, ...value.extraRedirectUris])],
  };
}
