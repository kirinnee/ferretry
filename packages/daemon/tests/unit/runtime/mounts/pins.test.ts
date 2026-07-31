import { PIN_SCHEMA_VERSION } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher, ApiRouter, type ApiResponse } from '../../../../src/lib/api/index.ts';
import { pinActor, pinRoutes } from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { AT, CREDENTIALS, IDS, agentIn, human, pinService } from './support.ts';

interface Fixture {
  readonly dispatch: (overrides: Parameters<typeof request>[0]) => Promise<ApiResponse>;
}

function fixture(options: { readonly instant?: string } = {}): Fixture {
  const routes = pinRoutes(pinService(['s1', 's2'], options.instant ?? AT));
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS);
  return { dispatch: async overrides => await dispatcher.dispatch(request(overrides)) };
}

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
