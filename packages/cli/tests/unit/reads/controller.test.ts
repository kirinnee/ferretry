import { describe, it } from 'bun:test';
import { FyTransportError } from '@ferretry/protocol/client';
import should from 'should';
import { IDLE_NOTICE_SECONDS, ReadsController } from '../../../src/lib/reads/controller.ts';
import {
  CapturingReadsIo,
  FakeClock,
  fyEvent,
  INSTANT,
  ScriptedMarker,
  ScriptedReadsGateway,
  sessionState,
  sessionView,
} from './fixtures.ts';

/**
 * The loops, and what they refuse.
 *
 * `decideWait` owns which way a wait ends; these cases prove the loop honours that decision, that the
 * follow reports its own silence, and that every flag this daemon cannot honour is refused in the
 * caller's own vocabulary rather than sent and rejected as a 501.
 */

function build(script: ConstructorParameters<typeof ScriptedReadsGateway>[0] = {}, markerAnswers: boolean[] = []) {
  const gateway = new ScriptedReadsGateway(script);
  const io = new CapturingReadsIo();
  const clock = new FakeClock();
  const marker = new ScriptedMarker(markerAnswers);
  return { controller: new ReadsController(gateway, io, clock, marker), gateway, io, clock, marker };
}

describe('fy snapshot', () => {
  it('should print the screen the daemon captured', async () => {
    // Arrange
    const { controller, io } = build({ screen: 'the agent is thinking' });

    // Act
    await controller.snapshot('s1', {});

    // Assert
    should(io.out).eql(['the agent is thinking']);
  });

  it('should wrap the screen when JSON is asked for', async () => {
    // Arrange
    const { controller, io } = build({ screen: 'frame' });

    // Act
    await controller.snapshot('s1', { json: true });

    // Assert
    should(JSON.parse(io.out[0] ?? '')).eql({ sessionId: 's1', snapshot: 'frame' });
  });
});

describe('fy logs', () => {
  it('should print the transcript tail', async () => {
    // Arrange
    const { controller, io } = build({ transcript: '[09:08:07] assistant/message: ready' });

    // Act
    await controller.logs('s1', {});

    // Assert
    should(io.out).eql(['[09:08:07] assistant/message: ready']);
  });

  it('should send a requested turn slice to the daemon', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.logs('s1', { turn: 3 });

    // Assert — the daemon can prove a boundary from transcript evidence or refuse it precisely.
    should(gateway.logCalls).eql([{ id: 's1', turn: 3 }]);
  });
});

