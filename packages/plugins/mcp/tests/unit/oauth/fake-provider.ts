/**
 * A FAKE MCP server and OAuth 2.1 authorization server in one `fetch` handler — never a real provider,
 * never a real account. The unit tests call it in process; the integration test serves it on loopback.
 *
 * It implements just enough of RFC 9728, RFC 8414, RFC 7591, RFC 7636, RFC 6749 and RFC 7009 to hold the
 * daemon to them: it CHECKS the PKCE verifier against the challenge, refuses a code twice, binds a code
 * to its client and redirect, rotates refresh tokens, and records every token it ever issued so a test
 * can search everything the daemon produced for any of them.
 */

export interface FakeProviderOptions {
  /** Refuse to register any redirect address this matches, answering `invalid_redirect_uri`. */
  readonly refuseRedirect?: (redirectUri: string) => boolean;
  /** Seconds an access token lives. */
  readonly expiresIn?: number;
  /** Omit the refresh token. */
  readonly noRefresh?: boolean;
  /** Leave `S256` out of the metadata. */
  readonly noPkce?: boolean;
  /** Serve no registration endpoint. */
  readonly noRegistration?: boolean;
  /** Advertise no RFC 7009 revocation endpoint. */
  readonly noRevocation?: boolean;
  /** Serve no protected-resource metadata, so the MCP server is its own authorization server. */
  readonly legacy?: boolean;
  /** Return a client secret on registration. */
  readonly confidential?: boolean;
  /** Advertise RFC 9207 `authorization_response_iss_parameter_supported`. */
  readonly issParameterSupported?: boolean;
  /** Leave `iss` off the authorization response. */
  readonly omitIss?: boolean;
  /**
   * Refuse a registration request this matches, with the RFC 7591 §3.2.2 answer it returns — the knob for
   * a provider that wants another auth method, objects to a field, or will not take new apps at all.
   */
  readonly refuseRegistration?: (metadata: Readonly<Record<string, unknown>>) => RegistrationRefusal | undefined;
  /** Advertise RFC 8414 `token_endpoint_auth_methods_supported`. */
  readonly tokenAuthMethods?: readonly string[];
}

/** What a refusing registration endpoint answers. */
interface RegistrationRefusal {
  readonly status: number;
  readonly error?: string;
  readonly error_description?: string;
}

