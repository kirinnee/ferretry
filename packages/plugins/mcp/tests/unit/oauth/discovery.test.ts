import { describe, it } from 'bun:test';
import should from 'should';
import {
  authorizationServerFrom,
  authorizationServerMetadataUrls,
  bearerChallenge,
  canonicalResource,
  DiscoveryRefusal,
  endpointAllowed,
  isPrivateLiteral,
  protectedResourceFrom,
  protectedResourceMetadataUrls,
  requestedScope,
} from '../../../src/lib/mcp-oauth/index.ts';

const SERVER = 'https://mcp.example.com/v1/mcp';

const metadata = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    issuer: 'https://auth.example.com/tenant',
    authorization_endpoint: 'https://auth.example.com/tenant/authorize',
    token_endpoint: 'https://auth.example.com/tenant/token',
    registration_endpoint: 'https://auth.example.com/tenant/register',
    revocation_endpoint: 'https://auth.example.com/tenant/revoke',
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['read'],
    ...overrides,
  });

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof DiscoveryRefusal) return error.message;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('MCP sign-in discovery', () => {
  describe('bearerChallenge', () => {
    it('should read quoted and token parameters in any order and case', () => {
      should(
        bearerChallenge('Bearer realm="x", SCOPE="a b", resource_metadata="https://m.example/.well-known/r"'),
      ).deepEqual({ resourceMetadata: 'https://m.example/.well-known/r', scope: 'a b' });
      should(bearerChallenge('Basic realm="y", bearer scope=read')).deepEqual({ scope: 'read' });
      should(bearerChallenge('Bearer scope="first", scope="second"')).deepEqual({ scope: 'first' });
    });

    it('should answer nothing for no header or no Bearer challenge', () => {
      should(bearerChallenge(undefined)).deepEqual({});
      should(bearerChallenge('Basic realm="y"')).deepEqual({});
    });
  });

  describe('metadata addresses', () => {
    it('should try the path-aware protected-resource address first, then the root', () => {
      should(protectedResourceMetadataUrls(SERVER)).deepEqual([
        'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp',
        'https://mcp.example.com/.well-known/oauth-protected-resource',
      ]);
      should(protectedResourceMetadataUrls('https://mcp.example.com/')).deepEqual([
        'https://mcp.example.com/.well-known/oauth-protected-resource',
      ]);
    });

    it('should try RFC 8414 then both OpenID forms for an issuer with a path, and two for one without', () => {
      should(authorizationServerMetadataUrls('https://auth.example.com/tenant/')).deepEqual([
        'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
        'https://auth.example.com/.well-known/openid-configuration/tenant',
        'https://auth.example.com/tenant/.well-known/openid-configuration',
      ]);
      should(authorizationServerMetadataUrls('https://auth.example.com')).deepEqual([
        'https://auth.example.com/.well-known/oauth-authorization-server',
        'https://auth.example.com/.well-known/openid-configuration',
      ]);
    });
  });

  describe('where an endpoint may be', () => {
    it('should know private literals', () => {
      for (const host of [
        '10.0.0.1',
        '192.168.1.1',
        '172.16.0.1',
        '172.31.9.9',
        '169.254.169.254',
        '0.0.0.0',
        '[fd00::1]',
        '[fe80::1]',
      ])
        should(isPrivateLiteral(host)).be.true();
      for (const host of ['172.32.0.1', '8.8.8.8', 'example.com']) should(isPrivateLiteral(host)).be.false();
    });

    it('should allow HTTPS, and plain HTTP only between loopback addresses', () => {
      should(endpointAllowed('https://auth.example.com/token', SERVER)).be.true();
      should(endpointAllowed('http://auth.example.com/token', SERVER)).be.false();
      should(endpointAllowed('http://127.0.0.1:9/token', 'http://localhost:8/mcp')).be.true();
      should(endpointAllowed('http://auth.example.com/token', 'http://localhost:8/mcp')).be.false();
      should(endpointAllowed('ftp://auth.example.com/token', SERVER)).be.false();
      should(endpointAllowed('not a url', SERVER)).be.false();
    });

    it('should refuse credentials or a fragment in an endpoint', () => {
      should(endpointAllowed('https://user:pass@auth.example.com/token', SERVER)).be.false();
      should(endpointAllowed('https://auth.example.com/token#x', SERVER)).be.false();
    });

    it('should not let a public server aim the daemon at this host or a private address', () => {
      should(endpointAllowed('https://127.0.0.1/token', SERVER)).be.false();
      should(endpointAllowed('https://10.1.2.3/token', SERVER)).be.false();
      // A server that is itself local or private may use either.
      should(endpointAllowed('https://10.1.2.3/token', 'https://10.0.0.5/mcp')).be.true();
      should(endpointAllowed('https://127.0.0.1/token', 'https://localhost/mcp')).be.true();
    });
  });

  describe('canonicalResource', () => {
    it('should drop a fragment and a trailing slash but keep a root path and a query', () => {
      should(canonicalResource('https://mcp.example.com/v1/mcp/#x')).equal('https://mcp.example.com/v1/mcp');
      should(canonicalResource('https://mcp.example.com/')).equal('https://mcp.example.com/');
      should(canonicalResource('https://mcp.example.com/v1/?a=1')).equal('https://mcp.example.com/v1/?a=1');
    });
  });

  describe('protectedResourceFrom', () => {
    it('should accept a document naming this server and an allowed authorization server', () => {
      should(
        protectedResourceFrom(
          JSON.stringify({
            resource: 'https://mcp.example.com/v1/mcp',
            authorization_servers: ['https://auth.example.com/tenant'],
            scopes_supported: ['a'],
          }),
          SERVER,
        ),
      ).deepEqual({
        resource: 'https://mcp.example.com/v1/mcp',
        issuer: 'https://auth.example.com/tenant',
        scopes: ['a'],
      });
      should(
        protectedResourceFrom(JSON.stringify({ authorization_servers: ['https://auth.example.com'] }), SERVER),
      ).deepEqual({ resource: SERVER, issuer: 'https://auth.example.com' });
      // A resource naming a prefix of the server's path still names this server.
      should(
        protectedResourceFrom(
          JSON.stringify({ resource: 'https://mcp.example.com/', authorization_servers: ['https://a.example'] }),
          SERVER,
        ).resource,
      ).equal('https://mcp.example.com/');
    });

    it('should refuse an unreadable document, a different server, a broken resource and a disallowed issuer', () => {
      should(refusal(() => protectedResourceFrom('{', SERVER))).match(/could not be read/u);
      should(refusal(() => protectedResourceFrom(JSON.stringify({ authorization_servers: [] }), SERVER))).match(
        /could not be read/u,
      );
      should(
        refusal(() =>
          protectedResourceFrom(
            JSON.stringify({ resource: 'https://other.example/v1/mcp', authorization_servers: ['https://a.example'] }),
            SERVER,
          ),
        ),
      ).match(/different server/u);
      should(
        refusal(() =>
          protectedResourceFrom(
            JSON.stringify({ resource: 'https://mcp.example.com/other', authorization_servers: ['https://a.example'] }),
            SERVER,
          ),
        ),
      ).match(/different server/u);
      should(
        refusal(() =>
          protectedResourceFrom(
            JSON.stringify({ resource: 'nope', authorization_servers: ['https://a.example'] }),
            SERVER,
          ),
        ),
      ).match(/no usable resource/u);
      should(
        refusal(() => protectedResourceFrom(JSON.stringify({ authorization_servers: ['http://a.example'] }), SERVER)),
      ).match(/will not use/u);
    });
  });

  describe('authorizationServerFrom', () => {
    it('should accept a matching issuer that lists S256, ignoring a trailing slash', () => {
      should(authorizationServerFrom(metadata(), 'https://auth.example.com/tenant/', SERVER)).deepEqual({
        issuer: 'https://auth.example.com/tenant',
        authorizationEndpoint: 'https://auth.example.com/tenant/authorize',
        tokenEndpoint: 'https://auth.example.com/tenant/token',
        registrationEndpoint: 'https://auth.example.com/tenant/register',
        revocationEndpoint: 'https://auth.example.com/tenant/revoke',
        scopes: ['read'],
        issParameterSupported: false,
      });
      should(
        authorizationServerFrom(
          metadata({ registration_endpoint: undefined, revocation_endpoint: undefined, scopes_supported: undefined }),
          'https://auth.example.com/tenant',
          SERVER,
        ),
      ).deepEqual({
        issuer: 'https://auth.example.com/tenant',
        authorizationEndpoint: 'https://auth.example.com/tenant/authorize',
        tokenEndpoint: 'https://auth.example.com/tenant/token',
        issParameterSupported: false,
      });
    });

    it('should refuse an unreadable document, a different issuer, no PKCE and a disallowed endpoint', () => {
      const issuer = 'https://auth.example.com/tenant';
      should(refusal(() => authorizationServerFrom('[]', issuer, SERVER))).match(/could not be read/u);
      should(
        refusal(() => authorizationServerFrom(metadata({ issuer: 'https://evil.example' }), issuer, SERVER)),
      ).match(/different provider/u);
      should(
        refusal(() =>
          authorizationServerFrom(metadata({ code_challenge_methods_supported: ['plain'] }), issuer, SERVER),
        ),
      ).match(/PKCE/u);
      should(
        refusal(() =>
          authorizationServerFrom(metadata({ code_challenge_methods_supported: undefined }), issuer, SERVER),
        ),
      ).match(/PKCE/u);
      should(
        refusal(() =>
          authorizationServerFrom(metadata({ token_endpoint: 'http://auth.example.com/token' }), issuer, SERVER),
        ),
      ).match(/will not use/u);
    });
  });

  describe('requestedScope', () => {
    it('should prefer the challenge, then the resource metadata, then none', () => {
      const resource = { resource: SERVER, issuer: 'https://a.example', scopes: ['a', 'b'] };
      should(requestedScope({ scope: ' x y ' }, resource)).equal('x y');
      should(requestedScope({ scope: ' ' }, resource)).equal('a b');
      should(requestedScope({}, { resource: SERVER, issuer: 'https://a.example' })).be.undefined();
      should(requestedScope({}, undefined)).be.undefined();
    });
  });
});

