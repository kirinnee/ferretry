import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import should from 'should';
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_LOOPBACK_HOST,
  MCP_OAUTH_PATH,
  McpOAuthCompleteRequestSchema,
  McpOAuthCompletionSchema,
  McpOAuthConnectionListSchema,
  McpOAuthFlowCancelledSchema,
  McpOAuthFlowSchema,
  McpOAuthSignedOutSchema,
  McpOAuthStartRequestSchema,
  mcpOAuthRedirectPath,
  mcpOAuthSecretNames,
  mcpOAuthServerKey,
  SecretNameSchema,
  sha256Hex,
} from '../../src/lib/index.ts';

const SERVER = 'https://mcp.linear.app/mcp';

describe('the MCP sign-in contract', () => {
  it('should compute SHA-256 exactly as the platform does', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ü'.repeat(500)])
      should(sha256Hex(text)).equal(createHash('sha256').update(text).digest('hex'));
  });

  it('should spell a server’s canonical address once', () => {
    should(mcpOAuthServerKey('https://mcp.example.com/v1/mcp/#x')).equal('https://mcp.example.com/v1/mcp');
    should(mcpOAuthServerKey('https://mcp.example.com/')).equal('https://mcp.example.com/');
    should(mcpOAuthServerKey('https://mcp.example.com/v1/?a=1')).equal('https://mcp.example.com/v1/?a=1');
  });

  it('should derive one set of names per component AND server', () => {
    const names = mcpOAuthSecretNames('linear', SERVER);
    should(names.access).match(/^MCP_LINEAR_[0-9A-F]{16}_ACCESS$/u);
    should(names.refresh).equal(names.access.replace(/_ACCESS$/u, '_REFRESH'));
    should(names.variable).equal(`FY_${names.access.replace(/_ACCESS$/u, '_TOKEN')}`);
    should(mcpOAuthSecretNames('linear', `${SERVER}/`)).deepEqual(names);
    // H1: the same component at another server is another secret.
    should(mcpOAuthSecretNames('linear', 'https://evil.example/mcp').access).not.equal(names.access);
  });

  it('should keep names that share a stem apart, and bound a long or symbol-only name', () => {
    should(mcpOAuthSecretNames('my-server', SERVER).access).not.equal(mcpOAuthSecretNames('my_server', SERVER).access);
    const long = mcpOAuthSecretNames(`${'a'.repeat(15)}-${'b'.repeat(60)}`, SERVER);
    should(long.refresh.length).be.belowOrEqual(64);
    should(long.access).match(/^MCP_A{15}_[0-9A-F]{16}_ACCESS$/u);
    should(mcpOAuthSecretNames('ü—ü', SERVER).access).match(/^MCP_[0-9A-F]{16}_ACCESS$/u);
    for (const name of [
      mcpOAuthSecretNames('Ünïcode server 1', SERVER).access,
      mcpOAuthSecretNames('x', SERVER).refresh,
    ])
      SecretNameSchema.parse(name);
  });

  it('should give every provider its own callback path', () => {
    should(mcpOAuthRedirectPath('https://auth.example.com')).match(/^\/oauth\/mcp-callback\/[0-9a-f]{16}$/u);
    should(mcpOAuthRedirectPath('https://auth.example.com/')).equal(mcpOAuthRedirectPath('https://auth.example.com'));
    should(mcpOAuthRedirectPath('https://auth.example.com')).not.equal(mcpOAuthRedirectPath('https://evil.example'));
  });

  it('should spell the callback base, loopback host and route once', () => {
    should(MCP_OAUTH_CALLBACK_PATH).equal('/oauth/mcp-callback');
    should(MCP_OAUTH_LOOPBACK_HOST).equal('127.0.0.1');
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
      redirectUri: 'https://ferretry.pages.dev/oauth/mcp-callback/0123456789abcdef',
      issuer: 'auth.example.com',
      expiresAt: '2026-10-16T00:10:00.000Z',
    });
    McpOAuthSignedOutSchema.parse({ component: 'linear', removed: true, revoked: false });
    McpOAuthFlowCancelledSchema.parse({ flowId: 'f', cancelled: true });
  });
});
