import { describe, it } from 'bun:test';
import should from 'should';
import { HANDOVER_RETIRING_MARKER } from '../../../src/lib/handover/policy.ts';
import { SessionHandoverService } from '../../../src/lib/handover/service.ts';
import { HandoverError, type HandoverReceipt } from '../../../src/lib/handover/types.ts';
import {
  BOARD_ID,
  type HandoverHarness,
  harness,
  membership,
  observation,
  planIdFor,
  receiptAt,
  request,
  REQUEST_ID,
  sessionView,
  SOURCE_ID,
} from './support.ts';

const REPLACEMENT = 'replacement-1';
const COORDINATOR = 'coordinator-1';

function service(context: HandoverHarness): SessionHandoverService {
  return new SessionHandoverService(context.ports, { verificationDeadlineMinutes: 30 });
}

/** Marks the invitation this handover created as verified by its own replacement. */
function verify(context: HandoverHarness): void {
  context.boardReader.observationAnswer = observation({
    invitation: {
      requestId: `invitation-of-${REPLACEMENT}`,
      targetSessionId: REPLACEMENT,
      verifiedAt: '2026-02-01T00:01:00.000Z',
      verifiedBySessionId: REPLACEMENT,
    },
  });
}

async function beginBoard(context: HandoverHarness): Promise<HandoverReceipt> {
  return await service(context).begin(SOURCE_ID, request(), REQUEST_ID);
}

describe('beginning a handover', () => {
  it('writes a requested receipt naming both harnesses, the plan and the board anchor', async () => {
    const context = harness();
    const receipt = await beginBoard(context);
    should(receipt).match({
      phase: 'requested',
      requestId: REQUEST_ID,
      sourceSessionId: SOURCE_ID,
      sourceHarness: 'claude',
      sourceTeammate: 'ada',
      resolvedTarget: { replacement: { harness: 'codex', agent: 'codex-main', model: 'gpt' } },
      planId: planIdFor(SOURCE_ID, REQUEST_ID),
      board: { boardId: BOARD_ID, creatorSessionId: SOURCE_ID, canonicalSessionId: SOURCE_ID },
    });
    should(receipt.phaseHistory).have.length(1);
    should(receipt.replacementSessionId).be.undefined();
  });

  it('freezes the resolved target and the whole plan ON the receipt, before anything is created', async () => {
    const context = harness();
    const receipt = await beginBoard(context);
    should(receipt.resolvedTarget).match({
      replacement: { agent: 'codex-main', contextWindow: 400_000 },
      coordinator: { agent: 'codex-coordinator' },
    });
    should(receipt.plan.planId).equal(planIdFor(SOURCE_ID, REQUEST_ID));
    should(receipt.reason).equal(request().reason);
  });

  it('records a boardless root as board: null rather than as a missing section', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = null;
    const receipt = await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    should(receipt.board).be.null();
  });

  it('carries the advisory report path when the gate produced one', async () => {
    const context = harness();
    context.preflight.verdict = { proceed: true, reason: 'quiet', reportPath: '/state/report.md' };
    should((await beginBoard(context)).inflightReportPath).equal('/state/report.md');
  });

  it('refuses without writing anything when the advisory gate refuses', async () => {
    const context = harness();
    context.preflight.verdict = { proceed: false, reason: 'a destructive tool call is open', reportPath: null };
    await should(beginBoard(context)).be.rejectedWith(/not safe to interrupt/u);
    should(context.receipts.writes).be.empty();
  });

  it('refuses an unknown session and a blank request id, writing nothing either time', async () => {
    const context = harness();
    await should(service(context).begin('nobody', request(), REQUEST_ID)).be.rejectedWith(/holds no session/u);
    await should(beginBoardWithId(context, '   ')).be.rejectedWith(/must not be blank/u);
    should(context.receipts.writes).be.empty();
  });

  it('refuses an ineligible session with the protocol cause and no receipt', async () => {
    const context = harness(sessionView({ mode: 'auto' }));
    const error = await beginBoard(context).catch((thrown: unknown) => thrown);
    should(error).be.instanceof(HandoverError);
    should((error as HandoverError).failure).equal('mode_not_invitable');
    should(context.receipts.writes).be.empty();
  });

  it('replays the same request id and refuses a different payload under it', async () => {
    const context = harness();
    const first = await beginBoard(context);
    should(await beginBoard(context)).deepEqual(first);
    should(context.receipts.writes).have.length(1);
    const error = await service(context)
      .begin(SOURCE_ID, request({ reason: 'a different reason' }), REQUEST_ID)
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('request_conflict');
  });

  it('reuses the frozen decision on a retry instead of resolving the manifest again', async () => {
    const context = harness();
    const first = await beginBoard(context);
    context.receipts.plant({
      ...first,
      phase: 'refused',
      phaseHistory: [...first.phaseHistory, { phase: 'refused', at: first.createdAt }],
      refusal: { failure: 'cancelled', message: 'an operator stopped it' },
      cancelRequestId: 'cancel-1',
    });
    context.accounts.failure = 'the fleet manifest changed underneath us';
    const retried = await beginBoard(context);
    should(retried.phase).equal('requested');
    should(retried.resolvedTarget).deepEqual(first.resolvedTarget);
    should(retried.plan).deepEqual(first.plan);
    // The seam was asked once, for the first attempt, and never again.
    should(context.preparer.calls).have.length(1);
  });

  it('refuses a second request id while one is in flight, and after a stranded or completed one', async () => {
    for (const [phase, failure] of [
      ['invited', 'in_flight'],
      ['completed', 'already_completed'],
      ['stranded', 'in_flight'],
      ['failed', 'in_flight'],
    ] as const) {
      const context = harness();
      context.receipts.plant(receiptAt(phase, { requestId: 'older' }));
      const error = await beginBoard(context).catch((thrown: unknown) => thrown);
      should((error as HandoverError).failure).equal(failure, phase);
    }
  });

  it('lets a refused or abandoned handover start over under its own request id', async () => {
    for (const phase of ['refused', 'abandoned'] as const) {
      const context = harness();
      const fingerprint = (await beginBoard(context)).fingerprint;
      context.receipts.plant(receiptAt(phase, { requestId: REQUEST_ID, fingerprint }));
      should((await beginBoard(context)).phase).equal('requested', phase);
    }
  });

  it('accepts a fresh request id after a refused handover', async () => {
    const context = harness();
    context.receipts.plant(receiptAt('refused', { requestId: 'older' }));
    should((await beginBoard(context)).phase).equal('requested');
  });
});

