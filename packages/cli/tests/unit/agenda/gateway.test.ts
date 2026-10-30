import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  agendaBoardPath,
  agendaRepliesPath,
  DAEMON_HEALTH_PATH,
  legacyAttentionBoardPath,
  ProtocolAgendaGateway,
  repliesPath,
} from '../../../src/lib/agenda/gateway';
import type { AgendaApiClient } from '../../../src/lib/agenda/ports';
import { humanItem, SESSION, snapshot } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing is real. */
function fakeClient(payload: unknown, calls: Call[] = []): AgendaApiClient {
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
    should(agendaBoardPath('a/b')).equal('/v1/sessions/a%2Fb/agenda');
    should(legacyAttentionBoardPath('a/b')).equal('/v1/sessions/a%2Fb/attention');
  });
});

describe('protocol attention gateway', () => {
  it('should read the board with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([humanItem('A1', 'x')]), calls));

    // Act
    const actual = await gateway.snapshot(SESSION);

    // Assert
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/agenda`);
    should(calls[0]?.init).deepEqual({ headers: { 'x-ferretry-client': 'cli' } });
    should(actual.items).have.length(1);
  });

  it('should post a mutation as validated protocol JSON', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([]), calls));

    // Act
    await gateway.apply(SESSION, { action: 'dismiss', id: 'A3', note: 'stale' });

    // Assert
    should(calls[0]?.init?.method).equal('POST');
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json', 'x-ferretry-client': 'cli' });
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({ action: 'dismiss', id: 'A3', note: 'stale' });
  });

  it('should refuse to send a request the protocol rejects', async () => {
    // Arrange
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([])));

    // Act + Assert — an id outside the A<n> grammar must fail here, not become an opaque 400.
    await should(gateway.apply(SESSION, { action: 'dismiss', id: 'nope' as never })).be.rejected();
  });

  it('should reject a daemon answer that is not an attention snapshot', async () => {
    // Arrange
    const gateway = new ProtocolAgendaGateway(fakeClient({ error: 'boom' }));

    // Act + Assert — kteam cast the response, so a bad shape crashed inside rendering.
    await should(gateway.snapshot(SESSION)).be.rejected();
  });
});

describe('protocol attention gateway attribution', () => {
  it('should name the ferret it runs inside on every call, so its raise is the agent’s', async () => {
    // Arrange — the live defect: a raise from inside a ferret reached the daemon as the person at the
    // shell, was stored `raisedBy: human`, and its answer was therefore never delivered back.
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([]), calls), 'mvgt2oz9-04e28935');

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
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([]), calls), '  ');

    // Act
    await gateway.snapshot(SESSION);

    // Assert
    should(calls[0]?.init?.headers).deepEqual({ 'x-ferretry-client': 'cli' });
  });
});

describe('protocol attention gateway send-now', () => {
  it('should post to the replies route with the attribution headers', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([]), calls), 'ferret-1');

    // Act
    await gateway.sendReplies('a/b');

    // Assert
    should(agendaRepliesPath('a/b')).equal('/v1/sessions/a%2Fb/agenda/replies');
    should(repliesPath('a/b')).equal('/v1/sessions/a%2Fb/attention/replies');
    should(calls[0]?.path).equal('/v1/sessions/a%2Fb/agenda/replies');
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({});
    should(calls[0]?.init?.headers).containDeep({ 'x-ferretry-session-id': 'ferret-1' });
  });
});

describe('the features the daemon offers', () => {
  it('should read them from its health report, and none when it reports none or cannot be asked', async () => {
    // Arrange
    // The health view's other fields are not this test's: the client hands back what the route said.
    const paths: string[] = [];
    const answering = (health: object): AgendaApiClient => ({
      request: <T>(path: string) => {
        paths.push(path);
        return Promise.resolve(health as T);
      },
    });
    const offering = new ProtocolAgendaGateway(answering({ features: ['agenda.task.1'] }));
    const silent = new ProtocolAgendaGateway(answering({}));
    const down = new ProtocolAgendaGateway({ request: () => Promise.reject(new Error('refused')) });

    // Act / Assert
    should(await offering.features()).deepEqual(['agenda.task.1']);
    should(paths[0]).equal(DAEMON_HEALTH_PATH);
    should(await silent.features()).deepEqual([]);
    should(await down.features()).deepEqual([]);
  });
});
