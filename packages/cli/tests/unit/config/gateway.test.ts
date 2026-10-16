import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  CONFIG_CONFIRM_PATH,
  CONFIG_FILE_PATH,
  CONFIG_STATUS_PATH,
  ProtocolConfigGateway,
} from '../../../src/lib/config/gateway';
import type { ConfigApiClient } from '../../../src/lib/config/ports';
import { pending, statusView } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

/** Answers with a payload and records the call, so the gateway's parsing is real. */
function fakeClient(payload: unknown, calls: Call[] = []): ConfigApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('config routes', () => {
  it('should address the status and the confirmation', () => {
    should(CONFIG_STATUS_PATH).equal('/v1/config/status');
    should(CONFIG_CONFIRM_PATH).equal('/v1/config/confirm');
  });
});

describe('protocol config gateway', () => {
  it('should read the status with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolConfigGateway(fakeClient(statusView({ pending: [pending()] }), calls));

    // Act
    const actual = await gateway.status();

    // Assert
    should(calls[0]?.path).equal(CONFIG_STATUS_PATH);
    should(calls[0]?.init).be.undefined();
    should(actual.pending[0]?.path).equal('warden.yaml');
  });

  it('should confirm by POSTing the path and the etag it reviewed', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolConfigGateway(fakeClient({ path: 'warden.yaml', confirmed: true }, calls));

    // Act
    const actual = await gateway.confirm('warden.yaml', 'etag-1');

    // Assert
    should(calls[0]?.path).equal(CONFIG_CONFIRM_PATH);
    should(calls[0]?.init?.method).equal('POST');
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json' });
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({ path: 'warden.yaml', etag: 'etag-1' });
    should(actual).deepEqual({ path: 'warden.yaml', confirmed: true });
  });

  it('should refuse an answer that is not the protocol’s', async () => {
    const gateway = new ProtocolConfigGateway(fakeClient({ nope: true }));
    await should(gateway.status()).rejected();
  });
});

describe('protocol config gateway — one file', () => {
  const view = {
    path: 'logins/a b.yaml',
    absolutePath: '/home/me/.ferretry/config/logins/a b.yaml',
    kind: 'login',
    schema: 'login',
    exists: true,
    text: 'harness: claude\n',
    etag: 'etag-1',
    state: 'ok',
    issues: [],
  };

  it('should read a file with a plain GET, its path escaped into the query', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolConfigGateway(fakeClient(view, calls));

    // Act
    const actual = await gateway.file('logins/a b.yaml');

    // Assert
    should(CONFIG_FILE_PATH).equal('/v1/config/file');
    should(calls[0]?.path).equal('/v1/config/file?path=logins%2Fa%20b.yaml');
    should(calls[0]?.init).be.undefined();
    should(actual.etag).equal('etag-1');
  });

  it('should write by PUT with the path and text as JSON, and no If-Match unless one was given', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolConfigGateway(
      fakeClient({ path: 'machine.yaml', etag: 'etag-2', outcome: 'applied' }, calls),
    );

    // Act
    const actual = await gateway.write('machine.yaml', 'a: 1\n', undefined);

    // Assert
    should(calls[0]?.path).equal(CONFIG_FILE_PATH);
    should(calls[0]?.init?.method).equal('PUT');
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json' });
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({ path: 'machine.yaml', text: 'a: 1\n' });
    should(actual.outcome).equal('applied');
  });

  it('should send the etag the edit was made against in If-Match when given', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolConfigGateway(
      fakeClient({ path: 'machine.yaml', etag: 'etag-2', outcome: 'applied' }, calls),
    );
    await gateway.write('machine.yaml', '', 'etag-1');
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json', 'if-match': 'etag-1' });
  });
});
