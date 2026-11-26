/**
 * THE CONNECTOR'S WIRE, through the one generated client this half is given (§9.6): every call is `client.call(routeKey)`
 * and the status answer is parsed with the contract's own schema, so a body this half cannot read fails at the call and
 * not as a blank card. Nothing here holds a base URL, a token or a fetch.
 *
 * NOTHING SECRET IS HERE TO CARRY. The status has no field for a handle, an authorization code, a client secret or a
 * token (the strict schema refuses one), and the three acts send an EMPTY body: who acts is the daemon's own answer to
 * "which device is this", and what is acted on is in the path. Approving asks a passkey proved for `approve-connector`;
 * the shell's client opens that prompt itself when the daemon answers `403 grant_step_up_required`, and resends once.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ConnectorStatusSchema, type ConnectorStatus } from '../../contract/index.ts';

/** The slice of the per-daemon client this half uses; a test hands a scripted one. */
export type ConnectorClient = Pick<PluginClient, 'call'>;

const READ_ROUTE = 'GET /v1/connector' as const;
const SWITCH_ROUTE = 'PUT /v1/connector' as const;
const APPROVE_ROUTE = 'POST /v1/connector/requests/:id/approve' as const;
const DENY_ROUTE = 'POST /v1/connector/requests/:id/deny' as const;
const REVOKE_ROUTE = 'POST /v1/connector/grants/:id/revoke' as const;

/** Whether the connector is on, where Claude reaches it, who waits for the owner, and who is connected. */
export const readConnector = async (client: ConnectorClient): Promise<ConnectorStatus> =>
  ConnectorStatusSchema.parse(await client.call(READ_ROUTE));

/** Switches the connector on or off; the answer is the status read after the change (never guessed here). */
export const switchConnector = async (client: ConnectorClient, enabled: boolean): Promise<ConnectorStatus> =>
  ConnectorStatusSchema.parse(await client.call(SWITCH_ROUTE, { body: { enabled } }));

/** Approves one waiting sign-in. The passkey for `approve-connector` is the shell's prompt, not this call's. */
export const approveSignIn = async (client: ConnectorClient, id: string): Promise<void> => {
  await client.call(APPROVE_ROUTE, { params: { id }, body: {} });
};

/** Turns one waiting sign-in down. It only takes away, so it asks no passkey. */
export const denySignIn = async (client: ConnectorClient, id: string): Promise<void> => {
  await client.call(DENY_ROUTE, { params: { id }, body: {} });
};

/** Ends one grant: its next call is refused. */
export const revokeGrant = async (client: ConnectorClient, id: string): Promise<void> => {
  await client.call(REVOKE_ROUTE, { params: { id }, body: {} });
};
