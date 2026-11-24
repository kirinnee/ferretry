import { z } from 'zod';
import { CONNECTOR_SCOPES, type ConnectorGrantView, type ConnectorPendingView, type ConnectorScope } from '../ports.ts';

const scopeSchema = z.enum(CONNECTOR_SCOPES);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const clientSchema = z.object({
  id: z.string().regex(/^fycl_[a-z2-7]{10}$/),
  name: z.string().max(100),
  redirectUris: z.array(z.string().url()).min(1).max(5),
  grantTypes: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2),
  authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
  secretDigest: digestSchema.optional(),
  createdAt: z.string().datetime(),
});
export type ConnectorClient = z.infer<typeof clientSchema>;
const tokenSchema = z.object({
  digest: digestSchema,
  expiresAt: z.number().finite(),
  audience: z.string(),
  scopes: z.array(scopeSchema),
});
/**
 * A refresh token that was rotated away. `expiresAt` is that token's OWN refresh expiry: once past it the token is
 * simply invalid, so the entry is dropped on the next write. `rotatedAt` and `successors` (the digests of the
 * access and refresh token its rotation issued) exist for the one-minute retry window after a lost response.
 * Both, and `expiresAt`, are absent on an entry written before they existed (a bare digest string in an old
 * `connector.json`, read as `{ digest }`): such an entry is stamped to expire 30 days from the next write of its
 * grant, and has no retry window — a reuse of it revokes, exactly as before.
 */
const usedRefreshSchema = z.preprocess(
  value => (typeof value === 'string' ? { digest: value } : value),
  z.object({
    digest: digestSchema,
    expiresAt: z.number().finite().optional(),
    rotatedAt: z.number().finite().optional(),
    successors: z.object({ access: digestSchema, refresh: digestSchema }).optional(),
  }),
);
export type UsedRefresh = z.infer<typeof usedRefreshSchema>;
const grantSchema = z.object({
  id: z.string().regex(/^cg_[a-z2-7]{10}$/),
  clientId: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  scopes: z.array(scopeSchema),
  createdAt: z.string().datetime(),
  approvedBy: z.string(),
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  access: z.array(tokenSchema),
  refresh: z.array(tokenSchema),
  usedRefresh: z.array(usedRefreshSchema),
});
export type ConnectorGrant = z.infer<typeof grantSchema>;
export const connectorStateSchema = z.object({
  version: z.literal(1),
  clients: z.array(clientSchema).max(20),
  grants: z.array(grantSchema),
});
export type ConnectorState = z.infer<typeof connectorStateSchema>;

/** No method on this port can receive a raw credential. A failed load must throw, never reset state. */
export interface ConnectorStore {
  load(): Promise<ConnectorState>;
  save(state: ConnectorState): Promise<void>;
}
export interface ConnectorClock {
  now(): number;
}
export interface ConnectorCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(text: string): Promise<Uint8Array>;
}

export interface PendingAuthorization {
  readonly view: ConnectorPendingView;
  readonly clientId: string;
  /** Where the sign-in came from (`ApiRequest.clientAddress`); absent counts as the shared `unknown` source. */
  readonly source?: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly challenge: string;
  readonly handleDigest: string;
  readonly decision?: 'approved' | 'denied';
  readonly grantId?: string;
}
export interface AuthorizationCode {
  readonly grantId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly expiresAt: number;
  readonly used: boolean;
}

/** What a presented token digest means, without touching storage. */
export interface IndexedToken {
  readonly kind: 'access' | 'refresh' | 'used-refresh';
  readonly grantId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly expiresAt: number;
  readonly audience: string;
  readonly scopes: readonly ConnectorScope[];
}

/**
 * A read-only mirror of the persisted state, keyed for the public paths: clients by id, tokens by digest, live
 * grants by id. Every write that reaches the store replaces it (`replace`), so a bearer check, a waiting-page
 * poll or a token request naming an unknown credential is answered from memory without entering the write
 * queue — public traffic cannot make the owner's approve/revoke wait. It holds digests, never a raw credential.
 */
export class ConnectorIndex {
  private clients = new Map<string, ConnectorClient>();
  private tokens = new Map<string, IndexedToken>();
  private live = new Set<string>();
  private built = false;
  private loading: Promise<void> | undefined;
  private readonly touched = new Map<string, number>();

