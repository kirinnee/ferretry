import { createHmac } from 'node:crypto';
import { describe, it } from 'bun:test';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import should from 'should';
import { ApiDispatcher, type ApiResponse, ApiRouter, entityTag } from '../../../../src/lib/api/index.ts';
import { sessionReadRoutes } from '../../../../src/lib/runtime/index.ts';
import {
  OperatorReadService,
  type OperatorReadRedactor,
  type PaneCapture,
  type PaneScope,
  type SessionTranscriptPages,
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
import type { TranscriptImageReader } from '../../../../src/lib/session/transcript/image-reader.ts';
import { claudeText, claudeUserImage, MemoryTranscript, pngBase64 } from '../../../support/transcript-images.ts';
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
    /** Every scope the pane was asked for, in order. */
    readonly scopes?: PaneScope[];
    /** A session the daemon recorded no terminal address for, which is not the same as a dead pane. */
    readonly noTerminal?: true;
    readonly tail?: TranscriptTailResult;
    readonly storedSnapshot?:
      | { readonly kind: 'absent' | 'unreadable' }
      | { readonly kind: 'read'; readonly text: string };
    readonly rows?: readonly PortableConversationRow[];
    readonly noTranscript?: true;
    readonly redactor?: OperatorReadRedactor;
    readonly images?: TranscriptImageReader;
    readonly pages?: SessionTranscriptPages;
  } = {},
) {
  const reads = new OperatorReadService(
    { replay: async () => options.events ?? [] },
    {
      capture: async (_sessionId, scope) => {
        options.scopes?.push(scope);
        return options.noTerminal === true
          ? undefined
          : (options.capture ?? { alive: true, dead: false, text: 'screen' });
      },
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
    options.redactor,
    options.pages,
  );
  const dispatcher = new ApiDispatcher(
    new ApiRouter([
      ...sessionReadRoutes(
        reads,
        sessionDirectory([sessionView('s1')]),
        options.images ?? new MemoryTranscript([]).reader(),
      ),
    ]),
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

  it('should capture the scrollback by default and the visible screen when asked', async () => {
    // Arrange
    const scopes: PaneScope[] = [];
    const dispatch = fixture({ scopes });

    // Act
    const omitted = await dispatch({ path: '/v1/sessions/s1/snapshot', headers: human });
    const history = await dispatch({
      path: '/v1/sessions/s1/snapshot',
      query: [
        ['live', 'true'],
        ['scope', 'history'],
      ],
      headers: human,
    });
    const screen = await dispatch({
      path: '/v1/sessions/s1/snapshot',
      query: [
        ['live', 'true'],
        ['scope', 'screen'],
      ],
      headers: human,
    });

    // Assert
    should([omitted.status, history.status, screen.status]).deepEqual([200, 200, 200]);
    should(scopes).deepEqual(['history', 'history', 'screen']);
  });

  it('should refuse a scope it does not know before touching the pane', async () => {
    // Arrange
    const scopes: PaneScope[] = [];
    const dispatch = fixture({ scopes });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/snapshot', query: [['scope', 'all']], headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_query');
    should(scopes).deepEqual([]);
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

describe('the session transcript route, read conditionally', () => {
  const said = (text: string): TranscriptTailResult => ({
    kind: 'read',
    events: [{ kind: 'message', harness: 'claude', role: 'assistant', text, timestamp: INSTANT }],
  });

  it('should tag the transcript when the request holds no validator', async () => {
    // Arrange
    const dispatch = fixture({ tail: said('ready') });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', headers: human });

    // Assert
    should(response.status).equal(200);
    should(response.body).equal('[09:08:07] assistant/message: ready');
    should(response.headers.get('etag')).equal(entityTag(response.body));
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should answer 304 with no body when the transcript is the one the client holds', async () => {
    // Arrange
    const dispatch = fixture({ tail: said('ready') });
    const first = await dispatch({ path: '/v1/sessions/s1/logs', headers: human });
    const etag = first.headers.get('etag') ?? '';

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', headers: { ...human, 'if-none-match': etag } });

    // Assert
    should(response.status).equal(304);
    should(response.body).equal('');
    should(response.headers.get('etag')).equal(etag);
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should serve the whole transcript when it moved on from the one the client holds', async () => {
    // Arrange
    const dispatch = fixture({ tail: said('ready, and more') });

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/logs',
      headers: { ...human, 'if-none-match': entityTag('[09:08:07] assistant/message: ready') },
    });

    // Assert
    should(response.status).equal(200);
    should(response.body).equal('[09:08:07] assistant/message: ready, and more');
  });

  it('should take the tag over the redacted text, so a change of redaction is a new answer', async () => {
    // Arrange
    const scrubbing: OperatorReadRedactor = {
      redact: async text => text.replaceAll('hunter2', '[redacted]'),
      batch: async work => work({ text: text => text.replaceAll('hunter2', '[redacted]'), data: value => value }),
    };
    const scrubbed = await fixture({ tail: said('the key is hunter2'), redactor: scrubbing })({
      path: '/v1/sessions/s1/logs',
      headers: human,
    });

    // Act
    const unscrubbed = await fixture({ tail: said('the key is hunter2') })({
      path: '/v1/sessions/s1/logs',
      headers: { ...human, 'if-none-match': scrubbed.headers.get('etag') ?? '' },
    });

    // Assert
    should(scrubbed.body).equal('[09:08:07] assistant/message: the key is [redacted]');
    should(scrubbed.headers.get('etag')).equal(entityTag(scrubbed.body));
    should(unscrubbed.status).equal(200);
  });

  it('should still refuse, not 304, a transcript that cannot be read', async () => {
    // Arrange
    const dispatch = fixture({ tail: { kind: 'unreadable' } });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/logs', headers: { ...human, 'if-none-match': '*' } });

    // Assert
    should(response.status).equal(409);
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

describe('the transcript image route', () => {
  const transcript = new MemoryTranscript([claudeText(1), claudeUserImage(2, [pngBase64(), pngBase64(40)])]);
  const images = (): TranscriptImageReader => transcript.reader();
  const at = (handle: string): string => `/v1/sessions/s1/transcript-images/${handle}`;

  it('should serve the image the handle names, as JSON a tunnel can carry', async () => {
    // Arrange
    const dispatch = fixture({ images: images() });

    // Act
    const response = await dispatch({ path: at(transcript.handle(1, 1)), headers: human });

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('content-type')).match(/^application\/json/u);
    should(jsonBody(response)).eql({
      image: { handle: transcript.handle(1, 1), mediaType: 'image/png', byteLength: 48 },
      base64: pngBase64(40),
    });
  });

  it('should be cacheable for good, never no-store, with a strong validator', async () => {
    // Arrange
    const dispatch = fixture({ images: images() });

    // Act
    const response = await dispatch({ path: at(transcript.handle(1, 0)), headers: human });

    // Assert
    should(response.headers.get('cache-control')).equal('private, max-age=31536000, immutable');
    should(response.headers.get('etag')).match(/^"[A-Za-z0-9_-]+"$/u);
  });

  it('should answer 304 with no body to a matching validator, and a body to a different one', async () => {
    // Arrange
    const dispatch = fixture({ images: images() });
    const path = at(transcript.handle(1, 0));
    const first = await dispatch({ path, headers: human });
    const etag = first.headers.get('etag') ?? '';

    // Act
    const same = await dispatch({ path, headers: { ...human, 'if-none-match': etag } });
    const list = await dispatch({ path, headers: { ...human, 'if-none-match': `"other", ${etag}` } });
    const other = await dispatch({ path, headers: { ...human, 'if-none-match': '"other"' } });

    // Assert
    should(same.status).equal(304);
    should(same.body).equal('');
    should(same.headers.get('etag')).equal(etag);
    should(list.status).equal(304);
    should(other.status).equal(200);
  });

  it('should take a handle spelled as a percent-encoded path segment', async () => {
    // Arrange
    const dispatch = fixture({ images: images() });
    const encoded = encodeURIComponent(transcript.handle(1, 0));

    // Act
    const response = await dispatch({ path: at(encoded), headers: human });

    // Assert
    should(response.status).equal(200);
  });

  it('should serve a base64url image as the standard alphabet', async () => {
    // Arrange
    const raw = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xff, 0xfe, 0xfb, 0xff, 0xfe]),
    ]);
    const urlSafe = new MemoryTranscript([claudeUserImage(1, [raw.toString('base64url')])]);
    const dispatch = fixture({ images: urlSafe.reader() });

    // Act
    const response = await dispatch({ path: at(urlSafe.handle(0)), headers: human });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).base64).equal(raw.toString('base64'));
  });

  it('should answer 404 for a session that does not exist, before it reads any transcript', async () => {
    // Arrange
    const dispatch = fixture({ images: images() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/nobody/transcript-images/0.10.0', headers: human });

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
  });

  it.each([
    ['a handle that is not one', 'nonsense', 400, 'invalid_image_handle'],
    ['an offset in the middle of a record', '5.30.0', 404, 'image_not_found'],
    [
      'an ordinal past the end',
      `${String(transcript.offsets[1])}.${String(transcript.lengths[1])}.9`,
      404,
      'image_not_found',
    ],
    ['a range past the end of the file', '99999999.10.0', 404, 'image_not_found'],
  ])('should refuse %s with a code and no daemon path', async (_name, handle, status, code) => {
    // Arrange
    const dispatch = fixture({ images: images() });

    // Act
    const response = await dispatch({ path: at(handle), headers: human });

    // Assert
    should(response.status).equal(status);
    should(jsonBody(response)).have.property('code', code);
    should(response.body).not.match(/transcripts|\.jsonl|\/home/u);
    should(response.headers.get('cache-control')).not.equal('private, max-age=31536000, immutable');
  });

  it('should refuse bytes that are not an image with 415', async () => {
    // Arrange
    const html = Buffer.from('<html><body>not an image, merely labelled one</body></html>').toString('base64');
    const forged = new MemoryTranscript([claudeUserImage(1, [html])]);
    const dispatch = fixture({ images: forged.reader() });

    // Act
    const response = await dispatch({ path: at(forged.handle(0)), headers: human });

    // Assert
    should(response.status).equal(415);
    should(jsonBody(response)).have.property('code', 'unsupported_image');
  });

  it('should answer 409 for a session whose transcript there is none of', async () => {
    // Arrange
    const none = new MemoryTranscript([claudeUserImage(1, [pngBase64()])], 'claude', false);
    const dispatch = fixture({ images: none.reader() });

    // Act
    const response = await dispatch({ path: at(none.handle(0)), headers: human });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'no_transcript');
  });

  it('should answer 500 without leaking the cause when the reader fails for a reason that is no refusal', async () => {
    // Arrange
    const broken = {
      lookup: async () => {
        throw new Error('disk /var/secret-transcripts is on fire');
      },
    } as unknown as TranscriptImageReader;
    const dispatch = fixture({ images: broken });

    // Act
    const response = await dispatch({ path: at(transcript.handle(1, 0)), headers: human });

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response)).have.property('code', 'internal_error');
    should(JSON.stringify(jsonBody(response))).not.containEql('secret-transcripts');
  });

  it('should refuse the warden and an anonymous caller exactly as it refuses them for /logs', async () => {
    // Arrange
    const dispatch = fixture({ images: images() });
    const handle = transcript.handle(1, 0);

    // Act
    const [logsWarden, imageWarden, logsAnonymous, imageAnonymous] = await Promise.all([
      dispatch({ path: '/v1/sessions/s1/logs', headers: wardenToken }),
      dispatch({ path: at(handle), headers: wardenToken }),
      dispatch({ path: '/v1/sessions/s1/logs' }),
      dispatch({ path: at(handle) }),
    ]);

    // Assert
    should(imageWarden.status).equal(logsWarden.status);
    should(jsonBody(imageWarden).code).equal(jsonBody(logsWarden).code);
    should(imageAnonymous.status).equal(logsAnonymous.status);
    should(jsonBody(imageAnonymous).code).equal(jsonBody(logsAnonymous).code);
    should(imageWarden.status).equal(403);
    should(imageAnonymous.status).equal(401);
  });

  it('should be governed exactly like /logs: same minimum, same capability, and never no-store', () => {
    // Arrange
    const reads = new OperatorReadService(
      { replay: async () => [] },
      { capture: async () => ({ alive: true, dead: false, text: '' }) },
      { tail: async () => ({ kind: 'read', events: [] }) },
      { read: async () => ({ kind: 'unresolved' }) },
      CODEC,
      { read: async () => ({ kind: 'absent' }) },
    );
    const routes = sessionReadRoutes(reads, sessionDirectory([sessionView('s1')]), images());
    const logs = routes.find(route => route.path === '/v1/sessions/:sessionId/logs');
    const image = routes.find(route => route.path === '/v1/sessions/:sessionId/transcript-images/:handle');

    // Assert
    should(logs).not.equal(undefined);
    should(image).not.equal(undefined);
    should(image?.method).equal(logs?.method);
    should(image?.minimum).equal(logs?.minimum);
    should(image?.minimum).equal('operator');
    should(image?.capability).equal(logs?.capability);
    should(image?.capability).equal(undefined);
    should(image?.privilegedOnly).equal(logs?.privilegedOnly);
    should(logs?.noStore).equal(true);
    should(image?.noStore).not.equal(true);
  });
});

