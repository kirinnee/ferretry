import { describe, it } from 'bun:test';
import { OpenUrlViewSchema } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { systemOpenRoutes } from '../../../../src/lib/runtime/mounts/system-open.ts';
import { OpenUrlError } from '../../../../src/lib/system/open-url.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

/**
 * The HTTP shape of "open this link in the computer's own browser".
 *
 * The decision that matters here is WHO may ask: privilege is the carrier's, so a request that arrived
 * over the relay, a tunnel or WebRTC is refused before the subsystem is asked anything.
 */

class RecordingOpen {
  readonly asked: string[] = [];
  constructor(private readonly failure?: OpenUrlError) {}
  async open(url: string) {
    this.asked.push(url);
    if (this.failure !== undefined) throw this.failure;
    return { opened: true as const, host: 'example.com' };
  }
}

function fixture(subsystem: RecordingOpen) {
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...systemOpenRoutes(subsystem)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const post = (url: unknown, loopback: boolean) =>
  ({
    method: 'POST',
    path: '/v1/system/open-url',
    headers: human,
    loopback,
    body: JSON.stringify({ url }),
  }) as const;

describe('the system open-url route', () => {
  it('should open a link for a caller on this machine and answer the host only', async () => {
    // Arrange
    const subsystem = new RecordingOpen();

    // Act
    const response = await fixture(subsystem)(post('https://example.com/a?token=1', true));

    // Assert
    should(response.status).equal(200);
    should(OpenUrlViewSchema.parse(jsonBody(response))).deepEqual({ opened: true, host: 'example.com' });
    should(subsystem.asked).deepEqual(['https://example.com/a?token=1']);
    should(response.headers.get('cache-control')).eql('no-store');
  });

  it('should refuse a caller that arrived on a remote carrier before asking the subsystem anything', async () => {
    // Arrange
    const subsystem = new RecordingOpen();

    // Act
    const response = await fixture(subsystem)(post('https://example.com/', false));

    // Assert
    should(response.status).equal(403);
    should(subsystem.asked).deepEqual([]);
  });

  it('should refuse a caller with no credential', async () => {
    // Act
    const response = await fixture(new RecordingOpen())({ ...post('https://example.com/', true), headers: {} });

    // Assert
    should(response.status).equal(401);
  });

  it('should restate the domain refusals as statuses a client can act on', async () => {
    // Arrange
    const cases = [
      [new OpenUrlError('invalid_url', 'no'), 400, 'invalid_url'],
      [new OpenUrlError('rate_limited', 'slow', 4), 429, 'rate_limited'],
      [new OpenUrlError('opener_failed', 'none'), 503, 'opener_failed'],
    ] as const;

    for (const [failure, status, code] of cases) {
      // Act
      const response = await fixture(new RecordingOpen(failure))(post('https://example.com/', true));

      // Assert
      should(response.status).equal(status);
      should(jsonBody(response)).have.property('code', code);
    }
  });

  it('should say how long to wait when rate limited', async () => {
    // Act
    const response = await fixture(new RecordingOpen(new OpenUrlError('rate_limited', 'slow', 4)))(
      post('https://example.com/', true),
    );

    // Assert
    should(jsonBody(response)).have.property('retryAfterSeconds', 4);
  });

  it('should refuse a body with a missing or extra field', async () => {
    // Arrange
    const dispatch = fixture(new RecordingOpen());

    // Act
    const missing = await dispatch({ ...post(undefined, true), body: '{}' });
    const extra = await dispatch({
      ...post('https://example.com/', true),
      body: '{"url":"https://example.com/","a":1}',
    });

    // Assert
    should([missing.status, extra.status]).deepEqual([400, 400]);
  });
});
