import { describe, it } from 'bun:test';
import should from 'should';
import { SessionHandoverService } from '../../../src/lib/handover/service.ts';
import { HandoverError, type HandoverReceipt } from '../../../src/lib/handover/types.ts';
import {
  CODEX_ACCOUNT,
  type HandoverHarness,
  harness,
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

/** A begun board handover, so the planted receipt below carries its real fingerprint. */
async function begun(): Promise<{ readonly context: HandoverHarness; readonly live: HandoverReceipt }> {
  const context = harness();
  await service(context).begin(SOURCE_ID, request(), REQUEST_ID);
  return { context, live: context.receipts.current() };
}

/** A receipt of the begun handover moved to `phase`, as a crash would have left it. */
function plantAt(
  context: HandoverHarness,
  live: HandoverReceipt,
  phase: HandoverReceipt['phase'],
  overrides: Partial<HandoverReceipt> = {},
): void {
  context.receipts.plant(
    receiptAt(phase, {
      requestId: REQUEST_ID,
      planId: planIdFor(SOURCE_ID, REQUEST_ID),
      fingerprint: live.fingerprint,
      ...overrides,
    }),
  );
}

describe('a handover receipt that contradicts its own schema', () => {
  it('records failed, naming step_failed, when the predecessor is stopped and no replacement was ever named', async () => {
    // Arrange
    const { context, live } = await begun();
    plantAt(context, live, 'predecessor_stopped', { replacementSessionId: undefined });
    context.sessions.set(sessionView({ status: 'stopped' }));

    // Act
    const settled = await service(context).advance(SOURCE_ID);

    // Assert — failed, not completed against a session that does not exist
    should(settled).match({ phase: 'failed', refusal: { failure: 'step_failed' } });
    should(context.journal.appends).be.empty();
  });

  it('refuses a start of the replacement when the receipt names no replacement identity', async () => {
    // Arrange
    const { context, live } = await begun();
    plantAt(context, live, 'accepted', { replacementSessionId: undefined });

    // Act
    const settled = await service(context).advance(SOURCE_ID);

    // Assert
    should(settled?.refusal?.failure).equal('step_failed');
    should(settled?.refusal?.message).match(/without a replacement identity/u);
    should(context.sessions.started).be.empty();
  });

  it('refuses to create the coordinator when the receipt names no coordinator identity', async () => {
    // Arrange
    const { context, live } = await begun();
    plantAt(context, live, 'coordinator_creating', { coordinatorSessionId: undefined });

    // Act
    const settled = await service(context).advance(SOURCE_ID);

    // Assert
    should(settled?.refusal?.failure).equal('step_failed');
    should(settled?.refusal?.message).match(/without a coordinator identity/u);
    should(context.sessions.created).be.empty();
  });

  it('refuses a board step when a boardless receipt reaches one', async () => {
    // Arrange
    const { context, live } = await begun();
    plantAt(context, live, 'approved', { board: null });

    // Act
    const settled = await service(context).advance(SOURCE_ID);

    // Assert
    should(settled?.refusal?.failure).equal('board_moved');
    should(settled?.refusal?.message).match(/no board recorded/u);
    should(context.board.steps()).be.empty();
  });

  it('refuses to approve an invitation the receipt never recorded', async () => {
    // Arrange
    const { context, live } = await begun();
    plantAt(context, live, 'invited');

    // Act
    const settled = await service(context).advance(SOURCE_ID);

    // Assert
    should(settled?.refusal?.failure).equal('step_failed');
    should(settled?.refusal?.message).match(/without the invitation it recorded at invite/u);
    should(context.board.steps()).be.empty();
  });

  it('refuses to seat a coordinator when the receipt resolved no coordinator account', async () => {
    // Arrange
    const { context, live } = await begun();
    plantAt(context, live, 'coordinator_creating', {
      coordinatorSessionId: COORDINATOR,
      resolvedTarget: { replacement: CODEX_ACCOUNT, coordinator: null },
    });

    // Act
    const settled = await service(context).advance(SOURCE_ID);

    // Assert
    should(settled?.refusal?.failure).equal('coordinator_required');
    should(settled?.refusal?.message).match(/no coordinator account recorded for board board-1/u);
    should(context.sessions.created).be.empty();
  });
});

describe('the retirement tail after the predecessor stopped', () => {
  async function stoppedMidRetirement(roots: readonly string[]) {
    const { context, live } = await begun();
    context.receipts.plant({
      ...live,
      phase: 'draining',
      phaseHistory: [...live.phaseHistory, { phase: 'draining', at: '2026-02-01T00:01:00.000Z' }],
      effectIntent: 'retiring',
      replacementSessionId: REPLACEMENT,
      coordinatorSessionId: COORDINATOR,
    });
    context.sessions.set(sessionView({ status: 'stopped' }));
    context.boardReader.observationAnswer = observation({ activeRootSessionIds: roots });
    return context;
  }

  it('relinquishes under a derived id when the stopped predecessor is still an active root', async () => {
    // Arrange
    const context = await stoppedMidRetirement([SOURCE_ID]);

    // Act
    const done = await service(context).advance(SOURCE_ID);

    // Assert
    should(done?.phase).equal('completed');
    should(context.board.calls.filter(call => call.step === 'relinquish')).have.length(1);
    should(context.board.calls.find(call => call.step === 'relinquish')?.requestId).match(/^[0-9a-f]{64}$/u);
    should(done?.phaseHistory.map(entry => entry.phase)).containEql('relinquished');
  });

  it('records a named board error inside the tail and parks, leaving the intent to replay', async () => {
    // Arrange
    const context = await stoppedMidRetirement([SOURCE_ID]);
    context.board.relinquish = async () => {
      throw new HandoverError('board_moved', 'the board refused the relinquish');
    };

    // Act
    const parked = await service(context).advance(SOURCE_ID);

    // Assert — nothing terminal: the tail is replayed, not settled
    should(parked).match({ phase: 'draining', effectIntent: 'retiring' });
    should(parked?.phaseHistory.at(-1)?.detail).equal('board_moved: the board refused the relinquish');
    should(parked?.refusal).be.undefined();
  });
});

describe('abandoning a handover whose predecessor dies mid-abandon', () => {
  it('settles as failed under source_lost, never as a tidy abandon, and stops nothing', async () => {
    // Arrange — a durable settlement intent, so the pass goes straight to the abandon
    const { context, live } = await begun();
    plantAt(context, live, 'replacement_created', {
      refusal: { failure: 'cancelled', message: 'an operator cancelled the handover' },
    });
    // The predecessor is alive when the pass opens and gone by the re-observation that follows the intent.
    const read = context.sessions.read.bind(context.sessions);
    let sourceReads = 0;
    context.sessions.read = async sessionId => {
      if (sessionId !== SOURCE_ID) return await read(sessionId);
      sourceReads += 1;
      return sourceReads === 1 ? await read(sessionId) : sessionView({ status: 'stopped' });
    };

    // Act
    const settled = await service(context).advance(SOURCE_ID);

    // Assert
    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
    should(settled?.refusal?.message).match(/stopped outside this handover while it was being abandoned/u);
    should(context.sessions.stopped).be.empty();
  });
});
