import { secretsMatch } from '../../api/authentication.ts';
import {
  CONNECTOR_SCOPES,
  type ConnectorAccess,
  type ConnectorAccessVerifier,
  type ConnectorActResult,
  type ConnectorAuditSink,
  type ConnectorEndpoints,
  type ConnectorGrantView,
  type ConnectorOwnerActs,
  type ConnectorPendingView,
  type ConnectorScope,
} from '../ports.ts';
import {
  type ConnectorClient,
  type ConnectorClock,
  type ConnectorCrypto,
  type ConnectorGrant,
  type ConnectorMemory,
  type ConnectorState,
  type ConnectorStore,
  OAuthError,
  base64url,
  canonicalResource,
  digest,
  grantView,
} from './model.ts';
import type { ConnectorRateLimiter } from './rate-limiter.ts';

export interface RegisterInput {
  readonly client_name?: string;
  readonly redirect_uris: readonly string[];
  readonly grant_types?: readonly ('authorization_code' | 'refresh_token')[];
  readonly response_types?: readonly string[];
  readonly token_endpoint_auth_method?: ConnectorClient['authMethod'];
}
export interface AuthorizeInput {
  readonly response_type: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge?: string;
  readonly code_challenge_method?: string;
  readonly state?: string;
  readonly scope?: string;
  readonly resource?: string;
}
export interface ExchangeInput {
  readonly grant_type: string;
  readonly client_id: string;
  readonly client_secret?: string;
  readonly authMethod?: ConnectorClient['authMethod'];
  readonly code?: string;
  readonly redirect_uri?: string;
  readonly code_verifier?: string;
  readonly refresh_token?: string;
  readonly scope?: string;
  readonly resource?: string;
}
export type WaitResult =
  | { readonly kind: 'pending'; readonly pending: ConnectorPendingView }
  | { readonly kind: 'redirect'; readonly location: string };
export interface ConnectorAuthorityOptions {
  readonly clock: ConnectorClock;
  readonly crypto: ConnectorCrypto;
  readonly store: ConnectorStore;
  readonly audit: ConnectorAuditSink;
  readonly endpoints: ConnectorEndpoints;
  readonly allowedRedirectUris: readonly string[];
  readonly memory: ConnectorMemory;
  readonly limiter: ConnectorRateLimiter;
}

/**
 * The authorization server has no host privileges. Owner acts arrive through a separately authorized
 * boundary. All decisions, token rotations and revocations share one ephemeral transaction queue so two
 * requests can never spend the same code or refresh token concurrently. Storage failures fail closed.
 */
export class ConnectorAuthority implements ConnectorOwnerActs, ConnectorAccessVerifier {
  constructor(private readonly ports: ConnectorAuthorityOptions) {}

  /** HTTP takes admission before parsing a body; direct callers take it inside the corresponding act. */
  admit(endpoint: 'register' | 'authorize' | 'token'): void {
    this.ports.limiter.take(
      endpoint,
      endpoint === 'register' ? 10 : endpoint === 'authorize' ? 30 : 120,
      endpoint === 'register' ? 3_600_000 : 60_000,
    );
  }

