import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import should from 'should';
import { FileHandoverReceiptStore } from '../../../src/adapters/handover/file-handover-receipt-store.ts';
import { SessionHandoverService } from '../../../src/lib/handover/service.ts';
import { HandoverError } from '../../../src/lib/handover/types.ts';
import type { HandoverPorts, HandoverReceipt, HandoverReceiptStore } from '../../../src/lib/handover/types.ts';
import { harness, observation, REQUEST_ID, request, sessionView, SOURCE_ID } from '../../unit/handover/support.ts';

/**
 * The state machine driven against the REAL receipt store, which parses on the way out.
 *
 * THIS TIER EXISTS BECAUSE THE UNIT FAKES CANNOT FAIL THIS WAY. `FakeReceiptStore` accepts any object,
 * so a write the durable schema would reject looks perfectly healthy in the unit suite — and two live
 * defects hid in exactly that gap: a `source_lost` intent written on a nonterminal phase while a
 * superseded cancellation still held its `cancelRequestId`, and a same-phase error append that dropped
 * the active `effectIntent` the schema requires on the last same-phase event. Both turned a retryable
 * error inside an open window into a permanent one, and both are invisible without a real store.
 *
 * So these tests assert something narrow and load-bearing: every receipt this machine writes while an
 * effect intent is live can be read back.
 */
/** The replacement id the identity fake mints first. */
const REPLACEMENT = 'replacement-1';

let home = '';
let sessions = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-handover-intents-'));
  sessions = join(home, 'state', 'sessions');
  await mkdir(join(sessions, SOURCE_ID), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/**
 * The REAL store, with one write made to fault.
 *
 * Everything else goes through `FileHandoverReceiptStore` untouched, so every receipt that DOES land
 * is parsed on the way out exactly as it would be in the daemon. The fault is aimed by a predicate
 * rather than by a counter, because these tests are about a specific write — the terminal one, after
 * its side effect already happened — and a counter would silently re-aim itself the moment the number
 * of intermediate writes changed.
 */
class FaultingReceiptStore implements HandoverReceiptStore {
  readonly written: HandoverReceipt[] = [];
  faultOn: ((receipt: HandoverReceipt) => boolean) | null = null;

  constructor(private readonly inner: FileHandoverReceiptStore) {}

  async read(sourceSessionId: string): Promise<HandoverReceipt | null> {
    return await this.inner.read(sourceSessionId);
  }

  async write(receipt: HandoverReceipt): Promise<void> {
    if (this.faultOn?.(receipt) === true) {
      this.faultOn = null;
      throw new Error('the daemon died before the terminal receipt landed');
    }
    // Through the real store, so an unreadable intermediate would throw here rather than pass.
    await this.inner.write(receipt);
    this.written.push(receipt);
  }

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    return await this.inner.pendingSourceSessionIds();
  }
}
/** The unit harness, with its in-memory receipt store swapped for the real, validating one. */
function durable(): {
  readonly service: SessionHandoverService;
  readonly store: FileHandoverReceiptStore;
  readonly context: ReturnType<typeof harness>;
} {
  const context = harness();
  const store = new FileHandoverReceiptStore(sessions);
  const ports: HandoverPorts = { ...context.ports, receipts: store };
  return { service: new SessionHandoverService(ports, { verificationDeadlineMinutes: 30 }), store, context };
}

/** The same wiring, with the faulting store in front of the real one. */
function faulting(): {
  readonly service: SessionHandoverService;
  readonly store: FaultingReceiptStore;
  readonly real: FileHandoverReceiptStore;
  readonly context: ReturnType<typeof harness>;
} {
  const context = harness();
  const real = new FileHandoverReceiptStore(sessions);
  const store = new FaultingReceiptStore(real);
  const ports: HandoverPorts = { ...context.ports, receipts: store };
  return { service: new SessionHandoverService(ports, { verificationDeadlineMinutes: 30 }), store, real, context };
}

