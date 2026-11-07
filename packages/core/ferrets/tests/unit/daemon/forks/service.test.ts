import { describe, expect, it } from 'bun:test';
import type { SessionTransferPlan, SessionView } from '@ferretry/protocol';
import { SessionForkRequestConflictError } from '../../../src/lib/fork/failures.ts';
import { type SessionForkKey, sessionForkFingerprint, sessionForkKey } from '../../../src/lib/fork/identity.ts';
import {
  advanceSessionForkReceipt,
  claimSessionForkReceipt,
  parseSessionForkReceipt,
  SESSION_FORK_PHASES,
  type SessionForkImportReport,
  type SessionForkPhase,
  type SessionForkReceipt,
  sessionForkPhaseRank,
} from '../../../src/lib/fork/receipt.ts';
import { SessionForkService } from '../../../src/lib/fork/service.ts';
import {
  type ForbiddenForkCapability,
  SESSION_FORK_PORTS,
  SESSION_FORK_TARGET_PORTS,
  type SessionForkBoundTarget,
  type SessionForkCapabilityLeak,
  type SessionForkClock,
  type SessionForkIdFactory,
  type SessionForkPorts,
  type SessionForkPreparer,
  type SessionForkReceiptStore,
  type SessionForkSerial,
  type SessionForkTargetBinder,
  type SessionForkTargetImporter,
  type SessionForkTargetLifecycle,
  type SessionForkTargetPlanStore,
  type SessionForkOpeningTurn,
  type SessionForkTargetResolver,
} from '../../../src/lib/fork/types.ts';
import {
  type SessionTransferImportOutcome,
  TransferImportError,
  TransferPrepareError,
  type TransferPrepareRequest,
} from '../../../src/lib/transfer/types.ts';
import { AT, command, plan, report, target } from './fixtures.ts';

const KEY: SessionForkKey = { sourceSessionId: 'source-a', requestId: 'req-1' };

/** A view is opaque here: this layer never reads one, it only hands the caller what lifecycle said. */
const view = (id: string): SessionView => ({ config: { id } }) as unknown as SessionView;

/**
 * The durable store, with the one property that matters made explicit: `claim` is a
 * compare-and-set, so a second claimant is answered with the document that already holds the pair.
 */
class FakeReceiptStore implements SessionForkReceiptStore {
  readonly documents = new Map<string, unknown>();
  /** Set when a test needs the store to look empty to a reader while a claim already holds it. */
  hideFromReads = false;

  constructor(private readonly log: string[]) {}

  async read(key: SessionForkKey): Promise<unknown> {
    if (this.hideFromReads) return undefined;
    return this.documents.get(sessionForkKey(key));
  }

  async claim(receipt: SessionForkReceipt): Promise<unknown> {
    const identity = sessionForkKey(receipt);
    const held = this.documents.get(identity);
    if (held !== undefined) return held;
    this.log.push('receipts.claim');
    this.documents.set(identity, structuredClone(receipt));
    return this.documents.get(identity);
  }

  async advance(receipt: SessionForkReceipt): Promise<void> {
    this.log.push(`receipts.advance:${receipt.phase}`);
    this.documents.set(sessionForkKey(receipt), structuredClone(receipt));
  }

  seed(receipt: SessionForkReceipt): void {
    this.documents.set(sessionForkKey(receipt), structuredClone(receipt));
  }
}

interface Harness {
  readonly service: SessionForkService;
  readonly receipts: FakeReceiptStore;
  readonly log: string[];
  readonly prepared: TransferPrepareRequest[];
  readonly bound: string[];
  readonly boundPlans: SessionTransferPlan[];
  readonly minted: string[];
  readonly imported: Array<{ readonly plan: SessionTransferPlan; readonly newSessionId: string }>;
}

