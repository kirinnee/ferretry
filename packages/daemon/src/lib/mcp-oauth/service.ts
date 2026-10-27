/**
 * Signing in to a remote MCP server, with this daemon as the OAuth client (`docs/mcp-oauth.md`).
 *
 * ## The properties everything else serves
 *
 * - **A token goes from the provider into a store and nowhere else.** Nothing this service answers has
 *   a field a token could occupy — the answers are the protocol's `McpOAuth*` shapes — and every refusal
 *   is a sentence chosen here, never text a provider or a pasted address supplied.
 * - **Only the ACCESS token is an ordinary secret.** It goes into the daemon's secret store because the
 *   launch has to resolve it into the runtime. The REFRESH token and any CLIENT SECRET go into a
 *   daemon-internal store ({@link McpOAuthServiceDeps.internal}) that no route lists, `use` cannot spend
 *   and `${secret:…}` cannot resolve: only this service reads them, and only to send them to the
 *   provider that issued them.
 * - **A token is bound to the server it was issued for.** Its secret name is derived from the component
 *   AND the server's canonical address (`mcpOAuthSecretNames`), so a component whose `url` changes names
 *   a secret nobody holds and its launch is refused — the old server's token is never sent to the new one.
 * - **A code from one provider can finish only a flow with that provider.** Each authorization server
 *   gets its own callback path (`mcpOAuthRedirectPath`), and `iss` is REQUIRED when the provider says it
 *   sends one (RFC 9207).
 *
 * ## No timer
 *
 * A flow that nobody finishes is dropped the next time anything looks at it after it expires, and a
 * token is refreshed only when a launch is about to use it ({@link McpOAuthService.refreshForLaunch}),
 * once per server however many launches ask at the same moment.
 */

import {
  isLoopbackHost,
  MCP_OAUTH_LOOPBACK_HOST,
  type McpOAuthCompleteRequest,
  type McpOAuthCompletion,
  type McpOAuthConnection,
  type McpOAuthFlow,
  type McpOAuthFlowCancelled,
  type McpOAuthSignedOut,
  type McpOAuthStartRequest,
  mcpOAuthRedirectPath,
  mcpOAuthSecretNames,
  type SecretName,
  sha256Hex,
} from '@ferretry/protocol';
import { checkCallback, pwaRedirectUri } from './callback.ts';
import {
  type AuthorizationServer,
  authorizationServerFrom,
  authorizationServerMetadataUrls,
  bearerChallenge,
  canonicalResource,
  DiscoveryRefusal,
  endpointAllowed,
  type ProtectedResource,
  protectedResourceFrom,
  protectedResourceMetadataUrls,
  requestedScope,
} from './discovery.ts';
import { flowIdentifier, flowState, pkcePair } from './pkce.ts';
import type {
  McpOAuthClock,
  McpOAuthCrypto,
  McpOAuthHttp,
  McpOAuthHttpResponse,
  McpOAuthPendingFlow,
  McpOAuthRecord,
  McpOAuthRegistration,
  McpOAuthSecretValues,
  McpOAuthSecretWriter,
  McpOAuthServer,
  McpOAuthServers,
  McpOAuthStateDocument,
  McpOAuthStateStore,
} from './ports.ts';
import { registrationAnswer, tokenAnswer, tokenRefusal } from './tokens.ts';

/** How long a person has to finish a sign-in. */
export const MCP_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

/** A token this close to its expiry is refreshed before a launch uses it. */
export const MCP_OAUTH_REFRESH_MARGIN_MS = 60 * 1000;

/** At most this many sign-ins in flight; the oldest is dropped to make room. */
const MAX_PENDING_FLOWS = 16;

/** At most this many client registrations kept per component; the oldest is forgotten. */
export const MAX_REGISTRATIONS_PER_COMPONENT = 4;

/** The ephemeral range a loopback redirect's port is drawn from (RFC 8252 §7.3, RFC 6335). */
const EPHEMERAL_PORT_BASE = 49152;
const EPHEMERAL_PORT_SPAN = 16384;