  private now(): number {
    return this.ports.clock.now();
  }
  private instant(): string {
    return new Date(this.now()).toISOString();
  }
  private random(prefix = ''): string {
    return prefix + base64url(this.ports.crypto.randomBytes(32));
  }
  private id(prefix: string): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    return prefix + Array.from(this.ports.crypto.randomBytes(10), n => alphabet[n % 32]).join('');
  }
  private matchCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const chars = Array.from(this.ports.crypto.randomBytes(6), n => alphabet[n % alphabet.length]).join('');
    return `${chars.slice(0, 3)}-${chars.slice(3)}`;
  }
  private prune(): void {
    for (const [key, request] of this.ports.memory.pending) {
      if (Date.parse(request.view.expiresAt) <= this.now()) this.ports.memory.pending.delete(key);
    }
    // Used-code tombstones survive expiry for the live grant, so replay still revokes that grant.
    for (const [key, code] of this.ports.memory.codes) {
      if (code.expiresAt + 30 * 86_400_000 <= this.now()) this.ports.memory.codes.delete(key);
    }
  }
  private target(resource?: string): void {
    if (resource !== undefined && canonicalResource(resource) !== canonicalResource(this.ports.endpoints.resource)) {
      throw new OAuthError('invalid_target', 'The requested resource is not this connector.');
    }
  }
  private async audit(event: Parameters<ConnectorAuditSink['record']>[0]): Promise<void> {
    try {
      await this.ports.audit.record(event);
    } catch {
      /* The audit port never interrupts a decision. */
    }
  }
  private async saveGrant(state: ConnectorState, grant: ConnectorGrant): Promise<void> {
    await this.ports.store.save({ ...state, grants: state.grants.map(g => (g.id === grant.id ? grant : g)) });
  }
  private async revokeGrant(state: ConnectorState, grant: ConnectorGrant, actor: string): Promise<ConnectorGrant> {
    if (grant.revokedAt) return grant;
    const revoked = { ...grant, revokedAt: this.instant(), access: [], refresh: [] };
    await this.saveGrant(state, revoked);
    await this.audit({ kind: 'connector.grant.revoked', grantId: grant.id, actor });
    return revoked;
  }

  register(input: RegisterInput, admitted = false) {
    return this.ports.memory.run(async () => {
      if (!admitted) this.admit('register');
      if (
        input.redirect_uris.length < 1 ||
        input.redirect_uris.length > 5 ||
        input.redirect_uris.some(
          uri => uri !== 'https://claude.ai/api/mcp/auth_callback' && !this.ports.allowedRedirectUris.includes(uri),
        )
      ) {
        throw new OAuthError('invalid_redirect_uri', 'Every redirect URI must be explicitly allowed by this daemon.');
      }
      if (input.response_types && (input.response_types.length !== 1 || input.response_types[0] !== 'code'))
        throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.');
      const state = await this.ports.store.load();
      const clients = state.clients.filter(client => {
        const old = Date.parse(client.createdAt) + 86_400_000 < this.now();
        const live = state.grants.some(
          g =>
            g.clientId === client.id && !g.revokedAt && [...g.access, ...g.refresh].some(t => t.expiresAt > this.now()),
        );
        const waiting = [...this.ports.memory.pending.values()].some(
          p => p.clientId === client.id && Date.parse(p.view.expiresAt) > this.now(),
        );
        const redeemable = [...this.ports.memory.codes.values()].some(
          code => code.clientId === client.id && !code.used && code.expiresAt > this.now(),
        );
        return !old || live || waiting || redeemable;
      });
      if (clients.length >= 20)
        throw new OAuthError('invalid_client_metadata', 'The daemon has reached its registered client limit.');
      const method = input.token_endpoint_auth_method ?? 'none';
      const secret = method === 'none' ? undefined : this.random();
      const client: ConnectorClient = {
        id: this.id('fycl_'),
        name: (input.client_name ?? 'MCP client').replace(/\p{Cc}/gu, '').slice(0, 100),
        redirectUris: [...input.redirect_uris],
        grantTypes: [...(input.grant_types ?? ['authorization_code', 'refresh_token'])],
        authMethod: method,
        secretDigest: secret ? await digest(this.ports.crypto, secret) : undefined,
        createdAt: this.instant(),
      };
      await this.ports.store.save({ ...state, clients: [...clients, client] });
      await this.audit({ kind: 'connector.client.registered', clientId: client.id, clientName: client.name });
      return {
        client_id: client.id,
        client_name: client.name,
        client_secret: secret,
        client_secret_expires_at: secret ? 0 : undefined,
        client_id_issued_at: Math.floor(this.now() / 1000),
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: method,
      };
    });
  }

  startAuthorization(input: AuthorizeInput, admitted = false): Promise<string> {
    return this.ports.memory.run(async () => {
      if (!admitted) this.admit('authorize');
      this.prune();
      const state = await this.ports.store.load();
      const client = state.clients.find(c => c.id === input.client_id);
      if (!client) throw new OAuthError('invalid_request', 'Unknown client.');
      if (!client.redirectUris.includes(input.redirect_uri))
        throw new OAuthError('invalid_request', 'The redirect URI does not exactly match the registered client.');
      if (!client.grantTypes.includes('authorization_code'))
        throw new OAuthError('unauthorized_client', 'This client may not request authorization codes.');
      if (input.response_type !== 'code')
        throw new OAuthError('unsupported_response_type', 'Only code responses are supported.');
      if (
        input.code_challenge_method !== 'S256' ||
        !input.code_challenge ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge)
      )
        throw new OAuthError('invalid_request', 'PKCE with S256 is required.');
      this.target(input.resource);
      const requested = input.scope === undefined ? [...CONNECTOR_SCOPES] : input.scope.split(' ').filter(Boolean);
      if (requested.some(scope => !CONNECTOR_SCOPES.some(known => known === scope)))
        throw new OAuthError('invalid_scope', 'Only fleet:read and fleet:write are supported.');
      const scopes = CONNECTOR_SCOPES.filter(scope => requested.includes(scope));
      if ([...this.ports.memory.pending.values()].filter(p => !p.decision).length >= 5)
        throw new OAuthError('temporarily_unavailable', 'Five sign-ins are already waiting for approval.', 429, 60);
      const handle = this.random();
      const handleDigest = await digest(this.ports.crypto, handle);
      let id = this.id('cr_');
      let matchCode = this.matchCode();
      while ([...this.ports.memory.pending.values()].some(p => p.view.id === id || p.view.matchCode === matchCode)) {
        id = this.id('cr_');
        matchCode = this.matchCode();
      }
      this.ports.memory.pending.set(handleDigest, {
        handleDigest,
        clientId: client.id,
        redirectUri: input.redirect_uri,
        state: input.state,
        challenge: input.code_challenge,
        view: {
          id,
          matchCode,
          clientName: client.name,
          redirectHost: new URL(input.redirect_uri).host,
          scopes,
          createdAt: this.instant(),
          expiresAt: new Date(this.now() + 600_000).toISOString(),
        },
      });
      return `${this.ports.endpoints.issuer}/oauth/authorize/wait?h=${encodeURIComponent(handle)}`;
    });
  }

  pending(): Promise<readonly ConnectorPendingView[]> {
    return this.ports.memory.run(async () => {
      this.prune();
      return [...this.ports.memory.pending.values()].filter(p => !p.decision).map(p => structuredClone(p.view));
    });
  }
  grants(): Promise<readonly ConnectorGrantView[]> {
    return this.ports.memory.run(async () => (await this.ports.store.load()).grants.map(grantView));
  }
  private findRequest(id: string) {
    const match = id.toUpperCase().replaceAll('-', '');
    return [...this.ports.memory.pending.entries()].find(
      ([, p]) => p.view.id === id || p.view.matchCode.replaceAll('-', '') === match,
    );
  }
  approve(id: string, approvedBy: string): Promise<ConnectorActResult<ConnectorGrantView>> {
    return this.ports.memory.run(async () => {
      const found = this.findRequest(id);
      if (!found) return { ok: false, code: 'not_found', message: 'No matching sign-in.' };
      const [key, request] = found;
      if (Date.parse(request.view.expiresAt) <= this.now())
        return { ok: false, code: 'expired', message: 'This sign-in expired.' };
      if (request.decision) return { ok: false, code: 'already_decided', message: 'This sign-in was already decided.' };
      const state = await this.ports.store.load();
      const grant: ConnectorGrant = {
        id: this.id('cg_'),
        clientId: request.clientId,
        clientName: request.view.clientName,
        redirectHost: request.view.redirectHost,
        scopes: [...request.view.scopes],
        createdAt: this.instant(),
        approvedBy,
        access: [],
        refresh: [],
        usedRefresh: [],
      };
      await this.ports.store.save({ ...state, grants: [...state.grants, grant] });
      this.ports.memory.pending.set(key, { ...request, decision: 'approved', grantId: grant.id });
      await this.audit({
        kind: 'connector.grant.approved',
        grantId: grant.id,
        clientName: grant.clientName,
        actor: approvedBy,
      });
      return { ok: true, value: grantView(grant) };
    });
  }
  deny(id: string, deniedBy: string): Promise<ConnectorActResult<ConnectorPendingView>> {
    return this.ports.memory.run(async () => {
      const found = this.findRequest(id);
      if (!found) return { ok: false, code: 'not_found', message: 'No matching sign-in.' };
      const [key, request] = found;
      if (Date.parse(request.view.expiresAt) <= this.now())
        return { ok: false, code: 'expired', message: 'This sign-in expired.' };
      if (request.decision) return { ok: false, code: 'already_decided', message: 'This sign-in was already decided.' };
      this.ports.memory.pending.set(key, { ...request, decision: 'denied' });
      await this.audit({
        kind: 'connector.grant.denied',
        requestId: request.view.id,
        clientName: request.view.clientName,
        actor: deniedBy,
      });
      return { ok: true, value: structuredClone(request.view) };
    });
  }
  revoke(id: string, revokedBy: string): Promise<ConnectorActResult<ConnectorGrantView>> {
    return this.ports.memory.run(async () => {
      const state = await this.ports.store.load();
      const grant = state.grants.find(g => g.id === id);
      return grant
        ? { ok: true, value: grantView(await this.revokeGrant(state, grant, revokedBy)) }
        : { ok: false, code: 'not_found', message: 'No matching grant.' };
    });
  }

  waitPage(handle: string): Promise<WaitResult> {
    return this.ports.memory.run(async () => {
      this.prune();
      const key = await digest(this.ports.crypto, handle);
      const request = this.ports.memory.pending.get(key);
      if (!request) throw new OAuthError('invalid_request', 'This sign-in is unknown or expired. Start again.');
      if (!request.decision) return { kind: 'pending', pending: structuredClone(request.view) };
      const url = new URL(request.redirectUri);
      if (request.state !== undefined) url.searchParams.set('state', request.state);
      url.searchParams.set('iss', this.ports.endpoints.issuer);
      if (request.decision === 'denied') url.searchParams.set('error', 'access_denied');
      else {
        const state = await this.ports.store.load();
        const grant = state.grants.find(g => g.id === request.grantId && !g.revokedAt);
        if (!grant) throw new OAuthError('invalid_request', 'The approved grant is no longer valid.');
        const code = this.random();
        this.ports.memory.codes.set(await digest(this.ports.crypto, code), {
          grantId: grant.id,
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          challenge: request.challenge,
          expiresAt: this.now() + 60_000,
          used: false,
        });
        url.searchParams.set('code', code);
      }
      this.ports.memory.pending.delete(key);
      return { kind: 'redirect', location: url.href };
    });
  }

  private async authenticate(
    state: ConnectorState,
    input: Pick<ExchangeInput, 'client_id' | 'client_secret' | 'authMethod'>,
  ): Promise<ConnectorClient> {
    const client = state.clients.find(c => c.id === input.client_id);
    if (!client) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    this.ports.limiter.take(`token:${client.id}`, 30);
    const method = input.authMethod ?? (input.client_secret === undefined ? 'none' : 'client_secret_post');
    if (
      method !== client.authMethod ||
      (method !== 'none' &&
        (!input.client_secret ||
          !client.secretDigest ||
          !secretsMatch(await digest(this.ports.crypto, input.client_secret), client.secretDigest)))
    ) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }
    return client;
  }

  exchange(input: ExchangeInput, admitted = false) {
    return this.ports.memory.run(async () => {
      if (!admitted) this.admit('token');
      this.prune();
      const state = await this.ports.store.load();
      const client = await this.authenticate(state, input);
      this.target(input.resource);
      if (input.grant_type !== 'authorization_code' && input.grant_type !== 'refresh_token')
        throw new OAuthError('unsupported_grant_type', 'Unsupported grant type.');
      if (!client.grantTypes.includes(input.grant_type))
        throw new OAuthError('unauthorized_client', 'This client may not use this grant type.');
      let grant: ConnectorGrant | undefined;
      let scopes: readonly ConnectorScope[];
      if (input.grant_type === 'authorization_code') {
        const key = await digest(this.ports.crypto, input.code ?? '');
        const code = this.ports.memory.codes.get(key);
        if (!code || code.clientId !== client.id || code.redirectUri !== input.redirect_uri)
          throw new OAuthError('invalid_grant', 'Invalid authorization code.');
        grant = state.grants.find(g => g.id === code.grantId);
        if (code.used) {
          if (grant) await this.revokeGrant(state, grant, 'code-reuse');
          throw new OAuthError('invalid_grant', 'Authorization code was already used.');
        }
        if (
          !grant ||
          grant.revokedAt ||
          code.expiresAt <= this.now() ||
          !input.code_verifier ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier) ||
          !secretsMatch(base64url(await this.ports.crypto.sha256(input.code_verifier)), code.challenge)
        )
          throw new OAuthError('invalid_grant', 'Invalid or expired authorization code or verifier.');
        // Spend before any await that might fail; even failed persistence cannot make a code reusable.
        this.ports.memory.codes.set(key, { ...code, used: true });
        scopes = grant.scopes;
      } else {
        const key = await digest(this.ports.crypto, input.refresh_token ?? '');
        grant = state.grants.find(
          g => g.clientId === client.id && (g.refresh.some(t => t.digest === key) || g.usedRefresh.includes(key)),
        );
        if (!grant || grant.revokedAt) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
        if (grant.usedRefresh.includes(key)) {
          await this.revokeGrant(state, grant, 'refresh-reuse');
          await this.audit({ kind: 'connector.refresh.reused', grantId: grant.id });
          throw new OAuthError('invalid_grant', 'Refresh token was already used.');
        }
        const token = grant.refresh.find(t => t.digest === key);
        if (!token || token.expiresAt <= this.now() || token.audience !== this.ports.endpoints.resource)
          throw new OAuthError('invalid_grant', 'Invalid or expired refresh token.');
        scopes =
          input.scope === undefined
            ? token.scopes
            : ([...new Set(input.scope.split(' ').filter(Boolean))] as ConnectorScope[]);
        if (scopes.some(scope => !token.scopes.includes(scope)))
          throw new OAuthError('invalid_scope', 'A refresh cannot increase its granted scopes.');
        grant = {
          ...grant,
          refresh: grant.refresh.filter(t => t.digest !== key),
          usedRefresh: [...grant.usedRefresh, key],
        };
      }
      const access = this.random('fyc_at_');
      const refresh = client.grantTypes.includes('refresh_token') ? this.random('fyc_rt_') : undefined;
      const audience = this.ports.endpoints.resource;
      const updated: ConnectorGrant = {
        ...grant,
        access: [
          ...grant.access.filter(t => t.expiresAt > this.now()),
          {
            digest: await digest(this.ports.crypto, access),
            expiresAt: this.now() + 3_600_000,
            audience,
            scopes: [...scopes],
          },
        ],
        refresh: [
          ...grant.refresh.filter(t => t.expiresAt > this.now()),
          ...(refresh
            ? [
                {
                  digest: await digest(this.ports.crypto, refresh),
                  expiresAt: this.now() + 30 * 86_400_000,
                  audience,
                  scopes: [...scopes],
                },
              ]
            : []),
        ],
      };
      await this.saveGrant(state, updated);
      return {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refresh,
        scope: scopes.join(' '),
      };
    });
  }

  revokeToken(
    input: Pick<ExchangeInput, 'client_id' | 'client_secret' | 'authMethod'> & { readonly token: string },
    admitted = false,
  ): Promise<void> {
    return this.ports.memory.run(async () => {
      if (!admitted) this.admit('token');
      const state = await this.ports.store.load();
      const client = await this.authenticate(state, input);
      const key = await digest(this.ports.crypto, input.token);
      const grant = state.grants.find(
        g =>
          g.clientId === client.id &&
          (g.access.some(t => t.digest === key) ||
            g.refresh.some(t => t.digest === key) ||
            g.usedRefresh.includes(key)),
      );
      if (grant) await this.revokeGrant(state, grant, `client:${client.id}`);
    });
  }

  async verify(bearer: string): Promise<ConnectorAccess | undefined> {
    if (!/^fyc_at_[A-Za-z0-9_-]{43}$/.test(bearer)) return undefined;
    try {
      return await this.ports.memory.run(async () => {
        const key = await digest(this.ports.crypto, bearer);
        const state = await this.ports.store.load();
        for (const grant of state.grants) {
          const token = grant.access.find(t => t.digest === key);
          if (
            !token ||
            grant.revokedAt ||
            token.expiresAt <= this.now() ||
            token.audience !== this.ports.endpoints.resource
          )
            continue;
          if (!grant.lastUsedAt || Date.parse(grant.lastUsedAt) + 60_000 <= this.now())
            await this.saveGrant(state, { ...grant, lastUsedAt: this.instant() });
          return {
            grantId: grant.id,
            tokenId: key.slice(0, 12),
            scopes: [...token.scopes],
            clientName: grant.clientName,
          };
        }
        return undefined;
      });
    } catch {
      return undefined;
    }
  }
}