  replace(state: ConnectorState): void {
    const clients = new Map<string, ConnectorClient>(state.clients.map(client => [client.id, client]));
    const tokens = new Map<string, IndexedToken>();
    const live = new Set<string>();
    for (const grant of state.grants) {
      if (grant.revokedAt) continue;
      live.add(grant.id);
      const base = { grantId: grant.id, clientId: grant.clientId, clientName: grant.clientName };
      for (const token of grant.access) tokens.set(token.digest, { ...base, ...token, kind: 'access' });
      for (const token of grant.refresh) tokens.set(token.digest, { ...base, ...token, kind: 'refresh' });
      for (const used of grant.usedRefresh)
        tokens.set(used.digest, { ...base, kind: 'used-refresh', expiresAt: 0, audience: '', scopes: [] });
    }
    this.clients = clients;
    this.tokens = tokens;
    this.live = live;
    this.built = true;
  }
  /** Loads the persisted state once; a write that lands first wins, and a failed load is retried by the next caller. */
  async ensure(load: () => Promise<ConnectorState>): Promise<void> {
    if (this.built) return;
    this.loading ??= load()
      .then(state => {
        if (!this.built) this.replace(state);
      })
      .finally(() => {
        this.loading = undefined;
      });
    await this.loading;
  }
  client(id: string): ConnectorClient | undefined {
    return this.clients.get(id);
  }
  token(digest: string): IndexedToken | undefined {
    return this.tokens.get(digest);
  }
  grantLive(id: string): boolean {
    return this.live.has(id);
  }
  /** True at most once a minute per grant: the caller then records the grant's last use. */
  shouldTouch(grantId: string, now: number): boolean {
    const last = this.touched.get(grantId);
    if (last !== undefined && last + 60_000 > now) return false;
    this.touched.set(grantId, now);
    return true;
  }
  forgetTouch(grantId: string): void {
    this.touched.delete(grantId);
  }
}

/**
 * The lanes of the one transaction queue. Persisted state is read-modify-write, so everything that writes shares
 * a single runner, but the lanes decide who waits: the owner's acts always run next, then token exchanges for a
 * credential the daemon actually knows, then everything anonymous (registration, last-use bookkeeping). Each
 * public lane is bounded, so a flood is refused (`temporarily_unavailable`) rather than queued without limit.
 */
export type QueueLane = 'owner' | 'token' | 'public';
const LANE_BOUNDS: Readonly<Record<QueueLane, number>> = { owner: Infinity, token: 64, public: 32 };
const LANE_ORDER: readonly QueueLane[] = ['owner', 'token', 'public'];

/** Ephemeral state and the transaction queue belong to one listener, shared by every authority call. */
export class ConnectorMemory {
  readonly pending = new Map<string, PendingAuthorization>();
  readonly codes = new Map<string, AuthorizationCode>();
  readonly index = new ConnectorIndex();
  private readonly lanes: Record<QueueLane, (() => Promise<void>)[]> = { owner: [], token: [], public: [] };
  private running = false;
  private drained: (() => void)[] = [];

  run<T>(operation: () => Promise<T>, lane: QueueLane = 'public'): Promise<T> {
    const queue = this.lanes[lane];
    if (queue.length >= LANE_BOUNDS[lane])
      return Promise.reject(
        new OAuthError('temporarily_unavailable', 'The connector is busy. Please try again shortly.', 503, 5),
      );
    return new Promise<T>((resolve, reject) => {
      queue.push(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      });
      this.pump();
    });
  }
  /** Resolves once nothing is running or queued. */
  idle(): Promise<void> {
    return this.running || LANE_ORDER.some(lane => this.lanes[lane].length > 0)
      ? new Promise(resolve => this.drained.push(resolve))
      : Promise.resolve();
  }
  private pump(): void {
    if (this.running) return;
    const lane = LANE_ORDER.find(name => this.lanes[name].length > 0);
    const job = lane === undefined ? undefined : this.lanes[lane].shift();
    if (!job) {
      for (const resolve of this.drained.splice(0)) resolve();
      return;
    }
    this.running = true;
    void job().then(() => {
      this.running = false;
      this.pump();
    });
  }
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly retryAfter?: number,
    /** RFC 6749 §4.1.2.1: where the user agent goes with this error, once client and redirect_uri are trusted. */
    readonly redirectTo?: string,
  ) {
    super(description);
  }
}

export function grantView(grant: ConnectorGrant): ConnectorGrantView {
  const { id, clientName, redirectHost, scopes, createdAt, approvedBy, lastUsedAt, revokedAt } = grant;
  return { id, clientName, redirectHost, scopes: [...scopes], createdAt, approvedBy, lastUsedAt, revokedAt };
}
export function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export async function digest(crypto: ConnectorCrypto, value: string): Promise<string> {
  return Array.from(await crypto.sha256(value), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function canonicalResource(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return undefined;
    return url.href.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}
