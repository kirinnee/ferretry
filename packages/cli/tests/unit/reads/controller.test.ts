import { describe, it } from 'bun:test';
import { FyTransportError } from '@ferretry/protocol/client';
import should from 'should';
import { ReadsController } from '../../../src/lib/reads/controller.ts';
import {
  attachTarget,
  CapturingReadsIo,
  eventFrame,
  FakeClock,
  fleetIdleFrame,
  fyEvent,
  INSTANT,
  RecordingAttacher,
  ScriptedMarker,
  ScriptedReadsGateway,
  sessionIdleFrame,
  sessionState,
  sessionView,
} from './fixtures.ts';

/**
 * The long-lived commands, and what they refuse.
 *
 * `decideWait` owns which way a wait ends; these cases prove the loop honours that decision, that the
 * follow trusts only the daemon's own idle proof for silence, that an attach is performed against
 * daemon-issued evidence rather than a locally guessed name, and that every flag this daemon cannot
 * honour is refused in the caller's own vocabulary rather than sent and rejected as a 501.
 */

function build(
  script: ConstructorParameters<typeof ScriptedReadsGateway>[0] = {},
  markerAnswers: boolean[] = [],
  attacher: RecordingAttacher = new RecordingAttacher(),
) {
  const gateway = new ScriptedReadsGateway(script);
  const io = new CapturingReadsIo();
  const clock = new FakeClock();
  const marker = new ScriptedMarker(markerAnswers);
  return {
    controller: new ReadsController(gateway, io, clock, marker, attacher),
    gateway,
    io,
    clock,
    marker,
    attacher,
  };
}

const running = (controller: ReadsController, id: string | undefined, options = {}): Promise<unknown> =>
  controller.stream(id, options, new AbortController().signal).catch((error: unknown) => error);

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

describe('fy attach', () => {
  it('should hand the daemon-issued pane proof straight to the attacher', async () => {
    // Arrange — the target is the daemon's, so nothing here derives a tmux name from the session id.
    const target = attachTarget({ tmuxSession: 'fy-other-name' });
    const { controller, gateway, attacher, io } = build({ target });

    // Act
    await controller.attach('s1');

    // Assert
    should(gateway.attachCalls).eql(['s1']);
    should(attacher.targets).eql([target]);
    should(io.exitCode).equal(0);
  });

  it("should adopt the attacher's exit code as the command's own", async () => {
    // Arrange — tmux ends with the client's status; a hard-coded 0 would hide a failed handover.
    const { controller, io } = build({}, [], new RecordingAttacher(130));

    // Act
    await controller.attach('s1');

    // Assert
    should(io.exitCode).equal(130);
  });

  it('should never reach the terminal when the daemon refuses to issue a proof', async () => {
    // Arrange
    const failure = new Error('session s1 has no registered pane');
    const { controller, attacher, io } = build({ attachError: failure });

    // Act
    const actual = await controller.attach('s1').catch((error: unknown) => error);

    // Assert
    should(actual).equal(failure);
    should(attacher.targets).be.empty();
    should(io.exitCode).be.undefined();
  });

  it('should surface an attacher refusal rather than reporting a successful attach', async () => {
    // Arrange
    const failure = new Error('the live pane no longer matches the daemon attach proof; refusing to attach');
    const { controller, io } = build({}, [], new RecordingAttacher(0, failure));

    // Act
    const actual = await controller.attach('s1').catch((error: unknown) => error);

    // Assert
    should(actual).equal(failure);
    should(io.exitCode).be.undefined();
  });
});

