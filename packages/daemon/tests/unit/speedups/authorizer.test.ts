import { describe, it } from 'bun:test';
import should from 'should';
import {
  allowedDestination,
  type OutboundHttpRequest,
  OutboundProviderAuthorizer,
  SecretStoreError,
} from '../../../src/lib/index.ts';
import { FixedVault, RecordingTransport } from './fakes.ts';

/**
 * The fifth vault holder. Every case here is about what the value may and may not touch: it rides
 * on exactly one request to an allowlisted HTTPS host, and it is never handed back.
 */

const KEY = 'gsk-test-0123456789abcdef';

const request = (overrides: Partial<OutboundHttpRequest> = {}): OutboundHttpRequest => ({
  method: 'POST',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  timeoutMs: 1_000,
  maxResponseBytes: 4_096,
  ...overrides,
});

function holder(vault = new FixedVault({ GROQ_API_KEY: `  ${KEY}  ` }), transport = new RecordingTransport()) {
  return { vault, transport, authorizer: new OutboundProviderAuthorizer(vault, transport) };
}

describe('the outbound provider authorizer', () => {
  it('should put the trimmed key on the request as a bearer header and return only the reply', async () => {
    // Arrange
    const { transport, authorizer } = holder();

    // Act
    const actual = await authorizer.send('GROQ_API_KEY', ['api.groq.com'], request());

    // Assert
    should(actual).deepEqual({ kind: 'completion', payload: { ok: true } });
    should(transport.sent).have.length(1);
    should(transport.sent[0]?.headers).deepEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    });
    should(JSON.stringify(actual)).not.containEql(KEY);
  });

  it('should honour a provider-specific placement, with or without a scheme', async () => {
    // Arrange
    const { transport, authorizer } = holder();

    // Act
    await authorizer.send('GROQ_API_KEY', ['api.groq.com'], request(), { header: 'x-api-key' });
    await authorizer.send('GROQ_API_KEY', ['api.groq.com'], request(), { header: 'x-token', scheme: 'Token' });

    // Assert
    should(transport.sent.map(sent => sent.headers)).deepEqual([
      { 'content-type': 'application/json', 'x-api-key': KEY },
      { 'content-type': 'application/json', 'x-token': `Token ${KEY}` },
    ]);
  });

  it('should refuse a host off the allowlist, plain HTTP or embedded userinfo before opening the vault', async () => {
    // Arrange
    const { vault, transport, authorizer } = holder();

    // Act
    const actual = await Promise.all([
      authorizer.send('GROQ_API_KEY', ['api.groq.com'], request({ url: 'https://evil.example/v1' })),
      authorizer.send('GROQ_API_KEY', ['api.groq.com'], request({ url: 'http://api.groq.com/v1' })),
      authorizer.send('GROQ_API_KEY', ['api.groq.com'], request({ url: 'https://a:b@api.groq.com/v1' })),
      authorizer.send('GROQ_API_KEY', ['api.groq.com'], request({ url: 'not a url' })),
    ]);

    // Assert
    should(actual.map(outcome => outcome.kind)).deepEqual(['refused', 'refused', 'refused', 'refused']);
    should(vault.opened).equal(0);
    should(transport.sent).be.empty();
  });

  it('should refuse a request that already carries the credential header', async () => {
    // Arrange
    const { vault, transport, authorizer } = holder();

    // Act
    const actual = await authorizer.send(
      'GROQ_API_KEY',
      ['api.groq.com'],
      request({ headers: { Authorization: 'Bearer somebody-else' } }),
    );

    // Assert
    should(actual).deepEqual({ kind: 'refused' });
    should(vault.opened).equal(0);
    should(transport.sent).be.empty();
  });

  it('should report a missing or blank key without sending anything', async () => {
    // Arrange
    const missing = holder(new FixedVault({}));
    const blank = holder(new FixedVault({ GROQ_API_KEY: '   ' }));

    // Act
    const actual = [
      await missing.authorizer.send('GROQ_API_KEY', ['api.groq.com'], request()),
      await blank.authorizer.send('GROQ_API_KEY', ['api.groq.com'], request()),
    ];

    // Assert
    should(actual).deepEqual([{ kind: 'secret_missing' }, { kind: 'secret_missing' }]);
    should(missing.transport.sent.length + blank.transport.sent.length).equal(0);
  });

  it('should report a damaged vault as damaged, never as missing', async () => {
    // Arrange
    const { transport, authorizer } = holder(new FixedVault(new SecretStoreError('key_missing', 'the key is gone')));

    // Act
    const actual = await authorizer.send('GROQ_API_KEY', ['api.groq.com'], request());

    // Assert
    should(actual).deepEqual({ kind: 'vault_damaged' });
    should(transport.sent).be.empty();
  });

  it('should let an unexpected failure escape rather than disguising it', async () => {
    // Arrange
    const { authorizer } = holder(new FixedVault(new TypeError('a defect')));

    // Act & Assert
    await should(authorizer.send('GROQ_API_KEY', ['api.groq.com'], request())).be.rejectedWith(TypeError);
  });

  it('should withhold a reply that echoes the key', async () => {
    // Arrange
    const { authorizer } = holder(
      undefined,
      new RecordingTransport({ kind: 'completion', payload: { debug: { authorization: `Bearer ${KEY}` } } }),
    );

    // Act
    const actual = await authorizer.send('GROQ_API_KEY', ['api.groq.com'], request());

    // Assert
    should(actual).deepEqual({ kind: 'unreadable' });
  });

  it('should pass every non-reply observation through unchanged', async () => {
    // Arrange
    const { authorizer } = holder(undefined, new RecordingTransport({ kind: 'status', status: 401 }));
    const empty = holder(undefined, new RecordingTransport({ kind: 'completion', payload: undefined }));

    // Act
    const actual = [
      await authorizer.send('GROQ_API_KEY', ['api.groq.com'], request()),
      await empty.authorizer.send('GROQ_API_KEY', ['api.groq.com'], request()),
    ];

    // Assert
    should(actual).deepEqual([
      { kind: 'status', status: 401 },
      { kind: 'completion', payload: undefined },
    ]);
  });
});

describe('allowed destinations', () => {
  it('should match the host exactly, case-insensitively, including any written port', () => {
    // Act
    const actual = {
      exact: allowedDestination('https://API.groq.com/x', ['api.groq.com']),
      subdomain: allowedDestination('https://x.api.groq.com/x', ['api.groq.com']),
      suffix: allowedDestination('https://api.groq.com.evil.example/x', ['api.groq.com']),
      port: allowedDestination('https://api.groq.com:8443/x', ['api.groq.com']),
      listedPort: allowedDestination('https://api.groq.com:8443/x', ['api.groq.com:8443']),
    };

    // Assert
    should(actual).deepEqual({ exact: true, subdomain: false, suffix: false, port: false, listedPort: true });
  });
});
