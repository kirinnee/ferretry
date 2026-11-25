import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLAUDE_REDIRECT_URI,
  CONNECTOR_DEFAULT_PORT,
  CONNECTOR_CONFIG,
  ConnectorConfigSchema,
  connectorLoosens,
} from '../../contract/index.ts';
import { CONNECTOR_OFF_SENTENCE, connectorSettings } from '../../daemon/lib/settings.ts';

const parse = (value: unknown) => ConnectorConfigSchema.parse(value);

describe('the connector config file', () => {
  it('reads an empty file as off, with no extra redirect URIs', () => {
    should(parse({})).deepEqual({ enabled: false, extraRedirectUris: [] });
  });

  it('is declared as config/connector.yaml on the configure axis', () => {
    should(CONNECTOR_CONFIG.shape).equal('file');
    should(CONNECTOR_CONFIG.file).equal('connector.yaml');
    should(CONNECTOR_CONFIG.axis).equal('configure');
  });

  for (const [why, publicUrl] of [
    ['plain http off loopback', 'http://mcp.example.com'],
    ['a path', 'https://mcp.example.com/mcp'],
    ['a query', 'https://mcp.example.com/?a=1'],
    ['credentials', 'https://user:pw@mcp.example.com'],
    ['a fragment', 'https://mcp.example.com/#x'],
    ['not a URL', 'mcp.example.com'],
  ] as const) {
    it(`refuses a public URL with ${why}, naming the key`, () => {
      const result = ConnectorConfigSchema.safeParse({ enabled: true, publicUrl });
      should(result.success).be.false();
      should(result.error?.issues[0]?.path).deepEqual(['publicUrl']);
    });
  }

  it('allows http on loopback for local testing', () => {
    should(ConnectorConfigSchema.safeParse({ enabled: true, publicUrl: 'http://127.0.0.1:7461' }).success).be.true();
  });

  it('refuses an unknown key or an http redirect off loopback rather than guessing', () => {
    should(
      ConnectorConfigSchema.safeParse({ enabled: true, publicUrl: 'https://a.example', extra: 1 }).success,
    ).be.false();
    should(
      ConnectorConfigSchema.safeParse({ extraRedirectUris: ['http://evil.example/cb'] }).error?.issues[0]?.path,
    ).deepEqual(['extraRedirectUris', 0]);
  });
});

describe('connectorSettings', () => {
  it('is off, with the sentence a person reads, when the switch is off', () => {
    should(connectorSettings(parse({ publicUrl: 'https://mcp.example.com' }))).deepEqual({
      kind: 'disabled',
      reason: CONNECTOR_OFF_SENTENCE,
    });
  });

  it('is on with Claude first and the default port, the issuer an origin with no trailing slash', () => {
    should(connectorSettings(parse({ enabled: true, publicUrl: 'https://mcp.example.com/' }))).deepEqual({
      kind: 'enabled',
      publicUrl: 'https://mcp.example.com',
      port: CONNECTOR_DEFAULT_PORT,
      redirectUris: [CLAUDE_REDIRECT_URI],
    });
  });

  it('adds extra redirect URIs once, exactly', () => {
    should(
      connectorSettings(
        parse({
          enabled: true,
          publicUrl: 'https://mcp.example.com',
          port: 7999,
          extraRedirectUris: ['http://localhost:6274/oauth/callback', CLAUDE_REDIRECT_URI],
        }),
      ),
    ).deepEqual({
      kind: 'enabled',
      publicUrl: 'https://mcp.example.com',
      port: 7999,
      redirectUris: [CLAUDE_REDIRECT_URI, 'http://localhost:6274/oauth/callback'],
    });
  });

  it('is on with no configured address: the built-in tunnel supplies it', () => {
    should(connectorSettings(parse({ enabled: true }))).deepEqual({
      kind: 'enabled',
      publicUrl: undefined,
      port: CONNECTOR_DEFAULT_PORT,
      redirectUris: [CLAUDE_REDIRECT_URI],
    });
  });
});

describe('connector config loosening is held', () => {
  const off = parse({ publicUrl: 'https://mcp.example.com' });
  const on = parse({ enabled: true, publicUrl: 'https://mcp.example.com' });

  it('holds switching it on, including from a file that did not exist', () => {
    should(connectorLoosens(off, on)).deepEqual(['Turns the Claude connector on.']);
    should(connectorLoosens(undefined, on)).containEql('Turns the Claude connector on.');
  });

  it('holds a redirect URI that was not allowed before, and only that one', () => {
    const before = parse({ extraRedirectUris: ['http://localhost:6274/cb'] });
    const after = parse({ extraRedirectUris: ['http://localhost:6274/cb', 'https://other.example/cb'] });
    should(connectorLoosens(before, after)).deepEqual([
      'Lets https://other.example/cb complete a Claude connector sign-in.',
    ]);
  });

  it('holds a new address, a removed address and nothing else about it', () => {
    should(connectorLoosens(on, parse({ enabled: true, publicUrl: 'https://other.example.com' }))).deepEqual([
      'Changes the address the Claude connector is published at.',
    ]);
    should(connectorLoosens(on, parse({ enabled: true }))).deepEqual([
      'Changes the address the Claude connector is published at.',
    ]);
    should(connectorLoosens(on, parse({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7999 }))).deepEqual(
      [],
    );
  });

  it('lets a tighter edit through: switching off, and dropping a redirect URI', () => {
    should(connectorLoosens(on, off)).deepEqual([]);
    should(connectorLoosens(parse({ extraRedirectUris: ['http://localhost:6274/cb'] }), parse({}))).deepEqual([]);
    should(connectorLoosens(on, undefined)).deepEqual([]);
  });
});