async function beginBoardWithId(context: HandoverHarness, id: string): Promise<HandoverReceipt> {
  return await service(context).begin(SOURCE_ID, request(), id);
}

describe('the full board ladder', () => {
  it('walks to completion once the replacement verifies, in the designed order', async () => {
    const context = harness();
    await beginBoard(context);
    const parked = await service(context).advance(SOURCE_ID);
    should(parked?.phase).equal('replacement_started');
    // Acceptance precedes the launch: the pane must find its capability already in its environment.
    should(context.board.steps()).deepEqual(['requestInvitation', 'approveInvitation', 'acceptInvitation']);
    should(context.sessions.started).deepEqual([REPLACEMENT]);
    verify(context);
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    should(context.receipts.phases()).deepEqual([
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
      'draining',
      'relinquished',
      'predecessor_stopped',
      'completed',
    ]);
    should(context.board.steps()).deepEqual([
      'requestInvitation',
      'approveInvitation',
      'acceptInvitation',
      'requestChildGrant',
      'approveChildGrant',
      'replaceCoordinator',
      'relinquish',
    ]);
  });

  it('imports the frozen plan into the replacement and never prepares a second one', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    should(context.importer.imported).deepEqual([{ planId: planIdFor(SOURCE_ID, REQUEST_ID), sessionId: REPLACEMENT }]);
    should(context.preparer.calls).have.length(1);
  });

  it('creates the replacement as a top-level session and the coordinator beneath it', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    await service(context).advance(SOURCE_ID);
    should(context.sessions.created).match([
      { sessionId: REPLACEMENT, parentSessionId: null, cwd: '/work/repo', account: { agent: 'codex-main' } },
      { sessionId: COORDINATOR, parentSessionId: REPLACEMENT, account: { agent: 'codex-coordinator' } },
    ]);
  });

  it('grants the coordinator before starting it, and starts it before seating it', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    await service(context).advance(SOURCE_ID);
    const created = context.sessions.created.findIndex(entry => entry.sessionId === COORDINATOR);
    should(created).be.greaterThanOrEqual(0);
    const granted = context.board.steps().indexOf('approveChildGrant');
    const seated = context.board.steps().indexOf('replaceCoordinator');
    should(context.sessions.started).deepEqual([REPLACEMENT, COORDINATOR]);
    should(granted).be.lessThan(seated);
  });

  it('leaves the predecessor running and a member until the gate clears', async () => {
    const context = harness();
    await beginBoard(context);
    context.preflight.verdict = { proceed: false, reason: 'a destructive tool call is open', reportPath: null };
    await service(context).advance(SOURCE_ID);
    verify(context);
    const parked = await service(context).advance(SOURCE_ID);
    should(parked?.phase).equal('draining');
    should(context.sessions.stopped).be.empty();
    should(context.board.steps()).not.containEql('relinquish');
    // Parking is idempotent: the same refusal is not written into the history twice.
    const before = context.receipts.writes.length;
    await service(context).advance(SOURCE_ID);
    should(context.receipts.writes).have.length(before);
  });

  it('journals the completion on the predecessor first, then the replacement, exactly once each', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    await service(context).advance(SOURCE_ID);
    should(context.journal.appends.map(entry => entry.sessionId)).deepEqual([SOURCE_ID, REPLACEMENT]);
    should(new Set(context.journal.appends.map(entry => entry.operationId)).size).equal(2);
    should(context.journal.appends[0]).match({ type: 'session.handover_completed', data: { boardId: BOARD_ID } });
    should(context.journal.appends[0]?.data).deepEqual(context.journal.appends[1]?.data);
  });
});

