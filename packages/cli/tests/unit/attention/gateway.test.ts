import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { ProtocolAttentionGateway, attentionBoardPath, notifyPath } from '../../../src/lib/attention/gateway';
import type { AttentionApiClient } from '../../../src/lib/attention/ports';
import { SESSION, humanItem, snapshot } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing is real. */
function fakeClient(payload: unknown, calls: Call[] = []): AttentionApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('attention routes', () => {
  it('should escape a session id that would otherwise break the route', () => {
    // Act + Assert
    should(attentionBoardPath('a/b')).equal('/v1/sessions/a%2Fb/attention');
    should(notifyPath('a b')).equal('/v1/sessions/a%20b/notify');
  });
});

describe('protocol attention gateway', () => {
  it('should read the board with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAttentionGateway(fakeClient(snapshot([humanItem('A1', 'x')]), calls));

    // Act
    const actual = await gateway.snapshot(SESSION);

    // Assert
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/attention`);
    should(calls[0]?.init).be.undefined();
    should(actual.items).have.length(1);
  });

  it('should post a mutation as validated protocol JSON', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAttentionGateway(fakeClient(snapshot([]), calls));

    // Act
    await gateway.apply(SESSION, { action: 'dismiss', id: 'A3', note: 'stale' });

    // Assert
    should(calls[0]?.init?.method).equal('POST');
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json' });
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({ action: 'dismiss', id: 'A3', note: 'stale' });
  });

  it('should refuse to send a request the protocol rejects', async () => {
    // Arrange
    const gateway = new ProtocolAttentionGateway(fakeClient(snapshot([])));

    // Act + Assert — an id outside the A<n> grammar must fail here, not become an opaque 400.
    await should(gateway.apply(SESSION, { action: 'dismiss', id: 'nope' as never })).be.rejected();
  });

  it('should reject a daemon answer that is not an attention snapshot', async () => {
    // Arrange
    const gateway = new ProtocolAttentionGateway(fakeClient({ error: 'boom' }));

    // Act + Assert — kteam cast the response, so a bad shape crashed inside rendering.
    await should(gateway.snapshot(SESSION)).be.rejected();
  });

  it('should post a notification to the notify route', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAttentionGateway(fakeClient({ sessionId: SESSION, delivered: 2 }, calls));

    // Act
    const actual = await gateway.notify(SESSION, { body: 'the build is green', kind: 'completed' });

    // Assert
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/notify`);
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({ body: 'the build is green', kind: 'completed' });
    should(actual.delivered).equal(2);
  });

  it('should refuse a notification the protocol rejects', async () => {
    // Arrange
    const gateway = new ProtocolAttentionGateway(fakeClient({ sessionId: SESSION, delivered: 0 }));

    // Act + Assert — a multi-line title is invalid on the wire.
    await should(gateway.notify(SESSION, { body: 'ok', title: 'two\nlines' })).be.rejected();
  });

  it('should reject a notify answer that is not a delivery report', async () => {
    // Arrange
    const gateway = new ProtocolAttentionGateway(fakeClient({ delivered: -1 }));

    // Act + Assert
    await should(gateway.notify(SESSION, { body: 'ok' })).be.rejected();
  });
});
