import { describe, it } from 'bun:test';
import should from 'should';
import { PerformanceRecorder, type RequestSample } from '../../../src/lib/performance/recorder.ts';

/** A clock the test moves by hand. */
const handClock = (start = 1_000) => {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
};

const request = (overrides: Partial<RequestSample> & Pick<RequestSample, 'at'>): RequestSample => ({
  route: 'GET /v1/sessions',
  durationMs: 10,
  outcome: 200,
  bytesIn: 100,
  bytesOut: 0,
  ...overrides,
});

describe('PerformanceRecorder', () => {
  it('should report each route with its count, rate, percentiles, bytes and failures', () => {
    // Arrange — two minutes: twenty list reads, then one failed, one aborted and one 503 usage read.
    const clock = handClock();
    const subject = new PerformanceRecorder(clock);
    for (let index = 1; index <= 20; index += 1) {
      subject.recordRequest(request({ at: clock.now(), durationMs: index * 10, bytesIn: 1_000 }));
      clock.advance(5_000);
    }
    subject.recordRequest(request({ at: clock.now(), route: 'GET /v1/usage', outcome: 'failed', bytesIn: 0 }));
    subject.recordRequest(request({ at: clock.now(), route: 'GET /v1/usage', outcome: 'aborted', bytesIn: 0 }));
    subject.recordRequest(request({ at: clock.now(), route: 'GET /v1/usage', outcome: 503, bytesOut: 7 }));
    clock.advance(20_000);

    // Act
    const actual = subject.report(120_000);

    // Assert
    should(actual.coveredMs).equal(120_000);
    should(actual.requests).eql({ count: 23, perMinute: 11.5, bytesIn: 20_100, bytesOut: 7, failed: 3 });
    should(actual.routes.map(route => route.route)).eql(['GET /v1/sessions', 'GET /v1/usage']);
    should(actual.routes[0]).eql({
      route: 'GET /v1/sessions',
      count: 20,
      perMinute: 10,
      p50Ms: 100,
      p95Ms: 190,
      maxMs: 200,
      bytesIn: 20_000,
      bytesOut: 0,
      failed: 0,
    });
    should(actual.routes[1]?.failed).equal(3);
  });

  it('should report only the window asked for, and say how much of it was recorded', () => {
    // Arrange
    const clock = handClock();
    const subject = new PerformanceRecorder(clock);
    subject.recordRequest(request({ at: clock.now() }));
    clock.advance(90_000);
    subject.recordRequest(request({ at: clock.now() }));
    clock.advance(10_000);

    // Act
    const lastMinute = subject.report(60_000);
    const lastHour = subject.report(3_600_000);

    // Assert
    should(lastMinute.requests.count).equal(1);
    should(lastMinute.coveredMs).equal(60_000);
    should(lastHour.requests.count).equal(2);
    should(lastHour.coveredMs).equal(100_000);
  });

  it('should forget everything on start, so the next report covers only what follows', () => {
    // Arrange
    const clock = handClock();
    const subject = new PerformanceRecorder(clock);
    subject.recordRequest(request({ at: clock.now() }));
    subject.recordStream('STREAM /v1/events');
    subject.recordLongTask(clock.now(), 80);
    subject.recordRender('fleet', 4);
    clock.advance(1_000);

    // Act
    subject.start();
    const actual = subject.report(60_000);

    // Assert
    should(actual.coveredMs).equal(0);
    should(actual.requests).eql({ count: 0, perMinute: 0, bytesIn: 0, bytesOut: 0, failed: 0 });
    should(actual.routes).eql([]);
    should(actual.streams).eql([]);
    should(actual.longTasks).eql({ observed: false, count: 0, totalMs: 0, maxMs: 0 });
    should(actual.renders).eql([]);
  });

  it('should count streams, long tasks and renders, slowest render first', () => {
    // Arrange
    const clock = handClock();
    const subject = new PerformanceRecorder(clock);
    subject.observingLongTasks();
    subject.recordStream('STREAM /v1/events');
    subject.recordStream('STREAM /v1/events');
    subject.recordStream('STREAM /v1/terminals/:id');
    subject.recordLongTask(clock.now(), 60);
    subject.recordLongTask(clock.now(), 140);
    subject.recordRender('fleet', 2);
    subject.recordRender('session', 30);
    subject.recordRender('session', 10);
    clock.advance(60_000);

    // Act
    const actual = subject.report(60_000);

    // Assert
    should(actual.streams).eql([
      { route: 'STREAM /v1/events', opened: 2 },
      { route: 'STREAM /v1/terminals/:id', opened: 1 },
    ]);
    should(actual.longTasks).eql({ observed: true, count: 2, totalMs: 200, maxMs: 140 });
    should(actual.renders).eql([
      { surface: 'session', count: 2, p50Ms: 10, p95Ms: 30, maxMs: 30 },
      { surface: 'fleet', count: 1, p50Ms: 2, p95Ms: 2, maxMs: 2 },
    ]);
  });

  it('should order equal counts by name, and keep at most the configured number of samples', () => {
    // Arrange
    const clock = handClock();
    const subject = new PerformanceRecorder(clock, { retainMs: 60_000, maxSamples: 3 });
    subject.recordStream('STREAM /b');
    subject.recordStream('STREAM /a');
    subject.recordRender('b', 5);
    subject.recordRender('a', 5);
    for (const route of ['GET /b', 'GET /a', 'GET /c', 'GET /d'])
      subject.recordRequest(request({ at: clock.now(), route }));

    // Act
    const actual = subject.report(60_000);

    // Assert — the oldest request (`/b`) was dropped for the cap.
    should(actual.routes.map(route => route.route)).eql(['GET /a', 'GET /c', 'GET /d']);
    should(actual.streams.map(stream => stream.route)).eql(['STREAM /a', 'STREAM /b']);
    should(actual.renders.map(render => render.surface)).eql(['a', 'b']);
    should(actual.requests.perMinute).equal(0);
  });

  it('should drop samples older than it retains', () => {
    // Arrange
    const clock = handClock();
    const subject = new PerformanceRecorder(clock, { retainMs: 10_000, maxSamples: 100 });
    subject.recordRequest(request({ at: clock.now(), route: 'GET /old' }));
    clock.advance(20_000);
    subject.recordRequest(request({ at: clock.now(), route: 'GET /new' }));

    // Act — a window wider than what is retained still holds only what was kept.
    const actual = subject.report(3_600_000);

    // Assert
    should(actual.routes.map(route => route.route)).eql(['GET /new']);
  });
});
