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
  type ConnectorRevocationInitiator,
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
  type PendingAuthorization,
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
 * Where a request came from. `source` is `ApiRequest.clientAddress` (the listener sets it from the tunnel's
 * CF-Connecting-IP); absent means every such request shares one `unknown` bucket. `admitted` says the HTTP layer
 * already took admission (before parsing a body) so the act does not take it twice.
 */
export interface Arrival {
  readonly source?: string;
  readonly admitted?: boolean;
}

const UNKNOWN_SOURCE = 'unknown';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Admission budgets, taken before a body is parsed. Every anonymous endpoint is limited PER SOURCE first, so one
 * address cannot spend what another needs, and then against a higher global ceiling. The token endpoint has no
 * global ceiling on purpose: a valid refresh must never be starved by anonymous traffic, so only a source's own
 * volume, its own failures and the authenticated client's own successes are ever counted against it.
 */
const ADMISSION: Readonly<
  Record<'register' | 'authorize' | 'wait' | 'token', { source: number; all?: number; windowMs: number }>
> = {
  register: { source: 10, all: 200, windowMs: HOUR },
  authorize: { source: 20, all: 300, windowMs: MINUTE },
  wait: { source: 60, all: 1200, windowMs: MINUTE },
  token: { source: 120, windowMs: MINUTE },
};
/** A source whose token or revocation requests keep failing is slowed down; successes cost it nothing here. */
const TOKEN_FAILURES = { limit: 30, windowMs: 5 * MINUTE };
/** Successful token requests per authenticated client per minute; only a holder of a valid credential spends it. */
const CLIENT_TOKENS_PER_MINUTE = 30;
const MAX_CLIENTS = 20;
/** A client that never reached a sign-in or a grant is reclaimable this long after it registered. */
const UNUSED_CLIENT_GRACE_MS = HOUR;
const MAX_PENDING = 10;
const MAX_PENDING_PER_SOURCE = 3;
const MAX_PENDING_PER_CLIENT = 2;

/**
 * The authorization server has no host privileges. Owner acts arrive through a separately authorized boundary.
 * Everything that writes shares one ephemeral transaction queue (`ConnectorMemory`) so two requests can never
 * spend the same code or refresh token concurrently; its lanes put the owner's acts ahead of every public one
 * and bound the public ones. The public READ paths — a bearer check, a waiting-page poll, an unknown credential —
 * are answered from the in-memory digest index the writes keep current and never enter the queue. Storage
 * failures fail closed.
 */
export class ConnectorAuthority implements ConnectorOwnerActs, ConnectorAccessVerifier {
  constructor(private readonly ports: ConnectorAuthorityOptions) {}

  /** HTTP takes admission before parsing a body; direct callers take it inside the corresponding act. */
  admit(endpoint: 'register' | 'authorize' | 'wait' | 'token', source: string = UNKNOWN_SOURCE): void {
    const rule = ADMISSION[endpoint];
    this.ports.limiter.take(`${endpoint}:source:${this.sourceKey(source)}`, rule.source, rule.windowMs);
    if (rule.all !== undefined) this.ports.limiter.take(`${endpoint}:all`, rule.all, rule.windowMs);
  }