interface Pending {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly resource: string | null;
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeProvider {
  /** Every access, refresh and client secret ever issued — what must appear NOWHERE the daemon writes. */
  readonly issued: string[] = [];
  readonly authorizationCodes: string[] = [];
  readonly bearersSeen: string[] = [];
  readonly revoked: string[] = [];
  readonly registrations: { clientId: string; redirectUris: readonly string[]; secret?: string }[] = [];
  /** Every registration request's metadata, refused or not, in order. */
  readonly registrationRequests: Record<string, unknown>[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  /** Every token request's `Authorization` header (`undefined` when it had none), in order. */
  readonly tokenAuthorizations: (string | undefined)[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly accessTokens = new Set<string>();
  private counter = 0;
  /** When set, the token endpoint answers this error for every refresh. */
  refreshError: string | undefined;

  constructor(
    readonly origin: string,
    private readonly options: FakeProviderOptions = {},
  ) {}

  get issuer(): string {
    return this.options.legacy === true ? this.origin : `${this.origin}/auth`;
  }

  get serverUrl(): string {
    return `${this.origin}/mcp`;
  }

  private mint(prefix: string): string {
    this.counter += 1;
    const random = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    return `${prefix}-${String(this.counter)}-${random}`;
  }

  /** What a browser does after the person approves: follow the authorization URL to its redirect. */
  async approve(authorizeUrl: string): Promise<string> {
    const response = await this.handle(new Request(authorizeUrl));
    const location = response.headers.get('location');
    if (response.status !== 302 || location === null) throw new Error(`authorize answered ${String(response.status)}`);
    return location;
  }

  readonly handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const prefix = this.options.legacy === true ? '' : '/auth';
    if (path === '/mcp' || path.startsWith('/mcp/')) return this.mcp(request);
    if (path === '/.well-known/oauth-protected-resource/mcp' && this.options.legacy !== true)
      return json(200, {
        resource: this.serverUrl,
        authorization_servers: [this.issuer],
        scopes_supported: ['mcp:tools'],
      });
    const metadataPath =
      this.options.legacy === true
        ? '/.well-known/oauth-authorization-server'
        : '/.well-known/oauth-authorization-server/auth';
    if (path === metadataPath)
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.origin}${prefix}/authorize`,
        token_endpoint: `${this.origin}${prefix}/token`,
        ...(this.options.noRegistration === true ? {} : { registration_endpoint: `${this.origin}${prefix}/register` }),
        ...(this.options.noRevocation === true ? {} : { revocation_endpoint: `${this.origin}${prefix}/revoke` }),
        ...(this.options.noPkce === true ? {} : { code_challenge_methods_supported: ['S256'] }),
        ...(this.options.issParameterSupported === true
          ? { authorization_response_iss_parameter_supported: true }
          : {}),
        ...(this.options.tokenAuthMethods === undefined
          ? {}
          : { token_endpoint_auth_methods_supported: this.options.tokenAuthMethods }),
      });
    if (path === `${prefix}/register` && request.method === 'POST') return this.register(request);
    if (path === `${prefix}/authorize`) return this.authorize(url);
    if (path === `${prefix}/token` && request.method === 'POST') return this.token(request);
    if (path === `${prefix}/revoke` && request.method === 'POST') return this.revoke(request);
    return new Response('not found', { status: 404 });
  };

  private mcp(request: Request): Response {
    const authorization = request.headers.get('authorization');
    const bearer = authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : undefined;
    if (bearer !== undefined) this.bearersSeen.push(bearer);
    if (bearer === undefined || !this.accessTokens.has(bearer))
      return new Response(null, {
        status: 401,
        headers:
          this.options.legacy === true
            ? { 'www-authenticate': 'Bearer realm="fake"' }
            : {
                'www-authenticate': `Bearer realm="fake", resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
              },
      });
    return json(200, { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fake', version: '1' } } });
  }

  private async register(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown> & { redirect_uris?: string[] };
    this.registrationRequests.push(body);
    const redirectUris = body.redirect_uris ?? [];
    if (redirectUris.some(uri => this.options.refuseRedirect?.(uri) === true))
      return json(400, { error: 'invalid_redirect_uri', error_description: 'not allowed here' });
    const refusal = this.options.refuseRegistration?.(body);
    if (refusal !== undefined) {
      const { status, ...reason } = refusal;
      return json(status, reason);
    }
    const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : undefined;
    // RFC 7591 §2: a client that asks for a secret method — or names none, whose default is basic — gets one.
    const confidential = this.options.confidential === true || method !== 'none';
    const clientId = this.mint('client');
    if (!confidential) {
      this.registrations.push({ clientId, redirectUris });
      return json(201, { client_id: clientId });
    }
    const secret = this.mint('client-secret');
    this.issued.push(secret);
    this.registrations.push({ clientId, redirectUris, secret });
    return json(201, { client_id: clientId, client_secret: secret });
  }

  /** A client somebody registered here by hand, as a provider's console would. */
  preRegister(clientId: string, redirectUris: readonly string[], secret?: string): void {
    this.registrations.push({ clientId, redirectUris, ...(secret === undefined ? {} : { secret }) });
  }

  /**
   * RFC 6749 §2.3.1: a client with a secret proves it, in the form or as a Basic credential — the fake
   * holds the daemon to sending it, the right one, one way.
   */
  private clientAuthenticated(form: URLSearchParams, authorization: string | null): boolean {
    const registration = this.registrations.find(entry => entry.clientId === form.get('client_id'));
    if (registration?.secret === undefined) return true;
    const posted = form.get('client_secret');
    if (authorization?.startsWith('Basic ') === true) {
      if (posted !== null) return false;
      const [id, secret] = atob(authorization.slice('Basic '.length))
        .split(':')
        .map(part => decodeURIComponent(part.replaceAll('+', ' ')));
      return id === registration.clientId && secret === registration.secret;
    }
    return posted === registration.secret;
  }

  private authorize(url: URL): Response {
    const query = url.searchParams;
    const clientId = query.get('client_id') ?? '';
    const redirectUri = query.get('redirect_uri') ?? '';
    const registration = this.registrations.find(entry => entry.clientId === clientId);
    if (registration === undefined || !registration.redirectUris.includes(redirectUri))
      return new Response('unknown client or redirect', { status: 400 });
    if (query.get('code_challenge_method') !== 'S256' || query.get('code_challenge') === null)
      return new Response('pkce required', { status: 400 });
    const code = this.mint('code');
    this.authorizationCodes.push(code);
    this.pending.set(code, {
      clientId,
      redirectUri,
      challenge: query.get('code_challenge') as string,
      resource: query.get('resource'),
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', query.get('state') ?? '');
    if (this.options.omitIss !== true) back.searchParams.set('iss', this.issuer);
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  }

  private issue(): Response {
    const access = this.mint('access');
    this.issued.push(access);
    this.accessTokens.add(access);
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer', scope: 'mcp:tools' };
    if (this.options.expiresIn !== undefined) body.expires_in = this.options.expiresIn;
    if (this.options.noRefresh !== true) {
      const refresh = this.mint('refresh');
      this.issued.push(refresh);
      this.refreshTokens.set(refresh, access);
      body.refresh_token = refresh;
    }
    return json(200, body);
  }

  private async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    this.tokenRequests.push(form);
    this.tokenAuthorizations.push(request.headers.get('authorization') ?? undefined);
    if (!this.clientAuthenticated(form, request.headers.get('authorization')))
      return json(401, { error: 'invalid_client' });
    if (form.get('grant_type') === 'refresh_token') {
      if (this.refreshError !== undefined) return json(400, { error: this.refreshError });
      const refresh = form.get('refresh_token') ?? '';
      if (!this.refreshTokens.has(refresh)) return json(400, { error: 'invalid_grant' });
      this.refreshTokens.delete(refresh);
      return this.issue();
    }
    const code = form.get('code') ?? '';
    const pending = this.pending.get(code);
    this.pending.delete(code);
    if (pending === undefined) return json(400, { error: 'invalid_grant', error_description: `bad code ${code}` });
    const verifier = form.get('code_verifier') ?? '';
    const challenge = base64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    if (
      challenge !== pending.challenge ||
      form.get('client_id') !== pending.clientId ||
      form.get('redirect_uri') !== pending.redirectUri ||
      form.get('resource') !== pending.resource
    )
      return json(400, { error: 'invalid_grant' });
    return this.issue();
  }

  private async revoke(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const token = form.get('token') ?? '';
    this.revoked.push(token);
    this.refreshTokens.delete(token);
    this.accessTokens.delete(token);
    return new Response(null, { status: 200 });
  }
}
