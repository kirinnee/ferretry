/**
 * Signing in to a remote MCP server, with this daemon as the OAuth client (`docs/mcp-oauth.md`).
 *
 * ## The one property everything else serves
 *
 * **A token goes from the provider into the secret store and nowhere else.** This service is given the
 * store's WRITE half (`put`, `remove`, `list`) to file tokens, and its OPEN half only so it can spend a
 * refresh token at the provider that issued it. Nothing it answers has a field a token could occupy —
 * the answers are the protocol's `McpOAuth*` shapes — and every refusal is a sentence chosen here, never
 * text a provider or a pasted address supplied. `docs/secrets.md` lists this as the fourth holder of a
 * vault and says why.
 *
 * ## The flow
 *
 * `start` discovers the server's authorization server (RFC 9728, RFC 8414), registers a public client
 * for the redirect address once (RFC 7591), and answers an authorization URL carrying a PKCE `S256`
 * challenge, a single-use `state` and the RFC 8707 `resource`. The verifier never leaves this object.
 * `complete` checks the address the browser came back to, CONSUMES the flow, and only then redeems the
 * code — so the same address submitted twice is refused the second time.
 *
 * ## No timer
 *
 * A flow that nobody finishes is dropped the next time anything looks at it after it expires, and a
 * token is refreshed only when a launch is about to use it ({@link McpOAuthService.refreshForLaunch}).
 * There is no background loop, so there is nothing to shut down.
 */