/** The name a client registers under. */
const CLIENT_NAME = 'Ferretry';

/** Why a call may not go ahead, in words, with a code a client branches on. */
export type McpOAuthRefusalCode =
  | 'mcp_auth_unknown_component'
  | 'mcp_auth_not_oauth'
  | 'mcp_auth_insecure_server'
  | 'mcp_auth_bad_redirect'
  | 'mcp_auth_discovery'
  | 'mcp_auth_registration'
  | 'mcp_auth_unknown_flow'
  | 'mcp_auth_callback'
  | 'mcp_auth_exchange';

export class McpOAuthRefusal extends Error {
  constructor(
    readonly code: McpOAuthRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpOAuthRefusal';
  }
}

/** A store this service both writes and reads: the daemon-internal one. */
export type McpOAuthInternalSecrets = McpOAuthSecretWriter & McpOAuthSecretValues;

export interface McpOAuthServiceDeps {
  readonly servers: McpOAuthServers;
  readonly http: McpOAuthHttp;
  readonly crypto: McpOAuthCrypto;
  readonly clock: McpOAuthClock;
  readonly state: McpOAuthStateStore;
  /** The daemon's ordinary secret store's write half: the ACCESS token, which a launch resolves. */
  readonly secrets: McpOAuthSecretWriter;
  /** The ordinary store's open half: read only to revoke an access token at sign-out. */
  readonly values: McpOAuthSecretValues;
  /** The daemon-internal store: refresh tokens and client secrets, which nothing but this reads. */
  readonly internal: McpOAuthInternalSecrets;
}

/** What discovery found for one server. */
interface Discovered {
  readonly resource: string;
  readonly server: AuthorizationServer;
  readonly scope?: string;
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } as const;

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

/** A URL as a person reads it: its host. */
const hostOf = (url: string): string => new URL(url).host;

/**
 * The internal name a registration's client secret rests under: bound to the component, the provider and
 * the redirect it was issued for, so two registrations never share one.
 */
const clientSecretName = (component: string, issuer: string, redirectUri: string): SecretName =>
  `MCP_CLIENT_${sha256Hex(`${component}\n${issuer}\n${redirectUri}`).slice(0, 24).toUpperCase()}`;

/** A server a bearer token may be sent to: HTTPS, or plain HTTP only on this machine. */
const secureServer = (url: string): boolean => {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
};

