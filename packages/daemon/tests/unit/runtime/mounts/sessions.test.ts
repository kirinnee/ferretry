import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import { SessionListSchema, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { sessionRoutes, type SessionDirectorySubsystem } from '../../../../src/lib/runtime/mounts/sessions.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionDirectory, sessionView } from './support.ts';

/**
 * The session read routes, driven through the real router over a reader the test owns.
 *
 * Every body is parsed against the PROTOCOL schema rather than inspected field by field, because the
 * whole value of this mount is that the shape the client already speaks is the shape the daemon
 * answers with — an assertion on two fields would pass while the wire contract was broken.
 */

function dispatcher(subsystem: SessionDirectorySubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

const FIRST = sessionView('s1', { name: 'Wire Subsystems' });
const SECOND = sessionView('s2', { name: 'Mount The Boards' }, { status: 'completed' });

describe('the session read mount', () => {
  it('should answer the whole fleet in the wire shape the client parses', async () => {
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST, SECOND])).dispatch(
      request({ path: '/v1/sessions', headers: human }),
    );

    // Assert
    should(response.status).equal(200);
    const sessions = SessionListSchema.parse(JSON.parse(response.body));
    should(sessions.map(session => [session.config.id, session.state.status])).deepEqual([
      ['s1', 'running'],
      ['s2', 'completed'],
    ]);
    // The directory is part of the contract: a client uses it to find the session's own files.
    should(sessions[0]?.directory).equal('/state/sessions/s1');
  });

  it('should answer an empty fleet with an empty list rather than a refusal', async () => {
    // A daemon that has never created a session holds none, and none is an answer, not an error.
    // Arrange / Act
    const response = await dispatcher(sessionDirectory()).dispatch(request({ path: '/v1/sessions', headers: human }));

    // Assert
    should(response.status).equal(200);
    should(SessionListSchema.parse(JSON.parse(response.body))).deepEqual([]);
  });

  it('should answer one session in full', async () => {
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST, SECOND])).dispatch(
      request({ path: '/v1/sessions/s2', headers: human }),
    );

    // Assert
    should(response.status).equal(200);
    should(SessionViewSchema.parse(JSON.parse(response.body)).config.name).equal('Mount The Boards');
  });

  it('should answer a session the index does not hold as absent', async () => {
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST])).dispatch(
      request({ path: '/v1/sessions/ghost', headers: human }),
    );

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
  });

  it('should refuse a session whose documents the protocol rejects instead of calling it absent', async () => {
    // This is the reason the read exists alongside the list: the list omits an unusable session, so
    // reporting it here as never having existed would make the gap in the list unanswerable.
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST], { unusable: ['s9'] })).dispatch(
      request({ path: '/v1/sessions/s9', headers: human }),
    );

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response)).have.property('code', 'unusable_session_document');
  });

  it('should refuse an id the state-home layout would not accept', async () => {
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST], { invalid: ['..'] })).dispatch(
      request({ path: '/v1/sessions/..', headers: human }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });

  it('should refuse a path parameter whose encoding regains a separator', async () => {
    // The reader is never reached: a traversal must not be one thing to routing and another to the
    // handler, so the decode happens here and a decoded separator is refused outright.
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST])).dispatch(
      request({ path: '/v1/sessions/%2e%2e%2fetc', headers: human }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });

  it('should refuse a caller holding only the warden token', async () => {
    // A session view carries the working directory, the harness and the model the operator chose.
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST])).dispatch(
      request({
        path: '/v1/sessions',
        headers: { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' },
      }),
    );

    // Assert
    should(response.status).equal(403);
  });

  it('should never let a cached view stand in for live session state', async () => {
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST])).dispatch(
      request({ path: '/v1/sessions', headers: human }),
    );

    // Assert
    should(response.headers.get('cache-control')).match(/no-store/u);
  });
});