describe('every receipt written while an effect intent is live', () => {
  it('round-trips through the durable schema when an accept throws after the intent', async () => {
    const { service, store, context } = durable();
    await service.begin(SOURCE_ID, request(), REQUEST_ID);
    // The board commits nothing and throws: the `accepting` intent is already durable by then, and the
    // error append that follows has to carry it forward or the write is unreadable.
    context.board.failures.add('acceptInvitation');
    await service.advance(SOURCE_ID);

    const durableReceipt = await store.read(SOURCE_ID);
    should(durableReceipt).not.be.null();
    should(durableReceipt?.phase).equal('approved');
    should(durableReceipt?.effectIntent).equal('accepting');
    // The schema demands the active intent on the LAST same-phase event, which is what the error
    // append would otherwise have dropped.
    should(durableReceipt?.phaseHistory.at(-1)).match({ phase: 'approved', effectIntent: 'accepting' });
  });

  it('rolls forward to accepted on the retry, clearing the intent but keeping its provenance', async () => {
    const { service, store, context } = durable();
    await service.begin(SOURCE_ID, request(), REQUEST_ID);
    context.board.failures.add('acceptInvitation');
    await service.advance(SOURCE_ID);
    context.boardReader.observationAnswer = observation({
      invitation: {
        requestId: 'invitation-of-replacement-1',
        targetSessionId: 'replacement-1',
        verifiedAt: '2026-02-01T00:01:00.000Z',
        verifiedBySessionId: 'replacement-1',
      },
    });
    const done = await service.advance(SOURCE_ID);
    should(done?.phase).equal('completed');

    const durableReceipt = await store.read(SOURCE_ID);
    should(durableReceipt?.effectIntent).be.undefined();
    // The EVENT survives the active field, which is what justifies any later shortcut off `approved`.
    should(durableReceipt?.phaseHistory.some(entry => entry.effectIntent === 'accepting')).be.true();
  });

  it('round-trips a retiring receipt whose stop threw, and completes on the retry', async () => {
    const { service, store, context } = durable();
    context.boardReader.membershipAnswer = null;
    await service.begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    // Armed BEFORE the pass that reaches the gate: the boardless ladder walks to the retirement in one
    // drive, so the stop has to be failing by then for the intent window to be observable at all.
    context.sessions.failures.add(`stop:${SOURCE_ID}`);
    await service.advance(SOURCE_ID);

    const parked = await store.read(SOURCE_ID);
    should(parked?.phase).equal('draining');
    should(parked?.effectIntent).equal('retiring');
    should(parked?.phaseHistory.at(-1)).match({ phase: 'draining', effectIntent: 'retiring' });

    const asked = context.preflight.subjects.length;
    const done = await service.advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    // The gate was never asked a second time: the retirement was already committed.
    should(context.preflight.subjects).have.length(asked);
    should((await store.read(SOURCE_ID))?.effectIntent).be.undefined();
  });

  it('persists a readable source_lost intent and terminal when it supersedes a cancellation', async () => {
    const { service, store, context } = durable();
    context.boardReader.membershipAnswer = null;
    const begun = await service.begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    // THE RACE, planted through the REAL store so the intermediate document is proved readable too:
    // an operator cancelled, the cleanup had not finished, and the predecessor then died externally.
    await store.write({
      ...begun,
      cancelRequestId: 'cancel-1',
      refusal: { failure: 'cancelled', message: 'an operator stopped it' },
      phaseHistory: [...begun.phaseHistory, { phase: 'requested', at: begun.updatedAt, detail: 'cancelling' }],
    });
    context.sessions.set(sessionView({ status: 'stopped' }));

    const settled = await service.advance(SOURCE_ID);
    // Source loss decides the TERMINAL — a cancellation could not promise a tidy undo of a session
    // that is already gone — but the operator's identity survives it, on the write-ahead intent and
    // on the terminal alike. Both writes went through a store that parses, so both are readable.
    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' }, cancelRequestId: 'cancel-1' });
    should((await store.read(SOURCE_ID))?.cancelRequestId).equal('cancel-1');
  });
  it('refuses a boardless request that names a coordinator BEFORE the store is ever reached', async () => {
    const { service, store, context } = durable();
    context.boardReader.membershipAnswer = null;
    // The receipt schema requires board membership and the coordinator target to agree. Left to the
    // write, this would surface as a Zod parse error out of the store — a stack trace where an
    // actionable refusal belongs — so the eligibility check has to catch it first.
    const error = await service.begin(SOURCE_ID, request(), REQUEST_ID).catch((thrown: unknown) => thrown);
    should(error).be.instanceof(HandoverError);
    should((error as HandoverError).failure).equal('coordinator_required');
    should((error as HandoverError).message).match(/belongs to no board/u);
    // Nothing durable was written, so the same request id may be presented again once corrected.
    should(await store.read(SOURCE_ID)).be.null();
    should(context.sessions.created).be.empty();
  });

  it('keeps every write readable across a whole successful board handover', async () => {
    const { service, store, context } = durable();
    await service.begin(SOURCE_ID, request(), REQUEST_ID);
    await service.advance(SOURCE_ID);
    context.boardReader.observationAnswer = observation({
      invitation: {
        requestId: 'invitation-of-replacement-1',
        targetSessionId: 'replacement-1',
        verifiedAt: '2026-02-01T00:01:00.000Z',
        verifiedBySessionId: 'replacement-1',
      },
    });
    const done = await service.advance(SOURCE_ID);
    should(done?.phase).equal('completed');
    // Reading it back is the assertion: the store parses, so a single unreadable write would have
    // thrown at the moment it was made.
    should((await store.read(SOURCE_ID))?.phase).equal('completed');
    should(context.sessions.stopped).match([{ sessionId: SOURCE_ID }]);
    should(sessionView().sessionId).equal(SOURCE_ID);
  });
});