describe('the boardless collapse', () => {
  it('skips every board phase and stops the predecessor after the gate', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    should(context.receipts.phases()).deepEqual([
      'requested',
      'replacement_creating',
      'replacement_created',
      'replacement_started',
      'draining',
      'draining',
      'predecessor_stopped',
      'completed',
    ]);
    should(context.board.steps()).be.empty();
    should(context.boardReader.observed).be.empty();
    should(context.sessions.stopped).match([{ sessionId: SOURCE_ID }]);
    should(context.journal.appends[0]?.data.boardId).be.null();
  });
});

describe('crash resume', () => {
  it('re-drives the create under the written-ahead id rather than minting a second one', async () => {
    const context = harness();
    await beginBoard(context);
    // The identity is written, the create never ran.
    await service(context)
      .advance(SOURCE_ID)
      .catch(() => undefined);
    const planted = receiptAt('replacement_creating', {
      requestId: REQUEST_ID,
      planId: planIdFor(SOURCE_ID, REQUEST_ID),
      fingerprint: context.receipts.current().fingerprint,
    });
    context.receipts.plant(planted);
    context.sessions.forget(REPLACEMENT);
    verify(context);
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    // Two creates, ONE identity: the retry re-created under the id the receipt already carried rather
    // than minting a second replacement and orphaning the first.
    should(context.sessions.created.map(entry => entry.sessionId)).deepEqual([REPLACEMENT, REPLACEMENT, COORDINATOR]);
  });

  it('replays the accept under one derived id after a crash before the phase write', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const accepts = context.board.calls.filter(call => call.step === 'acceptInvitation');
    context.receipts.plant(
      receiptAt('approved', {
        requestId: REQUEST_ID,
        planId: planIdFor(SOURCE_ID, REQUEST_ID),
        fingerprint: context.receipts.current().fingerprint,
        board: {
          boardId: BOARD_ID,
          creatorSessionId: SOURCE_ID,
          canonicalSessionId: SOURCE_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          invitationRequestId: `invitation-of-${REPLACEMENT}`,
        },
      }),
    );
    verify(context);
    await service(context).advance(SOURCE_ID);
    const replayed = context.board.calls.filter(call => call.step === 'acceptInvitation');
    should(replayed).have.length(2);
    should(replayed[0]?.requestId).equal(replayed[1]?.requestId);
    should(accepts).have.length(1);
  });

  it('continues to the stop after a crash between the relinquish and the phase write', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    // The relinquish happened; the board no longer counts the source as a root, and the phase is still draining.
    const retiring = receiptAt('draining', {
      requestId: REQUEST_ID,
      planId: planIdFor(SOURCE_ID, REQUEST_ID),
      fingerprint: context.receipts.current().fingerprint,
      coordinatorSessionId: COORDINATOR,
    });
    context.receipts.plant({
      ...retiring,
      phaseHistory: [
        ...retiring.phaseHistory,
        { phase: 'draining', at: '2026-02-01T00:00:10.000Z', detail: `no in-flight work; ${HANDOVER_RETIRING_MARKER}` },
      ],
    });
    context.boardReader.observationAnswer = observation({ activeRootSessionIds: [REPLACEMENT] });
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    should(context.sessions.stopped).match([{ sessionId: SOURCE_ID }]);
  });

  it('does NOT read a root removed while the gate is still refusing as its own progress', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    context.preflight.verdict = { proceed: false, reason: 'a destructive tool call is open', reportPath: null };
    await service(context).advance(SOURCE_ID);
    should(context.receipts.current().phase).equal('draining');
    // Nothing has been relinquished — the gate never cleared — so the source leaving the board is
    // somebody else's doing, and the handover must strand rather than carry on to stop a predecessor
    // whose membership it never gave up.
    context.boardReader.observationAnswer = observation({ activeRootSessionIds: [REPLACEMENT] });
    const stranded = await service(context).advance(SOURCE_ID);
    should(stranded).match({ phase: 'stranded', refusal: { failure: 'board_moved' } });
    should(context.sessions.stopped).be.empty();
  });

  it('stops a predecessor left running with no membership', async () => {
    const context = harness();
    await beginBoard(context);
    context.receipts.plant(
      receiptAt('relinquished', {
        requestId: REQUEST_ID,
        planId: planIdFor(SOURCE_ID, REQUEST_ID),
        fingerprint: context.receipts.current().fingerprint,
        coordinatorSessionId: COORDINATOR,
      }),
    );
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    should(context.sessions.stopped).match([{ sessionId: SOURCE_ID }]);
  });

  it('does not journal the predecessor twice when the second append crashed', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    context.journal.failAfter = 1;
    await service(context).advance(SOURCE_ID);
    should(context.receipts.current().phase).equal('predecessor_stopped');
    context.journal.failAfter = Number.POSITIVE_INFINITY;
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    should(context.journal.appends.filter(entry => entry.sessionId === SOURCE_ID)).have.length(1);
    should(context.journal.appends.filter(entry => entry.sessionId === REPLACEMENT)).have.length(1);
  });

  it('answers null for a roster entry whose receipt has gone', async () => {
    const context = harness();
    should(await service(context).advance('nobody')).be.null();
  });

  it('records a transient step failure and retries it on the next pass', async () => {
    const context = harness();
    await beginBoard(context);
    context.board.failures.add('requestInvitation');
    const parked = await service(context).advance(SOURCE_ID);
    should(parked?.phase).equal('replacement_created');
    should(context.receipts.current().phaseHistory.at(-1)?.detail).match(/invite did not complete/u);
    verify(context);
    should((await service(context).advance(SOURCE_ID))?.phase).equal('completed');
  });
});

