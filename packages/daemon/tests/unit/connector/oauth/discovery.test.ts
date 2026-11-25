import { describe, expect, test } from 'bun:test';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  unauthorizedResponse,
} from '../../../../src/lib/connector/oauth/discovery.ts';
import { endpoints } from '../../../support/connector/oauth-fixture.ts';

describe('connector discovery documents', () => {
  test('the protected resource names this connector, its one issuer, both scopes and the header method', () => {
    expect(protectedResourceMetadata(endpoints)).toEqual({
      resource: 'https://connector.example/mcp',
      authorization_servers: ['https://connector.example'],
      scopes_supported: ['fleet:read', 'fleet:write'],
      bearer_methods_supported: ['header'],
    });
  });

  test('the authorization server publishes every endpoint under its issuer and offers only S256 and the code flow', () => {
    const metadata = authorizationServerMetadata(endpoints);
    expect(metadata).toMatchObject({
      issuer: 'https://connector.example',
      authorization_endpoint: 'https://connector.example/oauth/authorize',
      token_endpoint: 'https://connector.example/oauth/token',
      registration_endpoint: 'https://connector.example/oauth/register',
      revocation_endpoint: 'https://connector.example/oauth/revoke',
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      'none',
      'client_secret_post',
      'client_secret_basic',
    ]);
  });
});

describe('the 401 a client with no usable token is sent', () => {
  test('points an unsigned client at the resource metadata and does not call its token invalid', () => {
    const answer = unauthorizedResponse(endpoints, { tokenPresented: false });
    expect(answer.status).toBe(401);
    expect(answer.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${endpoints.resourceMetadataUrl}", scope="fleet:read fleet:write"`,
    );
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(answer.body)).toEqual({ error: 'unauthorized' });
  });

  test('says invalid_token when a token was presented and refused', () => {
    const answer = unauthorizedResponse(endpoints, { tokenPresented: true });
    expect(answer.headers.get('www-authenticate')).toEndWith(', error="invalid_token"');
    expect(JSON.parse(answer.body)).toMatchObject({
      error: 'invalid_token',
      error_description: expect.stringContaining('Settings > Connectors > Ferretry > Connect'),
    });
  });
});
