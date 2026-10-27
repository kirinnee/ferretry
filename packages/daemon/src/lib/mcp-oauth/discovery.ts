/**
 * Where an MCP server's authorization lives, read from metadata — pure: addresses to try, and the
 * documents those addresses answered, checked (`docs/mcp-oauth.md`, MCP authorization spec,
 * RFC 9728, RFC 8414).
 *
 * Every check here is a reason to REFUSE, never to guess. A discovered endpoint is where this daemon
 * will send a code, a verifier and later a refresh token, so an endpoint this file cannot vouch for is
 * an endpoint nothing is sent to.
 */

import { isLoopbackHost, mcpOAuthServerKey } from '@ferretry/protocol';
import { z } from 'zod';

/** What a `401`'s `WWW-Authenticate: Bearer …` said, as far as discovery needs it. */
export interface BearerChallenge {
  readonly resourceMetadata?: string;
  readonly scope?: string;
}

/**
 * The `Bearer` challenge's parameters. Quoted and token values both, any order, case-insensitive
 * names (RFC 6750 §3, RFC 9728 §5.1). A header with no Bearer challenge answers nothing.
 */
export function bearerChallenge(header: string | undefined): BearerChallenge {
  if (header === undefined) return {};
  const at = header.search(/\bbearer\b/iu);
  if (at < 0) return {};
  const parameters = new Map<string, string>();
  for (const match of header
    .slice(at + 'bearer'.length)
    .matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/gu)) {
    const name = (match[1] as string).toLowerCase();
    if (!parameters.has(name)) parameters.set(name, match[2] ?? (match[3] as string));
  }
  const resourceMetadata = parameters.get('resource_metadata');
  const scope = parameters.get('scope');
  return {
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
    ...(scope === undefined ? {} : { scope }),
  };
}

const pathOf = (url: URL): string => (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, ''));

/** RFC 9728 §3.1: the path-aware address first, then the root one. */
export function protectedResourceMetadataUrls(serverUrl: string): readonly string[] {
  const url = new URL(serverUrl);
  const path = pathOf(url);
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path === '' ? [root] : [`${root}${path}`, root];
}

/**
 * The authorization server metadata addresses, in the order the MCP authorization spec gives: RFC 8414
 * with the issuer's path inserted, then OpenID Connect Discovery both ways.
 */
export function authorizationServerMetadataUrls(issuer: string): readonly string[] {
  const url = new URL(issuer);
  const path = pathOf(url);
  if (path === '')
    return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

// ── Where an endpoint may be ─────────────────────────────────────────────────────────────────────

/** A private, shared, loopback, link-local or unspecified IPv4 address in dotted form. */
const privateIpv4 = (address: string): boolean => {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet))) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10: carrier-grade NAT, Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

/**
 * An IP LITERAL that is not on the public internet: private, shared (`100.64/10`), loopback, link-local
 * or unspecified IPv4; and in IPv6, the unspecified `[::]`, loopback `[::1]`, unique-local `fc00::/7`,
 * link-local `fe80::/10`, site-local `fec0::/10`, and an IPv4-mapped `[::ffff:…]` whose IPv4 is any of
 * the above. The URL parser has already normalised the spelling. A NAME that resolves to one of these
 * is not caught — that is a declared residual risk (docs/mcp-oauth.md).
 */
export const isPrivateLiteral = (hostname: string): boolean => {
  if (!hostname.startsWith('[')) return privateIpv4(hostname);
  const address = hostname.slice(1, -1).toLowerCase();
  if (address === '::' || address === '::1') return true;
  if (/^(f[cd]|fe[89ab]|fe[c-f])/u.test(address)) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (mapped === null) return false;
  const high = Number.parseInt(mapped[1] as string, 16);
  const low = Number.parseInt(mapped[2] as string, 16);
  return privateIpv4(`${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`);
};

/**
 * Whether the daemon may talk to `endpoint` on behalf of the server at `serverUrl`.
 *
 * HTTPS always. Plain HTTP only on this machine, and only for a server that is itself on this machine —
 * which is what a local development server and the integration tests are. And a server on the public
 * internet may not send this daemon to a loopback or private address it names literally: that would let
 * a remote server aim this daemon's requests at the host it runs on.
 */
export function endpointAllowed(endpoint: string, serverUrl: string): boolean {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  const server = new URL(serverUrl);
  const serverLocal = isLoopbackHost(server.hostname);
  if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
  if (url.protocol === 'http:') return serverLocal && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:') return false;
  if (serverLocal || isPrivateLiteral(server.hostname)) return true;
  return !isLoopbackHost(url.hostname) && !isPrivateLiteral(url.hostname);
}

// ── The documents ────────────────────────────────────────────────────────────────────────────────

const ProtectedResourceMetadataSchema = z.looseObject({
  resource: z.string().min(1).max(2048).optional(),
  authorization_servers: z.array(z.string().min(1).max(2048)).min(1),
  scopes_supported: z.array(z.string().max(256)).optional(),
});

