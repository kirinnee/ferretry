import { describe, it } from 'bun:test';
import { SessionListSchema, type SessionView, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { gunzipSync } from 'node:zlib';
import { NodeGzip } from '../../../../src/adapters/api/node-gzip.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import type { ResponseCompressor } from '../../../../src/lib/api/compression.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SessionDirectorySubsystem, sessionRoutes } from '../../../../src/lib/runtime/mounts/sessions.ts';
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

/** One copy of `value` per primitive leaf, with only that leaf changed. */
function* leafVariants<T>(value: T): Generator<T> {
  if (typeof value === 'string') yield `${value}~` as T;
  else if (typeof value === 'number') yield (value + 1) as T;
  else if (typeof value === 'boolean') yield !value as T;
  else if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      for (const changed of leafVariants(item)) yield value.map((other, at) => (at === index ? changed : other)) as T;
    yield [...value, 'extra'] as T;
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      for (const changed of leafVariants(item)) yield { ...value, [key]: changed };
  }
}

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

  it('should answer a fleet the client already holds with a bodyless 304 under the same tag', async () => {
    // Arrange
    const mount = dispatcher(sessionDirectory([FIRST, SECOND]));
    const first = await mount.dispatch(request({ path: '/v1/sessions', headers: human }));
    const etag = first.headers.get('etag');

    // Act
    const again = await mount.dispatch(
      request({ path: '/v1/sessions', headers: { ...human, 'if-none-match': etag ?? '' } }),
    );

    // Assert
    should(first.status).equal(200);
    should(etag).match(/^"[A-Za-z0-9_-]+"$/u);
    should(again.status).equal(304);
    should(again.body).equal('');
    should(again.headers.get('etag')).equal(etag);
    // Still live state: a 304 confirms the bytes, it never licenses a cache to answer for them.
    should(again.headers.get('cache-control')).match(/no-store/u);
  });

  it('should answer two reads of an unchanged fleet with the same tag, and the second with a 304 that compresses nothing', async () => {
    // The tag is a digest of the served body and nothing in a list read is volatile, so an unchanged fleet
    // is a 304 over ANY encoding. Two separately built, equal fleets stand in for two reads of one.
    // Arrange
    const fleet = () =>
      Array.from({ length: 60 }, (_, index) => sessionView(`s${index}`, { name: `Session ${index}` }));
    const compressed: string[] = [];
    const real = new NodeGzip();
    const compressor: ResponseCompressor = {
      gzip: async text => {
        compressed.push(text);
        return await real.gzip(text);
      },
    };
    const mount = (views: readonly SessionView[]) =>
      new ApiDispatcher(
        new ApiRouter(sessionRoutes(sessionDirectory(views))),
        CREDENTIALS,
        NO_GOVERNED_ROUTES_GUARD,
        undefined,
        undefined,
        undefined,
        compressor,
      );
    const gzip = { ...human, 'accept-encoding': 'gzip' };

    // Act
    const first = await mount(fleet()).dispatch(request({ path: '/v1/sessions', headers: gzip }));
    const etag = first.headers.get('etag') ?? '';
    const second = await mount(fleet()).dispatch(
      request({ path: '/v1/sessions', headers: { ...gzip, 'if-none-match': etag } }),
    );

    // Assert
    should(first.status).equal(200);
    should(Buffer.from(gunzipSync(first.gzip ?? new Uint8Array())).toString('utf8')).equal(first.body);
    should(second.status).equal(304);
    should(second.gzip).be.undefined();
    should(second.headers.get('etag')).equal(etag);
    should(compressed).have.length(1);
  });

  it('should answer in full when the tag the client holds is not the current one', async () => {
    // Arrange / Act
    const response = await dispatcher(sessionDirectory([FIRST])).dispatch(
      request({ path: '/v1/sessions', headers: { ...human, 'if-none-match': '"stale"' } }),
    );

    // Assert
    should(response.status).equal(200);
    should(SessionListSchema.parse(JSON.parse(response.body))).have.length(1);
  });

  it('should move the tag when any field a client could render moves', async () => {
    // Every leaf of the view, changed one at a time, plus the optional cursor appearing: the tag is a
    // digest of the served body, so no field can change behind a 304.
    // Arrange
    const tagOf = async (views: readonly SessionView[]): Promise<string | undefined> =>
      (
        await dispatcher(sessionDirectory(views)).dispatch(request({ path: '/v1/sessions', headers: human }))
      ).headers.get('etag');
    const base = await tagOf([FIRST, SECOND]);
    const variants = [...leafVariants(FIRST)].map(view => [view, SECOND]);
    variants.push([{ ...FIRST, journalSequence: 7 }, SECOND], [SECOND, FIRST], [FIRST]);

    // Act
    const tags = await Promise.all(variants.map(async views => await tagOf(views)));

    // Assert
    should(variants.length).be.above(30);
    for (const tag of tags) should(tag).not.equal(base);
    should(await tagOf([FIRST, SECOND])).equal(base);
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
