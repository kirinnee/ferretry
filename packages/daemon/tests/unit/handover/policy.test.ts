import { describe, it } from 'bun:test';
import { SESSION_HANDOVER_PHASES, type SessionHandoverPhase } from '@ferretry/protocol';
import should from 'should';
import {
  derivedStepId,
  handoverCleanupPlan,
  handoverEligibility,
  handoverFingerprint,
  handoverPlanId,
  type HandoverStepId,
  type HandoverWorld,
  isPointOfNoReturn,
  isTerminalHandoverPhase,
  nextPhase,
} from '../../../src/lib/handover/policy.ts';
import type { HandoverReceipt } from '../../../src/lib/handover/types.ts';
import {
  CODEX_ACCOUNT,
  CODEX_COORDINATOR,
  membership,
  observation,
  receiptAt,
  request,
  sessionView,
  SOURCE_ID,
} from './support.ts';

const TARGET = { replacement: CODEX_ACCOUNT, coordinator: CODEX_COORDINATOR };

function world(overrides: Partial<HandoverWorld> = {}): HandoverWorld {
  return {
    now: '2026-02-01T00:00:00.000Z',
    replacement: sessionView({ sessionId: 'replacement-1', teammate: null }),
    board: observation(),
    verificationDeadlineMinutes: 30,
    ...overrides,
  };
}

describe('handover phase classification', () => {
  it('answers for every phase the protocol declares, so a new one cannot default', () => {
    const terminal = SESSION_HANDOVER_PHASES.filter(phase => isTerminalHandoverPhase(phase));
    should(terminal).deepEqual(['completed', 'refused', 'abandoned', 'stranded', 'failed']);
  });

  it('puts a board handover past the point of no return at accepted', () => {
    const past = SESSION_HANDOVER_PHASES.filter(phase => isPointOfNoReturn(phase, true));
    should(past).deepEqual([
      'accepted',
      'replacement_started',
      'verified',
      'coordinator_creating',
      'coordinator_created',
      'coordinator_granted',
      'coordinator_started',
      'coordinator_replaced',
      'draining',
      'relinquished',
      'predecessor_stopped',
      'completed',
      'stranded',
      'failed',
    ]);
  });

  it('keeps a boardless replacement disposable until the predecessor is stopped', () => {
    const past = SESSION_HANDOVER_PHASES.filter(phase => isPointOfNoReturn(phase, false));
    should(past).deepEqual(['predecessor_stopped', 'completed', 'stranded', 'failed']);
    // The distinction the second table exists for: a running boardless replacement is still disposable.
    should(isPointOfNoReturn('replacement_started', false)).be.false();
    should(isPointOfNoReturn('replacement_started', true)).be.true();
    should(isPointOfNoReturn('draining', false)).be.false();
  });
});

describe('handover identifiers', () => {
  it('fingerprints the raw ask, so a manifest edit cannot turn a retry into a conflict', () => {
    should(handoverFingerprint(request())).equal(handoverFingerprint(request()));
    should(handoverFingerprint(request({ reason: 'something else' }))).not.equal(handoverFingerprint(request()));
    should(handoverFingerprint(request({ coordinator: null }))).not.equal(handoverFingerprint(request()));
    should(handoverFingerprint(request({ model: undefined }))).not.equal(handoverFingerprint(request()));
    should(handoverFingerprint(request({ coordinator: { agent: 'other' } }))).not.equal(handoverFingerprint(request()));
  });

  it('derives a plan id from the source and the request id and nothing else', () => {
    should(handoverPlanId(SOURCE_ID, 'req-1')).equal(handoverPlanId(SOURCE_ID, 'req-1'));
    should(handoverPlanId(SOURCE_ID, 'req-2')).not.equal(handoverPlanId(SOURCE_ID, 'req-1'));
    should(handoverPlanId('other', 'req-1')).not.equal(handoverPlanId(SOURCE_ID, 'req-1'));
  });

  it('gives every board step a distinct, stable id', () => {
    const steps: readonly HandoverStepId[] = [
      'handover.invite',
      'handover.approve',
      'handover.accept',
      'handover.child-grant.request',
      'handover.child-grant.approve',
      'handover.coordinator.replace',
      'handover.relinquish',
      'handover.journal.source',
      'handover.journal.replacement',
    ];
    const receipt = receiptAt('invited', { coordinatorSessionId: 'coordinator-1' });
    const ids = steps.map(step => derivedStepId(receipt, step));
    should(new Set(ids).size).equal(steps.length);
    should(derivedStepId(receipt, 'handover.invite')).equal(derivedStepId(receipt, 'handover.invite'));
    // Two handovers of one session under different request ids never collide.
    should(derivedStepId({ ...receipt, requestId: 'req-2' }, 'handover.invite')).not.equal(ids[0]);
  });
});