const AuthorizationServerMetadataSchema = z.looseObject({
  issuer: z.string().min(1).max(2048),
  authorization_endpoint: z.string().min(1).max(2048),
  token_endpoint: z.string().min(1).max(2048),
  registration_endpoint: z.string().min(1).max(2048).optional(),
  revocation_endpoint: z.string().min(1).max(2048).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  scopes_supported: z.array(z.string().max(256)).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string().max(64)).max(32).optional(),
});

/** What a protected resource said about itself, checked. */
export interface ProtectedResource {
  readonly resource: string;
  readonly issuer: string;
  readonly scopes?: readonly string[];
}

/** What an authorization server said about itself, checked. */
export interface AuthorizationServer {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly scopes?: readonly string[];
  /** RFC 9207: the provider puts `iss` on every authorization response, so one without it is refused. */
  readonly issParameterSupported: boolean;
  /** RFC 8414 `token_endpoint_auth_methods_supported`: how the provider lets a client authenticate, when it says. */
  readonly tokenAuthMethods?: readonly string[];
}

/** A metadata document this daemon will not use, and why — in words that quote nothing it said. */
export class DiscoveryRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryRefusal';
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The server's canonical address (MCP spec "canonical server URI"): no fragment, no trailing slash. */
export const canonicalResource = (serverUrl: string): string => mcpOAuthServerKey(serverUrl);

/**
 * RFC 9728 metadata, checked against the server it was fetched for.
 *
 * `resource` must name this server — the same origin, and a path this server's address starts with —
 * or the document describes somebody else (RFC 9728 §3.3). The first authorization server is the one
 * used; it must be somewhere this daemon may go.
 */
export function protectedResourceFrom(text: string, serverUrl: string): ProtectedResource {
  const parsed = ProtectedResourceMetadataSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new DiscoveryRefusal('The server’s sign-in description could not be read.');
  const server = new URL(serverUrl);
  const resource = parsed.data.resource ?? canonicalResource(serverUrl);
  if (!URL.canParse(resource)) throw new DiscoveryRefusal('The server’s sign-in description names no usable resource.');
  const named = new URL(resource);
  const prefix = named.pathname.replace(/\/+$/u, '');
  // Segment-aware: `/mcp` names `/mcp` and `/mcp/x`, never `/mcp-admin`; `/m` names neither.
  const covers = prefix === '' || server.pathname === prefix || server.pathname.startsWith(`${prefix}/`);
  if (named.origin !== server.origin || !covers)
    throw new DiscoveryRefusal('The server’s sign-in description is for a different server.');
  const issuer = parsed.data.authorization_servers[0] as string;
  if (!endpointAllowed(issuer, serverUrl))
    throw new DiscoveryRefusal('The server sends sign-in to an address Ferretry will not use.');
  return {
    resource: canonicalResource(resource),
    issuer,
    ...(parsed.data.scopes_supported === undefined ? {} : { scopes: parsed.data.scopes_supported }),
  };
}

const sameIssuer = (left: string, right: string): boolean => left.replace(/\/+$/u, '') === right.replace(/\/+$/u, '');

/**
 * RFC 8414 metadata, checked.
 *
 * - `issuer` must be the issuer it was fetched for (§3.3), or this is a mix-up waiting to happen.
 * - `S256` must be listed: the MCP spec requires a client to refuse a server that does not say it
 *   supports PKCE, because a server that silently ignores the challenge gives no protection at all.
 * - Every endpoint must be somewhere this daemon may go.
 */
export function authorizationServerFrom(text: string, issuer: string, serverUrl: string): AuthorizationServer {
  const parsed = AuthorizationServerMetadataSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new DiscoveryRefusal('The sign-in provider’s description could not be read.');
  const metadata = parsed.data;
  if (!sameIssuer(metadata.issuer, issuer))
    throw new DiscoveryRefusal('The sign-in provider describes itself as a different provider.');
  if (!(metadata.code_challenge_methods_supported ?? []).includes('S256'))
    throw new DiscoveryRefusal(
      'The sign-in provider does not say it supports PKCE, which Ferretry requires to sign in safely.',
    );
  const endpoints = [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
    metadata.revocation_endpoint,
  ].filter((value): value is string => value !== undefined);
  if (!endpoints.every(endpoint => endpointAllowed(endpoint, serverUrl)))
    throw new DiscoveryRefusal('The sign-in provider names an address Ferretry will not use.');
  return {
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    ...(metadata.registration_endpoint === undefined ? {} : { registrationEndpoint: metadata.registration_endpoint }),
    ...(metadata.revocation_endpoint === undefined ? {} : { revocationEndpoint: metadata.revocation_endpoint }),
    ...(metadata.scopes_supported === undefined ? {} : { scopes: metadata.scopes_supported }),
    ...(metadata.token_endpoint_auth_methods_supported === undefined
      ? {}
      : { tokenAuthMethods: metadata.token_endpoint_auth_methods_supported }),
  };
}

/** The scope to ask for: what the server's challenge named, else what its metadata lists, else none. */
export function requestedScope(
  challenge: BearerChallenge,
  resource: ProtectedResource | undefined,
): string | undefined {
  if (challenge.scope !== undefined && challenge.scope.trim() !== '') return challenge.scope.trim();
  const listed = resource?.scopes ?? [];
  return listed.length === 0 ? undefined : listed.join(' ');
}
