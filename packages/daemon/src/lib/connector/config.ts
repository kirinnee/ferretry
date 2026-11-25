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
      /**
       * The public origin the operator configured, no trailing slash: the issuer. `undefined` means none was
       * written, and the issuer is this machine's built-in tunnel hostname once that is known (docs/mcp-connector.md
       * "Over the built-in tunnel"). A configured address ALWAYS wins and is never overwritten.
       */
      readonly publicUrl: string | undefined;
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

/**
 * The block read WHETHER OR NOT it is switched on: the settings a switch-on will use, or why none can be.
 *
 * Kept apart from {@link connectorSettings} so the app's switch can turn the connector on live — it needs the
 * address, port and redirect allow-list of a block that says `enabled: false`, and must refuse (not half-start)
 * when that block is damaged.
 */
export type ConnectorConfiguration =
  | {
      readonly kind: 'valid';
      /** Whether the block says the connector is on. */
      readonly enabled: boolean;
      readonly settings: Extract<ConnectorSettings, { kind: 'enabled' }>;
    }
  | { readonly kind: 'invalid'; readonly reason: string };

const OFF_SENTENCE = 'The connector is off. Switch it on in the app (Settings › Claude connector).';

export function connectorConfiguration(block: unknown): ConnectorConfiguration {
  const parsed = ConnectorBlockSchema.safeParse(block ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    return {
      kind: 'invalid',
      reason: `The connector is off: config/daemon.json "connector"${where === '' ? '' : `.${where}`} is not valid (${issue?.message ?? 'unreadable'}).`,
    };
  }
  const value = parsed.data;
  const publicProblem =
    value.publicUrl === undefined ? undefined : urlProblem(value.publicUrl, '"connector.publicUrl"', true);
  if (publicProblem !== undefined) return { kind: 'invalid', reason: `The connector is off: ${publicProblem}.` };
  for (const extra of value.extraRedirectUris) {
    const problem = urlProblem(extra, `"connector.extraRedirectUris" entry ${JSON.stringify(extra)}`, false);
    if (problem !== undefined) return { kind: 'invalid', reason: `The connector is off: ${problem}.` };
  }
  return {
    kind: 'valid',
    enabled: value.enabled,
    settings: {
      kind: 'enabled',
      publicUrl: value.publicUrl === undefined ? undefined : new URL(value.publicUrl).origin,
      port: value.port ?? CONNECTOR_DEFAULT_PORT,
      redirectUris: [...new Set([CLAUDE_REDIRECT_URI, ...value.extraRedirectUris])],
    },
  };
}

export function connectorSettings(block: unknown): ConnectorSettings {
  if (block === undefined) return { kind: 'disabled', reason: OFF_SENTENCE };
  const configuration = connectorConfiguration(block);
  if (configuration.kind === 'invalid') return { kind: 'disabled', reason: configuration.reason };
  return configuration.enabled ? configuration.settings : { kind: 'disabled', reason: OFF_SENTENCE };
}

/**
 * The raw `config/daemon.json` document with exactly one fact changed: `connector.enabled`.
 *
 * Raw in, raw out — the same rule every daemon-config write keeps: the operator's own `publicUrl`, `port` and
 * `extraRedirectUris` survive untouched, and a block that is not an object (a typo) is replaced by `{ enabled }` alone
 * rather than merged into, because a damaged block read as "off" must not stay damaged under a switch that says it is on.
 */
export function connectorEnabledDocument(raw: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const block = raw.connector;
  const existing =
    typeof block === 'object' && block !== null && !Array.isArray(block) ? (block as Record<string, unknown>) : {};
  return { ...raw, connector: { ...existing, enabled } };
}