describe('handover eligibility', () => {
  it('accepts a board root crossing families and reports both parsed harnesses', () => {
    const decision = handoverEligibility({
      source: sessionView(),
      membership: membership(),
      target: TARGET,
      wardenDriven: false,
    });
    should(decision).match({ ok: true, sourceHarness: 'claude', replacementHarness: 'codex' });
  });

  it('accepts a root with no board at all', () => {
    should(handoverEligibility({ source: sessionView(), membership: null, target: TARGET, wardenDriven: false })).match(
      { ok: true },
    );
  });

  it('refuses a session that is not top level before anything else is considered', () => {
    const decision = handoverEligibility({
      source: sessionView({ parentSessionId: 'parent-1', harness: 'unknown-harness' }),
      membership: membership(),
      target: TARGET,
      wardenDriven: true,
    });
    should(decision).match({ ok: false, refusal: { failure: 'not_top_level' } });
  });

  it('refuses a same-family target and names the operation that keeps the conversation', () => {
    const decision = handoverEligibility({
      source: sessionView({ harness: 'codex' }),
      membership: membership(),
      target: TARGET,
      wardenDriven: false,
    });
    should(decision).match({ ok: false, refusal: { failure: 'harness_same' } });
    should(decision.ok).be.false();
    if (!decision.ok) should(decision.refusal.message).match(/migration/u);
  });

  it('refuses rather than guesses when either family is a name it does not know', () => {
    should(
      handoverEligibility({
        source: sessionView({ harness: 'future-harness' }),
        membership: null,
        target: TARGET,
        wardenDriven: false,
      }),
    ).match({ ok: false, refusal: { failure: 'harness_unknown' } });
    should(
      handoverEligibility({
        source: sessionView(),
        membership: null,
        target: { replacement: { ...CODEX_ACCOUNT, harness: 'future-harness' as 'codex' }, coordinator: null },
        wardenDriven: false,
      }),
    ).match({ ok: false, refusal: { failure: 'harness_unknown' } });
  });

  it('refuses a warden-driven handover of a board root, and allows one of a boardless root', () => {
    should(
      handoverEligibility({ source: sessionView(), membership: membership(), target: TARGET, wardenDriven: true }),
    ).match({ ok: false, refusal: { failure: 'board_authority_required' } });
    should(handoverEligibility({ source: sessionView(), membership: null, target: TARGET, wardenDriven: true })).match({
      ok: true,
    });
  });

  it('answers board_authority_required for a warden even when the target would fail another check', () => {
    for (const harness of ['codex', 'future-harness']) {
      should(
        handoverEligibility({
          source: sessionView({ harness }),
          membership: membership(),
          target: TARGET,
          wardenDriven: true,
        }),
      ).match({ ok: false, refusal: { failure: 'board_authority_required' } }, harness);
    }
  });

  it('refuses an auto-mode board root instead of silently dropping the board', () => {
    should(
      handoverEligibility({
        source: sessionView({ mode: 'auto' }),
        membership: membership(),
        target: TARGET,
        wardenDriven: false,
      }),
    ).match({ ok: false, refusal: { failure: 'mode_not_invitable' } });
  });

  it('refuses a board handover that names no coordinator for the replacement to seat', () => {
    should(
      handoverEligibility({
        source: sessionView(),
        membership: membership(),
        target: { replacement: CODEX_ACCOUNT, coordinator: null },
        wardenDriven: false,
      }),
    ).match({ ok: false, refusal: { failure: 'coordinator_required' } });
  });

  it('refuses a board whose seated coordinator is dead', () => {
    should(
      handoverEligibility({
        source: sessionView(),
        membership: membership({ coordinatorAlive: false }),
        target: TARGET,
        wardenDriven: false,
      }),
    ).match({ ok: false, refusal: { failure: 'no_live_coordinator' } });
  });

  it('refuses a board that already carries an outstanding invitation', () => {
    should(
      handoverEligibility({
        source: sessionView(),
        membership: membership({ outstandingInvitation: true }),
        target: TARGET,
        wardenDriven: false,
      }),
    ).match({ ok: false, refusal: { failure: 'board_busy' } });
  });

  it('refuses a board that already has two active roots, which no pending invitation reveals', () => {
    // The exact state an accepted-but-unverified handover leaves: the invitation was consumed, so
    // `outstandingInvitation` is false while the board carries two roots.
    const decision = handoverEligibility({
      source: sessionView(),
      membership: membership({ outstandingInvitation: false, activeRootSessionIds: [SOURCE_ID, 'replacement-1'] }),
      target: TARGET,
      wardenDriven: false,
    });
    should(decision).match({ ok: false, refusal: { failure: 'board_busy' } });
    if (!decision.ok) should(decision.refusal.message).match(/sole active membership root/u);
  });

  it('refuses an empty root roster and one this session is missing from', () => {
    for (const activeRootSessionIds of [[], ['somebody-else'], ['somebody-else', SOURCE_ID]]) {
      should(
        handoverEligibility({
          source: sessionView(),
          membership: membership({ activeRootSessionIds }),
          target: TARGET,
          wardenDriven: false,
        }),
      ).match({ ok: false, refusal: { failure: 'board_busy' } }, JSON.stringify(activeRootSessionIds));
    }
  });
});

