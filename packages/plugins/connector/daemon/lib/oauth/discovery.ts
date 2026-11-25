import type { ApiResponse } from '@ferretry/kernel/contract';
import { CONNECTOR_SCOPES } from '../../../contract/index.ts';
import type { ConnectorEndpoints } from '../ports.ts';

export function protectedResourceMetadata(endpoints: ConnectorEndpoints) {
  return {
    resource: endpoints.resource,
    authorization_servers: [endpoints.issuer],
    scopes_supported: CONNECTOR_SCOPES,
    bearer_methods_supported: ['header'],
  };
}
export function authorizationServerMetadata(endpoints: ConnectorEndpoints) {
  const origin = endpoints.issuer;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: CONNECTOR_SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
}
/** An invalid presented bearer is distinguished from a request that has not yet signed in. */
export function unauthorizedResponse(
  endpoints: ConnectorEndpoints,
  options: { readonly tokenPresented: boolean },
): ApiResponse {
  return {
    status: 401,
    headers: new Map([
      [
        'www-authenticate',
        `Bearer resource_metadata="${endpoints.resourceMetadataUrl}", scope="${CONNECTOR_SCOPES.join(' ')}"${options.tokenPresented ? ', error="invalid_token"' : ''}`,
      ],
      ['cache-control', 'no-store'],
      ['content-type', 'application/json'],
    ]),
    body: JSON.stringify({ error: options.tokenPresented ? 'invalid_token' : 'unauthorized' }),
  };
}
