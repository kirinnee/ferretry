import { PIN_SCHEMA_VERSION, type Pin, type PinSnapshot } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher, ApiRouter, type ApiResponse } from '../../../../src/lib/api/index.ts';
import { PinService, type PinRepository, type PinSessionDirectory } from '../../../../src/lib/pins/index.ts';
import {
  createMountedDispatcher,
  mountedDaemonRoutes,
  pinActor,
  pinRoutes,
} from '../../../../src/lib/runtime/index.ts';
import type { UsageFeedPort } from '../../../../src/lib/usage/index.ts';
import { fixedClock, jsonBody, request } from '../../api/support.ts';

const AT = '2024-05-01T10:00:00.000Z';
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const CREDENTIALS = { admin: 'admin-secret', warden: 'warden-secret' } as const;

/** A repository under the test's control: the domain rules are real, the storage is not. */
class FakeRepository implements PinRepository {
  constructor(private pins: readonly Pin[] = []) {}

  async snapshot(sessionId: string): Promise<PinSnapshot> {
    return this.document(sessionId, this.pins);
  }

  async mutate(sessionId: string, transform: (current: readonly Pin[]) => readonly Pin[]): Promise<PinSnapshot> {
    this.pins = transform(this.pins);
    return this.document(sessionId, this.pins);
  }

  private document(sessionId: string, pins: readonly Pin[]): PinSnapshot {
    return { v: PIN_SCHEMA_VERSION, sessionId, pins: [...pins], updatedAt: AT };
  }
}

class FakeSessions implements PinSessionDirectory {
  constructor(private readonly known: readonly string[]) {}

  async has(sessionId: string): Promise<boolean> {
    return this.known.includes(sessionId);
  }
}

interface Fixture {
  readonly dispatch: (overrides: Parameters<typeof request>[0]) => Promise<ApiResponse>;
  readonly repository: FakeRepository;
}

function fixture(options: { readonly pins?: readonly Pin[]; readonly instant?: string } = {}): Fixture {
  const repository = new FakeRepository(options.pins ?? []);
  let minted = -1;
  const service = new PinService(
    new FakeSessions(['s1', 's2']),
    repository,
    { now: () => options.instant ?? AT },
    {
      next: () => {
        minted += 1;
        return IDS[minted] ?? `unexpected-${minted}`;
      },
    },
  );
  const dispatcher = new ApiDispatcher(new ApiRouter([...pinRoutes(service)]), CREDENTIALS);
  return { dispatch: async overrides => await dispatcher.dispatch(request(overrides)), repository };
}

/** The human's CLI. */
const human = { authorization: `Bearer ${CREDENTIALS.admin}`, 'x-ferretry-client': 'cli' } as const;
/** An agent calling from inside its own pane. */
const agentIn = (sessionId: string) => ({ ...human, 'x-ferretry-session-id': sessionId });

const post = (body: unknown, headers: Readonly<Record<string, string>> = human) => ({
  method: 'POST',
  path: '/v1/sessions/s1/pins',
  headers,
  body: JSON.stringify(body),
});

describe('pinActor', () => {
  it('should treat only an in-pane peer as an agent', () => {
    // Arrange / Act / Assert — the session id is server-derived, so a body cannot forge it.
    should(pinActor('peer:s1')).deepEqual({ sessionId: 's1' });
    should(pinActor('admin-cli')).deepEqual({});
    should(pinActor('admin-ui')).deepEqual({});
    should(pinActor('warden:s1')).deepEqual({});
    should(pinActor(undefined)).deepEqual({});
  });
});