describe('handover cleanup plans', () => {
  it('refuses when the identity was written ahead and no session was ever created', () => {
    const receipt = receiptAt('replacement_creating');
    should(handoverCleanupPlan(receipt, world({ replacement: null }), 'cancelled', 'why')).match({ kind: 'refuse' });
  });

  it('refuses when not even an identity exists', () => {
    const receipt = receiptAt('requested', {
      replacementSessionId: undefined,
      phaseHistory: [{ phase: 'requested', at: '2026-02-01T00:00:00.000Z' }],
    });
    should(handoverCleanupPlan(receipt, world(), 'cancelled', 'why')).match({ kind: 'refuse' });
  });

  it('abandons once a record answers to the written-ahead identity', () => {
    const receipt = receiptAt('replacement_creating');
    should(handoverCleanupPlan(receipt, world(), 'cancelled', 'why')).match({ kind: 'abandon' });
  });

  it('abandons a handover that reached replacement_created even if the record has since gone', () => {
    const receipt = receiptAt('replacement_created', {
      phaseHistory: [
        { phase: 'requested', at: '2026-02-01T00:00:00.000Z' },
        { phase: 'replacement_created', at: '2026-02-01T00:00:01.000Z' },
      ],
    });
    should(handoverCleanupPlan(receipt, world({ replacement: null }), 'board_moved', 'why')).match({
      kind: 'abandon',
    });
  });
});