describe('fy stream', () => {
  it('should open one scoped socket at the caller cursor and render every event', async () => {
    // Arrange
    const { controller, io, gateway } = build({ frames: [eventFrame(4), eventFrame(5)] });

    // Act
    await controller.stream('s1', { after: 3 }, new AbortController().signal);

    // Assert — one socket, not a poll: the cursor is handed over once and the daemon pushes.
    should(gateway.streamCalls).eql([{ sessionId: 's1', after: 3 }]);
    should(io.out).have.length(2);
    should(io.out[0]).equal(`#4 ${INSTANT} session.created (daemon) {"note":4}`);
  });

  it('should follow the daemon-local fleet when no session is named', async () => {
    // Arrange — sequences are per-session, so two sessions may legitimately both start at #1.
    const { controller, io, gateway } = build({
      frames: [eventFrame(1), eventFrame(1, { sessionId: 's2' }), eventFrame(2, { sessionId: 's2' })],
    });

    // Act
    await controller.stream(undefined, {}, new AbortController().signal);

    // Assert
    should(gateway.streamCalls).eql([{ sessionId: undefined, after: 0 }]);
    should(io.out).have.length(3);
  });

  it('should refuse a fleet cursor the daemon never issued', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    const refusal = await running(controller, undefined, { after: 5 });

    // Assert — a merged feed has no single sequence, so resuming one would be a fabricated position.
    should(refusal).be.instanceof(Error).and.have.property('exitCode', 2);
    should((refusal as Error).message).match(/fleet stream has no global cursor/);
    should(gateway.streamCalls).be.empty();
  });

  it('should accept an explicit zero cursor on a fleet stream', async () => {
    // Arrange
    const { controller, gateway } = build({ frames: [eventFrame(1)] });

    // Act
    await controller.stream(undefined, { after: 0 }, new AbortController().signal);

    // Assert — zero is the only cursor a fleet socket can honestly honour.
    should(gateway.streamCalls).eql([{ sessionId: undefined, after: 0 }]);
  });

  it('should report the scoped idle proof the daemon sent, with its own cursor', async () => {
    // Arrange
    const { controller, io } = build({ frames: [eventFrame(4), sessionIdleFrame('s1', 4, 30)] });

    // Act
    await controller.stream('s1', { after: 3 }, new AbortController().signal);

    // Assert — silence is the daemon's claim, on stderr, so stdout stays a pure event channel.
    should(io.err).eql(['fy stream: no new events for s1 in 30s (still following from #4)']);
    should(io.out).have.length(1);
  });

  it('should report a fleet idle proof without inventing a global cursor', async () => {
    // Arrange
    const { controller, io } = build({ frames: [fleetIdleFrame(3, 45)] });

    // Act
    await controller.stream(undefined, {}, new AbortController().signal);

    // Assert
    should(io.err).eql(['fy stream: no new fleet events in 45s (socket is live; following 3 sessions)']);
  });

  it('should refuse an idle proof that contradicts the followed scope', async () => {
    // Arrange
    const fleetProofOnAScopedFollow = build({ frames: [fleetIdleFrame(2)] }).controller;
    const wrongSession = build({ frames: [sessionIdleFrame('s2', 0)] }).controller;
    const wrongCursor = build({ frames: [eventFrame(4), sessionIdleFrame('s1', 3)] }).controller;
    const sessionProofOnAFleetFollow = build({ frames: [sessionIdleFrame('s1', 0)] }).controller;

    // Act
    const failures = [
      await running(fleetProofOnAScopedFollow, 's1'),
      await running(wrongSession, 's1'),
      await running(wrongCursor, 's1', { after: 3 }),
    ];
    const fleetFailure = await running(sessionProofOnAFleetFollow, undefined);

    // Assert — an idle proof is only evidence if it is evidence about THIS follow.
    for (const failure of failures)
      should(failure)
        .be.instanceof(Error)
        .and.match(/contradicted the followed session cursor/);
    should(fleetFailure)
      .be.instanceof(Error)
      .and.match(/session idle proof for a fleet stream/);
  });

  it('should not open a socket at all when the signal is already aborted', async () => {
    // Arrange
    const abort = new AbortController();
    abort.abort();
    const { controller, gateway } = build({ frames: [eventFrame(1)] });

    // Act
    await controller.stream('s1', {}, abort.signal);

    // Assert — nothing is held after the caller has gone away.
    should(gateway.streamCalls).be.empty();
  });

  it('should hand the caller signal to the socket and end when it aborts', async () => {
    // Arrange
    const abort = new AbortController();
    const { controller, gateway } = build({ blockStreamUntilAbort: true });

    // Act
    const followed = controller.stream('s1', {}, abort.signal);
    abort.abort();
    await followed;

    // Assert — the same signal reached the transport; no socket survives the command.
    should(gateway.streamSignals).eql([abort.signal]);
    should(gateway.streamCalls).have.length(1);
  });

  it('should surface a failed socket rather than rendering it as a quiet stream', async () => {
    // Arrange
    const failure = new Error('WebSocket stream closed unexpectedly: code 1006');
    const { controller } = build({ streamError: failure });

    // Act
    const actual = await running(controller, 's1');

    // Assert
    should(actual).equal(failure);
  });

  it('should refuse cross-session or non-advancing event evidence', async () => {
    // Arrange
    const crossed = build({ frames: [eventFrame(1, { sessionId: 's2' })] }).controller;
    const stale = build({ frames: [eventFrame(1), eventFrame(1)] }).controller;
    const rewound = build({
      frames: [eventFrame(1, { sessionId: 's2' }), eventFrame(1, { sessionId: 's2' })],
    }).controller;

    // Act
    const crossedFailure = await running(crossed, 's1');
    const staleFailure = await running(stale, 's1');
    const fleetFailure = await running(rewound, undefined);

    // Assert — a repeated sequence in the fleet form is caught per session, not globally.
    should(crossedFailure)
      .be.instanceof(Error)
      .and.match(/event for s2 while following s1/);
    should(staleFailure)
      .be.instanceof(Error)
      .and.match(/non-advancing event sequence #1 for s1 after #0/);
    should(fleetFailure)
      .be.instanceof(Error)
      .and.match(/non-advancing event sequence #1 for s2 after #0/);
  });

  it('should refuse a cursor a caller mistyped', async () => {
    // Arrange
    const { controller } = build();

    // Act
    const refusal = await running(controller, 's1', { after: -1 });

    // Assert
    should(refusal).be.instanceof(Error).and.have.property('exitCode', 2);
  });

  it('should print protocol events for a JSON caller', async () => {
    // Arrange
    const { controller, io } = build({ frames: [eventFrame(9)] });

    // Act
    await controller.stream('s1', { json: true }, new AbortController().signal);

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
    const failure = new FyTransportError('could not reach fyd at http://daemon.test', '/v1/sessions/s1', false, {});
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
