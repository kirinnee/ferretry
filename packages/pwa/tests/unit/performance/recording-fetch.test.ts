import { describe, it } from 'bun:test';
import should from 'should';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';
import { bodyBytes, recordingFetch, recordingStreams } from '../../../src/lib/performance/recording-fetch.ts';

const handClock = () => {
  let time = 0;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

/** Lets the size count, which reads a copy of the body after the caller has its answer, finish. */
const drained = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('recordingFetch', () => {
  it('should record a request by route, with its duration, status and both sizes', async () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const send = async (): Promise<Response> => {
      clock.advance(40);
      return new Response('{"sessions":[]}', { status: 200 });
    };
    const subject = recordingFetch(send, recorder);

    // Act
    const response = await subject('https://studio.local/v1/sessions/fy_s_1/attention?x=1', {
      method: 'POST',
      body: 'héllo',
    });
    const body = await response.text();
    await drained();
    clock.advance(59_960);

    // Assert — the caller's body is intact, and the sample names the route and nothing else.
    should(body).equal('{"sessions":[]}');
    should(recorder.report(60_000).routes).eql([
      {
        route: 'POST /v1/sessions/:id/attention',
        count: 1,
        perMinute: 1,
        p50Ms: 40,
        p95Ms: 40,
        maxMs: 40,
        bytesIn: 15,
        bytesOut: 6,
        failed: 0,
      },
    ]);
  });

  it('should take a declared size at its word, and count an empty answer as nothing', async () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const answers = [
      new Response('abc', { status: 200, headers: { 'content-length': '999' } }),
      new Response(null, { status: 204 }),
    ];
    const subject = recordingFetch(async () => answers.shift() ?? Response.error(), recorder);

    // Act
    await subject(new Request('https://d.test/v1/usage', { method: 'GET' }));
    await subject(new URL('https://d.test/v1/pins'), { method: 'DELETE' });
    await drained();
    clock.advance(60_000);

    // Assert
    const routes = recorder.report(60_000).routes;
    should(routes.find(route => route.route === 'GET /v1/usage')?.bytesIn).equal(999);
    should(routes.find(route => route.route === 'DELETE /v1/pins')?.bytesIn).equal(0);
  });

  it('should still record an answer whose size cannot be read', async () => {
    // Arrange — a body that errors when read.
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const broken = new ReadableStream<Uint8Array>({
      pull: controller => controller.error(new Error('torn')),
    });
    const subject = recordingFetch(async () => new Response(broken, { status: 200 }), recorder);

    // Act
    await subject('https://d.test/v1/usage');
    await drained();
    clock.advance(60_000);

    // Assert
    should(recorder.report(60_000).routes[0]).match({ route: 'GET /v1/usage', count: 1, bytesIn: 0 });
  });

  it('should record a transport failure and an abort, and pass each on to the caller', async () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const subject = recordingFetch(async () => {
      throw new Error('the carrier is down');
    }, recorder);
    const aborted = new AbortController();
    aborted.abort();

    // Act
    const failure = await subject('https://d.test/v1/usage').catch((error: unknown) => error);
    const abort = await subject('https://d.test/v1/usage', { signal: aborted.signal }).catch((error: unknown) => error);
    clock.advance(60_000);

    // Assert
    should(failure).be.instanceOf(Error);
    should(abort).be.instanceOf(Error);
    should(recorder.report(60_000).requests).match({ count: 2, failed: 2 });
  });
});

describe('bodyBytes', () => {
  it('should weigh every body this app sends, and leave a stream unmeasured', () => {
    // Arrange
    const bodies: (BodyInit | null | undefined)[] = [
      undefined,
      null,
      'a€😀',
      new ArrayBuffer(8),
      new Uint8Array(3),
      new Blob(['12345']),
      new URLSearchParams({ q: 'é' }),
      new ReadableStream(),
    ];

    // Act
    const actual = bodies.map(bodyBytes);

    // Assert — `a` 1, `€` 3, `😀` 4; `q=é` is `q=%C3%A9` once serialised.
    should(actual).eql([0, 0, 8, 8, 3, 5, 8, 0]);
  });
});

describe('recordingStreams', () => {
  it('should count each stream it opens by route, and open it the same with no recorder', async () => {
    // Arrange
    const clock = handClock();
    const recorder = new PerformanceRecorder(clock);
    const opened: string[] = [];
    const open = async (daemon: string, request: { readonly path: string }): Promise<string> => {
      opened.push(`${daemon} ${request.path}`);
      return 'session';
    };

    // Act
    const recorded = await recordingStreams(open, recorder)('alpha', {
      path: '/v1/sessions/fy_s_1/terminals/dev/attach',
    });
    const plain = await recordingStreams(open, undefined)('alpha', { path: '/v1/events' });
    clock.advance(60_000);

    // Assert
    should([recorded, plain]).eql(['session', 'session']);
    should(opened).eql(['alpha /v1/sessions/fy_s_1/terminals/dev/attach', 'alpha /v1/events']);
    should(recorder.report(60_000).streams).eql([{ route: 'STREAM /v1/sessions/:id/terminals/:id/attach', opened: 1 }]);
  });
});