import {
  MCP_OAUTH_LOOPBACK_REDIRECT,
  type McpOAuthCompleteRequest,
  type McpOAuthCompletion,
  type McpOAuthConnection,
  type McpOAuthFlow,
  type McpOAuthFlowCancelled,
  type McpOAuthSignedOut,
  type McpOAuthStartRequest,
  mcpOAuthSecretNames,
  type SecretName,
} from '@ferretry/protocol';
import { checkCallback, pwaRedirectUri } from './callback.ts';
import {
  type AuthorizationServer,
  authorizationServerFrom,
  authorizationServerMetadataUrls,
  bearerChallenge,
  DiscoveryRefusal,
  endpointAllowed,
  type ProtectedResource,
  canonicalResource,
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

/** The name a client registers under. */
const CLIENT_NAME = 'Ferretry';

/** Why a call may not go ahead, in words, with a code a client branches on. */
export type McpOAuthRefusalCode =
  | 'mcp_auth_unknown_component'
  | 'mcp_auth_not_oauth'
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

export interface McpOAuthServiceDeps {
  readonly servers: McpOAuthServers;
  readonly http: McpOAuthHttp;
  readonly crypto: McpOAuthCrypto;
  readonly clock: McpOAuthClock;
  readonly state: McpOAuthStateStore;
  readonly secrets: McpOAuthSecretWriter;
  readonly values: McpOAuthSecretValues;
}

/** What discovery found for one server. */
interface Discovered {
  readonly resource: string;
  readonly server: AuthorizationServer;
  readonly scope?: string;
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } as const;

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

/** An issuer as a person reads it: its host. */
const hostOf = (issuer: string): string => new URL(issuer).host;

export class McpOAuthService {
  private readonly flows = new Map<string, McpOAuthPendingFlow>();
  /** Every change to the state document and the store is serialised: both are read-modify-write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: McpOAuthServiceDeps) {}

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  /** Every MCP component that signs in, and every stored sign-in, with where each stands. */
  async connections(): Promise<readonly McpOAuthConnection[]> {
    const [servers, document, stored] = await Promise.all([
      this.deps.servers.list(),
      this.deps.state.read(),
      this.deps.secrets.list(),
    ]);
    const held = new Set(stored.map(summary => summary.name));
    const urls = new Map(servers.map(server => [server.component, server.url]));
    const components = new Set([
      ...servers.filter(server => server.url !== undefined && server.auth === 'oauth').map(server => server.component),
      ...Object.keys(document.connections),
    ]);
    return [...components]
      .sort((left, right) => left.localeCompare(right))
      .map(component => {
        const record = document.connections[component];
        const url = urls.get(component);
        // A token is bound to the server it was issued for (RFC 8707). A component whose address has
        // changed since needs a new sign-in, and saying so beats a launch that fails to authenticate.
        const moved = record !== undefined && url !== undefined && url !== record.serverUrl;
        return this.connectionOf(component, moved ? { ...record, needsSignIn: true } : record, held);
      });
  }

  private connectionOf(
    component: string,
    record: McpOAuthRecord | undefined,
    held: ReadonlySet<string>,
  ): McpOAuthConnection {
    const names = mcpOAuthSecretNames(component);
    const secrets = [names.access, names.refresh, names.client].filter(name => held.has(name));
    if (record === undefined || record.needsSignIn === true || !held.has(names.access))
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
    let redirectUri = MCP_OAUTH_LOOPBACK_REDIRECT;
    if (request.redirectUri !== undefined) {
      const checked = pwaRedirectUri(request.redirectUri);
      if (checked === undefined)
        throw new McpOAuthRefusal(
          'mcp_auth_bad_redirect',
          'That return address is not a Ferretry sign-in page, so no sign-in was started.',
        );
      redirectUri = checked;
    }
    const discovered = await this.discover(serverUrl);
    const registered = await this.register(component, discovered.server, redirectUri);
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
      mode: registered.registration.redirectUri === MCP_OAUTH_LOOPBACK_REDIRECT ? 'paste' : 'pwa',
      redirectUri: registered.registration.redirectUri,
      state,
      verifier: pkce.verifier,
      issuer: discovered.server.issuer,
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

  private flowView(flow: McpOAuthPendingFlow): McpOAuthFlow {
    return {
      flowId: flow.flowId,
      component: flow.component,
      authorizeUrl: flow.authorizeUrl,
      mode: flow.mode,
      redirectUri: flow.redirectUri,
      issuer: hostOf(flow.issuer),
      expiresAt: iso(flow.expiresAt),
      ...(flow.note === undefined ? {} : { note: flow.note }),
    };
  }

  private async serverOf(component: string): Promise<McpOAuthServer> {
    const server = (await this.deps.servers.list()).find(entry => entry.component === component);
    if (server === undefined)
      throw new McpOAuthRefusal('mcp_auth_unknown_component', `There is no MCP server named “${component}” here.`);
    if (server.url === undefined || server.auth !== 'oauth')
      throw new McpOAuthRefusal(
        'mcp_auth_not_oauth',
        `“${component}” is not a remote server that signs in. Turn on “Signs in with OAuth” for it first.`,
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

  /**
   * A client registration for this server and redirect: the one already held, or a new one (RFC 7591).
   *
   * A provider that refuses the PWA's address is asked once more with the loopback address, and the
   * flow becomes a paste flow — the person is told why in `note`.
   */
  private async register(
    component: string,
    server: AuthorizationServer,
    redirectUri: string,
  ): Promise<{ registration: McpOAuthRegistration; note?: string }> {
    const held = (await this.deps.state.read()).registrations[component] ?? [];
    const existing = held.find(entry => entry.issuer === server.issuer && entry.redirectUri === redirectUri);
    if (existing !== undefined) return { registration: existing };
    if (server.registrationEndpoint === undefined)
      throw new McpOAuthRefusal(
        'mcp_auth_registration',
        'This server’s sign-in provider does not let new apps register, so Ferretry cannot sign in to it yet.',
      );
    const answer = await this.requestRegistration(server.registrationEndpoint, redirectUri);
    if (answer.kind === 'redirect-refused' && redirectUri !== MCP_OAUTH_LOOPBACK_REDIRECT) {
      const fallback = await this.register(component, server, MCP_OAUTH_LOOPBACK_REDIRECT);
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
      redirectUri,
      clientId: answer.clientId,
      hasClientSecret: answer.clientSecret !== undefined,
    };
    await this.exclusive(async () => {
      if (answer.clientSecret !== undefined)
        await this.deps.secrets.put(mcpOAuthSecretNames(component).client, answer.clientSecret);
      const document = await this.deps.state.read();
      // A new client secret replaces the one the store held, so registrations that relied on the old
      // one are forgotten rather than left pointing at a value that is gone.
      const kept = (document.registrations[component] ?? []).filter(
        entry => !(answer.clientSecret !== undefined && entry.hasClientSecret),
      );
      await this.deps.state.write({
        ...document,
        registrations: { ...document.registrations, [component]: [...kept, registration] },
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
    const names = mcpOAuthSecretNames(flow.component);
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: checked.code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
      resource: flow.resource,
    });
    const answer = await this.tokenRequest(flow.tokenEndpoint, form, flow.hasClientSecret ? names.client : undefined);
    if (answer.kind === 'error') throw new McpOAuthRefusal('mcp_auth_exchange', tokenRefusal(answer.error));
    const now = this.deps.clock.now();
    const record: McpOAuthRecord = {
      serverUrl: flow.serverUrl,
      issuer: flow.issuer,
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
      await this.deps.secrets.put(names.access, answer.accessToken);
      if (answer.refreshToken === undefined) await this.deps.secrets.remove(names.refresh);
      else await this.deps.secrets.put(names.refresh, answer.refreshToken);
      const document = await this.deps.state.read();
      await this.deps.state.write({ ...document, connections: { ...document.connections, [flow.component]: record } });
    });
    const held = new Set((await this.deps.secrets.list()).map(summary => summary.name));
    return { component: flow.component, connection: this.connectionOf(flow.component, record, held) };
  }

  /** Ends a sign-in nobody will finish. */
  cancel(flowId: string): McpOAuthFlowCancelled {
    return { flowId, cancelled: this.flows.delete(flowId) };
  }

  /**
   * One POST to a token endpoint. A client secret, when registration returned one, is read out of the
   * store for this request only (`client_secret_post`).
   */
  private async tokenRequest(
    endpoint: string,
    form: URLSearchParams,
    clientSecret: SecretName | undefined,
  ): Promise<ReturnType<typeof tokenAnswer>> {
    if (clientSecret !== undefined) {
      const secret = (await this.deps.values.values()).get(clientSecret);
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
   * them. Called by the launch environment, never by a timer.
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
      const now = this.deps.clock.now();
      for (const [component, record] of Object.entries(document.connections)) {
        if (!wanted.has(mcpOAuthSecretNames(component).access)) continue;
        if (!record.renewable || record.needsSignIn === true || record.expiresAt === undefined) continue;
        if (Date.parse(record.expiresAt) - now > MCP_OAUTH_REFRESH_MARGIN_MS) continue;
        await this.refresh(component, record);
      }
    } catch {
      // A launch is never refused for this; see above.
    }
  }

  private async refresh(component: string, record: McpOAuthRecord): Promise<void> {
    const names = mcpOAuthSecretNames(component);
    const refreshToken = (await this.deps.values.values()).get(names.refresh);
    if (refreshToken === undefined) return await this.markNeedsSignIn(component);
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: record.clientId,
      resource: record.resource,
    });
    const answer = await this.tokenRequest(
      record.tokenEndpoint,
      form,
      record.hasClientSecret ? names.client : undefined,
    );
    if (answer.kind === 'error') {
      if (answer.error === 'invalid_grant') await this.markNeedsSignIn(component);
      return;
    }
    const now = this.deps.clock.now();
    await this.exclusive(async () => {
      await this.deps.secrets.put(names.access, answer.accessToken);
      // RFC 6749 §6: a provider may rotate the refresh token; one that does not keeps the old one valid.
      if (answer.refreshToken !== undefined) await this.deps.secrets.put(names.refresh, answer.refreshToken);
      const document = await this.deps.state.read();
      const current = document.connections[component];
      if (current === undefined) return;
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
    });
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
    const names = mcpOAuthSecretNames(component);
    const document = await this.deps.state.read();
    const record = document.connections[component];
    const revoked = record === undefined ? false : await this.revoke(record, names);
    return await this.exclusive(async () => {
      const removed = [
        await this.deps.secrets.remove(names.access),
        await this.deps.secrets.remove(names.refresh),
        await this.deps.secrets.remove(names.client),
      ].some(Boolean);
      const current = await this.deps.state.read();
      const { [component]: _connection, ...connections } = current.connections;
      const { [component]: _registrations, ...registrations } = current.registrations;
      await this.deps.state.write({ ...current, connections, registrations });
      return { component, removed: removed || record !== undefined, revoked };
    });
  }

  private async revoke(record: McpOAuthRecord, names: ReturnType<typeof mcpOAuthSecretNames>): Promise<boolean> {
    if (record.revocationEndpoint === undefined) return false;
    try {
      const values = await this.deps.values.values();
      const token = values.get(names.refresh) ?? values.get(names.access);
      if (token === undefined) return false;
      const form = new URLSearchParams({
        token,
        token_type_hint: values.has(names.refresh) ? 'refresh_token' : 'access_token',
        client_id: record.clientId,
      });
      const secret = record.hasClientSecret ? values.get(names.client) : undefined;
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
