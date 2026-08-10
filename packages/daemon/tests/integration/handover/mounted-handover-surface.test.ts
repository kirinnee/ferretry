import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionHandoverReceipt, SessionHandoverReceiptSchema } from '@ferretry/protocol';
import should from 'should';
import { FileHandoverReceiptStore } from '../../../src/adapters/handover/file-handover-receipt-store.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { HandoverReconcileLoop } from '../../../src/lib/handover/index.ts';
import { sessionHandoverRoutes } from '../../../src/lib/runtime/mounts/session-handover.ts';
import { request } from '../../unit/api/support.ts';
import { CODEX_ACCOUNT, planIdFor, REQUEST_ID, receiptAt, transferPlan } from '../../unit/handover/support.ts';

/**
 * The handover as the daemon actually mounts it: the real receipt store over a real directory, the
 * real route table, the real dispatcher, and the real reconcile loop.
 *
 * WHAT THIS TIER ADDS over the mount's unit cases. Those prove the route table against a fake
 * subsystem — the statuses, the credential policy, the refusal mapping. This proves the pieces the
 * COMPOSITION ROOT puts together: that a receipt written to a session directory is the one the GET
 * serves back, that the store the route reads and the store the loop rosters are one document, and
 * that arming the loop returns a disarm which actually stops it. Those are the exact edges a unit test
 * with a fake in the middle cannot see, and every one of them was a real defect class in this
 * migration — a subsystem constructed and never called, or a loop nothing armed.
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
  let home: string;
  let sessions: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fy-handover-'));
    sessions = join(home, 'sessions');
    // The store writes INTO a session's own directory and does not create one, exactly as the daemon
    // layout has it: a receipt only ever exists for a session that already does.
    await mkdir(join(sessions, 'source-1'), { recursive: true });
    await mkdir(join(sessions, 'source-2'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('should serve back over GET the exact receipt the store holds on disk', async () => {
    // The route, the store and the directory are all the production ones: what this proves is that the
    // document a handover writes is the document a caller reads, byte for byte through the wire schema.
    // Arrange
    const store = new FileHandoverReceiptStore(sessions);
    const written = receipt('source-1');
    await store.write(written);
    const dispatcher = new ApiDispatcher(
      new ApiRouter(
        sessionHandoverRoutes({
          begin: async () => written,
          receipt: async sessionId => {
            const found = await store.read(sessionId);
            if (found === null) throw new Error('unreachable in this case');
            return found;
          },
          cancel: async () => written,
        }),
      ),
      { admin: 'admin-secret', warden: 'warden-secret' },
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const response = await dispatcher.dispatch(
      request({
        method: 'GET',
        path: '/v1/sessions/source-1/handover',
        headers: { authorization: 'Bearer admin-secret' },
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(SessionHandoverReceiptSchema.parse(JSON.parse(response.body))).deepEqual(written);
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
      store,
      { every: () => () => {} },
    ).run();

    // Assert. The completed receipt is not rostered: a terminal handover has nothing left to drive.
    should(advanced).deepEqual(['source-1']);
    should(pass.considered).equal(1);
    should(pass.advanced).equal(1);
    should(pass.failures).be.empty();
  });

  it('should stop driving handovers once the disarm the composition root registered is called', async () => {
    // `bin/fyd.ts` pushes this disarm onto its cleanup list, so a stopped daemon does not leave a timer
    // advancing handovers at closed storage. A disarm that did not actually cancel would leave exactly
    // that, and nothing else in the tree would notice.
    // Arrange
    const store = new FileHandoverReceiptStore(sessions);
    await store.write(receipt('source-1'));
    let tick: (() => void) | undefined;
    let cancelled = false;
    const loop = new HandoverReconcileLoop({ advance: async () => {} }, store, {
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