describe('the session log page route', () => {
  const page = (calls: unknown[] = []): SessionTranscriptPages => ({
    page: async (_sessionId, query) => {
      calls.push(query);
      return {
        kind: 'read',
        events: [
          { kind: 'message', harness: 'claude', role: 'user', text: 'older', timestamp: INSTANT, byteOffset: 40 },
        ],
        start: 40,
        file: 'file-token',
      };
    },
  });

  it('should serve a page with where it begins and which file it came from', async () => {
    // Arrange
    const calls: unknown[] = [];
    const dispatch = fixture({ pages: page(calls) });

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/log-page',
      query: [
        ['before', '900'],
        ['from', '10'],
        ['limit', '50'],
        ['file', 'file-token'],
      ],
      headers: human,
    });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).eql({
      v: 1,
      sessionId: 's1',
      log: '[09:08:07] user/message: older',
      start: 40,
      file: 'file-token',
    });
    should(calls).eql([{ limit: 50, before: 900, from: 10 }]);
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should read the tail when no byte is named, and answer an unchanged page 304', async () => {
    // Arrange
    const calls: unknown[] = [];
    const dispatch = fixture({ pages: page(calls) });
    const first = await dispatch({ path: '/v1/sessions/s1/log-page', headers: human });
    const etag = first.headers.get('etag') ?? '';

    // Act
    const again = await dispatch({ path: '/v1/sessions/s1/log-page', headers: { ...human, 'if-none-match': etag } });

    // Assert
    should(calls[0]).eql({ limit: 200 });
    should(again.status).equal(304);
  });

  it('should refuse a page of a file other than the one the earlier pages came from', async () => {
    // Arrange
    const dispatch = fixture({ pages: page() });

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/log-page',
      query: [
        ['before', '900'],
        ['file', 'another-file'],
      ],
      headers: human,
    });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'log_cursor_stale');
  });

  it('should refuse an offset that is not a byte of a file, or a floor without an end', async () => {
    // Arrange
    const dispatch = fixture({ pages: page() });

    // Act
    const negative = await dispatch({ path: '/v1/sessions/s1/log-page', query: [['before', '-1']], headers: human });
    const floorOnly = await dispatch({ path: '/v1/sessions/s1/log-page', query: [['from', '3']], headers: human });
    const inverted = await dispatch({
      path: '/v1/sessions/s1/log-page',
      query: [
        ['before', '3'],
        ['from', '9'],
      ],
      headers: human,
    });

    // Assert
    for (const response of [negative, floorOnly, inverted]) {
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'invalid_query');
    }
  });

  it('should refuse a session whose transcript file cannot be proved', async () => {
    // Arrange
    const dispatch = fixture({ pages: { page: async () => ({ kind: 'unresolved' }) } });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/log-page', headers: human });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'no_transcript');
  });

  it('should refuse rather than serve an empty page when no page reader is wired', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/log-page', headers: human });

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).have.property('code', 'transcript_unreadable');
  });

  it('should keep the warden off it, as it keeps the warden off the transcript', async () => {
    // Arrange
    const dispatch = fixture({ pages: page() });

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/log-page', headers: wardenToken });

    // Assert
    should(response.status).equal(403);
  });
});
