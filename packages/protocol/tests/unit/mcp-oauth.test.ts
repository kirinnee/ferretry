import { describe, it } from 'bun:test';
import should from 'should';
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_LOOPBACK_REDIRECT,
  MCP_OAUTH_PATH,
  McpOAuthCompleteRequestSchema,
  McpOAuthCompletionSchema,
  McpOAuthConnectionListSchema,
  McpOAuthFlowCancelledSchema,
  McpOAuthFlowSchema,
  McpOAuthSignedOutSchema,
  McpOAuthStartRequestSchema,
  mcpOAuthSecretNames,
  SecretNameSchema,
} from '../../src/lib/index.ts';

describe('the MCP sign-in contract', () => {
  it('should derive one set of secret names per exact component name', () => {
    const names = mcpOAuthSecretNames('linear');
    should(names.access).match(/^MCP_LINEAR_[0-9A-F]{8}_ACCESS$/u);
    should(names.refresh).equal(names.access.replace(/_ACCESS$/u, '_REFRESH'));
    should(names.client).equal(names.access.replace(/_ACCESS$/u, '_CLIENT'));
    should(names.variable).equal(`FY_${names.access.replace(/_ACCESS$/u, '_TOKEN')}`);
    // Stable: the materialiser and the daemon compute it separately and must agree.
    should(mcpOAuthSecretNames('linear')).deepEqual(names);
  });

  it('should keep names that share a stem apart, and bound a long or symbol-only name', () => {
    should(mcpOAuthSecretNames('my-server').access).not.equal(mcpOAuthSecretNames('my_server').access);
    const long = mcpOAuthSecretNames(`${'a'.repeat(23)}-${'b'.repeat(60)}`);
    should(long.refresh.length).be.belowOrEqual(64);
    should(long.access).match(/^MCP_A{23}_[0-9A-F]{8}_ACCESS$/u);
    should(mcpOAuthSecretNames('ü—ü').access).match(/^MCP_[0-9A-F]{8}_ACCESS$/u);
    for (const name of Object.values(mcpOAuthSecretNames('Ünïcode server 1'))) SecretNameSchema.parse(name);
  });

  it('should spell the callback addresses and the route once', () => {
    should(MCP_OAUTH_CALLBACK_PATH).equal('/oauth/mcp-callback');
    should(MCP_OAUTH_LOOPBACK_REDIRECT).equal('http://127.0.0.1/oauth/mcp-callback');
    should(MCP_OAUTH_PATH).equal('/v1/fleet/mcp-auth');
  });

  it('should parse every request and answer, with no field a token could occupy', () => {
    should(McpOAuthStartRequestSchema.parse({})).deepEqual({});
    should(McpOAuthStartRequestSchema.safeParse({ redirectUri: 'x', token: 'y' }).success).be.false();
    should(McpOAuthCompleteRequestSchema.safeParse({ callback: '' }).success).be.false();
    const connection = { component: 'linear', state: 'signed-in', renewable: true, secrets: ['MCP_X_ACCESS'] } as const;
    McpOAuthConnectionListSchema.parse({ connections: [connection] });
    should(
      McpOAuthCompletionSchema.safeParse({ component: 'linear', connection: { ...connection, accessToken: 'x' } })
        .success,
    ).be.false();
    McpOAuthFlowSchema.parse({
      flowId: 'f',
      component: 'linear',
      authorizeUrl: 'https://auth.example.com/authorize?x=1',
      mode: 'pwa',
      redirectUri: 'https://ferretry.pages.dev/oauth/mcp-callback',
      issuer: 'auth.example.com',
      expiresAt: '2026-10-16T00:10:00.000Z',
    });
    McpOAuthSignedOutSchema.parse({ component: 'linear', removed: true, revoked: false });
    McpOAuthFlowCancelledSchema.parse({ flowId: 'f', cancelled: true });
  });
});