/**
 * The crash that happens AFTER a side effect and BEFORE the terminal receipt.
 *
 * This is the window the whole write-ahead intent exists for, and the happy-path tests do not enter
 * it: they prove the settlement is reachable, not that it is recoverable. What has to hold on restart
 * is narrow and worth stating — the forward ladder must NOT resume, because the intent on disk says
 * this handover is settling; the side effect may be replayed but must not be undone; and the terminal
 * the second pass reaches must be the same one the first pass was about to write.
 */
describe('a crash between the source-loss side effect and its terminal', () => {
  it('resumes the settlement for a disposable replacement, replaying the stop and raising nobody', async () => {
    const { service, store, real, context } = faulting();
    context.boardReader.membershipAnswer = null;
    await service.begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    // Stop the ladder while the replacement is still disposable, then kill the predecessor.
    context.sessions.failures.add('start:replacement-1');
    await service.advance(SOURCE_ID);
    context.sessions.set(sessionView({ status: 'stopped' }));

    // THE CRASH: the intent lands, the replacement is stopped, the terminal write faults.
    store.faultOn = receipt => receipt.phase === 'failed';
    // The write throws, and the pass rejects with it — which IS the crash. A real daemon sees this as
    // one failed reconcile tick; the reconcile loop records it per session and comes back.
    await service.advance(SOURCE_ID).catch(() => null);

    const mid = await real.read(SOURCE_ID);
    should(mid).not.be.null();
    should(mid?.phase).not.equal('failed');
    should(mid?.refusal).match({ failure: 'source_lost' });
    should(context.sessions.stopped.map(entry => entry.sessionId)).containEql(REPLACEMENT);

    // RESTART. The ladder must not resume — the intent on disk outranks it — and the settlement is
    // reached without anybody being told, because a disposable replacement needs no human.
    const stopped = context.sessions.stopped.length;
    const settled = await service.advance(SOURCE_ID);
    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
    should(context.attention.raised).be.empty();
    should(context.board.steps()).be.empty();
    // A replayed stop is allowed; a second CREATE or launch is not.
    should(context.sessions.stopped.length).be.greaterThanOrEqual(stopped);
    should(context.sessions.created.map(entry => entry.sessionId)).deepEqual([REPLACEMENT]);
    should((await real.read(SOURCE_ID))?.phase).equal('failed');
  });

  it('resumes past acceptance without touching the replacement, refreshing one attention', async () => {
    const { service, store, real, context } = faulting();
    await service.begin(SOURCE_ID, request(), REQUEST_ID);
    await service.advance(SOURCE_ID);
    // Past acceptance the grant may be unrevokeable, so the replacement is left alone and a human is
    // told instead. Then the predecessor dies underneath it.
    context.sessions.set(sessionView({ status: 'stopped' }));

    store.faultOn = receipt => receipt.phase === 'failed';
    // The write throws, and the pass rejects with it — which IS the crash. A real daemon sees this as
    // one failed reconcile tick; the reconcile loop records it per session and comes back.
    await service.advance(SOURCE_ID).catch(() => null);

    const mid = await real.read(SOURCE_ID);
    should(mid?.phase).not.equal('failed');
    should(mid?.refusal).match({ failure: 'source_lost' });
    should(context.attention.raised).have.length(1);
    should(context.sessions.stopped).be.empty();

    // RESTART: the replacement survives, and the retry raises under the SAME source reference, which
    // is what makes the ledger refresh one item instead of growing a second row about one operation.
    const settled = await service.advance(SOURCE_ID);
    should(settled).match({ phase: 'failed', refusal: { failure: 'source_lost' } });
    should(context.sessions.stopped).be.empty();
    should(new Set(context.attention.raised.map(item => item.sourceRef)).size).equal(1);
    should(context.attention.raised[0]?.sourceRef).equal(`handover:${REQUEST_ID}`);
    should((await real.read(SOURCE_ID))?.phase).equal('failed');
  });

  it('leaves every receipt it did write readable, including the intermediate ones', async () => {
    const { service, store, real, context } = faulting();
    context.boardReader.membershipAnswer = null;
    await service.begin(SOURCE_ID, request({ coordinator: null }), REQUEST_ID);
    context.sessions.failures.add('start:replacement-1');
    await service.advance(SOURCE_ID);
    context.sessions.set(sessionView({ status: 'stopped' }));
    store.faultOn = receipt => receipt.phase === 'failed';
    // The write throws, and the pass rejects with it — which IS the crash. A real daemon sees this as
    // one failed reconcile tick; the reconcile loop records it per session and comes back.
    await service.advance(SOURCE_ID).catch(() => null);
    await service.advance(SOURCE_ID);
    // Every write went through the parsing store, so reaching here at all is the assertion; this
    // states it out loud rather than leaving it implicit in the absence of a throw.
    should(store.written.length).be.greaterThan(2);
    should((await real.read(SOURCE_ID))?.phase).equal('failed');
  });
});