describe('stranding', () => {
  it('strands on the deadline, raises one item, and leaves the predecessor alone', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    context.clock.advanceMinutes(45);
    const stranded = await service(context).advance(SOURCE_ID);
    should(stranded).match({ phase: 'stranded', refusal: { failure: 'verification_timeout' } });
    should(context.attention.raised).have.length(1);
    should(context.attention.raised[0]).match({
      sessionId: SOURCE_ID,
      sourceRef: `handover:${REQUEST_ID}`,
    });
    should(context.sessions.stopped).be.empty();
    should(context.board.steps()).not.containEql('relinquish');
  });

  it('raises before it settles, so a failed raise is retried rather than lost', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    context.clock.advanceMinutes(45);
    context.attention.failure = 'down';
    const parked = await service(context).advance(SOURCE_ID);
    should(parked?.phase).equal('replacement_started');
    should(context.attention.raised).be.empty();
    const stranded = await service(context).advance(SOURCE_ID);
    should(stranded?.phase).equal('stranded');
    should(context.attention.raised).have.length(1);
  });

  it('does nothing at all once a receipt is terminal', async () => {
    const context = harness();
    context.receipts.plant(
      receiptAt('stranded', { refusal: { failure: 'verification_timeout', message: 'nobody verified' } }),
    );
    should((await service(context).advance(SOURCE_ID))?.phase).equal('stranded');
    should(context.receipts.writes).be.empty();
    should(context.attention.raised).be.empty();
  });

  it('refuses to seat a coordinator that descends from the retiring root', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    context.sessions.failures.add(`start:${COORDINATOR}`);
    await service(context).advance(SOURCE_ID);
    context.sessions.set(sessionView({ sessionId: COORDINATOR, parentSessionId: SOURCE_ID, status: 'running' }));
    const stranded = await service(context).advance(SOURCE_ID);
    should(stranded).match({ phase: 'stranded', refusal: { failure: 'step_failed' } });
    should(stranded?.refusal?.message).match(/relinquishing the predecessor revokes every grant/u);
    should(context.board.steps()).not.containEql('replaceCoordinator');
  });

  it('refuses to seat a coordinator that never came up', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    context.sessions.failures.add(`start:${COORDINATOR}`);
    await service(context).advance(SOURCE_ID);
    context.sessions.set(sessionView({ sessionId: COORDINATOR, parentSessionId: REPLACEMENT, status: 'failed' }));
    should((await service(context).advance(SOURCE_ID))?.phase).equal('stranded');
  });

  it('refuses a seam that answers with a plan id the receipt did not record', async () => {
    const context = harness();
    context.preparer.planId = 'b'.repeat(64);
    const error = await beginBoard(context).catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('plan_drifted');
    should(context.receipts.writes).be.empty();
  });
});