describe('the handover ladder', () => {
  const boardSteps: Readonly<Record<string, string>> = {
    requested: 'claim_replacement_identity',
    replacement_creating: 'create_replacement',
    replacement_created: 'invite',
    invited: 'approve',
    approved: 'accept',
    accepted: 'start_replacement',
    verified: 'claim_coordinator_identity',
    coordinator_creating: 'create_coordinator',
    coordinator_created: 'grant_coordinator',
    coordinator_granted: 'start_coordinator',
    coordinator_started: 'replace_coordinator',
    coordinator_replaced: 'enter_draining',
    draining: 'drain',
    relinquished: 'stop_predecessor',
    predecessor_stopped: 'complete',
  };

  it('names one step for every progress phase of a board handover', () => {
    for (const [phase, step] of Object.entries(boardSteps)) {
      const receipt = receiptAt(phase as SessionHandoverPhase, { coordinatorSessionId: 'coordinator-1' });
      should(nextPhase(receipt, world())).deepEqual({ kind: 'step', step }, `phase ${phase}`);
    }
  });

  it('settles on every terminal phase without reading the world', () => {
    for (const phase of ['completed', 'refused', 'abandoned', 'stranded', 'failed'] as const) {
      should(nextPhase(receiptAt(phase), world({ board: null }))).deepEqual({ kind: 'settled' });
    }
  });

  it('collapses the boardless ladder past every board step', () => {
    const boardless = (phase: SessionHandoverPhase): HandoverReceipt => receiptAt(phase, { board: null });
    should(nextPhase(boardless('replacement_created'), world({ board: null }))).deepEqual({
      kind: 'step',
      step: 'start_replacement',
    });
    should(nextPhase(boardless('replacement_started'), world({ board: null }))).deepEqual({
      kind: 'step',
      step: 'enter_draining',
    });
  });

  it('never advances a receipt backwards through the ladder', () => {
    // The termination argument the service's unbounded drive loop rests on.
    const rank = new Map(SESSION_HANDOVER_PHASES.map((phase, index) => [phase, index]));
    const results: Readonly<Record<string, string>> = {
      claim_replacement_identity: 'replacement_creating',
      create_replacement: 'replacement_created',
      invite: 'invited',
      approve: 'approved',
      accept: 'accepted',
      start_replacement: 'replacement_started',
      record_verified: 'verified',
      claim_coordinator_identity: 'coordinator_creating',
      create_coordinator: 'coordinator_created',
      grant_coordinator: 'coordinator_granted',
      start_coordinator: 'coordinator_started',
      replace_coordinator: 'coordinator_replaced',
      enter_draining: 'draining',
      drain: 'relinquished',
      stop_predecessor: 'predecessor_stopped',
      complete: 'completed',
    };
    for (const [phase, step] of Object.entries(boardSteps)) {
      const from = rank.get(phase as SessionHandoverPhase) ?? -1;
      const to = rank.get(results[step] as SessionHandoverPhase) ?? -1;
      should(to).be.greaterThan(from, `${phase} -> ${step}`);
    }
  });

  it('fails a completion whose receipt names no replacement, rather than journalling a lie', () => {
    const receipt = receiptAt('predecessor_stopped', { replacementSessionId: undefined });
    should(nextPhase(receipt, world())).match({ kind: 'fail', failure: 'step_failed' });
  });
});

describe('the verification wait', () => {
  const started = (overrides: Partial<HandoverReceipt> = {}): HandoverReceipt =>
    receiptAt('replacement_started', {
      board: {
        boardId: 'board-1',
        creatorSessionId: SOURCE_ID,
        canonicalSessionId: SOURCE_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        invitationRequestId: 'invitation-1',
      },
      ...overrides,
    });

  const verified = {
    requestId: 'invitation-1',
    targetSessionId: 'replacement-1',
    verifiedAt: '2026-02-01T00:00:05.000Z',
    verifiedBySessionId: 'replacement-1',
  };

  it('waits while the replacement is live and has not verified', () => {
    should(nextPhase(started(), world())).match({ kind: 'wait' });
  });

  it('advances when all four conjuncts hold', () => {
    should(nextPhase(started(), world({ board: observation({ invitation: verified }) }))).deepEqual({
      kind: 'step',
      step: 'record_verified',
    });
  });

  it('refuses a receipt from another invitation, another target, or another verifier', () => {
    const cases = [
      { ...verified, requestId: 'invitation-2' },
      { ...verified, targetSessionId: 'somebody-else' },
      { ...verified, verifiedBySessionId: 'somebody-else' },
    ];
    for (const invitation of cases) {
      should(nextPhase(started(), world({ board: observation({ invitation }) }))).match({ kind: 'wait' });
    }
  });

  it('strands a replacement that died before proving it could act', () => {
    should(
      nextPhase(started(), world({ replacement: sessionView({ sessionId: 'replacement-1', status: 'stopped' }) })),
    ).match({ kind: 'strand', failure: 'replacement_terminal' });
    should(nextPhase(started(), world({ replacement: null }))).match({
      kind: 'strand',
      failure: 'replacement_terminal',
    });
  });

  it('strands on the deadline, and only on this wait', () => {
    const late = world({ now: '2026-02-01T01:00:00.000Z' });
    should(nextPhase(started(), late)).match({ kind: 'strand', failure: 'verification_timeout' });
    // Every other post-acceptance phase is a deterministic effect: age is not evidence it failed.
    should(nextPhase(receiptAt('coordinator_granted', { coordinatorSessionId: 'coordinator-1' }), late)).match({
      kind: 'step',
      step: 'start_coordinator',
    });
    should(nextPhase(receiptAt('draining'), late)).match({ kind: 'step', step: 'drain' });
  });

  it('does not read an unparseable timestamp as a passed deadline', () => {
    const damaged = started({
      phaseHistory: [
        { phase: 'requested', at: '2026-02-01T00:00:00.000Z' },
        { phase: 'replacement_started', at: 'not-a-time' },
      ],
      updatedAt: 'not-a-time',
    });
    should(nextPhase(damaged, world({ now: '2027-01-01T00:00:00.000Z' }))).match({ kind: 'wait' });
    should(nextPhase(started(), world({ now: 'not-a-time' }))).match({ kind: 'wait' });
  });
});

