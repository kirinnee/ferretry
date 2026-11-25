import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * THE REMOTE MCP CONNECTOR, ON THE OWNER'S WIRE (`docs/mcp-connector.md`).
 *
 * What the app and `fy connector` read and send for the sign-ins Claude opens against this daemon's connector
 * listener. These documents describe a sign-in WAITING for the owner and a grant that was given; they have no
 * field for a token, a code, a client secret or a waiting-page handle — that is the connector's one rule, and the
 * strict schemas here keep it: an answer carrying anything else is refused, not passed along.
 */

/** The two scopes a connector grant may hold; the daemon's `CONNECTOR_SCOPES` spells the same pair. */
export const ConnectorScopeSchema = z.enum(['fleet:read', 'fleet:write']);
export type ConnectorScope = z.infer<typeof ConnectorScopeSchema>;

/** A sign-in request's public id: `cr_` + 10 lowercase base32 characters (the alphabet is the daemon's to choose, so only its shape is pinned). */
export const ConnectorRequestIdSchema = z.string().regex(/^cr_[a-z0-9]{10}$/u, 'not a connector request id');
/** A grant's id: `cg_` + 10 lowercase base32 characters. */
export const ConnectorGrantIdSchema = z.string().regex(/^cg_[a-z0-9]{10}$/u, 'not a connector grant id');
/** The match code on the waiting page: `XXX-XXX`, an alphabet without 0, O, 1 and I. */
export const ConnectorMatchCodeSchema = z.string().regex(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/u, 'not a match code');

/**
 * What the owner may name a request by: its public id, or the match code as typed — any case, the hyphen
 * optional (`k7q2mf`). Bounded, because it is a path segment; the daemon decides what it matches.
 */
export const ConnectorRequestRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/u, 'not a request id or match code');

const ClientNameSchema = z.string().min(1).max(100);
const RedirectHostSchema = z.string().min(1).max(253);

/** A sign-in waiting for the owner. No handle, no code. */
export const ConnectorPendingViewSchema = z.strictObject({
  id: ConnectorRequestIdSchema,
  matchCode: ConnectorMatchCodeSchema,
  clientName: ClientNameSchema,
  redirectHost: RedirectHostSchema,
  scopes: z.array(ConnectorScopeSchema).min(1).max(2),
  createdAt: InstantSchema,
  expiresAt: InstantSchema,
});
export type ConnectorPendingView = z.infer<typeof ConnectorPendingViewSchema>;

/** A live or revoked grant. No token digest. */
export const ConnectorGrantViewSchema = z.strictObject({
  id: ConnectorGrantIdSchema,
  clientName: ClientNameSchema,
  redirectHost: RedirectHostSchema,
  scopes: z.array(ConnectorScopeSchema).min(1).max(2),
  createdAt: InstantSchema,
  /** The actor that approved it: `device:<id>` (the app, with a passkey) or `admin-cli` (at the machine). */
  approvedBy: z.string().min(1).max(200),
  lastUsedAt: InstantSchema.optional(),
  revokedAt: InstantSchema.optional(),
});
export type ConnectorGrantView = z.infer<typeof ConnectorGrantViewSchema>;

/**
 * `GET /v1/connector`: whether the connector is on, where Claude reaches it, and what is waiting.
 *
 * `disabledReason` is a plain sentence saying why it is off and what to do ("set connector.enabled in
 * config/daemon.json"). `publicUrl` and `mcpUrl` are present only while it is on.
 */
export const ConnectorStatusSchema = z.strictObject({
  /** Whether the connector is reachable now: switched on AND the address Claude is given answers. */
  enabled: z.boolean(),
  /** Whether it is SWITCHED on (the owner's decision). On but not `enabled` means it is waiting — see `disabledReason`. */
  switchedOn: z.boolean(),
  /** Where `publicUrl` comes from while on: the operator's own `connector.publicUrl`, or this machine's built-in tunnel. */
  publicUrlSource: z.enum(['configured', 'tunnel']).optional(),
  publicUrl: z.string().max(2_048).optional(),
  mcpUrl: z.string().max(2_048).optional(),
  disabledReason: z.string().max(500).optional(),
  pending: z.array(ConnectorPendingViewSchema).max(100),
  grants: z.array(ConnectorGrantViewSchema).max(200),
});
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

/**
 * The bodies of the three acts. Each is EMPTY on purpose: who acts is the route's server-derived actor, never a
 * field the caller sends, and what is acted on is in the path. `strictObject` so a client that tries to send an
 * `approvedBy` is refused rather than ignored.
 */
export const ConnectorActRequestSchema = z.strictObject({});
export type ConnectorActRequest = z.infer<typeof ConnectorActRequestSchema>;

/** The answers of the three acts: approve and revoke answer with the grant view, deny with the request view it ended. */

/** The refusal codes the act routes answer with, so a client branches on a code and never on prose. */
export const CONNECTOR_REFUSAL_CODES = {
  disabled: 'connector_disabled',
  notFound: 'connector_not_found',
  expired: 'connector_expired',
  alreadyDecided: 'connector_already_decided',
  /** `PUT /v1/connector` could not switch it (a damaged block or state file); the sentence says what to fix. */
  cannotSwitch: 'connector_cannot_switch',
} as const;

/**
 * `PUT /v1/connector`: switch the connector on or off from the app, no restart. The one fact a caller may
 * change is on or off; the address, port and redirect allow-list stay the operator's (or the built-in tunnel's).
 * The answer is the {@link ConnectorStatusSchema} read after the change.
 */
export const ConnectorChangeSchema = z.strictObject({ enabled: z.boolean() });
export type ConnectorChange = z.infer<typeof ConnectorChangeSchema>;