function harness(
  options: {
    readonly importOutcome?: SessionTransferImportOutcome;
    readonly importFailures?: number;
    readonly rejectValidation?: boolean;
    readonly rejectOpening?: boolean;
    readonly prepare?: (request: TransferPrepareRequest) => SessionTransferPlan;
  } = {},
): Harness {
  const log: string[] = [];
  const prepared: TransferPrepareRequest[] = [];
  const bound: string[] = [];
  const boundPlans: SessionTransferPlan[] = [];
  const minted: string[] = [];
  const imported: Array<{ readonly plan: SessionTransferPlan; readonly newSessionId: string }> = [];
  const receipts = new FakeReceiptStore(log);
  let ids = 0;
  let ticks = -1;
  let refusedImports = 0;

  /** Each fake is declared against its own port, so a port it does not satisfy fails the typecheck. */
  const boundTarget = (targetSessionId: string): SessionForkBoundTarget => {
    const lifecycle: SessionForkTargetLifecycle = {
      create: async () => {
        log.push(`lifecycle.create:${targetSessionId}`);
      },
      captureTranscriptProvenance: async () => {
        log.push(`lifecycle.captureTranscriptProvenance:${targetSessionId}`);
      },
      start: async () => {
        log.push(`lifecycle.start:${targetSessionId}`);
        return view(targetSessionId);
      },
      view: async () => {
        log.push(`lifecycle.view:${targetSessionId}`);
        return view(targetSessionId);
      },
    };
    const plans: SessionForkTargetPlanStore = {
      persist: async () => {
        log.push(`plans.persist:${targetSessionId}`);
      },
    };
    const importer: SessionForkTargetImporter = {
      importPlan: async (receivedPlan, newSessionId) => {
        imported.push({ plan: receivedPlan, newSessionId });
        log.push(`importer.import:${targetSessionId}`);
        if (refusedImports < (options.importFailures ?? 0)) {
          refusedImports += 1;
          throw new TransferImportError('cut_rewritten', 'the pinned point no longer reads as the message it named');
        }
        return options.importOutcome ?? report();
      },
    };
    return { lifecycle, plans, importer };
  };

  const resolver: SessionForkTargetResolver = {
    resolve: async () => {
      log.push('resolver.resolve');
      return target();
    },
    validate: async (chosen, cwd) => {
      log.push(`resolver.validate:${chosen.agent}@${cwd}`);
      if (options.rejectValidation === true)
        throw new TransferPrepareError('target_not_found', 'that model is not served in this directory');
    },
  };
  const opening: SessionForkOpeningTurn = {
    assertDeliverable: () => {
      log.push('opening.assertDeliverable');
      if (options.rejectOpening === true)
        throw new TransferPrepareError('plan_invalid', 'the opening turn is larger than a session may be created with');
    },
  };
  const preparer: SessionForkPreparer = {
    prepare: async (request: TransferPrepareRequest): Promise<SessionTransferPlan> => {
      log.push('preparer.prepare');
      prepared.push(request);
      return (
        options.prepare?.(request) ??
        plan({
          sourceSessionId: request.sourceSessionId,
          requestId: request.requestId,
          preparedAt: request.preparedAt,
        })
      );
    },
  };
  const binder: SessionForkTargetBinder = {
    bind: (targetSessionId: string, boundPlan) => {
      boundPlans.push(boundPlan);
      bound.push(targetSessionId);
      return boundTarget(targetSessionId);
    },
  };
  const idFactory: SessionForkIdFactory = {
    next: () => {
      ids += 1;
      const id = `target-${ids}`;
      minted.push(id);
      return id;
    },
  };
  const clock: SessionForkClock = {
    now: () => {
      ticks += 1;
      return new Date(Date.UTC(2026, 7, 6, 7, 0, ticks)).toISOString();
    },
  };
  const serial: SessionForkSerial = {
    run: async (key, work) => {
      log.push(`serial.run:${sessionForkKey(key)}`);
      return await work();
    },
  };

  const ports: SessionForkPorts = { receipts, resolver, preparer, opening, binder, ids: idFactory, clock, serial };

  return { service: new SessionForkService(ports), receipts, log, prepared, bound, boundPlans, minted, imported };
}

