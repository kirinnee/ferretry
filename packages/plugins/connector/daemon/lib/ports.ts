/**
 * The connector's seams between the authorization server (`./oauth/`), the MCP endpoint, the owner's routes and the
 * door that serves them (docs/mcp-connector.md). This file decides nothing.
 *
 * THE ONE RULE every type below is shaped around: a token, a code, a client secret or a waiting-page handle is
 * handed out exactly once — in the response that minted it — and is otherwise only ever HASHED. No type here can
 * carry one back to a caller, a log or a journal.
 */
import type { ApiRequest, ApiResponse } from '@ferretry/kernel/contract';
import type { ConnectorGrantView, ConnectorPendingView, ConnectorScope } from '../../contract/index.ts';

/**
 * Where the connector is published: `config/connector.yaml` `publicUrl`, or — when that names none — this machine's
 * built-in tunnel hostname. READ LAZILY: an implementation may answer from a getter, because the tunnel's hostname is
 * known only once provisioning has answered and can change. Nothing may cache a field.
 */
export interface ConnectorEndpoints {
  /** The `publicUrl` origin, no trailing slash. Also the OAuth issuer. */
  readonly issuer: string;
  /** `issuer + "/mcp"` — the protected resource and every token's audience. */
  readonly resource: string;
  /** `issuer + "/.well-known/oauth-protected-resource/mcp"`. */
  readonly resourceMetadataUrl: string;
  /** Where the waiting page's "Open Ferretry" link and the app's deep link point. */
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

/** Why an owner act on a request or grant was refused, as words a person reads. */
type ConnectorActRefusal =
  | { readonly code: 'not_found'; readonly message: string }
  | { readonly code: 'expired'; readonly message: string }
  | { readonly code: 'already_decided'; readonly message: string };

export type ConnectorActResult<T> =
  | { readonly ok: true; readonly value: T }
  | ({ readonly ok: false } & ConnectorActRefusal);

/**
 * The owner's half of the authorization server — what the owner routes and `fy connector` call. Every caller of this
 * has ALREADY been authorized by the route boundary (a person, with the `approve-connector` step-up for `approve`);
 * this interface re-checks nothing about who is asking.
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
  /** The owner switched the connector on or off (a change to the machine's security, recorded as `security.changed`). */
  | { readonly kind: 'connector.switched'; readonly enabled: boolean; readonly actor: string };

/** Where those events go. Never throws into a request. */
export interface ConnectorAuditSink {
  record(event: ConnectorAuditEvent): Promise<void>;
}

/**
 * One door handler: answers the requests whose path it owns and `undefined` for any other, so a request no handler
 * claims is the same 404 as any unrouted path. The OAuth server is one; `/mcp` is the other.
 */
export interface ConnectorHttpHandler {
  handle(request: ApiRequest): Promise<ApiResponse | undefined>;
}
