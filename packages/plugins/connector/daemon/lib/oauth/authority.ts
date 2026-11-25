import { secretsMatch } from '@ferretry/kernel/contract';
import { instantFromEpochMs, type Instant } from '@ferretry/std';
import {
  CLAUDE_REDIRECT_URI,
  CONNECTOR_SCOPES,
  type ConnectorClient,
  type ConnectorGrant,
  type ConnectorGrantView,
  type ConnectorPendingView,
  type ConnectorScope,
  type ConnectorState,
  type UsedRefresh,
} from '../../../contract/index.ts';
import type {
  ConnectorAccess,
  ConnectorAccessVerifier,
  ConnectorActResult,
  ConnectorAuditSink,
  ConnectorEndpoints,
  ConnectorOwnerActs,
  ConnectorRevocationInitiator,
} from '../ports.ts';
import {
  type ConnectorClock,
  type ConnectorCrypto,
  type ConnectorMemory,
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
/** A rotated-away refresh token is accepted once more for this long, so a lost response does not cost the grant. */
const REFRESH_RETRY_MS = MINUTE;
/** A revoked grant stays listed (and its record kept) this long, then is dropped on the next write. */
const REVOKED_RETENTION_MS = 30 * DAY;

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
    this.ports.limiter.take(`${endpoint}:source:${this.sourceKey(source)}`, rule.source, rule.windowMs, 'source');
    if (rule.all !== undefined) this.ports.limiter.take(`${endpoint}:all`, rule.all, rule.windowMs);
  }

  private sourceKey(source: string | undefined): string {
    return (source ?? '').slice(0, 64) || UNKNOWN_SOURCE;
  }
  private now(): number {
    return this.ports.clock.now();
  }
  private instant(): Instant {
    return instantFromEpochMs(this.now());
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
  /**
   * Every write drops what can no longer matter: a revoked grant long after its revocation, and, from every other
   * grant, the rotated-away refresh tokens that have expired (an expired token replayed is just `invalid_grant`).
   */
  private tidy(state: ConnectorState): ConnectorState {
    const now = this.now();
    const grants = state.grants
      .filter(grant => !grant.revokedAt || Date.parse(grant.revokedAt) + REVOKED_RETENTION_MS > now)
      .map(grant => {
        const usedRefresh = grant.usedRefresh.filter(used => used.expiresAt > now);
        return usedRefresh.length === grant.usedRefresh.length &&
          usedRefresh.every((used, i) => used === grant.usedRefresh[i])
          ? grant
          : { ...grant, usedRefresh };
      });
    return { ...state, grants };
  }
  private async persist(state: ConnectorState): Promise<void> {
    const tidy = this.tidy(state);
    await this.ports.store.save(tidy);
    this.ports.memory.index.replace(tidy);
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
    const revoked = { ...grant, revokedAt: this.instant(), access: [], refresh: [], usedRefresh: [] };
    await this.saveGrant(state, revoked);
    await this.audit({ kind: 'connector.grant.revoked', grantId: grant.id, actor, initiator });
    return revoked;
  }
  /** An allowed URI is Claude's callback or one this daemon's CURRENT configuration lists. */
  private redirectAllowed(uri: string): boolean {
    return uri === CLAUDE_REDIRECT_URI || this.ports.allowedRedirectUris.includes(uri);
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

  /** A client holding nothing: no grant at all, no sign-in waiting and no code to redeem — whatever its age. */
  private holdsNothing(client: ConnectorClient, state: ConnectorState): boolean {
    const now = this.now();
    return (
      !state.grants.some(g => g.clientId === client.id) &&
      ![...this.ports.memory.pending.values()].some(
        p => p.clientId === client.id && Date.parse(p.view.expiresAt) > now,
      ) &&
      ![...this.ports.memory.codes.values()].some(
        code => code.clientId === client.id && !code.used && code.expiresAt > now,
      )
    );
  }

  private async registerClient(input: RegisterInput) {
    const method = input.token_endpoint_auth_method ?? 'none';
    const secret = method === 'none' ? undefined : this.random();
    const secretDigest = secret ? await digest(this.ports.crypto, secret) : undefined;
    return this.ports.memory.run(async () => {
      const state = await this.ports.store.load();
      const clients = state.clients.filter(client => !this.reclaimable(client, state));
      // Every slot taken: a client that never reached anything is dropped, oldest first, grace or not, so a
      // flood of registrations spends its own slots and the owner's next real one still finds room.
      if (clients.length >= MAX_CLIENTS) {
        const idle = clients.findIndex(client => this.holdsNothing(client, state));
        if (idle >= 0) clients.splice(idle, 1);
      }
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
  /**
   * Room for one more undecided sign-in: a client or source over its share loses its OWN oldest first. Over the
   * overall cap, only a source holding MORE than one sign-in gives one up (the busiest, and on a tie the one whose
   * sign-in is newest); when every source holds exactly one, nobody holds more than their share and the newcomer
   * is refused, so an existing sign-in — usually the owner's — is never displaced by a tie.
   */
  private makeRoom(clientId: string, source: string): void {
    const undecided = () => [...this.ports.memory.pending.values()].filter(p => !p.decision);
    const sourceOf = (p: PendingAuthorization) => p.source ?? UNKNOWN_SOURCE;
    while (undecided().filter(p => p.clientId === clientId).length >= MAX_PENDING_PER_CLIENT)
      this.evictOldest(p => p.clientId === clientId);
    while (undecided().filter(p => sourceOf(p) === source).length >= MAX_PENDING_PER_SOURCE)
      this.evictOldest(p => sourceOf(p) === source);
    while (undecided().length >= MAX_PENDING) {
      const counts = new Map<string, number>();
      const newest = new Map<string, number>();
      for (const [index, p] of undecided().entries()) {
        counts.set(sourceOf(p), (counts.get(sourceOf(p)) ?? 0) + 1);
        newest.set(sourceOf(p), index);
      }
      const heaviest = [...counts.entries()].reduce((best, entry) => {
        if (entry[1] !== best[1]) return entry[1] > best[1] ? entry : best;
        return (newest.get(entry[0]) ?? 0) > (newest.get(best[0]) ?? 0) ? entry : best;
      });
      if (heaviest[1] <= 1)
        throw new OAuthError(
          'temporarily_unavailable',
          'Too many sign-ins are waiting for approval. Please try again in a few minutes.',
          503,
        );
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
        expiresAt: instantFromEpochMs(this.now() + 600_000),
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
  // read-scoped: none — answers a match code, a client name and a redirect address, never pane text a redaction scope covers
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
        this.ports.limiter.record(key, TOKEN_FAILURES.windowMs, 'source');
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
      // The budget is judged again inside the serialized write: the check above ran before any queued redemption
      // had been charged, so a burst of callers would all have passed it.
      return this.ports.memory.run(async () => {
        this.ports.limiter.check(budget, CLIENT_TOKENS_PER_MINUTE);
        const issued = await this.redeem(input, grantType, client.id);
        this.ports.limiter.record(budget);
        return issued;
      }, 'token');
    });
  }

  private async redeem(input: ExchangeInput, grantType: 'authorization_code' | 'refresh_token', clientId: string) {
    this.prune();
    const state = await this.ports.store.load();
    const client = state.clients.find(c => c.id === clientId);
    if (!client) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    let grant: ConnectorGrant | undefined;
    let scopes: readonly ConnectorScope[];
    /** The refresh token being rotated, and (on a retry inside its window) the pair its first rotation issued. */
    let rotating: { readonly used: UsedRefresh; readonly retry: boolean } | undefined;
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
        g =>
          g.clientId === client.id &&
          (g.refresh.some(t => t.digest === key) || g.usedRefresh.some(u => u.digest === key)),
      );
      if (!grant || grant.revokedAt) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
      const used = grant.usedRefresh.find(u => u.digest === key);
      let token: ConnectorGrant['refresh'][number] | undefined;
      if (used) {
        // Past its own expiry a rotated-away token is just an invalid one; it is not evidence of theft.
        if (used.expiresAt <= this.now()) throw new OAuthError('invalid_grant', 'Invalid or expired refresh token.');
        // A lost response: the token rotated moments ago and nothing has used its successor yet.
        const successor = this.retryable(grant, used);
        if (!successor) {
          await this.revokeGrant(state, grant, 'refresh-reuse', 'reuse-detected');
          await this.audit({ kind: 'connector.refresh.reused', grantId: grant.id });
          throw new OAuthError('invalid_grant', 'Refresh token was already used.');
        }
        token = successor;
        rotating = { used, retry: true };
      } else token = grant.refresh.find(t => t.digest === key);
      if (!token || token.expiresAt <= this.now() || token.audience !== this.ports.endpoints.resource)
        throw new OAuthError('invalid_grant', 'Invalid or expired refresh token.');
      scopes =
        input.scope === undefined
          ? token.scopes
          : ([...new Set(input.scope.split(' ').filter(Boolean))] as ConnectorScope[]);
      if (scopes.some(scope => !token.scopes.includes(scope)))
        throw new OAuthError('invalid_scope', 'A refresh cannot increase its granted scopes.');
      // On a retry the pair the first rotation issued is superseded: the client never saw it, so it dies here.
      const superseded = used?.successors;
      grant = {
        ...grant,
        access: grant.access.filter(t => t.digest !== superseded?.access),
        refresh: grant.refresh.filter(t => t.digest !== key && t.digest !== superseded?.refresh),
      };
      rotating ??= { used: { digest: key, expiresAt: token.expiresAt, rotatedAt: this.now() }, retry: false };
    }
    const access = this.random('fyc_at_');
    const refresh = client.grantTypes.includes('refresh_token') ? this.random('fyc_rt_') : undefined;
    const audience = this.ports.endpoints.resource;
    const accessDigest = await digest(this.ports.crypto, access);
    const refreshDigest = refresh ? await digest(this.ports.crypto, refresh) : undefined;
    // Rotation is recorded with the digests of what it issued, so a retry can supersede exactly that pair.
    const rotated: UsedRefresh | undefined = rotating
      ? {
          ...rotating.used,
          // The one retry is consumed by the retry itself: with no successor pointer left, a further use of this
          // digest is reuse and revokes the family instead of minting another pair.
          successors: refreshDigest && !rotating.retry ? { access: accessDigest, refresh: refreshDigest } : undefined,
        }
      : undefined;
    const updated: ConnectorGrant = {
      ...grant,
      access: [
        ...grant.access.filter(t => t.expiresAt > this.now()),
        { digest: accessDigest, expiresAt: this.now() + 3_600_000, audience, scopes: [...scopes] },
      ],
      refresh: [
        ...grant.refresh.filter(t => t.expiresAt > this.now()),
        ...(refreshDigest
          ? [{ digest: refreshDigest, expiresAt: this.now() + 30 * DAY, audience, scopes: [...scopes] }]
          : []),
      ],
      usedRefresh: rotated
        ? [...grant.usedRefresh.filter(u => u.digest !== rotated.digest), rotated]
        : grant.usedRefresh,
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

  /**
   * The live refresh token a rotated-away one handed out, when presenting the old one again is a retry rather than
   * a theft: within a minute of the rotation and with nothing yet rotated from its successor. A token rotated two
   * generations ago, or one outside the window, has no such successor and revokes.
   */
  private retryable(grant: ConnectorGrant, used: UsedRefresh): ConnectorGrant['refresh'][number] | undefined {
    if (used.successors === undefined) return undefined;
    if (this.now() - used.rotatedAt > REFRESH_RETRY_MS) return undefined;
    const successor = used.successors.refresh;
    return grant.refresh.find(t => t.digest === successor);
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