/** A receipt already durably at `phase`, as a crashed attempt would have left behind. */
function receiptAt(
  phase: SessionForkPhase,
  key: SessionForkKey = KEY,
  targetSessionId = 'target-1',
): SessionForkReceipt {
  let receipt = claimSessionForkReceipt({
    key,
    requestFingerprint: sessionForkFingerprint(command()),
    targetSessionId,
    plan: plan({ sourceSessionId: key.sourceSessionId, requestId: key.requestId }),
    at: AT,
  });
  for (const next of SESSION_FORK_PHASES.slice(1, sessionForkPhaseRank(phase) + 1))
    receipt = advanceSessionForkReceipt(receipt, {
      phase: next,
      at: AT,
      report: next === 'imported' ? report() : undefined,
    });
  return receipt;
}

describe('SessionForkService order', () => {
  it('claims the receipt before anything is created, and crosses every boundary in order', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());

    expect(fork.log).toEqual([
      `serial.run:${sessionForkKey(KEY)}`,
      'resolver.resolve',
      'preparer.prepare',
      'resolver.validate:account-b@/work/repo',
      'opening.assertDeliverable',
      'receipts.claim',
      'lifecycle.create:target-1',
      'receipts.advance:target_created',
      'plans.persist:target-1',
      'receipts.advance:plan_persisted',
      'importer.import:target-1',
      'receipts.advance:imported',
      'lifecycle.captureTranscriptProvenance:target-1',
      'receipts.advance:provenance_captured',
      'lifecycle.start:target-1',
      'receipts.advance:completed',
    ]);
  });

  it('prepares against the source the key names, through the exact message the caller chose', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command({ through: { v: 1, byteOffset: 900, blockIndex: 2 } }));

    expect(fork.prepared).toHaveLength(1);
    expect(fork.prepared[0]?.sourceSessionId).toBe('source-a');
    expect(fork.prepared[0]?.requestId).toBe('req-1');
    expect(fork.prepared[0]?.cutMessagePoint).toEqual({ v: 1, byteOffset: 900, blockIndex: 2 });
    expect(fork.prepared[0]?.selectionBinding).toBe('selection-binding-1');
    expect(fork.prepared[0]?.target).toEqual(target());
  });

  it('answers with the target, the exact plan and the import report', async () => {
    const fork = harness();
    const result = await fork.service.fork(KEY, command());

    expect(result.targetSessionId).toBe('target-1');
    expect(result.session).toEqual(view('target-1'));
    expect(result.plan).toEqual(plan());
    expect(result.report).toEqual(report());
  });
});

describe('SessionForkService target binding', () => {
  it('writes only into a freshly minted session, never the one it read', async () => {
    const fork = harness();
    const result = await fork.service.fork(KEY, command());

    expect(fork.minted).toEqual(['target-1']);
    expect(fork.bound).toEqual(['target-1']);
    expect(fork.imported).toEqual([{ plan: plan(), newSessionId: 'target-1' }]);
    expect(result.targetSessionId).not.toBe(KEY.sourceSessionId);
    expect(fork.log.some(entry => entry.endsWith(`:${KEY.sourceSessionId}`))).toBe(false);
  });

  it('mints one target per fork and reuses it for the fork it belongs to', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());
    await fork.service.fork({ sourceSessionId: 'source-b', requestId: 'req-1' }, command());

    expect(fork.minted).toEqual(['target-1', 'target-2']);
  });
});

describe('SessionForkService composite key', () => {
  it('treats one request id on two different sources as two independent forks', async () => {
    const fork = harness();
    const first = await fork.service.fork(KEY, command());
    const second = await fork.service.fork({ sourceSessionId: 'source-b', requestId: 'req-1' }, command());

    expect(first.targetSessionId).not.toBe(second.targetSessionId);
    expect(first.plan.source.sessionId).toBe('source-a');
    expect(second.plan.source.sessionId).toBe('source-b');
    expect(fork.receipts.documents.size).toBe(2);
    expect(fork.prepared.map(request => request.sourceSessionId)).toEqual(['source-a', 'source-b']);
  });

  it('serialises each fork under its own composite key', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());
    await fork.service.fork({ sourceSessionId: 'source-b', requestId: 'req-1' }, command());

    expect(fork.log.filter(entry => entry.startsWith('serial.run'))).toEqual([
      `serial.run:${sessionForkKey(KEY)}`,
      `serial.run:${sessionForkKey({ sourceSessionId: 'source-b', requestId: 'req-1' })}`,
    ]);
  });
});

