import { describe, it } from 'bun:test';
import should from 'should';
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
      // The second `approved` write is the durable `accepting` intent, recorded before the board call.
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
    context.receipts.plant({ ...retiring, effectIntent: 'retiring' });
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

  it('reconciles a boardless stop that crashed before its phase write, without asking the gate again', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    await service(context).advance(SOURCE_ID);
    const done = context.receipts.current();
    should(done.phase).equal('completed');
    should(context.sessions.stopped).match([{ sessionId: SOURCE_ID }]);

    // THE CRASH STATE: the stop landed, the phase write that followed it did not. The receipt is back
    // at draining, carrying the marker the cleared gate wrote, and the source is already terminal.
    const drained = done.phaseHistory.findIndex(entry => entry.phase === 'draining' && entry.detail !== undefined);
    should(drained).be.greaterThanOrEqual(0);
    context.receipts.plant({
      ...done,
      phase: 'draining',
      phaseHistory: done.phaseHistory.slice(0, drained + 1),
      effectIntent: 'retiring',
      refusal: undefined,
    });

    // A REAL gate cannot answer for a pane that is gone, so the fake refuses to be asked at all. If
    // the reconciliation consulted it, this test would throw rather than complete.
    context.preflight.failure = 'the pane is gone: there is nothing to inspect';
    const asked = context.preflight.subjects.length;
    const stopped = context.sessions.stopped.length;
    const resumed = await service(context).advance(SOURCE_ID);
    should(resumed?.phase).equal('completed');
    should(context.preflight.subjects).have.length(asked);
    // And it did not issue a second stop for a session it can see has already stopped.
    should(context.sessions.stopped).have.length(stopped);
  });

  it('reconciles a board retirement whose source is already gone, OBSERVING the committed relinquish', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    verify(context);
    const live = context.receipts.current();
    context.receipts.plant({
      ...live,
      phase: 'draining',
      phaseHistory: [...live.phaseHistory, { phase: 'draining', at: '2026-02-01T00:01:00.000Z' }],
      effectIntent: 'retiring',
      replacementSessionId: REPLACEMENT,
      coordinatorSessionId: COORDINATOR,
    });
    context.sessions.set(sessionView({ status: 'stopped' }));
    context.boardReader.observationAnswer = observation({ activeRootSessionIds: [REPLACEMENT] });
    context.preflight.failure = 'the pane is gone: there is nothing to inspect';
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    // NOT replayed. `membership.relinquish` authorizes before it consults its applied-operation ledger,
    // and its commit revokes the binding that authorization reads — so a second call after a successful
    // one cannot authenticate at all. The board roster is the durable evidence instead: the source is no
    // longer an active root, so the relinquish had already committed.
    should(context.board.steps()).not.containEql('relinquish');
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

  it('abandons a replacement the pass created after its own snapshot, instead of writing refused', async () => {
    const context = harness();
    await beginBoard(context);
    // THE WINDOW: the pass begins at replacement_creating, where the world honestly holds no
    // replacement. The create then succeeds, and only after that does a NAMED failure settle the
    // handover. Deciding from the opening snapshot would record "nothing was ever created" and leave
    // the session that was just created running with nothing left to stop it.
    context.importer.named = 'plan_drifted';
    const settled = await service(context).advance(SOURCE_ID);
    should(settled).match({ phase: 'abandoned', refusal: { failure: 'plan_drifted' } });
    should(context.sessions.created.map(entry => entry.sessionId)).deepEqual([REPLACEMENT]);
    should(context.sessions.stopped).match([{ sessionId: REPLACEMENT }]);
  });

  it('replays the stop inside the retirement tail rather than terminalising it', async () => {
    const context = harness();
    await beginBoard(context);
    const live = context.receipts.current();
    context.receipts.plant({
      ...live,
      phase: 'relinquished',
      phaseHistory: [...live.phaseHistory, { phase: 'relinquished', at: live.updatedAt }],
      replacementSessionId: REPLACEMENT,
      coordinatorSessionId: COORDINATOR,
    });
    // A named error at `relinquished` has no legal terminal edge: `relinquished -> stranded` is not a
    // legal walk, and the membership is already gone. It records and replays.
    context.sessions.failures.add(`stop:${SOURCE_ID}`);
    const parked = await service(context).advance(SOURCE_ID);
    should(parked?.phase).equal('relinquished');
    should(context.attention.raised).be.empty();
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
  });

  it('replays a boardless retirement whose stop failed, without terminalising or re-gating it', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    await service(context).advance(SOURCE_ID);
    const live = context.receipts.current();

    // THE STATE: the gate cleared, `retiring` is durable, and the predecessor is still alive because
    // the stop that follows has not landed yet.
    context.receipts.plant({
      ...live,
      phase: 'draining',
      phaseHistory: [...live.phaseHistory, { phase: 'draining', at: live.updatedAt }],
      replacementSessionId: REPLACEMENT,
      effectIntent: 'retiring',
      refusal: undefined,
    });
    context.sessions.set(sessionView({ status: 'running' }));
    context.preflight.failure = 'the gate must not be asked a second time';
    const asked = context.preflight.subjects.length;
    context.sessions.failures.add(`stop:${SOURCE_ID}`);

    const parked = await service(context).advance(SOURCE_ID);
    // Not `failed`, and the intent that proves the retirement began is still there.
    should(parked?.phase).equal('draining');
    should(parked?.effectIntent).equal('retiring');
    should(parked?.refusal).be.undefined();
    should(context.preflight.subjects).have.length(asked);

    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    should(context.sessions.stopped).match([{ sessionId: SOURCE_ID }]);
    should(context.preflight.subjects).have.length(asked);
  });

  it('does not launder a predecessor that died while the gate was being read', async () => {
    // Stamping `retiring` makes a terminal source EXEMPT from source loss — it becomes the expected
    // proof of this handover's OWN committed stop. A death during the preflight predates that, so
    // claiming it would let the boardless path record a completion for a stop it never performed.
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    context.preflight.afterEvaluate = () => {
      context.sessions.set(sessionView({ status: 'stopped' }));
    };
    const settled = await service(context).advance(SOURCE_ID);

    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
    should(settled?.refusal?.message).match(/while the gate was being read/u);
    // No retirement was ever claimed, and nothing was stopped or relinquished on its behalf.
    should(settled?.effectIntent).be.undefined();
    should(settled?.phaseHistory.some(entry => entry.effectIntent === 'retiring')).be.false();
    should(context.sessions.stopped.filter(entry => entry.sessionId === SOURCE_ID)).have.length(0);
    should(context.board.steps()).not.containEql('relinquish');
  });

  it('records the stop it can SEE rather than issuing one against a session that is gone', async () => {
    // By `relinquished` the membership is already given up, so a crash before the phase write leaves
    // the retry here against a predecessor that may be stopped — or gone from the registry. A stop is
    // idempotent against a stopped RECORD but not against a missing one: the lifecycle needs a record
    // to stop, so an unconditional call would throw every pass and park the handover one write short
    // of finishing, with the membership already relinquished and nothing left to recover it.
    for (const gone of ['terminal', 'absent'] as const) {
      const context = harness();
      await beginBoard(context);
      const live = context.receipts.current();
      context.receipts.plant({
        ...live,
        phase: 'relinquished',
        phaseHistory: [...live.phaseHistory, { phase: 'relinquished', at: live.updatedAt }],
        replacementSessionId: REPLACEMENT,
        coordinatorSessionId: COORDINATOR,
      });
      if (gone === 'absent') context.sessions.forget(SOURCE_ID);
      else context.sessions.set(sessionView({ status: 'stopped' }));

      const done = await service(context).advance(SOURCE_ID);
      should(done?.phase).equal('completed', gone);
      // No stop was issued for the predecessor: the observation IS the proof it already happened.
      should(context.sessions.stopped.filter(entry => entry.sessionId === SOURCE_ID)).have.length(0, gone);
      // And the completion still journals both sides, so the handover finishes rather than parking.
      should(context.journal.appends.map(entry => entry.sessionId)).deepEqual([SOURCE_ID, REPLACEMENT], gone);
    }
  });

  it('still stops a predecessor that is genuinely live at the retirement', async () => {
    const context = harness();
    await beginBoard(context);
    const live = context.receipts.current();
    context.receipts.plant({
      ...live,
      phase: 'relinquished',
      phaseHistory: [...live.phaseHistory, { phase: 'relinquished', at: live.updatedAt }],
      replacementSessionId: REPLACEMENT,
      coordinatorSessionId: COORDINATOR,
    });
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    should(context.sessions.stopped).match([{ sessionId: SOURCE_ID }]);
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

  it('does not strand a predecessor that died between the intent and the raise', async () => {
    // EVERY WORD OF A STRANDING IS A CLAIM ABOUT A LIVE PREDECESSOR: still running, still a member,
    // yours to decide about. If the source dies in that window the message is false in every clause —
    // and `stranded` is terminal, so once written no later pass can let source loss outrank it.
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    context.clock.advanceMinutes(45);
    // The deadline has passed, so this pass is on its way to stranding. The source dies as the intent
    // is written, which is the hook: the raise is what runs next.
    context.receipts.afterWrite = written => {
      if (written.refusal?.failure === 'verification_timeout') {
        context.sessions.set(sessionView({ status: 'stopped' }));
      }
    };
    const settled = await service(context).advance(SOURCE_ID);

    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
    const raised = context.attention.raised.at(-1);
    should(raised?.howToResolve).match(/stopped outside this handover/u);
    should(raised?.howToResolve).not.match(/still running and still a member/u);
    should(raised?.subject).not.match(/is stranded/u);
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

  it('classifies a dead predecessor rather than refusing the cancel that raced it', async () => {
    // SOURCE LOSS OUTRANKS CANCELLATION EVERYWHERE, and this was the one door where it did not.
    // Throwing here answered the caller a 409 about a handover whose subject had already gone, and
    // left nothing durable saying so until some later reconcile tick noticed. C1 now drives instead.
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    context.sessions.failures.add('start:replacement-1');
    await service(context).advance(SOURCE_ID);
    context.sessions.set(sessionView({ status: 'stopped' }));

    const answered = await service(context).cancel(SOURCE_ID, 'cancel-1');
    should(answered).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
    // NOT a cancellation: none of this was one, so no cancellation identity is invented for it.
    should(answered.cancelRequestId).be.undefined();
    should(answered.refusal?.failure).not.equal('cancelled');
  });

  it('answers the same way for a predecessor whose record has gone entirely', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    context.sessions.failures.add('start:replacement-1');
    await service(context).advance(SOURCE_ID);
    context.sessions.forget(SOURCE_ID);
    const answered = await service(context).cancel(SOURCE_ID, 'cancel-1');
    should(answered).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
  });
  it('lets source loss supersede a cancellation without erasing who asked for it', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const live = context.receipts.current();
    // C1 writes its cancellation intent at a phase where the replacement is still disposable.
    context.receipts.plant({
      ...live,
      phase: 'replacement_created',
      phaseHistory: [...live.phaseHistory, { phase: 'replacement_created', at: live.updatedAt }],
      replacementSessionId: REPLACEMENT,
      cancelRequestId: 'cancel-1',
      refusal: { failure: 'cancelled', message: 'an operator stopped it' },
      effectIntent: undefined,
    });
    // Then the predecessor dies externally, before the cleanup ran.
    context.sessions.set(sessionView({ status: 'stopped' }));

    const settled = await service(context).advance(SOURCE_ID);
    // Source loss decides the terminal — `abandoned` would promise a tidy undo of a session that is
    // already gone — but the operator's identity survives it.
    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' }, cancelRequestId: 'cancel-1' });
    // The replacement was still disposable, so it was cleaned up rather than left running.
    should(context.sessions.stopped.map(entry => entry.sessionId)).containEql(REPLACEMENT);
  });

  it('keeps C1 authoritative after the supersession, and still conflicts C2', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const live = context.receipts.current();
    context.receipts.plant({
      ...live,
      phase: 'replacement_created',
      phaseHistory: [...live.phaseHistory, { phase: 'replacement_created', at: live.updatedAt }],
      replacementSessionId: REPLACEMENT,
      cancelRequestId: 'cancel-1',
      refusal: { failure: 'cancelled', message: 'an operator stopped it' },
      effectIntent: undefined,
    });
    const error = await service(context)
      .cancel(SOURCE_ID, 'cancel-2')
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('request_conflict');
    should(context.receipts.current().cancelRequestId).equal('cancel-1');
  });

  it('tells a human the truth when the source dies after acceptance, not the stranding sentence', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    // Past acceptance the replacement is unrevokeable, so it is NOT stopped; and the predecessor is
    // gone, so the stranding wording — "still running and still a member" — would be false.
    context.sessions.set(sessionView({ status: 'stopped' }));
    const settled = await service(context).advance(SOURCE_ID);
    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
    should(context.attention.raised).have.length(1);
    const raised = context.attention.raised[0];
    should(raised?.sourceRef).equal(`handover:${REQUEST_ID}`);
    should(raised?.howToResolve).match(/stopped outside this handover/u);
    should(raised?.howToResolve).not.match(/still running and still a member/u);
    should(context.sessions.stopped).be.empty();
  });

  it('replays rather than unwinding when a named error lands inside the accepting window', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const live = context.receipts.current();
    context.receipts.plant({
      ...live,
      phase: 'approved',
      phaseHistory: [...live.phaseHistory, { phase: 'approved', at: live.updatedAt, effectIntent: 'accepting' }],
      replacementSessionId: REPLACEMENT,
      effectIntent: 'accepting',
      board: {
        boardId: BOARD_ID,
        creatorSessionId: SOURCE_ID,
        canonicalSessionId: SOURCE_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        invitationRequestId: `invitation-of-${REPLACEMENT}`,
      },
    });
    // A NAMED error inside the window must not settle: the board may already hold the grant, so
    // unwinding would abandon a replacement it has admitted, and clearing the intent on its own
    // phase is a write the durable schema refuses outright.
    context.importer.named = 'plan_drifted';
    context.board.failures.add('acceptInvitation');
    const parked = await service(context).advance(SOURCE_ID);
    should(parked?.phase).equal('approved');
    should(parked?.effectIntent).equal('accepting');
    should(parked?.refusal).be.undefined();
    should(context.sessions.stopped).be.empty();
  });

  it('keeps C1 authoritative after source loss supersedes the cancellation mid-flight', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    const live = context.receipts.current();
    // THE CRASH STATE: the source_lost intent landed, the terminal write did not, and the refusal now
    // reads source_lost while cancelRequestId still names C1.
    context.receipts.plant({
      ...live,
      cancelRequestId: 'cancel-1',
      refusal: { failure: 'source_lost', message: 'the predecessor stopped outside this handover' },
    });
    context.sessions.set(sessionView({ status: 'stopped' }));
    // C2 must still conflict, and must not overwrite the recorded identity.
    const conflict = await service(context)
      .cancel(SOURCE_ID, 'cancel-2')
      .catch((thrown: unknown) => thrown);
    should((conflict as HandoverError).failure).equal('request_conflict');
    should(context.receipts.current().cancelRequestId).equal('cancel-1');
    // C1 resumes the settlement it started rather than being refused for a stopped source.
    const resumed = await service(context).cancel(SOURCE_ID, 'cancel-1');
    should(resumed).match({ phase: 'failed', refusal: { failure: 'source_lost' }, cancelRequestId: 'cancel-1' });
  });

  it('refuses a session with no receipt at all', async () => {
    const context = harness();
    const error = await service(context)
      .cancel(SOURCE_ID, 'cancel-1')
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('source_not_found');
  });
});

