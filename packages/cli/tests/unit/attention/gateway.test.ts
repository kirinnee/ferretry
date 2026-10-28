import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  attentionBoardPath,
  notifyPath,
  ProtocolAttentionGateway,
  repliesPath,
} from '../../../src/lib/attention/gateway';
import type { AttentionApiClient } from '../../../src/lib/attention/ports';
import { humanItem, SESSION, snapshot } from './fixtures';

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
    should(calls[0]?.init).deepEqual({ headers: { 'x-ferretry-client': 'cli' } });
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
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json', 'x-ferretry-client': 'cli' });
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

describe('protocol attention gateway attribution', () => {
  it('should name the ferret it runs inside on every call, so its raise is the agent’s', async () => {
    // Arrange — the live defect: a raise from inside a ferret reached the daemon as the person at the
    // shell, was stored `raisedBy: human`, and its answer was therefore never delivered back.
    const calls: Call[] = [];
    const gateway = new ProtocolAttentionGateway(fakeClient(snapshot([]), calls), 'mvgt2oz9-04e28935');

    // Act
    await gateway.snapshot(SESSION);
    await gateway.apply(SESSION, { action: 'dismiss', id: 'A1' });

    // Assert
    const own = { 'x-ferretry-client': 'cli', 'x-ferretry-session-id': 'mvgt2oz9-04e28935' };
    should(calls[0]?.init?.headers).deepEqual(own);
    should(calls[1]?.init?.headers).deepEqual({ 'content-type': 'application/json', ...own });
  });

  it('should name no session at the person’s own shell, however blank the variable', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAttentionGateway(fakeClient({ sessionId: SESSION, delivered: 1 }, calls), '  ');

    // Act
    await gateway.notify(SESSION, { body: 'ok' });

    // Assert
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json', 'x-ferretry-client': 'cli' });
  });
});

describe('protocol attention gateway send-now', () => {
  it('should post to the replies route with the attribution headers', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAttentionGateway(fakeClient(snapshot([]), calls), 'ferret-1');

    // Act
    await gateway.sendReplies('a/b');

    // Assert
    should(repliesPath('a/b')).equal('/v1/sessions/a%2Fb/attention/replies');
    should(calls[0]?.path).equal('/v1/sessions/a%2Fb/attention/replies');
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({});
    should(calls[0]?.init?.headers).containDeep({ 'x-ferretry-session-id': 'ferret-1' });
  });
});