export class McpOAuthService {
  private readonly flows = new Map<string, McpOAuthPendingFlow>();
  /** One refresh per component in flight, so concurrent launches spend a refresh token once. */
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Every change to the state document and the stores is serialised: all are read-modify-write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: McpOAuthServiceDeps) {}

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  /** Every MCP component that must sign in, and every stored sign-in (a project server's too), with where each stands. */
  async connections(): Promise<readonly McpOAuthConnection[]> {
    const [servers, document, stored, internal] = await Promise.all([
      this.deps.servers.list(),
      this.deps.state.read(),
      this.deps.secrets.list(),
      this.deps.internal.list(),
    ]);
    const held = new Set([...stored, ...internal].map(summary => summary.name));
    const urls = new Map(servers.map(server => [server.component, server.url]));
    const components = new Set([
      ...servers
        .filter(server => server.url !== undefined && server.auth === 'oauth' && server.optional !== true)
        .map(server => server.component),
      ...Object.keys(document.connections),
    ]);
    return [...components]
      .sort((left, right) => left.localeCompare(right))
      .map(component => this.connectionOf(component, document.connections[component], held, urls.get(component)));
  }

  /**
   * Where one sign-in stands, for the server the component names NOW. A record for another address
   * reads as needing a new sign-in — and the materialiser, naming the secret by the current address,
   * finds none, so nothing is sent.
   */
  private connectionOf(
    component: string,
    record: McpOAuthRecord | undefined,
    held: ReadonlySet<string>,
    currentUrl: string | undefined,
  ): McpOAuthConnection {
    const url = currentUrl ?? record?.serverUrl;
    const names = url === undefined ? undefined : mcpOAuthSecretNames(component, url);
    const secrets = names === undefined || !held.has(names.access) ? [] : [names.access];
    const moved = record !== undefined && url !== record.serverUrl;
    if (record === undefined || names === undefined || moved || record.needsSignIn === true || !held.has(names.access))
      return {
        component,
        state: 'needs-sign-in',
        ...(record === undefined ? {} : { issuer: hostOf(record.issuer) }),
        renewable: false,
        secrets,
      };
    const renewable = record.renewable && held.has(names.refresh);
    const expired = record.expiresAt !== undefined && Date.parse(record.expiresAt) <= this.deps.clock.now();
    return {
      component,
      state: expired ? 'expired' : 'signed-in',
      issuer: hostOf(record.issuer),
      signedInAt: record.signedInAt,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      renewable,
      ...(record.scope === undefined ? {} : { scope: record.scope }),
      secrets,
    };
  }

  // ── Start ──────────────────────────────────────────────────────────────────────────────────────

  async start(component: string, request: McpOAuthStartRequest): Promise<McpOAuthFlow> {
    const server = await this.serverOf(component);
    const serverUrl = server.url as string;
    let pwaOrigin: string | undefined;
    if (request.redirectUri !== undefined) {
      const checked = pwaRedirectUri(request.redirectUri);
      if (checked === undefined)
        throw new McpOAuthRefusal(
          'mcp_auth_bad_redirect',
          'That return address is not a Ferretry sign-in page, so no sign-in was started.',
        );
      pwaOrigin = new URL(checked).origin;
    }
    const discovered = await this.discover(serverUrl);
    const path = mcpOAuthRedirectPath(discovered.server.issuer);
    const registered = await this.register(
      component,
      discovered.server,
      pwaOrigin === undefined ? undefined : `${pwaOrigin}${path}`,
    );
    const pkce = await pkcePair(this.deps.crypto);
    const state = flowState(this.deps.crypto);
    const authorize = new URL(discovered.server.authorizationEndpoint);
    const parameters: Record<string, string> = {
      response_type: 'code',
      client_id: registered.registration.clientId,
      redirect_uri: registered.registration.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      resource: discovered.resource,
      ...(discovered.scope === undefined ? {} : { scope: discovered.scope }),
    };
    for (const [key, value] of Object.entries(parameters)) authorize.searchParams.set(key, value);
    const flow: McpOAuthPendingFlow = {
      flowId: flowIdentifier(this.deps.crypto),
      component,
      mode: registered.registration.paste === true ? 'paste' : 'pwa',
      redirectUri: registered.registration.redirectUri,
      state,
      verifier: pkce.verifier,
      issuer: discovered.server.issuer,
      requireIss: discovered.server.issParameterSupported,
      serverUrl,
      tokenEndpoint: discovered.server.tokenEndpoint,
      ...(discovered.server.revocationEndpoint === undefined
        ? {}
        : { revocationEndpoint: discovered.server.revocationEndpoint }),
      clientId: registered.registration.clientId,
      hasClientSecret: registered.registration.hasClientSecret,
      resource: discovered.resource,
      ...(discovered.scope === undefined ? {} : { scope: discovered.scope }),
      authorizeUrl: authorize.toString(),
      expiresAt: this.deps.clock.now() + MCP_OAUTH_FLOW_TTL_MS,
      ...(registered.note === undefined ? {} : { note: registered.note }),
    };
    this.admit(flow);
    return this.flowView(flow);
  }

  /** One sign-in per component: a new start replaces the old one, whose code can then finish nothing. */
  private admit(flow: McpOAuthPendingFlow): void {
    this.prune();
    for (const [id, pending] of this.flows) if (pending.component === flow.component) this.flows.delete(id);
    while (this.flows.size >= MAX_PENDING_FLOWS) this.flows.delete(this.flows.keys().next().value as string);
    this.flows.set(flow.flowId, flow);
  }

  private prune(): void {
    const now = this.deps.clock.now();
    for (const [id, flow] of this.flows) if (flow.expiresAt <= now) this.flows.delete(id);
  }

  /**
   * The flow as the browser sees it. `issuer` is the host of the page the link actually OPENS, which
   * may differ from the authorization server's identifier — a person is told where they are going.
   */
  private flowView(flow: McpOAuthPendingFlow): McpOAuthFlow {
    return {
      flowId: flow.flowId,
      component: flow.component,
      authorizeUrl: flow.authorizeUrl,
      mode: flow.mode,
      redirectUri: flow.redirectUri,
      issuer: hostOf(flow.authorizeUrl),
      expiresAt: iso(flow.expiresAt),
      ...(flow.note === undefined ? {} : { note: flow.note }),
    };
  }

  private async serverOf(component: string): Promise<McpOAuthServer> {
    const server = (await this.deps.servers.list()).find(entry => entry.component === component);
    if (server === undefined)
      throw new McpOAuthRefusal(
        'mcp_auth_unknown_component',
        (await this.deps.servers.missing?.(component)) ?? `There is no MCP server named “${component}” here.`,
      );
    if (server.url === undefined || server.auth !== 'oauth')
      throw new McpOAuthRefusal(
        'mcp_auth_not_oauth',
        `“${component}” is not a remote server that signs in. Turn on “Signs in with OAuth” for it first.`,
      );
    // Its token will travel in a header to this address on every launch: never in cleartext.
    if (!secureServer(server.url))
      throw new McpOAuthRefusal(
        'mcp_auth_insecure_server',
        `“${component}” is reached over plain HTTP, so a sign-in would send its token unencrypted. Use its https:// address.`,
      );
    return server;
  }

  // ── Discovery ──────────────────────────────────────────────────────────────────────────────────

  private async discover(serverUrl: string): Promise<Discovered> {
    try {
      const challenge = await this.challengeOf(serverUrl);
      const resource = await this.protectedResource(serverUrl, challenge.resourceMetadata);
      // A server with no resource metadata is its own authorization server (MCP 2025-03-26).
      const issuer = resource?.issuer ?? new URL(serverUrl).origin;
      const server = await this.authorizationServer(issuer, serverUrl);
      const scope = requestedScope(challenge, resource);
      return {
        resource: resource?.resource ?? canonicalResource(serverUrl),
        server,
        ...(scope === undefined ? {} : { scope }),
      };
    } catch (error) {
      if (error instanceof DiscoveryRefusal) throw new McpOAuthRefusal('mcp_auth_discovery', error.message);
      throw new McpOAuthRefusal(
        'mcp_auth_discovery',
        'Ferretry could not reach the server to find out how it signs in. Check its address and try again.',
      );
    }
  }

  /** One unauthenticated MCP `initialize`; a `401`'s challenge says where the metadata is. */
  private async challengeOf(serverUrl: string): Promise<ReturnType<typeof bearerChallenge>> {
    const response = await this.deps.http.request({
      method: 'POST',
      url: serverUrl,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: '1' },
        },
      }),
    });
    return response.status === 401 ? bearerChallenge(response.header('www-authenticate')) : {};
  }

  private async protectedResource(
    serverUrl: string,
    named: string | undefined,
  ): Promise<ProtectedResource | undefined> {
    const candidates =
      named !== undefined && endpointAllowed(named, serverUrl) ? [named] : protectedResourceMetadataUrls(serverUrl);
    for (const url of candidates) {
      const response = await this.get(url);
      if (response.status === 200) return protectedResourceFrom(response.text, serverUrl);
    }
    return undefined;
  }

  private async authorizationServer(issuer: string, serverUrl: string): Promise<AuthorizationServer> {
    for (const url of authorizationServerMetadataUrls(issuer)) {
      const response = await this.get(url);
      if (response.status === 200) return authorizationServerFrom(response.text, issuer, serverUrl);
    }
    throw new DiscoveryRefusal('The server does not describe how to sign in to it, so Ferretry cannot sign in.');
  }

  private async get(url: string): Promise<McpOAuthHttpResponse> {
    return await this.deps.http.request({ method: 'GET', url, headers: { accept: 'application/json' } });
  }

  // ── Registration ───────────────────────────────────────────────────────────────────────────────

  /** A loopback redirect on a random ephemeral port, at this provider's own path (RFC 8252 §7.3). */
  private loopbackRedirect(issuer: string): string {
    const [high, low] = this.deps.crypto.randomBytes(2);
    const port = EPHEMERAL_PORT_BASE + ((((high as number) << 8) | (low as number)) % EPHEMERAL_PORT_SPAN);
    return `http://${MCP_OAUTH_LOOPBACK_HOST}:${String(port)}${mcpOAuthRedirectPath(issuer)}`;
  }

  /**
   * A client registration for this provider: the one already held for this redirect, or a new one
   * (RFC 7591). `redirectUri` undefined asks for the paste (loopback) way; a held loopback registration
   * for the provider is reused rather than drawing a new port every time.
   *
   * A provider that refuses the PWA's address is asked once more with a loopback address, and the flow
   * becomes a paste flow — the person is told why in `note`.
   */
  private async register(
    component: string,
    server: AuthorizationServer,
    redirectUri: string | undefined,
  ): Promise<{ registration: McpOAuthRegistration; note?: string }> {
    const held = (await this.deps.state.read()).registrations[component] ?? [];
    const existing = held.find(
      entry =>
        entry.issuer === server.issuer &&
        (redirectUri === undefined ? entry.paste === true : entry.redirectUri === redirectUri),
    );
    if (existing !== undefined) return { registration: existing };
    if (server.registrationEndpoint === undefined)
      throw new McpOAuthRefusal(
        'mcp_auth_registration',
        'This server’s sign-in provider does not let new apps register, so Ferretry cannot sign in to it yet.',
      );
    const target = redirectUri ?? this.loopbackRedirect(server.issuer);
    const answer = await this.requestRegistration(server.registrationEndpoint, target);
    if (answer.kind === 'redirect-refused' && redirectUri !== undefined) {
      const fallback = await this.register(component, server, undefined);
      return {
        registration: fallback.registration,
        note: 'This provider does not send you back to Ferretry automatically, so you will paste an address instead.',
      };
    }
    if (answer.kind !== 'registered')
      throw new McpOAuthRefusal(
        'mcp_auth_registration',
        'This server’s sign-in provider would not register Ferretry, so the sign-in could not start.',
      );
    const registration: McpOAuthRegistration = {
      issuer: server.issuer,
      redirectUri: target,
      clientId: answer.clientId,
      hasClientSecret: answer.clientSecret !== undefined,
      ...(redirectUri === undefined ? { paste: true as const } : {}),
    };
    await this.exclusive(async () => {
      if (answer.clientSecret !== undefined)
        await this.deps.internal.put(clientSecretName(component, server.issuer, target), answer.clientSecret);
      const document = await this.deps.state.read();
      const all = [...(document.registrations[component] ?? []), registration];
      // Bounded: a caller trying many PWA origins cannot grow this file, or the provider's client list,
      // without limit. A forgotten registration's client secret is forgotten with it.
      // The registration the live sign-in refreshes through is never the one dropped: forgetting it (and
      // its client secret) would leave the sign-in reading "signed in" while every refresh failed.
      const live = document.connections[component];
      const inUse = (entry: McpOAuthRegistration): boolean =>
        live !== undefined && entry.issuer === live.issuer && entry.redirectUri === live.redirectUri;
      const excess = Math.max(0, all.length - MAX_REGISTRATIONS_PER_COMPONENT);
      const dropped = all.filter(entry => !inUse(entry)).slice(0, excess);
      for (const entry of dropped)
        if (entry.hasClientSecret)
          await this.deps.internal.remove(clientSecretName(component, entry.issuer, entry.redirectUri));
      await this.deps.state.write({
        ...document,
        registrations: { ...document.registrations, [component]: all.filter(entry => !dropped.includes(entry)) },
      });
    });
    return { registration };
  }

  private async requestRegistration(
    endpoint: string,
    redirectUri: string,
  ): Promise<ReturnType<typeof registrationAnswer>> {
    try {
      const response = await this.deps.http.request({
        method: 'POST',
        url: endpoint,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: CLIENT_NAME,
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      return registrationAnswer(response.status, response.text);
    } catch {
      return { kind: 'refused' };
    }
  }

  // ── Finish ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Check the address the browser came back to, consume the flow, redeem the code, file the tokens.
   *
   * A malformed or mismatched address does NOT consume the flow, so a person who pasted the wrong thing
   * can paste again. A well-formed one consumes it BEFORE the code is redeemed: whatever the provider
   * then answers, that flow can finish nothing else.
   */
  async complete(flowId: string, request: McpOAuthCompleteRequest): Promise<McpOAuthCompletion> {
    this.prune();
    const flow = this.flows.get(flowId);
    if (flow === undefined)
      throw new McpOAuthRefusal(
        'mcp_auth_unknown_flow',
        'This sign-in has already finished or expired. Start a new one.',
      );
    const checked = checkCallback(request.callback, flow);
    if (checked.kind === 'refused') throw new McpOAuthRefusal('mcp_auth_callback', checked.reason);
    this.flows.delete(flowId);
    const names = mcpOAuthSecretNames(flow.component, flow.serverUrl);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: checked.code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
      resource: flow.resource,
    });
    const secret = flow.hasClientSecret ? clientSecretName(flow.component, flow.issuer, flow.redirectUri) : undefined;
    const answer = await this.tokenRequest(flow.tokenEndpoint, form, secret);
    if (answer.kind === 'error') throw new McpOAuthRefusal('mcp_auth_exchange', tokenRefusal(answer.error));
    const now = this.deps.clock.now();
    const record: McpOAuthRecord = {
      serverUrl: flow.serverUrl,
      issuer: flow.issuer,
      redirectUri: flow.redirectUri,
      tokenEndpoint: flow.tokenEndpoint,
      ...(flow.revocationEndpoint === undefined ? {} : { revocationEndpoint: flow.revocationEndpoint }),
      clientId: flow.clientId,
      hasClientSecret: flow.hasClientSecret,
      resource: flow.resource,
      ...((answer.scope ?? flow.scope) === undefined ? {} : { scope: answer.scope ?? flow.scope }),
      signedInAt: iso(now),
      ...(answer.expiresInSeconds === undefined ? {} : { expiresAt: iso(now + answer.expiresInSeconds * 1000) }),
      renewable: answer.refreshToken !== undefined,
    };
    await this.exclusive(async () => {
      const document = await this.deps.state.read();
      // A sign-in for the address the component USED to name leaves nothing behind.
      const previous = document.connections[flow.component];
      if (previous !== undefined && previous.serverUrl !== flow.serverUrl) {
        const old = mcpOAuthSecretNames(flow.component, previous.serverUrl);
        await this.deps.secrets.remove(old.access);
        await this.deps.internal.remove(old.refresh);
      }
      await this.deps.secrets.put(names.access, answer.accessToken);
      if (answer.refreshToken === undefined) await this.deps.internal.remove(names.refresh);
      else await this.deps.internal.put(names.refresh, answer.refreshToken);
      await this.deps.state.write({ ...document, connections: { ...document.connections, [flow.component]: record } });
    });
    const held = new Set(
      [...(await this.deps.secrets.list()), ...(await this.deps.internal.list())].map(summary => summary.name),
    );
    return {
      component: flow.component,
      connection: this.connectionOf(flow.component, record, held, flow.serverUrl),
    };
  }

  /** Ends a sign-in nobody will finish. */
  cancel(flowId: string): McpOAuthFlowCancelled {
    return { flowId, cancelled: this.flows.delete(flowId) };
  }

  /**
   * One POST to a token endpoint. A client secret, when registration returned one, is read out of the
   * internal store for this request only (`client_secret_post`).
   */
  private async tokenRequest(
    endpoint: string,
    form: URLSearchParams,
    clientSecret: SecretName | undefined,
  ): Promise<ReturnType<typeof tokenAnswer>> {
    if (clientSecret !== undefined) {
      const secret = (await this.deps.internal.values()).get(clientSecret);
      if (secret !== undefined) form.set('client_secret', secret);
    }
    try {
      const response = await this.deps.http.request({
        method: 'POST',
        url: endpoint,
        headers: FORM,
        body: form.toString(),
      });
      return tokenAnswer(response.status, response.text);
    } catch {
      return { kind: 'error', error: 'unreachable' };
    }
  }

  // ── Refresh, on use ────────────────────────────────────────────────────────────────────────────

  /**
   * Make current every access token among `names` that is about to expire, before a launch resolves
   * them. Called by the launch environment, never by a timer. Servers are refreshed in parallel, and a
   * server already being refreshed for another launch is waited on, not refreshed again.
   *
   * NEVER THROWS. A refresh that fails leaves the old token where it was and the launch goes ahead —
   * the harness then reports the one server as unauthorised, which is better than an agent that does
   * not start because one of its servers expired. A refresh the provider REJECTS marks the sign-in as
   * needing a new one, which is what the component then says.
   */
  async refreshForLaunch(names: readonly SecretName[]): Promise<void> {
    try {
      const wanted = new Set(names);
      const document = await this.deps.state.read();
      const due = Object.entries(document.connections)
        .filter(([component, record]) => wanted.has(mcpOAuthSecretNames(component, record.serverUrl).access))
        .filter(([, record]) => this.due(record))
        .map(([component]) => component);
      await Promise.all(due.map(component => this.refreshOnce(component)));
    } catch {
      // A launch is never refused for this; see above.
    }
  }

  private due(record: McpOAuthRecord): boolean {
    if (!record.renewable || record.needsSignIn === true || record.expiresAt === undefined) return false;
    return Date.parse(record.expiresAt) - this.deps.clock.now() <= MCP_OAUTH_REFRESH_MARGIN_MS;
  }

  /** Single flight per component: concurrent launches share one refresh and spend the token once. */
  private async refreshOnce(component: string): Promise<void> {
    const running = this.refreshing.get(component);
    if (running !== undefined) return await running;
    const work = this.refresh(component)
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(component));
    this.refreshing.set(component, work);
    return await work;
  }

  private async refresh(component: string): Promise<void> {
    // Re-read: an earlier launch may have refreshed it between the survey and now.
    const record = (await this.deps.state.read()).connections[component];
    if (record === undefined || !this.due(record)) return;
    // Defence in depth: the endpoint on disk is re-checked before a refresh token is sent to it.
    if (!endpointAllowed(record.tokenEndpoint, record.serverUrl)) return await this.markNeedsSignIn(component);
    const names = mcpOAuthSecretNames(component, record.serverUrl);
    const refreshToken = (await this.deps.internal.values()).get(names.refresh);
    if (refreshToken === undefined) return await this.markNeedsSignIn(component);
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: record.clientId,
      resource: record.resource,
    });
    const secret = record.hasClientSecret ? clientSecretName(component, record.issuer, record.redirectUri) : undefined;
    const answer = await this.tokenRequest(record.tokenEndpoint, form, secret);
    if (answer.kind === 'error') {
      if (answer.error === 'invalid_grant') await this.markNeedsSignIn(component);
      return;
    }
    const now = this.deps.clock.now();
    const filed = await this.exclusive(async () => {
      // The answer arrived up to a request timeout after the record was read. A sign-out — or a new
      // sign-in at another address — may have happened meanwhile, and filing these tokens then would
      // bring back a sign-in the person just ended, or stamp the old server's expiry on the new one. So
      // the record is checked FIRST, inside the serialised write, and nothing is filed unless it is
      // still this sign-in.
      const document = await this.deps.state.read();
      const current = document.connections[component];
      if (current === undefined || current.serverUrl !== record.serverUrl) return false;
      await this.deps.secrets.put(names.access, answer.accessToken);
      // RFC 6749 §6: a provider may rotate the refresh token; one that does not keeps the old one valid.
      if (answer.refreshToken !== undefined) await this.deps.internal.put(names.refresh, answer.refreshToken);
      const { expiresAt: _previous, ...rest } = current;
      await this.deps.state.write({
        ...document,
        connections: {
          ...document.connections,
          [component]: {
            ...rest,
            ...(answer.expiresInSeconds === undefined ? {} : { expiresAt: iso(now + answer.expiresInSeconds * 1000) }),
            ...(answer.scope === undefined ? {} : { scope: answer.scope }),
          },
        },
      });
      return true;
    });
    // Tokens nobody will file are tokens nobody should hold: ask the provider to drop them.
    if (!filed)
      await this.revokeToken(
        component,
        record,
        answer.refreshToken ?? answer.accessToken,
        answer.refreshToken === undefined ? 'access_token' : 'refresh_token',
      );
  }

  private async markNeedsSignIn(component: string): Promise<void> {
    await this.exclusive(async () => {
      const document = await this.deps.state.read();
      const current = document.connections[component];
      if (current === undefined) return;
      await this.deps.state.write({
        ...document,
        connections: { ...document.connections, [component]: { ...current, renewable: false, needsSignIn: true } },
      });
    });
  }

  // ── Sign out ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Revoke the refresh token at the provider when it says how (RFC 7009), then delete every secret and
   * record this component's sign-in left. The revocation is best effort: a sign-out whose provider is
   * unreachable still deletes everything here, and says it could not confirm the revocation.
   */
  async signOut(component: string): Promise<McpOAuthSignedOut> {
    const document = await this.deps.state.read();
    const record = document.connections[component];
    const revoked = record === undefined ? false : await this.revoke(component, record);
    return await this.exclusive(async () => {
      const current = await this.deps.state.read();
      const removals: Promise<boolean>[] = [];
      const signedIn = current.connections[component];
      if (signedIn !== undefined) {
        const names = mcpOAuthSecretNames(component, signedIn.serverUrl);
        removals.push(this.deps.secrets.remove(names.access), this.deps.internal.remove(names.refresh));
      }
      for (const entry of current.registrations[component] ?? [])
        if (entry.hasClientSecret)
          removals.push(this.deps.internal.remove(clientSecretName(component, entry.issuer, entry.redirectUri)));
      const removed = (await Promise.all(removals)).some(Boolean);
      const { [component]: _connection, ...connections } = current.connections;
      const { [component]: _registrations, ...registrations } = current.registrations;
      await this.deps.state.write({ ...current, connections, registrations });
      return { component, removed: removed || record !== undefined, revoked };
    });
  }

  private async revoke(component: string, record: McpOAuthRecord): Promise<boolean> {
    try {
      const names = mcpOAuthSecretNames(component, record.serverUrl);
      const refresh = (await this.deps.internal.values()).get(names.refresh);
      const token = refresh ?? (await this.deps.values.values()).get(names.access);
      if (token === undefined) return false;
      return await this.revokeToken(component, record, token, refresh === undefined ? 'access_token' : 'refresh_token');
    } catch {
      return false;
    }
  }

  /** RFC 7009, best effort: whether the provider confirmed it. Never throws. */
  private async revokeToken(
    component: string,
    record: McpOAuthRecord,
    token: string,
    hint: 'access_token' | 'refresh_token',
  ): Promise<boolean> {
    if (record.revocationEndpoint === undefined || !endpointAllowed(record.revocationEndpoint, record.serverUrl))
      return false;
    try {
      const form = new URLSearchParams({ token, token_type_hint: hint, client_id: record.clientId });
      const secret = record.hasClientSecret
        ? (await this.deps.internal.values()).get(clientSecretName(component, record.issuer, record.redirectUri))
        : undefined;
      if (secret !== undefined) form.set('client_secret', secret);
      const response = await this.deps.http.request({
        method: 'POST',
        url: record.revocationEndpoint,
        headers: FORM,
        body: form.toString(),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return await run;
  }
}

/** The state document for a daemon that has never signed in to anything. */
export const EMPTY_MCP_OAUTH_STATE: McpOAuthStateDocument = { v: 1, registrations: {}, connections: {} };
