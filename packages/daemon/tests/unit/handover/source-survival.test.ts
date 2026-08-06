import { describe, it } from 'bun:test';
import type { SessionHandoverPhase } from '@ferretry/protocol';
import should from 'should';
import { type HandoverWorld, nextPhase } from '../../../src/lib/handover/policy.ts';
import { observation, receiptAt, sessionView } from './support.ts';

function world(overrides: Partial<HandoverWorld> = {}): HandoverWorld {
  return {
    now: '2026-02-01T00:00:00.000Z',
    source: sessionView(),
    replacement: sessionView({ sessionId: 'replacement-1', teammate: null }),
    board: observation(),
    verificationDeadlineMinutes: 30,
    ...overrides,
  };
}

/**
 * The predecessor surviving is an invariant, not a detail.
 *
 * Every forward effect is performed on behalf of a session this machine believes is running: it invites
 * a replacement onto that session's board, seats a coordinator over that session's membership, and only
 * then retires it. A predecessor that died OUTSIDE the recorded retirement tail is external loss — and
 * a handover that kept walking would seat a replacement over the membership of a session nobody can
 * hand anything over from.
 */
describe('source loss, which supersedes every other classification', () => {
  const dead = (status: 'stopped' | 'failed' = 'stopped'): HandoverWorld => world({ source: sessionView({ status }) });

  it('settles source_lost at every progress phase before the retirement', () => {
    const phases: readonly SessionHandoverPhase[] = [
      'requested',
      'replacement_creating',
      'replacement_created',
      'invited',
      'approved',
      'accepted',
      'replacement_started',
      'verified',
      'coordinator_creating',
      'coordinator_created',
      'coordinator_granted',
      'coordinator_started',
      'coordinator_replaced',
      'draining',
    ];
    for (const phase of phases) {
      const receipt = receiptAt(phase, { coordinatorSessionId: 'coordinator-1' });
      should(nextPhase(receipt, dead())).match({ kind: 'fail', failure: 'source_lost' }, phase);
      should(nextPhase(receipt, dead('failed'))).match({ kind: 'fail', failure: 'source_lost' }, `${phase} (failed)`);
      should(nextPhase(receipt, world({ source: null }))).match(
        { kind: 'fail', failure: 'source_lost' },
        `${phase} (absent)`,
      );
    }
  });

  it('settles a boardless handover the same way, including at ordinary draining', () => {
    should(nextPhase(receiptAt('draining', { board: null }), dead())).match({ kind: 'fail', failure: 'source_lost' });
    should(nextPhase(receiptAt('replacement_started', { board: null }), dead())).match({
      kind: 'fail',
      failure: 'source_lost',
    });
  });

  it('says which session and what state, because the receipt is what a human reads', () => {
    const blocked = nextPhase(receiptAt('replacement_started'), dead());
    should(blocked).match({ kind: 'fail', failure: 'source_lost' });
    if (blocked.kind === 'fail') {
      should(blocked.reason).match(/source-1 is stopped/u);
      should(blocked.reason).match(/every forward effect is blocked/u);
    }
  });

  it('treats a terminal source as the expected proof once retiring is durable', () => {
    const retiring = receiptAt('draining', { effectIntent: 'retiring' });
    should(nextPhase(retiring, dead())).deepEqual({ kind: 'step', step: 'retire_without_gate' });
    should(nextPhase(retiring, world({ source: null }))).deepEqual({ kind: 'step', step: 'retire_without_gate' });
  });

  it('treats a terminal source as the tail from relinquished onward', () => {
    should(nextPhase(receiptAt('relinquished'), dead())).deepEqual({ kind: 'step', step: 'stop_predecessor' });
    should(nextPhase(receiptAt('predecessor_stopped'), dead())).deepEqual({ kind: 'step', step: 'complete' });
  });

  it('is checked ahead of the board invariant, because the source decides whether that question matters', () => {
    // Both are wrong at once: the source is gone AND the board no longer counts it as a root. The
    // source answer wins, because a board complaint about a session that no longer exists would send a
    // human to look at the wrong document.
    const both = world({ source: null, board: observation({ activeRootSessionIds: ['somebody-else'] }) });
    should(nextPhase(receiptAt('replacement_created'), both)).match({ kind: 'fail', failure: 'source_lost' });
  });

  it('does not settle a live source at any phase', () => {
    should(nextPhase(receiptAt('replacement_created'), world())).match({ kind: 'step' });
    should(nextPhase(receiptAt('draining'), world())).match({ kind: 'step', step: 'drain' });
  });
});
