import { describe, it } from 'bun:test';
import should from 'should';
import {
  decideWait,
  renderWaitOutcome,
  waitExitCode,
  type WaitNotices,
  type WaitObservation,
} from '../../../src/lib/reads/wait.ts';
import { sessionState } from './fixtures.ts';

/**
 * The four ways a wait ends, and the one way it does not.
 *
 * The legacy command answered exit 0 to three of these — completed, died, and needs-a-human were all
 * "the wait is over" — so a script blocking on a teammate carried on after a failure as though the work
 * had been done. Every case below pins one of those apart from the others.
 */

const FRESH: WaitNotices = { missingMarker: false, declaredWait: false };

const observe = (overrides: Partial<WaitObservation> & Pick<WaitObservation, 'state'>): WaitObservation => ({
  expired: false,
  ...overrides,
});

describe('decideWait without a deliverable', () => {
  it('should settle when the session completed', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ state: sessionState({ status: 'completed' }) }), FRESH);

    // Assert
    should(outcome).eql({ kind: 'settled', reason: 'completed' });
    should(waitExitCode(outcome as never)).equal(0);
  });

  it('should report a session that ended without completing as a failure', () => {
    // Arrange / Act — this is the case legacy answered 0 to.
    for (const status of ['failed', 'stalled', 'stopped', 'kill_failed']) {
      const { outcome } = decideWait(observe({ state: sessionState({ status: status as never }) }), FRESH);

      // Assert
      should(outcome).eql({ kind: 'ended', status });
      should(waitExitCode(outcome as never)).equal(1);
    }
  });

  it('should distinguish a session parked on a human from one that died', () => {
    // Arrange / Act
    for (const status of ['waiting', 'awaiting_user', 'awaiting_question']) {
      const { outcome } = decideWait(observe({ state: sessionState({ status: status as never }) }), FRESH);

      // Assert — nothing is broken, and nothing will happen either until somebody replies.
      should(outcome).eql({ kind: 'needs-attention', status });
      should(waitExitCode(outcome as never)).equal(3);
    }
  });

  it('should keep waiting on a DECLARED wait, because the daemon will wake it', () => {
    // Arrange
    const state = sessionState({ status: 'waiting', waiting: { condition: 'CI', until: INSTANT } as never });

    // Act
    const first = decideWait(observe({ state }), FRESH);
    const second = decideWait(observe({ state }), first.notices);

    // Assert — the advisory is said once, not on every poll.
    should(first.outcome.kind).equal('keep-waiting');
    should((first.outcome as { note?: string }).note).match(/declared a wait on CI/);
    should(second.outcome).eql({ kind: 'keep-waiting' });
  });

  it('should give up when the deadline passes while the session is still going', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ state: sessionState({ status: 'thinking' }), expired: true }), FRESH);

    // Assert — 124 is what `timeout(1)` reports and what the legacy command already used.
    should(outcome).eql({ kind: 'timed-out', status: 'thinking' });
    should(waitExitCode(outcome as never)).equal(124);
  });

  it('should keep waiting on a session that is simply working', () => {
    // Arrange / Act
    const { outcome } = decideWait(observe({ state: sessionState({ status: 'tool_running' }) }), FRESH);

    // Assert
    should(outcome).eql({ kind: 'keep-waiting' });
  });
});

const INSTANT = '2026-02-01T09:08:07.000Z';

describe('decideWait with a deliverable', () => {
  const marker = (present: boolean) => ({ path: '/work/done.md', present });

  it('should settle the moment the deliverable exists, whatever the status says', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ state: sessionState({ status: 'running' }), marker: marker(true) }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'settled', reason: 'marker' });
  });

  it('should keep waiting on a completion CLAIM with no deliverable behind it', () => {
    // Arrange
    const state = sessionState({ status: 'completed' });

    // Act
    const first = decideWait(observe({ state, marker: marker(false) }), FRESH);
    const second = decideWait(observe({ state, marker: marker(false) }), first.notices);

    // Assert — the file is evidence; `completed` is a claim. Said once, then silent.
    should(first.outcome.kind).equal('keep-waiting');
    should((first.outcome as { note?: string }).note).match(/completed but \/work\/done\.md is not there yet/);
    should(second.outcome).eql({ kind: 'keep-waiting' });
  });

  it('should fail when the session ended and the deliverable never appeared', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ state: sessionState({ status: 'failed' }), marker: marker(false) }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'ended', status: 'failed', marker: '/work/done.md' });
    should(waitExitCode(outcome as never)).equal(1);
  });

  it('should hand control back when a human is needed, since the deliverable can never appear alone', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ state: sessionState({ status: 'awaiting_question' }), marker: marker(false) }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'needs-attention', status: 'awaiting_question' });
  });

  it('should keep waiting through a DECLARED wait and say so once', () => {
    // Arrange
    const state = sessionState({ status: 'waiting', waiting: {} as never });

    // Act
    const first = decideWait(observe({ state, marker: marker(false) }), FRESH);
    const second = decideWait(observe({ state, marker: marker(false) }), first.notices);

    // Assert
    should((first.outcome as { note?: string }).note).match(/declared a wait \(open-ended\)/);
    should(second.outcome).eql({ kind: 'keep-waiting' });
  });

  it('should time out rather than block forever on a deliverable that never lands', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ state: sessionState({ status: 'running' }), marker: marker(false), expired: true }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'timed-out', status: 'running' });
  });

  it('should keep waiting silently on an ordinary working session', () => {
    // Arrange / Act
    const { outcome } = decideWait(
      observe({ state: sessionState({ status: 'running' }), marker: marker(false) }),
      FRESH,
    );

    // Assert
    should(outcome).eql({ kind: 'keep-waiting' });
  });
});

describe('renderWaitOutcome', () => {
  it('should explain every ending except a settled one', () => {
    // Arrange / Act / Assert
    should(renderWaitOutcome({ kind: 'settled', reason: 'completed' })).be.undefined();
    should(renderWaitOutcome({ kind: 'ended', status: 'failed' })).match(/ended as failed rather than completing/);
    should(renderWaitOutcome({ kind: 'ended', status: 'stopped', marker: '/work/done.md' })).match(
      /is stopped and \/work\/done\.md never appeared/,
    );
    should(renderWaitOutcome({ kind: 'needs-attention', status: 'awaiting_user' })).match(/needs a human/);
    should(renderWaitOutcome({ kind: 'timed-out', status: 'running' })).match(/gave up while the session was still/);
    should(renderWaitOutcome({ kind: 'timed-out' })).match(/before fyd returned a session state/);
    should(
      renderWaitOutcome({
        kind: 'daemon-unavailable',
        failure: 'unresponsive',
        detail: 'request deadline passed',
      }),
    ).match(/fyd became unresponsive: request deadline passed/);
  });

  it('should give daemon loss its own script-visible exit', () => {
    // Arrange
    const outcome = {
      kind: 'daemon-unavailable',
      failure: 'unavailable',
      detail: 'connection refused',
    } as const;

    // Act / Assert — a dead session is 1 and a caller timeout is 124; daemon loss is neither.
    should(waitExitCode(outcome)).equal(69);
  });
});
