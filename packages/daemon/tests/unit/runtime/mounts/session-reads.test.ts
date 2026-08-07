import { createHmac } from 'node:crypto';
import { describe, it } from 'bun:test';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { sessionReadRoutes } from '../../../../src/lib/runtime/index.ts';
import {
  OperatorReadService,
  type PaneCapture,
  type StoredSessionEvent,
  type TranscriptTailResult,
} from '../../../../src/lib/session/reads/index.ts';
import type { PortableConversationRow } from '../../../../src/lib/session/transcript/digest.ts';
import {
  issueSessionTranscriptMessageToken,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
  type SessionTranscriptMessageTokenCodec,
  type SessionTranscriptMessageTokenContext,
} from '../../../../src/lib/session/transcript/message-token.ts';
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

/** A stand-in for the daemon-private key. The read's own tests own what a token means. */
const CODEC: SessionTranscriptMessageTokenCodec = {
  tag: async input => new Uint8Array(createHmac('sha256', 'mount-fixture-key').update(input).digest()),
  matches: async (input, tag) =>
    Buffer.from(createHmac('sha256', 'mount-fixture-key').update(input).digest()).equals(Buffer.from(tag)),
};

const CONTEXT: SessionTranscriptMessageTokenContext = {
  sessionId: 's1',
  incarnation: 'inc-one',
  provenance: {
    v: 1,
    home: '/harness/home',
    identity: 'minted',
    harnessSessionId: 'harness-one',
    file: '/harness/home/one.jsonl',
    resolvedAt: INSTANT,
  },
};

const addressable = (byteOffset: number, prefix = byteOffset): PortableConversationRow => ({
  point: { v: 1, byteOffset, blockIndex: 0 },
  role: 'assistant',
  text: `said at ${byteOffset}`,
  timestamp: INSTANT,
  rawPrefix: new Uint8Array(32).fill(prefix),
});

function fixture(
  options: {
    readonly events?: readonly StoredSessionEvent[];
    readonly capture?: PaneCapture;
    /** A session the daemon recorded no terminal address for, which is not the same as a dead pane. */
    readonly noTerminal?: true;
    readonly tail?: TranscriptTailResult;
    readonly storedSnapshot?:
      | { readonly kind: 'absent' | 'unreadable' }
      | { readonly kind: 'read'; readonly text: string };
    readonly rows?: readonly PortableConversationRow[];
    readonly noTranscript?: true;
  } = {},
) {
  const reads = new OperatorReadService(
    { replay: async () => options.events ?? [] },
    {
      capture: async () =>
        options.noTerminal === true ? undefined : (options.capture ?? { alive: true, dead: false, text: 'screen' }),
    },
    { tail: async () => options.tail ?? { kind: 'read', events: [] } },
    {
      read: async () =>
        options.noTranscript === true
          ? { kind: 'unresolved' }
          : { kind: 'read', context: CONTEXT, rows: options.rows ?? [addressable(10), addressable(20)] },
    },
    CODEC,
    { read: async () => options.storedSnapshot ?? { kind: 'absent' } },
  );
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...sessionReadRoutes(reads, sessionDirectory([sessionView('s1')]))]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

