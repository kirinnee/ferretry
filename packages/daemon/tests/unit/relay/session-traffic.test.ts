import { describe, it } from 'bun:test';
import should from 'should';
import { MAX_SESSION_ROUTE_TEMPLATES, SessionTraffic } from '../../../src/lib/relay/session-traffic.ts';

describe('a tunnel session’s bounded traffic counters', () => {
  it('should count an answer once and all of its wire parts, independently per session', () => {
    // Arrange
    const subject = new SessionTraffic();
    const otherSession = new SessionTraffic();

    // Act
    subject.answer('GET /v1/sessions', 100, true);
    subject.answer('GET /v1/sessions', 200, false);
    subject.answer('GET /v1/sessions', 50, true);
    subject.answer('GET /v1/sessions/:id/events', 40, true);

    // Assert
    should(subject.snapshot().routes).eql([
      { route: 'GET /v1/sessions', answers: 2, bytes: 350 },
      { route: 'GET /v1/sessions/:id/events', answers: 1, bytes: 40 },
    ]);
    should(otherSession.snapshot()).eql({ routes: [] });
  });

  it('should cap distinct templates and aggregate every further route under other', () => {
    // Arrange
    const subject = new SessionTraffic();
    for (let index = 0; index < MAX_SESSION_ROUTE_TEMPLATES; index += 1)
      subject.answer(`GET /route-${String(index)}`, 1, true);

    // Act
    for (let index = 0; index < 1_000; index += 1) subject.answer(`GET /overflow-${String(index)}`, 2, true);
    subject.answer('GET /route-0', 3, false);
    subject.answer('GET /overflow-0', 4, false);

    // Assert
    const actual = subject.snapshot().routes;
    should(actual).have.length(MAX_SESSION_ROUTE_TEMPLATES + 1);
    should(actual[0]).eql({ route: 'GET /route-0', answers: 1, bytes: 4 });
    should(actual.at(-1)).eql({ route: 'other', answers: 1_000, bytes: 2_004 });
  });

  it('should describe a stream by its router template and count only its payload frames', () => {
    // Arrange
    const subject = new SessionTraffic();
    subject.streamFrame(99);
    subject.openStream('GET /v1/events');
    const before = subject.snapshot();

    // Act
    subject.streamFrame(120);
    subject.streamFrame(80);

    // Assert
    should(before.stream).eql({ route: 'GET /v1/events', frames: 0, bytes: 0 });
    should(subject.snapshot()).eql({
      routes: [],
      stream: { route: 'GET /v1/events', frames: 2, bytes: 200 },
    });
  });
});
