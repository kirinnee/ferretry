import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { sessionReadRoutes } from '../../../../src/lib/runtime/index.ts';
import {
  OperatorReadService,
  type PaneCapture,
  type StoredSessionEvent,
  type TranscriptTailResult,
} from '../../../../src/lib/session/reads/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionDirectory, sessionView } from './support.ts';

/**
 * The HTTP shape of the operator reads.
 *
 * Three things are asserted here that the domain cannot assert for itself: an unknown session is a 404
 * before any evidence is gathered, a parameter this daemon cannot honour is a stated refusal rather than
 * a silently different answer, and none of these responses is cacheable.
 */

const INSTANT = '2026-02-01T09:08:07.000Z';

/** The warden-scoped token, which must never reach this surface. */
const wardenToken = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

function fixture(
  options: {
    readonly events?: readonly StoredSessionEvent[];
    readonly capture?: PaneCapture;
    /** A session the daemon recorded no terminal address for, which is not the same as a dead pane. */
    readonly noTerminal?: true;
    readonly tail?: TranscriptTailResult;
  } = {},
) {
  const reads = new OperatorReadService(
    { replay: async () => options.events ?? [] },
    {
      capture: async () =>
        options.noTerminal === true ? undefined : (options.capture ?? { alive: true, dead: false, text: 'screen' }),
    },
    { tail: async () => options.tail ?? { kind: 'read', events: [] } },
  );
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...sessionReadRoutes(reads, sessionDirectory([sessionView('s1')]))]),
    CREDENTIALS,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const event = (sequence: number): StoredSessionEvent => ({
  sequence,
  sessionId: 's1',
  time: INSTANT,
  type: 'session.created',
  data: {},
});

describe('the session event replay route', () => {
  it('should serve the page in the protocol envelope', async () => {
    // Arrange
    const dispatch = fixture({ events: [event(1)] });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/events', headers: human });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).eql([
      { sequence: 1, time: INSTANT, sessionId: 's1', type: 'session.created', source: 'daemon', data: {} },
    ]);
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should answer 404 for a session the daemon does not hold', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/other/events', headers: human });

    // Assert — without this, an unknown id and a session with no history would both read as an empty page.
    should(response.status).equal(404);
  });

  it('should refuse a non-numeric cursor rather than falling back to the default', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/events', query: [['after', 'latest']], headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_query');
  });

  it('should restate a domain refusal as a status a client can act on', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/events', query: [['limit', '0']], headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_query');
  });

  it('should fail closed when journal evidence crosses a session boundary', async () => {
    // Arrange
    const dispatch = fixture({ events: [{ ...event(1), sessionId: 's2' }] });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/events', headers: human });

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response)).have.property('code', 'event_evidence_mismatch');
  });

  it('should treat an empty query value as absent', async () => {
    // Arrange
    const dispatch = fixture({ events: [event(1)] });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/events', query: [['limit', '']], headers: human });

    // Assert
    should(response.status).equal(200);
  });

  it('should refuse a path parameter that is not usable as an id', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/%2f/events', headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });

  it('should not serve the warden', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/events', headers: wardenToken });

    // Assert — the journal carries the session's configuration in its lifecycle events.
    should(response.status).equal(403);
  });
});

describe('the session snapshot route', () => {
  it('should serve the live screen as text', async () => {
    // Arrange
    const dispatch = fixture({ capture: { alive: true, dead: false, text: 'the agent is thinking' } });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/snapshot', query: [['live', 'true']], headers: human });

    // Assert
    should(response.status).equal(200);
    should(response.body).equal('the agent is thinking');
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should refuse a stored last frame this daemon never wrote', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/snapshot', query: [['live', 'false']], headers: human });

    // Assert — honouring it would answer '' for every session, which reads as a blank terminal.
    should(response.status).equal(501);
    should(jsonBody(response)).have.property('code', 'stored_snapshot_unavailable');
  });

  it('should report a dead pane as a conflict rather than a blank screen', async () => {
    // Arrange
    const dispatch = fixture({ capture: { alive: false, dead: true, text: '' } });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/snapshot', headers: human });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'pane_dead');
  });

  it('should distinguish a session with no terminal at all', async () => {
    // Arrange
    const dispatch = fixture({ noTerminal: true });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/snapshot', headers: human });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'no_terminal');
  });

  it('should answer 404 for a session the daemon does not hold', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/other/snapshot', headers: human });

    // Assert
    should(response.status).equal(404);
  });
});

describe('the session transcript route', () => {
  it('should render the resolved tail as text', async () => {
    // Arrange
    const dispatch = fixture({
      tail: {
        kind: 'read',
        events: [{ kind: 'message', harness: 'claude', role: 'assistant', text: 'ready', timestamp: INSTANT }],
      },
    });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', headers: human });

    // Assert
    should(response.status).equal(200);
    should(response.body).equal('[09:08:07] assistant/message: ready');
  });

  it('should refuse a turn slice this daemon keeps no log for', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', query: [['turn', '3']], headers: human });

    // Assert — serving the whole tail would hand a caller comparing two turns the same bytes twice.
    should(response.status).equal(501);
    should(jsonBody(response)).have.property('code', 'turn_partition_unavailable');
  });

  it('should refuse a session whose transcript file cannot be proved', async () => {
    // Arrange
    const dispatch = fixture({ tail: { kind: 'unresolved' } });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', headers: human });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'no_transcript');
  });

  it('should refuse a proved transcript that became unreadable', async () => {
    // Arrange
    const dispatch = fixture({ tail: { kind: 'unreadable' } });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', headers: human });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'transcript_unreadable');
  });

  it('should answer 404 for a session the daemon does not hold', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/other/logs', headers: human });

    // Assert
    should(response.status).equal(404);
  });

  it('should refuse a limit outside the ceiling', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', query: [['limit', '99999']], headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_query');
  });
});
