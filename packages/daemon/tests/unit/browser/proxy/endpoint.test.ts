import { describe, it } from 'bun:test';
import { BrowserProxySettingSchema } from '@ferretry/protocol';
import should from 'should';
import {
  BrowserControlError,
  browserProxyStatus,
  proxyEndpoint,
  resolveBrowserProxy,
} from '../../../../src/lib/index.ts';

const setting = (extra: Record<string, unknown> = {}) =>
  BrowserProxySettingSchema.parse({ url: 'http://proxy.example:8080', ...extra });

describe('proxy endpoint', () => {
  it('should read the scheme, host and port the setting names', () => {
    // Act + Assert
    should(proxyEndpoint('http://proxy.example:8080')).eql({ scheme: 'http', host: 'proxy.example', port: 8080 });
    should(proxyEndpoint('socks5://[::1]:1081')).eql({ scheme: 'socks5', host: '::1', port: 1081 });
  });

  it("should use the scheme's own port when the address has none", () => {
    // Act + Assert
    should(proxyEndpoint('http://p.example').port).equal(80);
    should(proxyEndpoint('https://p.example').port).equal(443);
    should(proxyEndpoint('socks5://p.example').port).equal(1080);
  });
});

describe('browser proxy status', () => {
  it('should show the address, whether it signs in and how many hosts skip it, and nothing secret', () => {
    // Arrange
    const proxy = setting({
      bypass: ['*.internal.example', '10.0.0.0/8'],
      username: '${secret:PROXY_USER}',
      password: '${secret:PROXY_PASSWORD}',
    });

    // Act
    const status = browserProxyStatus(proxy);

    // Assert
    should(status).eql({ url: 'http://proxy.example:8080', authenticated: true, bypassCount: 2 });
    should(JSON.stringify(status)).not.containEql('PROXY_');
  });

  it('should say a proxy without credentials does not sign in', () => {
    // Act + Assert
    should(browserProxyStatus(setting()).authenticated).be.false();
  });
});

describe('resolving a browser proxy', () => {
  const credentials = {
    username: '${secret:PROXY_USER}',
    password: '${secret:PROXY_PASSWORD}',
  };

  it('should need no secrets for a proxy that does not sign in', () => {
    // Act
    const resolved = resolveBrowserProxy(setting(), new Map());

    // Assert
    should(resolved.credentials).be.undefined();
  });

  it('should put the secrets the references name behind the credentials', () => {
    // Act
    const resolved = resolveBrowserProxy(
      setting(credentials),
      new Map([
        ['PROXY_USER', 'alice'],
        ['PROXY_PASSWORD', 's3cret'],
      ]),
    );

    // Assert
    should(resolved.credentials).eql({ username: 'alice', password: 's3cret' });
  });

  it('should refuse the launch, naming the missing secret and the fix, when the store lacks one', () => {
    // Act
    const act = () => resolveBrowserProxy(setting(credentials), new Map([['PROXY_USER', 'alice']]));

    // Assert
    should(act).throw(BrowserControlError, { code: 'launch_failed' });
    should(act).throw(/PROXY_PASSWORD/u);
    should(act).throw(/fy secret set PROXY_PASSWORD/u);
  });

  it('should name every missing secret', () => {
    // Act
    const act = () => resolveBrowserProxy(setting(credentials), new Map());

    // Assert
    should(act).throw(/PROXY_USER, PROXY_PASSWORD/u);
  });
});