describe('SessionForkService replay', () => {
  it('answers a lost response from the durable receipt without touching the source again', async () => {
    const fork = harness();
    const first = await fork.service.fork(KEY, command());
    fork.log.length = 0;
    const replay = await fork.service.fork(KEY, command());

    expect(replay.targetSessionId).toBe(first.targetSessionId);
    expect(replay.plan).toEqual(first.plan);
    expect(replay.report).toEqual(first.report);
    expect(fork.prepared).toHaveLength(1);
    expect(fork.minted).toEqual(['target-1']);
    // The completed fork is read, never re-started: an operator may have stopped the new session.
    expect(fork.log).toEqual([`serial.run:${sessionForkKey(KEY)}`, 'lifecycle.view:target-1']);
  });

  it('derives source decisions exactly once however many times the request arrives', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());
    await fork.service.fork(KEY, command());
    await fork.service.fork(KEY, command());

    expect(fork.prepared).toHaveLength(1);
    expect(fork.log.filter(entry => entry === 'preparer.prepare')).toHaveLength(1);
  });

  it('replays persisted P0 after the source could produce P1, never silently replacing the plan', async () => {
    const persisted = receiptAt('claimed');
    const moved = plan({
      preparedAt: persisted.plan.preparedAt,
    });
    const movedMessage = moved.facets.conversation?.messages[0];
    if (movedMessage === undefined) throw new Error('the fork fixture must carry one message');
    const changedPlan: SessionTransferPlan = {
      ...moved,
      facets: {
        ...moved.facets,
        conversation: {
          messages: [{ ...movedMessage, text: 'a later source decision' }],
        },
      },
    };
    const fork = harness({ prepare: () => changedPlan });
    fork.receipts.seed(persisted);

    const result = await fork.service.fork(KEY, command());

    expect(fork.prepared).toEqual([]);
    expect(result.plan).toEqual(persisted.plan);
    expect(result.plan).not.toEqual(changedPlan);
  });

  for (const phase of SESSION_FORK_PHASES) {
    it(`resumes a fork that crashed after ${phase} without repeating an earlier boundary`, async () => {
      const fork = harness();
      fork.receipts.seed(receiptAt(phase));
      const result = await fork.service.fork(KEY, command());

      const expected = [
        `serial.run:${sessionForkKey(KEY)}`,
        ...(sessionForkPhaseRank(phase) < sessionForkPhaseRank('target_created')
          ? ['lifecycle.create:target-1', 'receipts.advance:target_created']
          : []),
        ...(sessionForkPhaseRank(phase) < sessionForkPhaseRank('plan_persisted')
          ? ['plans.persist:target-1', 'receipts.advance:plan_persisted']
          : []),
        ...(sessionForkPhaseRank(phase) < sessionForkPhaseRank('imported')
          ? ['importer.import:target-1', 'receipts.advance:imported']
          : []),
        ...(sessionForkPhaseRank(phase) < sessionForkPhaseRank('provenance_captured')
          ? ['lifecycle.captureTranscriptProvenance:target-1', 'receipts.advance:provenance_captured']
          : []),
        ...(sessionForkPhaseRank(phase) < sessionForkPhaseRank('completed')
          ? ['lifecycle.start:target-1', 'receipts.advance:completed']
          : ['lifecycle.view:target-1']),
      ];

      expect(fork.log).toEqual(expected);
      // Whatever it resumed from, it reused the reserved target and the plan already decided.
      expect(fork.prepared).toHaveLength(0);
      expect(fork.minted).toHaveLength(0);
      expect(result.targetSessionId).toBe('target-1');
      expect(result.plan).toEqual(plan());
      expect(result.report).toEqual(report());
    });
  }

  /**
   * The importer re-reads the pinned point and refuses `cut_unreadable` / `cut_rewritten` BEFORE it
   * writes anything. This layer passes that refusal through and adds no validator of its own, so the
   * receipt is still at `plan_persisted` and the next attempt re-drives the same import.
   */
  it('re-drives a refused import against the same target and plan, and never re-prepares', async () => {
    const fork = harness({ importFailures: 1 });
    await expect(fork.service.fork(KEY, command())).rejects.toThrow(TransferImportError);
    expect(parseSessionForkReceipt(fork.receipts.documents.get(sessionForkKey(KEY)), KEY).phase).toBe('plan_persisted');

    fork.log.length = 0;
    const result = await fork.service.fork(KEY, command());

    expect(fork.log).toEqual([
      `serial.run:${sessionForkKey(KEY)}`,
      'importer.import:target-1',
      'receipts.advance:imported',
      'lifecycle.captureTranscriptProvenance:target-1',
      'receipts.advance:provenance_captured',
      'lifecycle.start:target-1',
      'receipts.advance:completed',
    ]);
    expect(fork.prepared).toHaveLength(1);
    expect(fork.minted).toEqual(['target-1']);
    expect(result.targetSessionId).toBe('target-1');
  });

  it('keeps the report the crashed attempt produced rather than re-importing for a new one', async () => {
    const fork = harness({ importOutcome: report({ briefPath: '/state/sessions/target-1/turns/turn-002.md' }) });
    fork.receipts.seed(receiptAt('imported'));
    const result = await fork.service.fork(KEY, command());

    expect(result.report).toEqual(report());
    expect(fork.log).not.toContain('importer.import:target-1');
  });
});

