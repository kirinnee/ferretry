import {
  ConnectorActRequestSchema,
  ConnectorGrantViewSchema,
  ConnectorPendingViewSchema,
  type ConnectorGrantView,
  type ConnectorPendingView,
  type ConnectorStatus,
  ConnectorStatusSchema,
} from '@ferretry/protocol';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME } from '../session/connection.ts';
import type { ConnectorApiClient, IConnectorGateway } from './ports.ts';

/** The connector routes' root; the acts hang beneath it (docs/mcp-connector.md). */
export const CONNECTOR_PATH = '/v1/connector';
/** `x-ferretry-client: cli`, so the security log says this computer's `fy` acted (`admin-cli`), never the app. */
const JSON_HEADERS = { 'content-type': 'application/json', [FY_CLIENT_HEADER]: FY_CLIENT_NAME } as const;
/** Every act's body is empty on purpose: who acts is the daemon's server-derived actor, what is acted on is the path. */
const EMPTY_BODY = JSON.stringify(ConnectorActRequestSchema.parse({}));

/**
 * Speaks the connector routes through the protocol client.
 *
 * Both directions are parsed: the answers by the strict protocol schemas, so a daemon that answered an older or a
 * wider shape is a stated failure rather than an undefined field inside rendering, and the (empty) bodies by theirs.
 */
export class ProtocolConnectorGateway implements IConnectorGateway {
  constructor(private readonly client: ConnectorApiClient) {}

  async status(): Promise<ConnectorStatus> {
    return await this.client.request(CONNECTOR_PATH, ConnectorStatusSchema);
  }

  async approve(idOrMatchCode: string): Promise<ConnectorGrantView> {
    return await this.client.request(
      `${CONNECTOR_PATH}/requests/${encodeURIComponent(idOrMatchCode)}/approve`,
      ConnectorGrantViewSchema,
      { method: 'POST', headers: JSON_HEADERS, body: EMPTY_BODY },
    );
  }

  async deny(idOrMatchCode: string): Promise<ConnectorPendingView> {
    return await this.client.request(
      `${CONNECTOR_PATH}/requests/${encodeURIComponent(idOrMatchCode)}/deny`,
      ConnectorPendingViewSchema,
      { method: 'POST', headers: JSON_HEADERS, body: EMPTY_BODY },
    );
  }

  async revoke(grantId: string): Promise<ConnectorGrantView> {
    return await this.client.request(
      `${CONNECTOR_PATH}/grants/${encodeURIComponent(grantId)}/revoke`,
      ConnectorGrantViewSchema,
      { method: 'POST', headers: JSON_HEADERS, body: EMPTY_BODY },
    );
  }
}
