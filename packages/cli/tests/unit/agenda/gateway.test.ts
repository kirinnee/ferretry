import { describe, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import should from 'should';
import type { z } from 'zod';
import {
  agendaBoardPath,
  agendaRepliesPath,
  legacyAttentionBoardPath,
  ProtocolAgendaGateway,
  repliesPath,
} from '../../../src/lib/agenda/gateway';
import type { AgendaApiClient } from '../../../src/lib/agenda/ports';
import { DAEMON_HEALTH_PATH, DaemonFeaturesUnreadable } from '../../../src/lib/daemon/features';
import { humanItem, SESSION, snapshot } from './fixtures';
import { projectionRecord } from '../../../../protocol/tests/fixtures/agenda-projection.ts';

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
  it('uses the owner machine route for machine reads and actions, in both wire spellings', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient({ ...snapshot([]), sessionId: MACHINE_AGENDA_ID }, calls));
    await gateway.snapshot(MACHINE_AGENDA_ID);
    await gateway.apply(MACHINE_AGENDA_ID, { action: 'dismiss', id: 'A1' });
    should(calls.map(call => call.path)).deepEqual(['/v1/machine/agenda', '/v1/machine/agenda']);
    should(() => agendaBoardPath(MACHINE_AGENDA_ID)).throw(/use \/v1\/machine\/agenda/u);
    should(() => legacyAttentionBoardPath(MACHINE_AGENDA_ID)).throw(/use \/v1\/machine\/agenda/u);
    should(() => agendaRepliesPath(MACHINE_AGENDA_ID)).throw(/use \/v1\/machine\/agenda/u);
    should(() => repliesPath(MACHINE_AGENDA_ID)).throw(/use \/v1\/machine\/agenda/u);
    await should(gateway.sendReplies(MACHINE_AGENDA_ID)).be.rejectedWith(/has no replies/u);
    should(calls).have.length(2);
  });

  it('tells a ferret to ask the owner for machine agenda access, without making a request', async () => {
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([]), calls), 's1');
    await should(gateway.snapshot(MACHINE_AGENDA_ID)).be.rejectedWith(/the machine agenda is the owner's; ask them/u);
    await should(gateway.apply(MACHINE_AGENDA_ID, { action: 'dismiss', id: 'A1' })).be.rejectedWith(/ask them/u);
    await should(gateway.sendReplies(MACHINE_AGENDA_ID)).be.rejectedWith(/ask them/u);
    should(calls).be.empty();
  });

  it('should read a full resolved document and refuse another item in its place', async () => {
    // Arrange
    const calls: Call[] = [];
    const input = projectionRecord();
    const gateway = new ProtocolAgendaGateway(fakeClient(input, calls));
    // Act
    const actual = await gateway.readItem(SESSION, 'A1');
    // Assert
    should(actual).deepEqual(input);
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/agenda/A1`);
    await should(gateway.readItem(SESSION, 'A2')).be.rejectedWith(/another agenda item/u);
  });
  it('should read the board with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient(snapshot([humanItem('A1', 'x')]), calls));

    // Act
    const actual = await gateway.snapshot(SESSION);

    // Assert
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/agenda`);
    should(calls[0]?.init).deepEqual({ headers: { 'x-ferretry-client': 'cli', 'x-fy-agenda-channel': '2' } });
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
    should(calls[0]?.init?.headers).deepEqual({
      'content-type': 'application/json',
      'x-ferretry-client': 'cli',
      'x-fy-agenda-channel': '2',
    });
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
    const own = {
      'x-ferretry-client': 'cli',
      'x-fy-agenda-channel': '2',
      'x-ferretry-session-id': 'mvgt2oz9-04e28935',
    };
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
    should(calls[0]?.init?.headers).deepEqual({ 'x-ferretry-client': 'cli', 'x-fy-agenda-channel': '2' });
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
  it('should read them from its health report, none when it reports none, and say so when it cannot be asked', async () => {
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
    await down.features().then(
      () => should.fail('', '', 'an unreadable health was taken as no features'),
      (error: unknown) => should(error).be.instanceOf(DaemonFeaturesUnreadable),
    );
  });
});

describe('protocol agenda gateway: clearing the agent ferrets', () => {
  it('should post a dry run as a count and a clear as an empty body, attributed to the CLI', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolAgendaGateway(fakeClient({ cleared: 4, sessions: 2 }, calls));

    // Act
    const counted = await gateway.clearAgents(true);
    const cleared = await gateway.clearAgents(false);

    // Assert
    should(counted).deepEqual({ cleared: 4, sessions: 2 });
    should(cleared).deepEqual({ cleared: 4, sessions: 2 });
    should(calls.map(call => call.path)).deepEqual(['/v1/agenda/clear-agents', '/v1/agenda/clear-agents']);
    should(calls.map(call => call.init?.body)).deepEqual([JSON.stringify({ dryRun: true }), '{}']);
    should(calls[0]?.init?.method).equal('POST');
  });
});