describe('MCP sign-in discovery — review hardening', () => {
  it('L1: treats IPv4-mapped IPv6, the unspecified address, shared CGNAT space and site-local as private', () => {
    for (const host of [
      '[::ffff:7f00:1]', // 127.0.0.1
      '[::ffff:a9fe:a9fe]', // 169.254.169.254
      '[::ffff:a00:1]', // 10.0.0.1
      '[::]',
      '[::1]',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.53',
      '[fec0::1]',
    ])
      should(isPrivateLiteral(host)).be.true();
    for (const host of ['100.63.0.1', '100.128.0.1', '[::ffff:808:808]', '[2001:db8::1]', '1.2.3', 'a.b.c.d'])
      should(isPrivateLiteral(host)).be.false();
  });

  it('L1: does not let a public server aim the daemon at a mapped or unspecified address', () => {
    // The URL parser normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` before the check sees it.
    for (const endpoint of ['https://[::ffff:127.0.0.1]/t', 'https://[::]/t', 'https://100.100.100.100/t'])
      should(endpointAllowed(endpoint, SERVER)).be.false();
  });

  it('L2: matches a resource path by whole segments', () => {
    const document = (resource: string) =>
      JSON.stringify({ resource, authorization_servers: ['https://auth.example.com'] });
    should(refusal(() => protectedResourceFrom(document('https://mcp.example.com/v1/m'), SERVER))).match(
      /different server/u,
    );
    should(
      refusal(() =>
        protectedResourceFrom(document('https://mcp.example.com/v1/mcp'), 'https://mcp.example.com/v1/mcp-admin'),
      ),
    ).match(/different server/u);
    should(protectedResourceFrom(document('https://mcp.example.com/v1'), SERVER).resource).equal(
      'https://mcp.example.com/v1',
    );
  });

  it('M1: reads whether the provider promises iss on every authorization response', () => {
    should(
      authorizationServerFrom(
        metadata({ authorization_response_iss_parameter_supported: true }),
        'https://auth.example.com/tenant',
        SERVER,
      ).issParameterSupported,
    ).be.true();
  });
});