describe('the acceptance window', () => {
  /** The receipt as it stands the instant before `board.acceptInvitation` is called. */
  const accepting = (context: HandoverHarness, live: HandoverReceipt): void => {
    context.receipts.plant({
      ...live,
      phase: 'approved',
      phaseHistory: [...live.phaseHistory, { phase: 'approved', at: live.updatedAt }],
      replacementSessionId: REPLACEMENT,
      board: {
        boardId: BOARD_ID,
        creatorSessionId: SOURCE_ID,
        canonicalSessionId: SOURCE_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        invitationRequestId: `invitation-of-${REPLACEMENT}`,
      },
      effectIntent: 'accepting',
    });
  };

  it('writes the intent before the board call, so the window is durable from its first instant', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const before = context.receipts.writes.findIndex(receipt => receipt.effectIntent === 'accepting');
    const accepted = context.receipts.writes.findIndex(receipt => receipt.phase === 'accepted');
    should(before).be.greaterThanOrEqual(0);
    should(before).be.lessThan(accepted);
    // And the transition it authorized clears it, because the schema refuses to hold it elsewhere.
    should(context.receipts.writes[accepted]?.effectIntent).be.undefined();
    should(context.receipts.writes[accepted]?.board?.grantId).equal(`grant-of-${REPLACEMENT}`);
  });

  it('refuses a cancel while accepting, and does not stop the replacement', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    accepting(context, context.receipts.current());
    const error = await service(context)
      .cancel(SOURCE_ID, 'cancel-1')
      .catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('cancelled');
    should((error as HandoverError).message).match(/mid-accepting/u);
    should(context.sessions.stopped).be.empty();
    should(context.receipts.current().phase).equal('approved');
  });

  it('rolls forward by replaying accept when the board committed but the receipt write did not', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const commits = context.board.calls.filter(call => call.step === 'acceptInvitation');
    accepting(context, context.receipts.current());
    verify(context);
    const done = await service(context).advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    // Replayed under the SAME derived id, which is what makes it a replay rather than a second accept.
    const replayed = context.board.calls.filter(call => call.step === 'acceptInvitation');
    should(replayed).have.length(commits.length + 1);
    should(replayed[0]?.requestId).equal(replayed[1]?.requestId);
  });
});