describe('SessionForkService target anchoring', () => {
  /**
   * The write surface is bound to BOTH the reserved id and the receipt's own plan. Without the
   * second anchor, the operations that take no plan argument — capture, start, view — can only check
   * the target against the plan installed beside it, which is circular: a valid but different plan
   * written under the same deterministic id satisfies every later phase self-consistently.
   */
  it('binds the write surface to the plan the receipt froze, not to whatever is installed', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());

    expect(fork.boundPlans).toHaveLength(1);
    expect(fork.boundPlans[0]).toEqual(
      parseSessionForkReceipt(fork.receipts.documents.get(sessionForkKey(KEY)), KEY).plan,
    );
  });

  it('anchors a replay to the receipt plan at every phase it resumes from', async () => {
    for (const phase of SESSION_FORK_PHASES) {
      const fork = harness();
      const seeded = receiptAt(phase);
      fork.receipts.seed(seeded);
      await fork.service.fork(KEY, command());

      expect(fork.boundPlans).toEqual([seeded.plan]);
    }
  });
});

describe('SessionForkService pre-claim validation', () => {
  /**
   * Both of these refusals must land while the answer is still free. After the claim they would be
   * a durable receipt whose every replay re-drives the same impossible step forever, because every
   * post-claim boundary is idempotent and re-driven by design.
   */
  it('re-proves the target in the directory the plan froze, not the one resolution guessed', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());

    // The cwd is `plan.durable.cwd` — the SOURCE's directory, which nothing had read at resolve time.
    expect(fork.log).toContain('resolver.validate:account-b@/work/repo');
    expect(fork.log.indexOf('resolver.validate:account-b@/work/repo')).toBeGreaterThan(
      fork.log.indexOf('preparer.prepare'),
    );
    expect(fork.log.indexOf('resolver.validate:account-b@/work/repo')).toBeLessThan(fork.log.indexOf('receipts.claim'));
  });

  it('refuses a target the catalogue will not serve there, and claims nothing', async () => {
    const fork = harness({ rejectValidation: true });

    await expect(fork.service.fork(KEY, command())).rejects.toThrow(TransferPrepareError);
    expect(fork.receipts.documents.size).toBe(0);
    expect(fork.log).not.toContain('receipts.claim');
    expect(fork.bound).toEqual([]);
  });

  it('refuses an opening turn the target could never be created with, and claims nothing', async () => {
    const fork = harness({ rejectOpening: true });

    const thrown = (await fork.service.fork(KEY, command()).catch((error: unknown) => error)) as TransferPrepareError;

    expect(thrown.failure).toBe('plan_invalid');
    expect(fork.receipts.documents.size).toBe(0);
    expect(fork.log).not.toContain('receipts.claim');
    expect(fork.minted).toEqual([]);
  });

  it('asks neither question again once a receipt exists', async () => {
    const fork = harness();
    fork.receipts.seed(receiptAt('plan_persisted'));
    await fork.service.fork(KEY, command());

    // A replay applies the frozen decision; re-validating it could refuse a fork already half-built.
    expect(fork.log.some(entry => entry.startsWith('resolver.validate'))).toBe(false);
    expect(fork.log).not.toContain('opening.assertDeliverable');
  });
});