describe('cancellation', () => {
  it('writes the intent before it stops anything, and settles as abandoned', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    context.receipts.plant(
      receiptAt('replacement_created', {
        requestId: REQUEST_ID,
        planId: planIdFor(SOURCE_ID, REQUEST_ID),
        fingerprint: context.receipts.current().fingerprint,
      }),
    );
    const before = context.receipts.writes.length;
    const cancelled = await service(context).cancel(SOURCE_ID, 'cancel-1');
    should(cancelled).match({ phase: 'abandoned', cancelRequestId: 'cancel-1', refusal: { failure: 'cancelled' } });
    // The intent write comes first, on the phase the handover was still at.
    should(context.receipts.writes[before]).match({ phase: 'replacement_created', refusal: { failure: 'cancelled' } });
    should(context.sessions.stopped).match([{ sessionId: REPLACEMENT }]);
  });

  it('settles as refused when only the identity was ever written', async () => {
    const context = harness();
    await beginBoard(context);
    const cancelled = await service(context).cancel(SOURCE_ID, 'cancel-1');
    should(cancelled).match({ phase: 'refused', refusal: { failure: 'cancelled' } });
    should(context.sessions.stopped).be.empty();
  });

  it('resumes as a cancellation, never as forward progress, after a crash on the intent', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    context.receipts.plant(
      receiptAt('replacement_created', {
        requestId: REQUEST_ID,
        planId: planIdFor(SOURCE_ID, REQUEST_ID),
        fingerprint: context.receipts.current().fingerprint,
        cancelRequestId: 'cancel-1',
        refusal: { failure: 'cancelled', message: 'an operator stopped it' },
      }),
    );
    context.board.calls.length = 0;
    const resumed = await service(context).advance(SOURCE_ID);
    should(resumed?.phase).equal('abandoned');
    should(context.board.steps()).be.empty();
    should(context.sessions.stopped).match([{ sessionId: REPLACEMENT }]);
  });

  it('refuses a second cancel id and resumes the first one under its own', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const live = context.receipts.current();
    context.receipts.plant({
      ...live,
      phase: 'replacement_created',
      phaseHistory: [...live.phaseHistory, { phase: 'replacement_created', at: live.updatedAt }],
      cancelRequestId: 'cancel-1',
      refusal: { failure: 'cancelled', message: 'an operator stopped it' },
    });
    const conflict = await service(context)
      .cancel(SOURCE_ID, 'cancel-2')
      .catch((thrown: unknown) => thrown);
    should((conflict as HandoverError).failure).equal('request_conflict');
    should((conflict as HandoverError).message).match(/already being cancelled under request id cancel-1/u);
    // The original id resumes the cleanup it started rather than opening a second one.
    const resumed = await service(context).cancel(SOURCE_ID, 'cancel-1');
    should(resumed).match({ phase: 'abandoned', cancelRequestId: 'cancel-1' });
  });

  it('is idempotent once terminal, and refuses past the point of no return', async () => {
    const context = harness();
    await beginBoard(context);
    const first = await service(context).cancel(SOURCE_ID, 'cancel-1');
    should(await service(context).cancel(SOURCE_ID, 'cancel-2')).deepEqual(first);
    const past = harness();
    past.receipts.plant(receiptAt('accepted'));
    const error = await service(past)
      .cancel(SOURCE_ID, 'cancel-1')
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('cancelled');
    should((error as HandoverError).message).match(/point of no return/u);
  });

  it('refuses once the predecessor has already been stopped', async () => {
    const context = harness(sessionView({ status: 'stopped' }));
    context.receipts.plant(receiptAt('draining', { board: null }));
    const error = await service(context)
      .cancel(SOURCE_ID, 'cancel-1')
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).message).match(/already been stopped/u);
  });

  it('refuses a session with no receipt at all', async () => {
    const context = harness();
    const error = await service(context)
      .cancel(SOURCE_ID, 'cancel-1')
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('source_not_found');
  });
});