describe('pin routes', () => {
  it("should list a session's board for the human", async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/pins', headers: human });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ v: PIN_SCHEMA_VERSION, sessionId: 's1', pins: [], updatedAt: AT });
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should refuse a path session id that decodes to a traversal step', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act — '%2e%2e' decodes to '..', which must never reach a session lookup.
    const response = await dispatch({ path: '/v1/sessions/%2e%2e/pins', headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });

  it('should report an unknown session as not found', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/nope/pins', headers: human });

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
  });

  it('should report a malformed session id as a client error', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act — uppercase is not a legal session id, so the domain refuses it as invalid, not missing.
    const response = await dispatch({ path: '/v1/sessions/S1/pins', headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid');
  });

  it('should add a note pin attributed to the human', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch(post({ action: 'add', kind: 'note', text: 'ship the gate' }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).pins).deepEqual([
      {
        id: IDS[0],
        at: Date.parse(AT),
        kind: 'note',
        text: 'ship the gate',
        by: 'human',
        createdBy: null,
        createdByName: null,
      },
    ]);
  });

  it('should add a message pin attributed to the agent that sent it', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch(
      post(
        { action: 'add', kind: 'message', blockId: 'b1', blockKind: 'assistant', preview: '  the   plan  ' },
        agentIn('s1'),
      ),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).pins).deepEqual([
      {
        id: IDS[0],
        at: Date.parse(AT),
        kind: 'message',
        blockId: 'b1',
        blockKind: 'assistant',
        // Whitespace is flattened by the domain, so a preview cannot smuggle layout into a client.
        preview: 'the plan',
        by: 'agent',
        createdBy: 's1',
        createdByName: null,
      },
    ]);
  });

  it('should let the human edit a note the agent created', async () => {
    // Arrange
    const { dispatch } = fixture();
    await dispatch(post({ action: 'add', kind: 'note', text: 'first' }, agentIn('s1')));

    // Act
    const response = await dispatch(post({ action: 'edit', id: IDS[0], text: 'second' }));

    // Assert
    should(response.status).equal(200);
    should((jsonBody(response).pins as readonly { text: string }[])[0]?.text).equal('second');
  });

  it('should remove a pin', async () => {
    // Arrange
    const { dispatch } = fixture();
    await dispatch(post({ action: 'add', kind: 'note', text: 'transient' }));

    // Act
    const response = await dispatch(post({ action: 'remove', id: IDS[0] }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).pins).be.empty();
  });

  it('should refuse an agent pinning to a session that is not its own', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch(post({ action: 'add', kind: 'note', text: 'not mine' }, agentIn('s2')));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'forbidden');
  });

  it('should refuse an agent editing a pin it did not create', async () => {
    // Arrange
    const { dispatch } = fixture();
    await dispatch(post({ action: 'add', kind: 'note', text: 'the human wrote this' }));

    // Act
    const response = await dispatch(post({ action: 'edit', id: IDS[0], text: 'hijacked' }, agentIn('s1')));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'forbidden');
  });

  it('should refuse a body the protocol schema rejects, naming the field', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch(post({ action: 'add', kind: 'note', text: '' }));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_request');
    should(String(jsonBody(response).error)).match(/text/u);
  });

  it('should surface a genuine daemon fault as an internal error, not a client error', async () => {
    // A clock that cannot produce an instant is a bug in the daemon; blaming the caller would send
    // an operator hunting through their own request for a fault that is not there.
    // Arrange
    const { dispatch } = fixture({ instant: 'not-an-instant' });

    // Act
    const response = await dispatch(post({ action: 'add', kind: 'note', text: 'anything' }));

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response)).have.property('code', 'internal_error');
  });

  it('should keep the board out of the warden token’s reach', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/pins',
      headers: { authorization: `Bearer ${CREDENTIALS.warden}` },
    });

    // Assert
    should(response.status).equal(403);
  });

  it('should answer 401 without a token at all', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/pins' });

    // Assert
    should(response.status).equal(401);
  });
});

/** A feed that never collected: enough to build the base surface without a transport. */
const emptyFeed: UsageFeedPort = {
  accounts: async () => [],
  snapshotAt: () => undefined,
  hasSnapshot: () => false,
};

describe('the mounted daemon surface', () => {
  const base = { credentials: CREDENTIALS, usage: emptyFeed, clock: fixedClock(1_700_000_000_000), startedAtMs: 0 };
  const subsystems = {
    pins: new PinService(new FakeSessions([]), new FakeRepository(), { now: () => AT }, { next: () => IDS[0]! }),
  };

  it('should serve the base feeds and every mounted subsystem from one table', () => {
    // Arrange / Act
    const paths = mountedDaemonRoutes(base, subsystems).map(route => `${route.method} ${route.path}`);

    // Assert
    should(paths).containDeep([
      'GET /healthz',
      'GET /v1/health',
      'GET /usage',
      'GET /v1/usage',
      'GET /metrics',
      'GET /v1/sessions/:sessionId/pins',
      'POST /v1/sessions/:sessionId/pins',
    ]);
  });

  it('should dispatch a base feed and a subsystem route through the same dispatcher', async () => {
    // Arrange
    const dispatcher = createMountedDispatcher(base, subsystems);

    // Act
    const health = await dispatcher.dispatch(request({ path: '/healthz' }));
    const pins = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/pins', headers: human }));

    // Assert
    should(health.status).equal(200);
    // The session is unknown to this fixture, which still proves the route is mounted and reached.
    should(pins.status).equal(404);
  });
});