describe('SessionForkService conflict', () => {
  it('refuses a second payload under one pair, and creates nothing for it', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());
    fork.log.length = 0;

    await expect(
      fork.service.fork(KEY, command({ through: { v: 1, byteOffset: 900, blockIndex: 0 } })),
    ).rejects.toThrow(SessionForkRequestConflictError);
    expect(fork.minted).toEqual(['target-1']);
    expect(fork.log).toEqual([`serial.run:${sessionForkKey(KEY)}`]);
  });

  it('refuses a payload that differs only in the model the caller chose', async () => {
    const fork = harness();
    await fork.service.fork(KEY, command());

    await expect(fork.service.fork(KEY, command({ model: 'gpt-mini' }))).rejects.toThrow(
      SessionForkRequestConflictError,
    );
  });
});

describe('SessionForkService atomic claim', () => {
  it('adopts the claim that won rather than creating a second target', async () => {
    const fork = harness();
    // The pair is already held, but a reader cannot see it: exactly the race the compare-and-set
    // exists for — two attempts both find nothing and only one may mint a session.
    fork.receipts.seed(receiptAt('claimed', KEY, 'target-winner'));
    fork.receipts.hideFromReads = true;

    const result = await fork.service.fork(KEY, command());

    expect(result.targetSessionId).toBe('target-winner');
    expect(fork.bound).toEqual(['target-winner']);
    // The losing attempt minted an id and prepared a plan; both are discarded, unused.
    expect(fork.minted).toEqual(['target-1']);
    expect(fork.log).not.toContain('receipts.claim');
  });

  it('refuses when the claim that won was made for a different payload', async () => {
    const fork = harness();
    const held = claimSessionForkReceipt({
      key: KEY,
      requestFingerprint: sessionForkFingerprint(command({ agent: 'account-z' })),
      targetSessionId: 'target-winner',
      plan: plan(),
      at: AT,
    });
    fork.receipts.seed(held);
    fork.receipts.hideFromReads = true;

    await expect(fork.service.fork(KEY, command())).rejects.toThrow(SessionForkRequestConflictError);
    expect(fork.bound).toEqual([]);
  });
});

describe('SessionForkService capabilities', () => {
  /** Compiles only when `T` is `never`, so a leaked capability fails the typecheck, not this run. */
  function provesNoLeak<_T extends never>(): boolean {
    return true;
  }

  /** Compiles only when `_From` is assignable to `_To`. */
  function provesAssignable<_From extends _To, _To>(): boolean {
    return true;
  }

  const FORBIDDEN: readonly ForbiddenForkCapability[] = [
    'board',
    'boards',
    'childGrant',
    'grants',
    'stop',
    'source',
    'sourceWriter',
    'descendants',
    'waiters',
    'pointers',
  ];

  it('holds no board, grant, stop, source-writer or descendant capability', () => {
    expect(provesNoLeak<SessionForkCapabilityLeak>()).toBe(true);
    const names = [...Object.keys(SESSION_FORK_PORTS), ...Object.keys(SESSION_FORK_TARGET_PORTS)];
    for (const forbidden of FORBIDDEN) expect(names).not.toContain(forbidden);
  });

  it('enumerates every port it does hold, so a new one cannot be added unnoticed', () => {
    expect(Object.keys(SESSION_FORK_PORTS).sort()).toEqual(
      ['receipts', 'resolver', 'preparer', 'opening', 'binder', 'ids', 'clock', 'serial'].sort(),
    );
    expect(Object.keys(SESSION_FORK_TARGET_PORTS).sort()).toEqual(['lifecycle', 'plans', 'importer'].sort());
  });

  it('stores exactly the import outcome the transfer seam produces', () => {
    expect(provesAssignable<SessionForkImportReport, SessionTransferImportOutcome>()).toBe(true);
    expect(provesAssignable<SessionTransferImportOutcome, SessionForkImportReport>()).toBe(true);
  });
});