describe('fy events', () => {
  it('should page the whole history through the client cursor', async () => {
    // Arrange
    const { controller, io, gateway } = build({ history: [fyEvent(1), fyEvent(2, { type: 'session.stopped' })] });

    // Act
    await controller.events('s1', { after: 5, limit: 10 });

    // Assert
    should(gateway.historyCalls).eql([{ id: 's1', after: 5, limit: 10 }]);
    should(io.out[0]).equal(`#1 ${INSTANT} session.created (daemon) {"note":1}`);
    should(io.out[1]).match(/^#2 .* session\.stopped \(daemon\)/);
  });

  it('should print one protocol event per line for a JSON caller', async () => {
    // Arrange
    const { controller, io } = build({ history: [fyEvent(1)] });

    // Act
    await controller.events('s1', { json: true });

    // Assert
    should(JSON.parse(io.out[0] ?? '')).have.property('sequence', 1);
  });

  it('should refuse a cursor or page size a caller mistyped', async () => {
    // Arrange
    const { controller } = build();

    // Act
    const cursor = await controller.events('s1', { after: -1 }).catch((error: unknown) => error);
    const limit = await controller.events('s1', { limit: 0 }).catch((error: unknown) => error);

    // Assert
    should(cursor).be.instanceof(Error).and.have.property('exitCode', 2);
    should(limit).be.instanceof(Error).and.have.property('exitCode', 2);
  });

  it('should render a turn only when the producer recorded one', async () => {
    // Arrange
    const { controller, io } = build({ history: [fyEvent(1, { turn: 4 })] });

    // Act
    await controller.events('s1', {});

    // Assert — a `turn=0` on every line would look like the whole session happened in its first turn.
    should(io.out[0]).match(/turn=4/);
  });
});

describe('fy stream', () => {
  it('should follow the cursor forward and stop when the caller aborts', async () => {
    // Arrange
    const abort = new AbortController();
    const { controller, io, gateway, clock } = build({ pages: [[fyEvent(1), fyEvent(2)], [fyEvent(5)], []] });
    let sleeps = 0;
    clock.afterSleep = () => {
      sleeps += 1;
      if (sleeps === 3) abort.abort();
    };

    // Act — the third poll finds nothing and the abort lands during its sleep.
    const running = controller.stream('s1', { after: 0 }, abort.signal);
    await running;

    // Assert — every read after the first resumes from the last sequence seen, never from zero.
    should(gateway.eventCalls[0]).eql({ id: 's1', after: 0 });
    should(gateway.eventCalls[1]).eql({ id: 's1', after: 2 });
    should(io.out.length).be.aboveOrEqual(3);
  });

  it('should say so when a follow has gone quiet, once per silent stretch', async () => {
    // Arrange
    const abort = new AbortController();
    const { controller, io, clock } = build({ pages: [[], [], [], []] });
    let sleeps = 0;
    clock.afterSleep = () => {
      sleeps += 1;
      if (sleeps === 2) abort.abort();
    };

    // Act — the fake clock advances by each sleep, so the idle window elapses without real waiting.
    const running = controller.stream('s1', { interval: IDLE_NOTICE_SECONDS }, abort.signal);
    await running;

    // Assert — a silent stream and a quiet session are otherwise indistinguishable.
    should(io.err.filter(line => line.includes('no new events'))).have.length(1);
    should(io.err[0]).match(/still following from #0/);
  });

  it('should not start at all when the signal is already aborted', async () => {
    // Arrange
    const abort = new AbortController();
    abort.abort();
    const { controller, gateway } = build({ pages: [[fyEvent(1)]] });

    // Act
    await controller.stream('s1', {}, abort.signal);

    // Assert — nothing is held after the caller has gone away.
    should(gateway.eventCalls).be.empty();
  });

  it('should cancel the in-flight daemon read when the caller goes away', async () => {
    // Arrange
    const abort = new AbortController();
    const { controller, gateway } = build({ blockEventsUntilAbort: true });

    // Act
    const running = controller.stream('s1', {}, abort.signal);
    abort.abort();
    await running;

    // Assert — the same signal reached the transport; no request or timer survives the command.
    should(gateway.eventSignals).eql([abort.signal]);
    should(gateway.eventCalls).have.length(1);
  });

  it('should surface a failed daemon poll rather than rendering it as a quiet stream', async () => {
    // Arrange
    const failure = new Error('event route unavailable');
    const { controller } = build({ eventError: failure });

    // Act
    const actual = await controller.stream('s1', {}, new AbortController().signal).catch((error: unknown) => error);

    // Assert
    should(actual).equal(failure);
  });

  it('should refuse cross-session or non-advancing event evidence', async () => {
    // Arrange
    const crossed = build({ pages: [[fyEvent(1, { sessionId: 's2' })]] }).controller;
    const stale = build({ pages: [[fyEvent(1), fyEvent(1)]] }).controller;

    // Act
    const crossedFailure = await crossed
      .stream('s1', {}, new AbortController().signal)
      .catch((error: unknown) => error);
    const staleFailure = await stale.stream('s1', {}, new AbortController().signal).catch((error: unknown) => error);

    // Assert
    should(crossedFailure)
      .be.instanceof(Error)
      .and.match(/event for s2 while following s1/);
    should(staleFailure)
      .be.instanceof(Error)
      .and.match(/non-advancing event sequence/);
  });

  it('should refuse a poll interval a caller mistyped', async () => {
    // Arrange
    const { controller } = build();

    // Act
    const refusal = await controller
      .stream('s1', { interval: 0 }, new AbortController().signal)
      .catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(Error).and.have.property('exitCode', 2);
  });

  it('should print protocol events for a JSON caller', async () => {
    // Arrange
    const abort = new AbortController();
    const { controller, io, clock } = build({ pages: [[fyEvent(9)]] });
    clock.afterSleep = () => abort.abort();

    // Act
    const running = controller.stream('s1', { json: true }, abort.signal);
    await running;

    // Assert
    should(JSON.parse(io.out[0] ?? '')).have.property('sequence', 9);
  });
});

describe('fy wait', () => {
  it('should exit 0 and print the state when the session completes', async () => {
    // Arrange
    const { controller, io } = build({
      views: [sessionView(sessionState({ status: 'running' })), sessionView(sessionState({ status: 'completed' }))],
    });

    // Act
    await controller.wait('s1', {});

    // Assert
    should(io.exitCode).equal(0);
    should(io.out).eql(['s1 is completed']);
  });

  it('should exit 1 when the session ended without completing', async () => {
    // Arrange
    const { controller, io } = build({ views: [sessionView(sessionState({ status: 'failed' }))] });

    // Act
    await controller.wait('s1', {});

    // Assert — legacy answered 0 here, so a script carried on as though the work had been done.
    should(io.exitCode).equal(1);
    should(io.err.join('\n')).match(/ended as failed/);
  });

  it('should exit 124 once the caller deadline passes', async () => {
    // Arrange
    const { controller, io, clock } = build({ views: [sessionView(sessionState({ status: 'running' }))] });

    // Act
    await controller.wait('s1', { timeout: 2, interval: 1 });

    // Assert — two sleeps of one second bring the fake clock to the deadline.
    should(io.exitCode).equal(124);
    should(clock.sleeps).eql([1_000, 1_000]);
  });

  it('should trust the deliverable over a completion claim', async () => {
    // Arrange — the session claims completion on the first poll and the file lands on the second.
    const { controller, io, marker } = build({ views: [sessionView(sessionState({ status: 'completed' }))] }, [
      false,
      true,
    ]);

    // Act
    await controller.wait('s1', { untilMarker: 'done.md' });

    // Assert
    should(io.exitCode).equal(0);
    should(marker.asked).eql(['/work/done.md', '/work/done.md']);
    should(io.err.join('\n')).match(/completed but \/work\/done\.md is not there yet/);
  });

  it('should print one line of JSON for a piped consumer', async () => {
    // Arrange
    const { controller, io } = build({ views: [sessionView(sessionState({ status: 'completed' }))] });

    // Act
    await controller.wait('s1', { json: true });

    // Assert — pretty-printing this broke line-oriented readers.
    should(io.out).have.length(1);
    should(JSON.parse(io.out[0] ?? '')).have.property('status', 'completed');
  });

  it('should exit 3 when a human is needed', async () => {
    // Arrange
    const { controller, io } = build({ views: [sessionView(sessionState({ status: 'awaiting_question' }))] });

    // Act
    await controller.wait('s1', {});

    // Assert
    should(io.exitCode).equal(3);
  });

  it('should exit 69 when the daemon goes away', async () => {
    // Arrange
    const failure = new FyTransportError('fyd is unavailable at http://daemon.test', '/v1/sessions/s1', false, {});
    const { controller, io } = build({ getError: failure });

    // Act
    await controller.wait('s1', {});

    // Assert — daemon loss is neither a successful wait nor a session failure.
    should(io.exitCode).equal(69);
    should(io.out).be.empty();
    should(io.err.join('\n')).match(/fyd became unavailable/);
  });

  it('should distinguish an unresponsive daemon from the caller timeout', async () => {
    // Arrange
    const failure = new FyTransportError('fyd did not answer within 30s', '/v1/sessions/s1', true, {});
    const { controller, io } = build({ getError: failure });

    // Act
    await controller.wait('s1', {});

    // Assert — transport timeout is daemon unavailability (69); only --timeout is 124.
    should(io.exitCode).equal(69);
    should(io.err.join('\n')).match(/fyd became unresponsive/);
  });

  it('should propagate a non-transport read failure', async () => {
    // Arrange
    const failure = new Error('schema refused the session view');
    const { controller } = build({ getError: failure });

    // Act
    const actual = await controller.wait('s1', {}).catch((error: unknown) => error);

    // Assert
    should(actual).equal(failure);
  });

  it('should abort an in-flight read when the caller deadline passes', async () => {
    // Arrange
    const { controller, io, clock, gateway } = build({ blockGetUntilAbort: true });

    // Act
    const running = controller.wait('s1', { timeout: 1 });
    clock.advance(1_000);
    await running;

    // Assert — no state was invented when the daemon never answered.
    should(gateway.getSignals[0]?.aborted).be.true();
    should(io.exitCode).equal(124);
    should(io.out).be.empty();
    should(io.err.join('\n')).match(/before fyd returned a session state/);
  });

  it('should refuse a timeout a caller mistyped', async () => {
    // Arrange
    const { controller } = build();

    // Act
    const refusal = await controller.wait('s1', { timeout: -5 }).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceof(Error).and.have.property('exitCode', 2);
  });
});