/** A cursor this daemon really issued, for a row that may or may not still be there. */
const cursorFor = async (row: PortableConversationRow): Promise<string> =>
  await issueSessionTranscriptMessageToken(
    CODEC,
    SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
    CONTEXT,
    row.point,
    row.rawPrefix,
  );

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

  it('should serve a stored final frame when the daemon captured one', async () => {
    // Arrange
    const dispatch = fixture({ storedSnapshot: { kind: 'read', text: 'final frame' } });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/snapshot', query: [['live', 'false']], headers: human });

    // Assert
    should(response.status).equal(200);
    should(response.body).equal('final frame');
  });

  it('should refuse a stored last frame the daemon never captured', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/snapshot', query: [['live', 'false']], headers: human });

    // Assert — an absent artifact is not a blank captured terminal.
    should(response.status).equal(409);
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

  it('should serve a turn slice only when normalized evidence proves its boundary', async () => {
    // Arrange
    const dispatch = fixture({
      tail: {
        kind: 'read',
        events: [
          { kind: 'turn', harness: 'codex', role: 'system', state: 'started' },
          { kind: 'message', harness: 'codex', role: 'assistant', text: 'first turn' },
        ],
      },
    });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', query: [['turn', '0']], headers: human });

    // Assert
    should(response.status).equal(200);
    should(response.body).containEql('first turn');
  });

  it('should refuse a turn slice whose boundary transcript evidence cannot prove', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', query: [['turn', '3']], headers: human });

    // Assert
    should(response.status).equal(409);
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

describe('the session addressable-message route', () => {
  it('should serve the page in the protocol envelope and never cache it', async () => {
    // Arrange
    const dispatch = fixture({ rows: [addressable(10)] });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/messages', headers: human });

    // Assert — the rows carry evidence that is only true of the conversation as it read just now, so a
    // cached page is a page whose bindings may already have been refused.
    should(response.status).equal(200);
    should(jsonBody(response)).have.property('v', 1);
    should(jsonBody(response)).have.property('sessionId', 's1');
    should(jsonBody(response)).have.property('nextCursor', null);
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should page over the cursor it handed back', async () => {
    // Arrange
    const dispatch = fixture({ rows: [addressable(10), addressable(20)] });

    // Act
    const first = await dispatch({ path: '/v1/sessions/s1/messages', query: [['limit', '1']], headers: human });
    const cursor = jsonBody(first).nextCursor;
    should(cursor).be.a.String();
    const second = await dispatch({
      path: '/v1/sessions/s1/messages',
      query: [
        ['cursor', String(cursor)],
        ['limit', '1'],
      ],
      headers: human,
    });

    // Assert — the token survives the query string verbatim; nothing on this route re-spells its bytes.
    should(second.status).equal(200);
    should(second.body).containEql('"byteOffset":20');
  });

  it('should answer 404 for a session the daemon does not hold', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/other/messages', headers: human });

    // Assert — existence is decided before any transcript evidence is gathered.
    should(response.status).equal(404);
  });

  it('should not serve the warden', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/messages', headers: wardenToken });

    // Assert — an addressable transcript is everything the agent has said, plus a handle to act on it.
    should(response.status).equal(403);
  });

  it('should refuse a blank or malformed cursor as a bad request', async () => {
    // Arrange
    const dispatch = fixture();

    // Act — an empty value is NOT treated as absent here, unlike the numeric parameters.
    const blank = await dispatch({ path: '/v1/sessions/s1/messages', query: [['cursor', '']], headers: human });
    const malformed = await dispatch({
      path: '/v1/sessions/s1/messages',
      query: [['cursor', 'page-2']],
      headers: human,
    });

    // Assert
    should([blank.status, malformed.status]).eql([400, 400]);
    should(jsonBody(blank)).have.property('code', 'invalid_query');
    should(jsonBody(malformed)).have.property('code', 'invalid_query');
  });

  it('should answer a well-formed cursor the conversation has moved past with a conflict', async () => {
    // Arrange — the anchor row is gone, which is a statement about the session rather than the request.
    const stale = await cursorFor(addressable(20));
    const dispatch = fixture({ rows: [addressable(10)] });

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/messages',
      query: [['cursor', stale]],
      headers: human,
    });

    // Assert — 409 and not 400: the client corrects this by re-reading, not by fixing its query.
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'message_cursor_stale');
  });

  it('should answer a well-formed cursor whose anchor content changed with the same conflict', async () => {
    // Arrange — the point still resolves; only the raw prefix beneath it moved.
    const stale = await cursorFor(addressable(20));
    const dispatch = fixture({ rows: [addressable(10), addressable(20, 99)] });

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/messages',
      query: [['cursor', stale]],
      headers: human,
    });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'message_cursor_stale');
  });

  it('should refuse a limit this route does not offer', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const zero = await dispatch({ path: '/v1/sessions/s1/messages', query: [['limit', '0']], headers: human });
    const huge = await dispatch({ path: '/v1/sessions/s1/messages', query: [['limit', '1001']], headers: human });
    const words = await dispatch({ path: '/v1/sessions/s1/messages', query: [['limit', 'all']], headers: human });

    // Assert
    should([zero.status, huge.status, words.status]).eql([400, 400, 400]);
    for (const response of [zero, huge, words]) should(jsonBody(response)).have.property('code', 'invalid_query');
  });

  it('should treat an absent limit as the default rather than an error', async () => {
    // Arrange
    const dispatch = fixture({ rows: [addressable(10)] });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/messages', query: [['limit', '']], headers: human });

    // Assert
    should(response.status).equal(200);
  });

  it('should refuse a session whose transcript file cannot be proved', async () => {
    // Arrange
    const dispatch = fixture({ noTranscript: true });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/messages', headers: human });

    // Assert — an empty page here would read as "there is nothing to fork from".
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'no_transcript');
  });

  it('should refuse a path parameter that is not usable as an id', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/%2f/messages', headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });
});
