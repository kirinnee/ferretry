/**
 * A DAEMON THAT IS ALIVE MUST SAY SO, AND ONE THAT HAS STOPPED MUST NOT STAY.
 *
 * The defect: on a real Mac `fy daemon status` said "process exists but its API is unavailable" nearly
 * every time. The address was bound only after every boot step — twenty seconds of a closed port on a
 * large fleet — and once serving, a synchronous pass over huge transcripts held the event loop for
 * minutes at a time, during which nothing answered and nothing could restart it.
 *
 * These boot a REAL `fyd` in its own process whose usage-feed step is slow, hiccups or stalls, and play
 * the operator and the service manager against it. A child process because the watchdog ends a daemon
 * whose loop has stopped with SIGKILL, and a test runner it shared a process with would go with it.
 * Everything but that one step is the composition root's own: the real `start`, the real staged
 * surface, the real lag meter and the real watchdog thread.
 */
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { bootStagedDaemon as boot, liveness, stopStagedDaemons, until } from '../support/staged-boot-daemon.ts';

afterEach(stopStagedDaemons);

describe('a daemon whose boot takes time', () => {
  it('should answer liveness while it boots, naming the step it is on', async () => {
    // Arrange
    const daemon = await boot('slow');

    // Act
    const first = await until(
      () => liveness(daemon.base),
      () => true,
      'the first liveness answer',
    );
    const onStep = await until(
      () => liveness(daemon.base),
      answer => answer.body.boot?.step === 'opening the usage feed',
      'the slow step to be reported',
    );
    const served = await until(
      () => liveness(daemon.base),
      answer => answer.status === 200,
      'the routes to mount',
    );
    const health = await fetch(`${daemon.base}/v1/health`);

    // Assert — the port used to stay closed for the whole boot.
    should(daemon.startedAtMs()).not.be.undefined();
    should(first.status).equal(503);
    should(first.body.status).equal('starting');
    should(onStep.status).equal(503);
    should(served.body.status).equal('ok');
    should(health.status).equal(200);
    should(daemon.journal()).match(/listening — http:\/\/127\.0\.0\.1:\d+ — answering \/healthz/u);
    should(daemon.journal()).match(/serving — every route is mounted/u);
  }, 30_000);

  it('should name a stall in its journal with the step that caused it', async () => {
    // Arrange
    const daemon = await boot('hiccup');

    // Act
    await until(
      () => liveness(daemon.base),
      answer => answer.status === 200,
      'the routes to mount',
    );

    // Assert
    should(daemon.journal()).match(/! event loop stalled for 1\.\d+s — during [^\n]*boot: opening the usage feed/u);
    const answer = await liveness(daemon.base);
    should(answer?.status).equal(200);
  }, 30_000);
});

describe('a daemon whose event loop has stopped', () => {
  it('should be ended by its watchdog so a service manager can start a fresh one', async () => {
    // Arrange — a one-second limit, so the case does not wait out the shipped five minutes.
    const daemon = await boot('stall', { FYD_WATCHDOG_SECONDS: '1' });
    await until(
      () => liveness(daemon.base),
      answer => answer.body.boot?.step === 'opening the usage feed',
      'the step that will stall',
    );

    // Act
    // A watchdog that never fires leaves this to the test's own timeout, which names the case.
    const exitedAtMs = await daemon.child.exited.then(() => Date.now());

    // Assert — the stall lasts a minute; the watchdog ended it in seconds, and said why first.
    should(exitedAtMs).not.be.undefined();
    should(daemon.child.signalCode).equal('SIGKILL');
    should(daemon.journal()).match(
      /! watchdog: the event loop has not run for \d+s \(during [^)]*boot: opening the usage feed[^)]*\) — ending this process/u,
    );
  }, 30_000);
});
