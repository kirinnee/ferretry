import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLAUDE_REDIRECT_URI,
  CONNECTOR_DEFAULT_PORT,
  connectorConfiguration,
  connectorEnabledDocument,
  connectorSettings,
} from '../../../src/lib/connector/config.ts';

describe('connectorSettings', () => {
  it('is off, with a reason, when the block is absent or not enabled', () => {
    should(connectorSettings(undefined).kind).equal('disabled');
    should(connectorSettings({ enabled: false, publicUrl: 'https://mcp.example.com' }).kind).equal('disabled');
    should(connectorSettings({ publicUrl: 'https://mcp.example.com' }).kind).equal('disabled');
  });

  it('is on with Claude first and the default port', () => {
    const settings = connectorSettings({ enabled: true, publicUrl: 'https://mcp.example.com/' });
    should(settings).deepEqual({
      kind: 'enabled',
      publicUrl: 'https://mcp.example.com',
      port: CONNECTOR_DEFAULT_PORT,
      redirectUris: [CLAUDE_REDIRECT_URI],
    });
  });

  it('adds extra redirect URIs once, exactly', () => {
    const settings = connectorSettings({
      enabled: true,
      publicUrl: 'https://mcp.example.com',
      port: 7999,
      extraRedirectUris: ['http://localhost:6274/oauth/callback', CLAUDE_REDIRECT_URI],
    });
    should(settings).deepEqual({
      kind: 'enabled',
      publicUrl: 'https://mcp.example.com',
      port: 7999,
      redirectUris: [CLAUDE_REDIRECT_URI, 'http://localhost:6274/oauth/callback'],
    });
  });

  for (const [why, publicUrl] of [
    ['plain http off loopback', 'http://mcp.example.com'],
    ['a path', 'https://mcp.example.com/mcp'],
    ['a query', 'https://mcp.example.com/?a=1'],
    ['credentials', 'https://user:pw@mcp.example.com'],
    ['a fragment', 'https://mcp.example.com/#x'],
    ['not a URL', 'mcp.example.com'],
  ] as const) {
    it(`refuses a public URL with ${why}`, () => {
      const settings = connectorSettings({ enabled: true, publicUrl });
      should(settings.kind).equal('disabled');
      if (settings.kind === 'disabled') should(settings.reason).match(/connector is off/u);
    });
  }

  it('allows http on loopback for local testing', () => {
    should(connectorSettings({ enabled: true, publicUrl: 'http://127.0.0.1:7461' }).kind).equal('enabled');
  });

  it('refuses an unknown key or an http redirect off loopback rather than guessing', () => {
    should(connectorSettings({ enabled: true, publicUrl: 'https://a.example', extra: 1 }).kind).equal('disabled');
    should(
      connectorSettings({
        enabled: true,
        publicUrl: 'https://a.example',
        extraRedirectUris: ['http://evil.example/cb'],
      }).kind,
    ).equal('disabled');
  });
});

describe('connectorSettings without an address', () => {
  it('is on with no configured address: the built-in tunnel supplies it', () => {
    should(connectorSettings({ enabled: true })).deepEqual({
      kind: 'enabled',
      publicUrl: undefined,
      port: CONNECTOR_DEFAULT_PORT,
      redirectUris: [CLAUDE_REDIRECT_URI],
    });
  });

  it('still refuses a configured address that is not an origin', () => {
    should(connectorSettings({ enabled: true, publicUrl: 'https://a.example/path' }).kind).equal('disabled');
  });
});

describe('connectorConfiguration', () => {
  it('reads the settings of a block that is switched off, so a live switch-on has them', () => {
    const configuration = connectorConfiguration({ enabled: false, publicUrl: 'https://mcp.example.com', port: 7999 });
    should(configuration.kind).equal('valid');
    if (configuration.kind === 'valid') {
      should(configuration.enabled).equal(false);
      should(configuration.settings.publicUrl).equal('https://mcp.example.com');
      should(configuration.settings.port).equal(7999);
    }
  });

  it('reads an absent block as valid and off', () => {
    const configuration = connectorConfiguration(undefined);
    should(configuration.kind === 'valid' && configuration.enabled).equal(false);
  });

  it('says why a damaged block cannot be switched on', () => {
    const configuration = connectorConfiguration({ enabled: true, port: 'x' });
    should(configuration.kind).equal('invalid');
  });
});

describe('connectorEnabledDocument', () => {
  it('changes only connector.enabled and keeps every other key', () => {
    should(
      connectorEnabledDocument(
        { port: 7457, connector: { enabled: false, publicUrl: 'https://a.example', port: 7461 } },
        true,
      ),
    ).deepEqual({ port: 7457, connector: { enabled: true, publicUrl: 'https://a.example', port: 7461 } });
  });

  it('adds the block when there is none, and replaces one that is not an object', () => {
    should(connectorEnabledDocument({ a: 1 }, true)).deepEqual({ a: 1, connector: { enabled: true } });
    should(connectorEnabledDocument({ connector: 'oops' }, false)).deepEqual({ connector: { enabled: false } });
  });
});
