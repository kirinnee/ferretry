/**
 * The browser's half of the connector routes (docs/mcp-connector.md, "Why the approval happens in the app").
 *
 * Like the other settings APIs this takes a client rather than building one, and caches nothing: a pending
 * sign-in and a grant belong to ONE machine, and one browser can be paired to several.
 *
 * ## THERE IS NO CREDENTIAL TO CARRY
 *
 * Approving is a passkey step-up for the `approve-connector` act. The carrier asks for the passkey itself when
 * the daemon answers `403 grant_step_up_required` and resends the request once, so `approveConnectorRequest`
 * sends nothing but the POST. A request id and a grant id are PUBLIC ids; no handle, code or token is ever on
 * the wire to the app, and none can appear in these schemas.
 *
 * The shapes mirror `ConnectorStatusSchema` in `packages/protocol/src/lib/connector.ts`, but are read LENIENTLY on
 * purpose: the protocol's strict schemas are the daemon's answer guard (an extra field there is a defect), while an
 * app reading a newer daemon must not break because that daemon added a field.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import { z } from 'zod';

export type ConnectorClient = Pick<IFyApiClient, 'request'>;

export const CONNECTOR_PATH = '/v1/connector';

const ScopeSchema = z.enum(['fleet:read', 'fleet:write']);
export type ConnectorScope = z.infer<typeof ScopeSchema>;

export const ConnectorPendingSchema = z.object({
  id: z.string(),
  matchCode: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  scopes: z.array(ScopeSchema),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ConnectorPending = z.infer<typeof ConnectorPendingSchema>;

export const ConnectorGrantSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  scopes: z.array(ScopeSchema),
  createdAt: z.string(),
  approvedBy: z.string(),
  lastUsedAt: z.string().optional(),
  revokedAt: z.string().optional(),
});
export type ConnectorGrant = z.infer<typeof ConnectorGrantSchema>;

export const ConnectorViewSchema = z.object({
  enabled: z.boolean(),
  publicUrl: z.string().optional(),
  mcpUrl: z.string().optional(),
  disabledReason: z.string().optional(),
  pending: z.array(ConnectorPendingSchema),
  grants: z.array(ConnectorGrantSchema),
});
export type ConnectorView = z.infer<typeof ConnectorViewSchema>;

const Acknowledged = z.object({}).passthrough();

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } as const;
const enc = encodeURIComponent;

/** Everything in one read: the address, why it is off, who is waiting, and who is connected. */
export async function readConnector(client: ConnectorClient): Promise<ConnectorView> {
  return await client.request(CONNECTOR_PATH, ConnectorViewSchema);
}

/** Approves one waiting sign-in. The carrier asks for the passkey (`approve-connector`) and resends. */
export async function approveConnectorRequest(client: ConnectorClient, requestId: string): Promise<void> {
  await client.request(`${CONNECTOR_PATH}/requests/${enc(requestId)}/approve`, Acknowledged, JSON_POST);
}

export async function denyConnectorRequest(client: ConnectorClient, requestId: string): Promise<void> {
  await client.request(`${CONNECTOR_PATH}/requests/${enc(requestId)}/deny`, Acknowledged, JSON_POST);
}

export async function revokeConnectorGrant(client: ConnectorClient, grantId: string): Promise<void> {
  await client.request(`${CONNECTOR_PATH}/grants/${enc(grantId)}/revoke`, Acknowledged, JSON_POST);
}