describe('reading a receipt', () => {
  it('answers the durable document and refuses absence rather than answering empty', async () => {
    const context = harness();
    const error = await service(context)
      .receipt(SOURCE_ID)
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('source_not_found');
    await beginBoard(context);
    should((await service(context).receipt(SOURCE_ID)).phase).equal('requested');
  });
});

describe('serialization per predecessor', () => {
  it('queues concurrent calls for one session and survives a rejected one', async () => {
    const context = harness();
    await beginBoard(context);
    const shared = service(context);
    const [first, second] = await Promise.all([shared.advance(SOURCE_ID), shared.advance(SOURCE_ID)]);
    should(first?.phase).equal('replacement_started');
    should(second?.phase).equal('replacement_started');
    // One create, not two: the second call read the receipt the first had already written.
    should(context.sessions.created).have.length(1);
    const one = service(context);
    const failing = one.begin('nobody', request(), REQUEST_ID).catch(() => 'rejected');
    const following = one.receipt(SOURCE_ID);
    should(await failing).equal('rejected');
    should((await following).sourceSessionId).equal(SOURCE_ID);
  });

  it('refuses a second handover of a board that already has two active roots', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = membership({
      outstandingInvitation: false,
      activeRootSessionIds: [SOURCE_ID, REPLACEMENT],
    });
    const error = await beginBoard(context).catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('board_busy');
    should(context.sessions.created).be.empty();
    should(context.receipts.writes).be.empty();
  });
});