describe('an abandoned board handover, and the invitation it cannot withdraw', () => {
  const abandoned = async (context: HandoverHarness): Promise<HandoverReceipt> => {
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    const live = context.receipts.current();
    context.receipts.plant({
      ...live,
      phase: 'replacement_created',
      phaseHistory: [...live.phaseHistory, { phase: 'replacement_created', at: live.updatedAt }],
    });
    return await service(context).cancel(SOURCE_ID, 'cancel-1');
  };

  it('refuses the same request id while the unwithdrawn invitation is still live', async () => {
    const context = harness();
    const settled = await abandoned(context);
    should(settled.phase).equal('abandoned');
    // Nothing in this daemon revokes an invitation, so it is left to expire — and while it is there the
    // reducer would refuse a second one anyway. Refusing here is what stops a doomed retry minting an
    // identity and creating a session first.
    context.boardReader.membershipAnswer = membership({ outstandingInvitation: true });
    const created = context.sessions.created.length;
    const error = await beginBoard(context).catch((thrown: unknown) => thrown);
    should((error as HandoverError).failure).equal('board_busy');
    should(context.receipts.current()).deepEqual(settled);
    should(context.sessions.created).have.length(created);
  });

  it('restarts on the same request id once the invitation has expired, reusing the frozen decision', async () => {
    const context = harness();
    const settled = await abandoned(context);
    context.boardReader.membershipAnswer = membership({ outstandingInvitation: false });
    context.accounts.failure = 'the fleet manifest changed underneath us';
    const restarted = await beginBoard(context);
    should(restarted.phase).equal('requested');
    should(restarted.resolvedTarget).deepEqual(settled.resolvedTarget);
    should(restarted.plan).deepEqual(settled.plan);
    should(context.preparer.calls).have.length(1);
    // A fresh replacement identity: the abandoned one was stopped and must not be revived.
    should(restarted.replacementSessionId).be.undefined();
  });
});

