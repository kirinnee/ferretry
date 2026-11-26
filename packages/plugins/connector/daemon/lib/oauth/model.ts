import type {
  ConnectorClient,
  ConnectorGrant,
  ConnectorGrantView,
  ConnectorPendingView,
  ConnectorScope,
  ConnectorState,
} from '../../../contract/index.ts';

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
  /** The origin (OAuth issuer) this sign-in was started under; it is good for no other (see `ConnectorAuthority.trusted`). */
  readonly issuer: string;
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
  /** The origin (OAuth issuer) that issued this code; redeemed under any other it mints nothing. */
  readonly issuer: string;
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
      if (grant.revokedAt || grant.pending) continue;
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

/**
 * Why a sign-in could not continue, in the person's terms. Each reason has one page (`daemon/lib/http/pages.ts`) that says
 * what happened and how to connect again; the OAuth error code stays for Claude and for the small print.
 */
export type ReconnectReason = 'sign_in_gone' | 'cancelled' | 'unrecognised' | 'busy' | 'slow_down' | 'trouble';
/** The sentence every error Claude may show ends with: exactly where to connect again. */
export const RECONNECT_HINT = 'Reconnect in Claude: Settings > Connectors > Ferretry > Connect.';
/** The one description every dead grant, code or token carries, whatever made it unusable. */
export const DEAD_CONNECTION_TEXT = `This connection is no longer valid: it expired or was disconnected. ${RECONNECT_HINT}`;
/** The one description every `invalid_client` refusal carries, whatever made the client unacceptable. */
export const INVALID_CLIENT_TEXT = `Ferretry does not recognise this connection. ${RECONNECT_HINT}`;
/** What a person is told when a rotated-away credential is presented again and the grant is ended for safety. */
export const CANCELLED_FOR_SAFETY_TEXT = `Ferretry cancelled this connection to keep your account safe; connecting again is safe. ${RECONNECT_HINT}`;

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
    readonly retryAfter?: number,
    /** RFC 6749 §4.1.2.1: where the user agent goes with this error, once client and redirect_uri are trusted. */
    readonly redirectTo?: string,
    /** Which "connect again" page a person sees for this failure; absent means it is chosen from the status. */
    readonly reason?: ReconnectReason,
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
