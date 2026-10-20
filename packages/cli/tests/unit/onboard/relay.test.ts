import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { CARRIERS_PATH, ProtocolOnboardRelay } from '../../../src/lib/onboard/relay.ts';

/** A client that answers one path by parsing `body` through the caller's schema, as the real one does. */
const client = (body: unknown) => ({
  paths: [] as string[],
  async request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    this.paths.push(path);
    if (body instanceof Error || typeof body === 'string') throw body;
    return schema.parse(body);
  },
});

describe('ProtocolOnboardRelay', () => {
  it('should read the relay carrier the daemon publishes', async () => {
    // Arrange
    const fake = client({
      carriers: [
        { kind: 'direct', url: 'http://127.0.0.1:7431' },
        { kind: 'relay', url: 'wss://relay.example.test' },
      ],
    });

    // Act
    const reach = await new ProtocolOnboardRelay(fake).reach();

    // Assert
    should(fake.paths).eql([CARRIERS_PATH]);
    should(reach).eql({ state: 'relay', url: 'wss://relay.example.test' });
  });

  it('should say direct-only when the daemon publishes no relay', async () => {
    const reach = await new ProtocolOnboardRelay(client({ carriers: [] })).reach();
    should(reach).eql({ state: 'direct-only' });
  });

  it('should turn a failure into unknown with its reason, never a throw', async () => {
    should(await new ProtocolOnboardRelay(client(new Error('connection refused'))).reach()).eql({
      state: 'unknown',
      reason: 'connection refused',
    });
    should(await new ProtocolOnboardRelay(client('nope')).reach()).eql({ state: 'unknown', reason: 'nope' });
  });
});