describe('what a pass answers with when it stops without advancing', () => {
  /**
   * `null` from a step means 'no further progress', NOT 'nothing was written'. Several of those
   * paths write first and stop second, so answering with the receipt the pass STARTED with hands a
   * caller a document that disagrees with the one on disk. Both the route and `advance` promise the
   * current durable receipt.
   */
  it('answers the durable receipt after a source_lost intent whose Attention could not be raised', async () => {
    const context = harness();
    await beginBoard(context);
    await service(context).advance(SOURCE_ID);
    // Past acceptance, so the loss raises rather than cleans up — and the ledger is down.
    context.sessions.set(sessionView({ status: 'stopped' }));
    context.attention.failure = 'the attention ledger is unreachable';

    const answered = await service(context).advance(SOURCE_ID);
    // The intent DID land, so the answer must carry it rather than the pre-write copy.
    should(answered?.refusal).match({ failure: 'source_lost' });
    should(answered).deepEqual(context.receipts.current());
  });

  it('answers the durable receipt when a cancel races the same failure', async () => {
    const context = harness();
    context.boardReader.membershipAnswer = null;
    await service(context).begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    context.sessions.failures.add('start:replacement-1');
    await service(context).advance(SOURCE_ID);
    context.sessions.set(sessionView({ status: 'stopped' }));

    const answered = await service(context).cancel(SOURCE_ID, 'cancel-1');
    // Never the stale `cancelled` view of a handover whose durable refusal is already `source_lost`.
    should(answered.refusal).match({ failure: 'source_lost' });
    should(answered).deepEqual(context.receipts.current());
  });

  it('answers the durable receipt after a gate refusal records a changed reason', async () => {
    const context = harness();
    await beginBoard(context);
    context.preflight.verdict = { proceed: false, reason: 'a destructive tool call is open', reportPath: null };
    await service(context).advance(SOURCE_ID);
    verify(context);
    const parked = await service(context).advance(SOURCE_ID);
    should(parked?.phase).equal('draining');
    should(parked).deepEqual(context.receipts.current());
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
