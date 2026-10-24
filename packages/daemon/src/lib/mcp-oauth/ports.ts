/**
 * The seams the daemon's MCP sign-in needs (`docs/mcp-oauth.md`), and nothing that decides anything.
 *
 * The daemon is the OAuth CLIENT here, which makes it — unlike the harness sign-in — a holder of tokens.
 * So the one rule every port below is shaped around: a token goes from the network straight into the
 * secret store, and the only way back out is the launch environment. No port answers a value to a
 * caller that could show it to anybody.
 */

import type { McpOAuthRedirectMode, SecretName, SecretSummary } from '@ferretry/protocol';

/** One HTTP exchange, as the client needs it: a status, a header lookup and a bounded body. */
export interface McpOAuthHttpResponse {
  readonly status: number;
  header(name: string): string | undefined;
  /** At most the adapter's cap. Never logged, never put in an error message. */
  readonly text: string;
}

export interface McpOAuthHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * The network. The adapter never follows a redirect (a 3xx is answered as itself) and bounds both time
 * and size. A transport failure raises; the service turns it into words that quote nothing.
 */
export interface McpOAuthHttp {
  request(request: McpOAuthHttpRequest): Promise<McpOAuthHttpResponse>;
}

/** Randomness and hashing, injected so a test can pin a verifier and the lib holds no global. */
export interface McpOAuthCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(text: string): Promise<Uint8Array>;
}

/**
 * One MCP server, as far as signing in to it is concerned: a fleet component (`component` is its name),
 * or a project's `.mcp.json` server (`component` is its subject, `mcpProjectSubject`).
 */
export interface McpOAuthServer {
  readonly component: string;
  /**
   * A server that MAY sign in rather than one that must: a project server, which nothing marks
   * `auth: oauth`. It is listed among the connections only once it has a sign-in.
   */
  readonly optional?: true;
  /** Absent for a server Ferretry starts as a command: there is nothing to sign in to. */
  readonly url?: string;
  readonly auth?: 'oauth';
}

/** The configured MCP servers that can sign in. Read on every call: the configuration can change under the daemon. */
export interface McpOAuthServers {
  list(): Promise<readonly McpOAuthServer[]>;
}

/**
 * The management half of the secret store — `SecretDirectory` satisfies it. It can write and delete a
 * value and list names; it cannot read one.
 */
export interface McpOAuthSecretWriter {
  list(): Promise<readonly SecretSummary[]>;
  put(name: SecretName, value: string): Promise<SecretSummary>;
  remove(name: SecretName): Promise<boolean>;
}

/**
 * The opening half — `SecretVault` satisfies it. Held so a refresh token can be SPENT (refresh, revoke)
 * by this service, which sends it to the provider that issued it and to nobody else.
 */
export interface McpOAuthSecretValues {
  values(): Promise<ReadonlyMap<SecretName, string>>;
}

/** A client registration this daemon holds with one authorization server, for one redirect address. */
export interface McpOAuthRegistration {
  readonly issuer: string;
  readonly redirectUri: string;
  /** A loopback redirect whose address a person pastes back, rather than the PWA's callback page. */
  readonly paste?: true;
  readonly clientId: string;
  /** Whether registration returned a client secret, which then rests in the store under `_CLIENT`. */
  readonly hasClientSecret: boolean;
}

/** What is known about one component's sign-in that is NOT secret. */
export interface McpOAuthRecord {
  readonly serverUrl: string;
  readonly issuer: string;
  /** The redirect the code came back to, which names the registration (and any client secret). */
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientId: string;
  readonly hasClientSecret: boolean;
  readonly resource: string;
  readonly scope?: string;
  readonly signedInAt: string;
  readonly expiresAt?: string;
  readonly renewable: boolean;
  /** The provider rejected the refresh token: only a new sign-in helps. */
  readonly needsSignIn?: boolean;
}

/** The whole document at `<FY_HOME>/state/mcp-oauth.json`. It never holds a value from the store. */
export interface McpOAuthStateDocument {
  readonly v: 1;
  readonly registrations: Readonly<Record<string, readonly McpOAuthRegistration[]>>;
  readonly connections: Readonly<Record<string, McpOAuthRecord>>;
}

/** The durable document. `read` answers an empty document only for one that was never written. */
export interface McpOAuthStateStore {
  read(): Promise<McpOAuthStateDocument>;
  write(document: McpOAuthStateDocument): Promise<void>;
}

/** Milliseconds since the epoch. */
export interface McpOAuthClock {
  now(): number;
}

/** One sign-in in flight. Held in memory only: a daemon restart ends every sign-in. */
export interface McpOAuthPendingFlow {
  readonly flowId: string;
  readonly component: string;
  readonly mode: McpOAuthRedirectMode;
  readonly redirectUri: string;
  readonly state: string;
  readonly verifier: string;
  readonly issuer: string;
  /** The provider said it sends `iss` (RFC 9207), so a callback without one is refused. */
  readonly requireIss: boolean;
  readonly serverUrl: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientId: string;
  readonly hasClientSecret: boolean;
  readonly resource: string;
  readonly scope?: string;
  readonly authorizeUrl: string;
  readonly expiresAt: number;
  readonly note?: string;
}