describe('the board invariant', () => {
  it('passes when the anchor and the active roots are intact', () => {
    should(nextPhase(receiptAt('replacement_creating'), world())).match({ kind: 'step' });
  });

  it('unwinds when no board answers to the pinned id', () => {
    should(nextPhase(receiptAt('replacement_creating'), world({ board: null }))).match({
      kind: 'abandon',
      failure: 'board_moved',
    });
  });

  it('unwinds on any one field of the anchor drifting', () => {
    const drifts = [
      observation({ boardId: 'board-2' }),
      observation({ creatorSessionId: 'somebody-else' }),
      observation({ canonicalSessionId: 'somebody-else' }),
      observation({ createdAt: '2026-01-02T00:00:00.000Z' }),
    ];
    for (const board of drifts) {
      should(nextPhase(receiptAt('replacement_creating'), world({ board }))).match({
        kind: 'abandon',
        failure: 'board_moved',
      });
    }
  });

  it('accepts a board whose canonical session is neither root, which every second handover has', () => {
    const anchor = {
      boardId: 'board-1',
      creatorSessionId: 'the-original-root',
      canonicalSessionId: 'the-original-root',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const board = observation({
      creatorSessionId: 'the-original-root',
      canonicalSessionId: 'the-original-root',
    });
    should(nextPhase(receiptAt('replacement_creating', { board: anchor }), world({ board }))).match({ kind: 'step' });
  });

  it('strands rather than unwinds once the handover is past the point of no return', () => {
    should(nextPhase(receiptAt('accepted'), world({ board: null }))).match({
      kind: 'strand',
      failure: 'board_moved',
    });
  });

  it('unwinds when the source is no longer one of the board roots', () => {
    should(
      nextPhase(receiptAt('replacement_creating'), world({ board: observation({ activeRootSessionIds: ['other'] }) })),
    ).match({ kind: 'abandon', failure: 'board_moved' });
  });

  it('stops checking once the source has relinquished on purpose', () => {
    const gone = world({ board: observation({ activeRootSessionIds: ['replacement-1'] }) });
    should(nextPhase(receiptAt('relinquished'), gone)).deepEqual({ kind: 'step', step: 'stop_predecessor' });
    should(nextPhase(receiptAt('predecessor_stopped'), gone)).deepEqual({ kind: 'step', step: 'complete' });
  });
});

describe('a durable cancellation intent', () => {
  it('outranks forward progress at every nonterminal phase', () => {
    const cancelled = receiptAt('replacement_created', {
      cancelRequestId: 'cancel-1',
      refusal: { failure: 'cancelled', message: 'an operator stopped it' },
    });
    should(nextPhase(cancelled, world())).match({ kind: 'abandon', failure: 'cancelled' });
  });
});
