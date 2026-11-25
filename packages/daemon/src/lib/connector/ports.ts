/**
 * The remote MCP connector's shared seams (docs/mcp-connector.md). This file is the contract between the
 * authorization server (`./oauth/`), the MCP endpoint (`./mcp/`), the owner's `/v1/connector/*` routes and the
 * listener that serves them. It decides nothing.
 *
 * THE ONE RULE every type below is shaped around: a token, a code, a client secret or a waiting-page handle is
 * handed out exactly once — in the response that minted it — and is otherwise only ever HASHED. No type here can
 * carry one back to a caller, a log or a journal.
 */

/** The two scopes a connector grant may hold. */
export const CONNECTOR_SCOPES = ['fleet:read', 'fleet:write'] as const;
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

/**
 * Where the connector is published: `config/daemon.json` `connector.publicUrl`, or — when that names none — this
 * machine's built-in tunnel hostname. READ LAZILY: an implementation may answer from a getter, because the tunnel's
 * hostname is known only once provisioning has answered and can change. Nothing may cache a field.
 */
export interface ConnectorEndpoints {
  /** The `publicUrl` origin, no trailing slash. Also the OAuth issuer. */
  readonly issuer: string;
  /** `issuer + "/mcp"` — the protected resource and every token's audience. */
  readonly resource: string;
  /** `issuer + "/.well-known/oauth-protected-resource/mcp"`. */
  readonly resourceMetadataUrl: string;
  /** Where the waiting page's "Open Ferretry" link and the app's deep link point (FY_APP_URL or the hosted app). */
  readonly appOrigin: string;
  /** This daemon's id, so the app's deep link can name the machine. */
  readonly daemonId: string;
}

/** What `/mcp` learns from a valid access token. Never the token itself. */
export interface ConnectorAccess {
  readonly grantId: string;
  /** The first 12 hex characters of the access token's SHA-256 digest: an id for the calls log, never the token. */
  readonly tokenId: string;
  readonly scopes: readonly ConnectorScope[];
  readonly clientName: string;
}

/** Answers whether a presented bearer is a live access token for THIS resource. Constant work per call; never throws. */
export interface ConnectorAccessVerifier {
  verify(bearer: string): Promise<ConnectorAccess | undefined>;
}

/** A sign-in waiting for the owner, as the app and `fy connector` see it. No handle, no code. */
export interface ConnectorPendingView {
  /** Public id, `cr_` + 10 lowercase base32 characters. */
  readonly id: string;
  /** `XXX-XXX`, uppercase, from an alphabet without 0/O/1/I. Shown on the waiting page and in the app. */
  readonly matchCode: string;
  readonly clientName: string;
  /** The redirect URI's host, e.g. `claude.ai`. */
  readonly redirectHost: string;
  readonly scopes: readonly ConnectorScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** A live or revoked grant, as the app and `fy connector` see it. No token digest. */
export interface ConnectorGrantView {
  /** `cg_` + 10 lowercase base32 characters. */
  readonly id: string;
  readonly clientName: string;
  readonly redirectHost: string;
  readonly scopes: readonly ConnectorScope[];
  readonly createdAt: string;
  /** The actor that approved it: `device:<id>` (app, passkey) or `admin-cli` (at the machine). */
  readonly approvedBy: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

/** Why an owner act on a request or grant was refused, as words a person reads. */
export type ConnectorActRefusal =
  | { readonly code: 'not_found'; readonly message: string }
  | { readonly code: 'expired'; readonly message: string }
  | { readonly code: 'already_decided'; readonly message: string };

export type ConnectorActResult<T> =
  | { readonly ok: true; readonly value: T }
  | ({ readonly ok: false } & ConnectorActRefusal);

/**
 * The owner's half of the authorization server — what the `/v1/connector/*` routes and `fy connector` call.
 * Every caller of this has ALREADY been authorized by the route boundary (a person, with the `approve-connector`
 * step-up for `approve`); this interface re-checks nothing about who is asking.
 */
export interface ConnectorOwnerActs {
  pending(): Promise<readonly ConnectorPendingView[]>;
  grants(): Promise<readonly ConnectorGrantView[]>;
  /** By public id or by match code (case-insensitive, hyphen optional). `approvedBy` is the route's actor. */
  approve(idOrMatchCode: string, approvedBy: string): Promise<ConnectorActResult<ConnectorGrantView>>;
  deny(idOrMatchCode: string, deniedBy: string): Promise<ConnectorActResult<ConnectorPendingView>>;
  /** Revoking an already-revoked grant succeeds again (idempotent). */
  revoke(grantId: string, revokedBy: string): Promise<ConnectorActResult<ConnectorGrantView>>;
}

export type ConnectorRevocationInitiator = 'owner' | 'client' | 'reuse-detected';

/** The connector's security-log events (docs/audit.md). Names and ids only. */
export type ConnectorAuditEvent =
  | { readonly kind: 'connector.client.registered'; readonly clientId: string; readonly clientName: string }
  | {
      readonly kind: 'connector.grant.approved';
      readonly grantId: string;
      readonly clientName: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'connector.grant.denied';
      readonly requestId: string;
      readonly clientName: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'connector.grant.revoked';
      readonly grantId: string;
      /** The route's actor for an owner act; for the other initiators, a label only (never trusted as a person). */
      readonly actor: string;
      /**
       * WHO ended the grant: `owner` (an owner act — `actor` names them; the default when absent), `client` (the OAuth
       * client's own RFC 7009 revocation) or `reuse-detected` (a replayed authorization code or rotated refresh token).
       */
      readonly initiator?: ConnectorRevocationInitiator;
    }
  | { readonly kind: 'connector.refresh.reused'; readonly grantId: string }
  | {
      readonly kind: 'connector.tool';
      readonly grantId: string;
      readonly tool: string;
      readonly sessionId?: string;
      /** How the call ended; absent reads as `ok` (an event from before outcomes were recorded). */
      readonly outcome?: ConnectorToolOutcome;
    };

/** How a tool call ended: it did what was asked, it failed, or it was refused (by a gate, the tool or the daemon). */
export type ConnectorToolOutcome = 'ok' | 'error' | 'refused';

/** Where those events go. Never throws into a request. */
export interface ConnectorAuditSink {
  record(event: ConnectorAuditEvent): Promise<void>;
}

/**
 * One request to the daemon's OWN route table, in-process, as the owner, attributed to `connector:<grantId>`.
 * The listener wiring builds it from the main dispatcher (`fyd.ts`); the MCP tools only ever call this.
 * `path` is a route path the TOOL built from fixed templates and encoded parameters, never a caller's string.
 */
export interface ConnectorApiCall {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /**
   * Extra request headers, lower-cased names. ADDED by the MCP part: the daemon's start and restart routes
   * refuse a POST without `x-fy-request-id` (their retry contract), so a tool must be able to say one.
   * The listener wiring must pass these through to the dispatcher and let no other header through.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ConnectorApiAnswer {
  readonly status: number;
  /** The response body as text; JSON for every route the tools call. */
  readonly body: string;
}

export interface ConnectorApiDispatch {
  call(grantId: string, call: ConnectorApiCall): Promise<ConnectorApiAnswer>;
}

/**
 * A handler on the connector listener. `undefined` means "not my path" — the listener answers 404 when no
 * handler claims a request. Handlers receive the transport-free `ApiRequest` (`../api/http.ts`).
 */
export interface ConnectorHttpHandler {
  handle(request: import('../api/http.ts').ApiRequest): Promise<import('../api/http.ts').ApiResponse | undefined>;
}
