import { beforeEach, describe, it } from 'bun:test';
import { ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallContext, StatePort } from '@ferretry/kernel/contract';
import { type SessionHandoverReceipt, SessionHandoverReceiptSchema } from '../../../../../contract/handover.ts';
import should from 'should';
import { FileHandoverReceiptStore } from '../../../../../daemon/adapters/moves/handover/file-handover-receipt-store.ts';
import { HandoverReconcileLoop, RememberedHandoverReceipts } from '../../../../../daemon/lib/moves/handover/index.ts';
import { sessionHandoverRoutes } from '../../../../../daemon/lib/runtime/mounts/session-handover.ts';
import { memoryHandoverState } from '../../../../support/daemon/handover-state.ts';
import {
  CODEX_ACCOUNT,
  planIdFor,
  REQUEST_ID,
  receiptAt,
  transferPlan,
} from '../../../../unit/daemon/moves/handover/support.ts';

/**
 * The handover as the daemon actually mounts it: the real receipt store over the state port, the
 * real route table, and the real reconcile loop.
 *
 * WHAT THIS TIER ADDS over the mount's unit cases. Those prove the route table against a fake
 * subsystem — the statuses, the credential policy, the refusal mapping. This proves the pieces the
 * COMPOSITION ROOT puts together: that a receipt written to a session directory is the one the GET
 * serves back, that the store the route reads and the store the loop rosters are one document, and
 * that arming the loop returns a disarm which actually stops it. Those are the exact edges a unit test
 * with a fake in the middle cannot see, and every one of them was a real defect class in this
 * move — a subsystem constructed and never called, or a loop nothing armed.
 */

const AT = '2026-02-01T00:00:00.000Z';

/**
 * A receipt at `requested`, built from the handover domain's OWN fixture.
 *
 * Not hand-written here: the receipt carries a whole frozen transfer plan whose fields the wire schema
 * cross-checks against the receipt around it, so a second copy maintained beside the composition tests
 * would drift from those refinements the first time the domain that owns them moved.
 */
function receipt(sourceSessionId: string): SessionHandoverReceipt {
  const planId = planIdFor(sourceSessionId, REQUEST_ID);
  const plan = transferPlan(planId);
  return SessionHandoverReceiptSchema.parse(
    receiptAt('requested', {
      sourceSessionId,
      planId,
      plan: { ...plan, source: { ...plan.source, sessionId: sourceSessionId } },
      // A boardless root, which is the shorter ladder and needs no coordinator: `null` is the explicit
      // total record of "this root had no board", never an omission.
      board: null,
      resolvedTarget: { replacement: CODEX_ACCOUNT, coordinator: null },
      phaseHistory: [{ phase: 'requested', at: AT }],
    }),
  );
}

describe('the mounted handover surface', () => {
  let sessions: StatePort;

  beforeEach(() => {
    sessions = memoryHandoverState().state;
  });

  it('should serve back over GET the exact receipt the store holds on disk', async () => {
    // The route, the store and the directory are all the production ones: what this proves is that the
    // document a handover writes is the document a caller reads, byte for byte through the wire schema.
    // Arrange
    const store = new FileHandoverReceiptStore(sessions);
    const written = receipt('source-1');
    await store.write(written);
    const read = sessionHandoverRoutes({
      begin: async () => written,
      receipt: async sessionId => {
        const found = await store.read(sessionId);
        if (found === null) throw new Error('unreachable in this case');
        return found;
      },
      cancel: async () => written,
    }).find(route => route.method === 'GET');

    // Act
    const response = await read?.handle({
      params: new Map([['ferretId', 'source-1']]),
      request: { method: 'GET', path: '/v1/ferrets/source-1/handover', headers: new Headers(), query: new Map() },
      ...ownerStanding(),
    } as unknown as CallContext);

    // Assert
    should(response?.status).equal(200);
    should(SessionHandoverReceiptSchema.parse(JSON.parse(response?.body ?? ''))).deepEqual(written);
  });

  it('should roster exactly the receipts that are not yet terminal, through the store the routes use', async () => {
    // The loop's roster and the route's reader are ONE document. Two handles over one directory would
    // be two answers to "what is still in flight", which is the shape of every supervision bug where a
    // surface reports a handover the reconciler is not driving.
    // Arrange
    const store = new FileHandoverReceiptStore(sessions);
    const pending = receipt('source-1');
    await store.write(pending);
    await store.write({
      ...receipt('source-2'),
      phase: 'completed',
      phaseHistory: [
        { phase: 'requested', at: AT },
        { phase: 'replacement_creating', at: AT },
        { phase: 'replacement_created', at: AT },
        { phase: 'replacement_started', at: AT },
        { phase: 'draining', at: AT },
        { phase: 'predecessor_stopped', at: AT },
        { phase: 'completed', at: AT },
      ],
      replacementSessionId: 'replacement-2',
    });

    // Act
    const advanced: string[] = [];
    const pass = await new HandoverReconcileLoop(
      {
        advance: async sessionId => {
          advanced.push(sessionId);
        },
      },
      new RememberedHandoverReceipts(store),
      { every: () => () => {} },
    ).run();

    // Assert. The completed receipt is not rostered: a terminal handover has nothing left to drive.
    should(advanced).deepEqual(['source-1']);
    should(pass.considered).equal(1);
    should(pass.advanced).equal(1);
    should(pass.failures).be.empty();
  });

  it('should stop driving handovers once the disarm the composition root registered is called', async () => {
    // the host registers this disarm as a release, so a stopped daemon does not leave a timer
    // advancing handovers at closed storage. A disarm that did not actually cancel would leave exactly
    // that, and nothing else in the tree would notice.
    // Arrange
    const store = new FileHandoverReceiptStore(sessions);
    await store.write(receipt('source-1'));
    let tick: (() => void) | undefined;
    let cancelled = false;
    const loop = new HandoverReconcileLoop({ advance: async () => {} }, new RememberedHandoverReceipts(store), {
      every: (_intervalMs, scheduled) => {
        tick = scheduled;
        return () => {
          cancelled = true;
        };
      },
    });

    // Act
    const disarm = loop.arm();
    should(tick).not.be.undefined();
    disarm();

    // Assert
    should(cancelled).be.true();
  });
});