  private sourceKey(source: string | undefined): string {
    return (source ?? '').slice(0, 64) || UNKNOWN_SOURCE;
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
      if (code.expiresAt + 30 * DAY <= this.now()) this.ports.memory.codes.delete(key);
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
  /** The persisted state, loaded into the digest index once; afterwards every write keeps the index current. */
  private ready(): Promise<void> {
    return this.ports.memory.index.ensure(() => this.ports.store.load());
  }
  private async persist(state: ConnectorState): Promise<void> {
    await this.ports.store.save(state);
    this.ports.memory.index.replace(state);
  }
  private saveGrant(state: ConnectorState, grant: ConnectorGrant): Promise<void> {
    return this.persist({ ...state, grants: state.grants.map(g => (g.id === grant.id ? grant : g)) });
  }
  private async revokeGrant(
    state: ConnectorState,
    grant: ConnectorGrant,
    actor: string,
    initiator: ConnectorRevocationInitiator,
  ): Promise<ConnectorGrant> {
    if (grant.revokedAt) return grant;
    const revoked = { ...grant, revokedAt: this.instant(), access: [], refresh: [] };
    await this.saveGrant(state, revoked);
    await this.audit({ kind: 'connector.grant.revoked', grantId: grant.id, actor, initiator });
    return revoked;
  }
  /** An allowed URI is Claude's callback or one this daemon's CURRENT configuration lists. */
  private redirectAllowed(uri: string): boolean {
    return uri === CLAUDE_CALLBACK || this.ports.allowedRedirectUris.includes(uri);
  }

  async register(input: RegisterInput, arrival: Arrival = {}) {
    if (!arrival.admitted) this.admit('register', arrival.source);
    if (
      input.redirect_uris.length < 1 ||
      input.redirect_uris.length > 5 ||
      input.redirect_uris.some(uri => !this.redirectAllowed(uri))
    )
      throw new OAuthError('invalid_redirect_uri', 'Every redirect URI must be explicitly allowed by this daemon.');
    if (input.response_types && (input.response_types.length !== 1 || input.response_types[0] !== 'code'))
      throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported.');
    return this.registerClient(input);
  }

  /** A client nobody is using: no sign-in waiting, no code to redeem, no live token, and past its grace. */
  private reclaimable(client: ConnectorClient, state: ConnectorState): boolean {
    const now = this.now();
    const waiting = [...this.ports.memory.pending.values()].some(
      p => p.clientId === client.id && Date.parse(p.view.expiresAt) > now,
    );
    const redeemable = [...this.ports.memory.codes.values()].some(
      code => code.clientId === client.id && !code.used && code.expiresAt > now,
    );
    const grants = state.grants.filter(g => g.clientId === client.id);
    const live = grants.some(g => !g.revokedAt && [...g.access, ...g.refresh].some(t => t.expiresAt > now));
    if (waiting || redeemable || live) return false;
    const age = now - Date.parse(client.createdAt);
    return grants.length === 0 ? age >= UNUSED_CLIENT_GRACE_MS : age > DAY;
  }

  private async registerClient(input: RegisterInput) {
    const method = input.token_endpoint_auth_method ?? 'none';
    const secret = method === 'none' ? undefined : this.random();
    const secretDigest = secret ? await digest(this.ports.crypto, secret) : undefined;
    return this.ports.memory.run(async () => {
      const state = await this.ports.store.load();
      const clients = state.clients.filter(client => !this.reclaimable(client, state));
      if (clients.length >= MAX_CLIENTS)
        throw new OAuthError('invalid_client_metadata', 'The daemon has reached its registered client limit.');
      const client: ConnectorClient = {
        id: this.id('fycl_'),
        name: (input.client_name ?? 'MCP client').replace(/\p{Cc}/gu, '').slice(0, 100),
        redirectUris: [...input.redirect_uris],
        grantTypes: [...(input.grant_types ?? ['authorization_code', 'refresh_token'])],
        authMethod: method,
        secretDigest,
        createdAt: this.instant(),
      };
      await this.persist({ ...state, clients: [...clients, client] });
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

  /**
   * RFC 6749 §4.1.2.1: once the client and its redirect URI are trusted, a protocol error goes back to that
   * redirect URI (error, error_description, state, iss) instead of a local page.
   */
  private redirecting<T>(input: AuthorizeInput, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      const url = new URL(input.redirect_uri);
      url.searchParams.set('error', error.error);
      url.searchParams.set('error_description', error.description);
      if (input.state !== undefined) url.searchParams.set('state', input.state);
      url.searchParams.set('iss', this.ports.endpoints.issuer);
      throw new OAuthError(error.error, error.description, error.status, error.retryAfter, url.href);
    }
  }

  private evictOldest(matches: (request: PendingAuthorization) => boolean): void {
    for (const [key, request] of this.ports.memory.pending) {
      if (!request.decision && matches(request)) {
        this.ports.memory.pending.delete(key);
        return;
      }
    }
  }
  /** Room for one more undecided sign-in: a client or source over its share loses its OWN oldest first. */
  private makeRoom(clientId: string, source: string): void {
    const undecided = () => [...this.ports.memory.pending.values()].filter(p => !p.decision);
    const sourceOf = (p: PendingAuthorization) => p.source ?? UNKNOWN_SOURCE;
    while (undecided().filter(p => p.clientId === clientId).length >= MAX_PENDING_PER_CLIENT)
      this.evictOldest(p => p.clientId === clientId);
    while (undecided().filter(p => sourceOf(p) === source).length >= MAX_PENDING_PER_SOURCE)
      this.evictOldest(p => sourceOf(p) === source);
    while (undecided().length >= MAX_PENDING) {
      const counts = new Map<string, number>();
      for (const p of undecided()) counts.set(sourceOf(p), (counts.get(sourceOf(p)) ?? 0) + 1);
      const heaviest = [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
      this.evictOldest(p => sourceOf(p) === heaviest[0]);
    }
  }

  /** Reads the digest index and the in-memory sign-ins only: it never enters the write queue. */
  async startAuthorization(input: AuthorizeInput, arrival: Arrival = {}): Promise<string> {
    const source = this.sourceKey(arrival.source);
    if (!arrival.admitted) this.admit('authorize', source);
    await this.ready();
    const client = this.ports.memory.index.client(input.client_id);
    if (!client) throw new OAuthError('invalid_request', 'Unknown client.');
    if (!client.redirectUris.includes(input.redirect_uri) || !this.redirectAllowed(input.redirect_uri))
      throw new OAuthError('invalid_request', 'The redirect URI does not exactly match the registered client.');
    const scopes = this.redirecting(input, () => {
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
      return CONNECTOR_SCOPES.filter(scope => requested.includes(scope));
    });
    const handle = this.random();
    const handleDigest = await digest(this.ports.crypto, handle);
    // Everything from here is synchronous, so the caps and the insert can never interleave with another sign-in.
    this.prune();
    this.makeRoom(client.id, source);
    let id = this.id('cr_');
    let matchCode = this.matchCode();
    while ([...this.ports.memory.pending.values()].some(p => p.view.id === id || p.view.matchCode === matchCode)) {
      id = this.id('cr_');
      matchCode = this.matchCode();
    }
    this.ports.memory.pending.set(handleDigest, {
      handleDigest,
      clientId: client.id,
      source,
      redirectUri: input.redirect_uri,
      state: input.state,
      challenge: input.code_challenge ?? '',
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
  }

  pending(): Promise<readonly ConnectorPendingView[]> {
    return this.ports.memory.run(async () => {
      this.prune();
      return [...this.ports.memory.pending.values()].filter(p => !p.decision).map(p => structuredClone(p.view));
    }, 'owner');
  }
  grants(): Promise<readonly ConnectorGrantView[]> {
    return this.ports.memory.run(async () => (await this.ports.store.load()).grants.map(grantView), 'owner');
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
      await this.persist({ ...state, grants: [...state.grants, grant] });
      this.ports.memory.pending.set(key, { ...request, decision: 'approved', grantId: grant.id });
      await this.audit({
        kind: 'connector.grant.approved',
        grantId: grant.id,
        clientName: grant.clientName,
        actor: approvedBy,
      });
      return { ok: true, value: grantView(grant) };
    }, 'owner');
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
    }, 'owner');
  }
  revoke(id: string, revokedBy: string): Promise<ConnectorActResult<ConnectorGrantView>> {
    return this.ports.memory.run(async () => {
      const state = await this.ports.store.load();
      const grant = state.grants.find(g => g.id === id);
      return grant
        ? { ok: true, value: grantView(await this.revokeGrant(state, grant, revokedBy, 'owner')) }
        : { ok: false, code: 'not_found', message: 'No matching grant.' };
    }, 'owner');
  }

  /** Answered from memory: an unknown handle is refused, and the approved path needs no stored state. */
  async waitPage(handle: string, arrival: Arrival = {}): Promise<WaitResult> {
    if (!arrival.admitted) this.admit('wait', arrival.source);
    this.prune();
    const key = await digest(this.ports.crypto, handle);
    const request = this.ports.memory.pending.get(key);
    if (!request) throw new OAuthError('invalid_request', 'This sign-in is unknown or expired. Start again.');
    if (!request.decision) return { kind: 'pending', pending: structuredClone(request.view) };
    // The handle is spent before anything else can run, so two polls never both mint a code.
    this.ports.memory.pending.delete(key);
    const url = new URL(request.redirectUri);
    if (request.state !== undefined) url.searchParams.set('state', request.state);
    url.searchParams.set('iss', this.ports.endpoints.issuer);
    if (request.decision === 'denied') url.searchParams.set('error', 'access_denied');
    else {
      // An approval persisted before it was recorded, so the index already knows whether its grant is live.
      if (!request.grantId || !this.ports.memory.index.grantLive(request.grantId))
        throw new OAuthError('invalid_request', 'The approved grant is no longer valid.');
      const code = this.random();
      this.ports.memory.codes.set(await digest(this.ports.crypto, code), {
        grantId: request.grantId,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        challenge: request.challenge,
        expiresAt: this.now() + 60_000,
        used: false,
      });
      url.searchParams.set('code', code);
    }
    return { kind: 'redirect', location: url.href };
  }

  /** Authenticates against the index, so a bad client never reaches the queue. */
  private async authenticate(input: Pick<ExchangeInput, 'client_id' | 'client_secret' | 'authMethod'>) {
    const client = this.ports.memory.index.client(input.client_id);
    if (!client) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
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

  /**
   * Runs a token-endpoint act for one source: refused up front when that source's recent attempts keep failing,
   * and charged for it when this one fails. Anonymous noise therefore spends only its own source's budget.
   */
  private async guarded<T>(source: string, operation: () => Promise<T>): Promise<T> {
    const key = `token-failures:${source}`;
    this.ports.limiter.check(key, TOKEN_FAILURES.limit);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OAuthError && error.status >= 400 && error.status < 500 && error.status !== 429)
        this.ports.limiter.record(key, TOKEN_FAILURES.windowMs);
      throw error;
    }
  }

  async exchange(input: ExchangeInput, arrival: Arrival = {}) {
    const source = this.sourceKey(arrival.source);
    if (!arrival.admitted) this.admit('token', source);
    return this.guarded(source, async () => {
      this.prune();
      await this.ready();
      const client = await this.authenticate(input);
      this.target(input.resource);
      const grantType = input.grant_type;
      if (grantType !== 'authorization_code' && grantType !== 'refresh_token')
        throw new OAuthError('unsupported_grant_type', 'Unsupported grant type.');
      if (!client.grantTypes.includes(grantType))
        throw new OAuthError('unauthorized_client', 'This client may not use this grant type.');
      const budget = `token:${client.id}`;
      this.ports.limiter.check(budget, CLIENT_TOKENS_PER_MINUTE);
      // A credential the daemon has never issued to this client is refused here, without taking a queue slot.
      if (grantType === 'authorization_code') {
        const code = this.ports.memory.codes.get(await digest(this.ports.crypto, input.code ?? ''));
        if (!code || code.clientId !== client.id) throw new OAuthError('invalid_grant', 'Invalid authorization code.');
      } else {
        const known = this.ports.memory.index.token(await digest(this.ports.crypto, input.refresh_token ?? ''));
        if (!known || known.kind === 'access' || known.clientId !== client.id)
          throw new OAuthError('invalid_grant', 'Invalid refresh token.');
      }
      const tokens = await this.ports.memory.run(() => this.redeem(input, grantType, client.id), 'token');
      this.ports.limiter.record(budget);
      return tokens;
    });
  }

  private async redeem(input: ExchangeInput, grantType: 'authorization_code' | 'refresh_token', clientId: string) {
    this.prune();
    const state = await this.ports.store.load();
    const client = state.clients.find(c => c.id === clientId);
    if (!client) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    let grant: ConnectorGrant | undefined;
    let scopes: readonly ConnectorScope[];
    if (grantType === 'authorization_code') {
      const key = await digest(this.ports.crypto, input.code ?? '');
      const code = this.ports.memory.codes.get(key);
      if (!code || code.clientId !== client.id || code.redirectUri !== input.redirect_uri)
        throw new OAuthError('invalid_grant', 'Invalid authorization code.');
      grant = state.grants.find(g => g.id === code.grantId);
      if (code.used) {
        if (grant) await this.revokeGrant(state, grant, 'code-reuse', 'reuse-detected');
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
        await this.revokeGrant(state, grant, 'refresh-reuse', 'reuse-detected');
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
                expiresAt: this.now() + 30 * DAY,
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
  }

  /** RFC 7009: a token this client does not hold is silently accepted, and only a held one takes a queue slot. */
  async revokeToken(
    input: Pick<ExchangeInput, 'client_id' | 'client_secret' | 'authMethod'> & { readonly token: string },
    arrival: Arrival = {},
  ): Promise<void> {
    const source = this.sourceKey(arrival.source);
    if (!arrival.admitted) this.admit('token', source);
    await this.guarded(source, async () => {
      await this.ready();
      const client = await this.authenticate(input);
      const held = this.ports.memory.index.token(await digest(this.ports.crypto, input.token));
      if (!held || held.clientId !== client.id) return;
      await this.ports.memory.run(async () => {
        const state = await this.ports.store.load();
        const grant = state.grants.find(g => g.id === held.grantId && g.clientId === client.id);
        if (grant) await this.revokeGrant(state, grant, `client:${client.id}`, 'client');
      }, 'token');
    });
  }

  /** Answered from the digest index: a bearer check never waits for, or delays, a write. */
  async verify(bearer: string): Promise<ConnectorAccess | undefined> {
    if (!/^fyc_at_[A-Za-z0-9_-]{43}$/.test(bearer)) return undefined;
    try {
      await this.ready();
      const key = await digest(this.ports.crypto, bearer);
      const token = this.ports.memory.index.token(key);
      if (token?.kind !== 'access' || token.expiresAt <= this.now() || token.audience !== this.ports.endpoints.resource)
        return undefined;
      this.recordUse(token.grantId);
      return {
        grantId: token.grantId,
        tokenId: key.slice(0, 12),
        scopes: [...token.scopes],
        clientName: token.clientName,
      };
    } catch {
      return undefined;
    }
  }

  /** Last-use bookkeeping is best effort: at most once a minute per grant, off the request, never blocking it. */
  private recordUse(grantId: string): void {
    const index = this.ports.memory.index;
    if (!index.shouldTouch(grantId, this.now())) return;
    this.ports.memory
      .run(async () => {
        const state = await this.ports.store.load();
        const grant = state.grants.find(g => g.id === grantId);
        if (grant && !grant.revokedAt && (!grant.lastUsedAt || Date.parse(grant.lastUsedAt) + MINUTE <= this.now()))
          await this.saveGrant(state, { ...grant, lastUsedAt: this.instant() });
      })
      .catch(() => index.forgetTouch(grantId));
  }
}
