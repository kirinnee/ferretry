import { describe, it } from 'bun:test';
import should from 'should';
import { CLAUDE_REDIRECT_URI, CONNECTOR_DEFAULT_PORT, connectorSettings } from '../../../src/lib/connector/config.ts';

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
  it('says to set publicUrl when the block is on but names none', () => {
    const settings = connectorSettings({ enabled: true });
    should(settings.kind).equal('disabled');
    if (settings.kind === 'disabled') should(settings.reason).match(/connector\.publicUrl/u);
  });
});
