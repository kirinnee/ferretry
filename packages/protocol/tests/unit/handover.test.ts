import { describe, it } from 'bun:test';
import should from 'should';
import * as handover from '../../src/lib/handover.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const AT = '2026-08-06T07:00:00.000Z';

const request = {
  agent: 'codex-auto',
  model: 'gpt-5',
  coordinator: { agent: 'codex-auto', model: 'gpt-5' },
  reason: 'predecessor wedged on an unanswerable question',
};

/** A handover transfer plan: no conversation (cutMessagePoint / conversation null). */
const plan = {
  v: 1 as const,
  planId: 'transfer-plan-1',
  preparedAt: AT,
  source: {
    sessionId: 'session-1',
    incarnation: 'session-1-1',
    runtimeGeneration: 1,
    harness: 'claude' as const,
    agent: 'claude-auto',
    model: 'opus',
    teammate: 'molli',
    name: 'Recovery',
    label: null,
    transcriptProvenance: null,
    cutMessagePoint: null,
  },
  target: {
    accountId: 'account-2',
    agent: 'codex-auto',
    harness: 'codex' as const,
    model: 'gpt-5',
    effort: 'high',
    contextWindow: 200_000,
  },
  durable: {
    cwd: '/work/repo',
    mode: 'auto' as const,
    parentSessionId: null,
    boardAccess: 'none' as const,
    label: null,
    harnessFlags: [] as readonly string[],
    remoteControl: true,
    intervalSeconds: 5,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 60,
    killAfterSeconds: 120,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'summary' as const,
    maxSnapshots: 10,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  },
  facets: {
    conversation: null,
    attachments: { attachments: [] },
    references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
    workspace: { cwd: '/work/repo', head: null, status: null, repositorySnapshot: null },
    lineage: { wardenLineage: false, warden: null },
  },
  notCarried: [] as readonly unknown[],
};

const resolvedReplacement = {
  accountId: 'account-2',
  agent: 'codex-auto',
  harness: 'codex' as const,
  model: 'gpt-5',
  effort: 'high',
  contextWindow: 200_000,
};
const resolvedCoordinator = {
  accountId: 'account-3',
  agent: 'codex-auto',
  harness: 'codex' as const,
  model: 'gpt-5',
  effort: null,
  contextWindow: 200_000,
};

const BOARD_ANCHOR = {
  boardId: 'board-1',
  creatorSessionId: 'root-0',
  canonicalSessionId: 'root-0',
  createdAt: AT,
};

const BOARD_LADDER = [
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
  'relinquished',
  'predecessor_stopped',
  'completed',
] as const;

const history = (phases: readonly string[]): unknown => phases.map(phase => ({ phase, at: AT }));

/** A completed board-root handover: every phase-dependent field populated, no refusal. */
const receipt = {
  requestId: 'req-1',
  fingerprint: 'sha256:abc',
  reason: request.reason,
  sourceSessionId: 'session-1',
  sourceHarness: 'claude' as const,
  sourceAgent: 'claude-auto',
  sourceTeammate: 'molli',
  resolvedTarget: { replacement: resolvedReplacement, coordinator: resolvedCoordinator },
  planId: 'transfer-plan-1',
  plan,
  replacementSessionId: 'session-2',
  coordinatorSessionId: 'session-3',
  board: { ...BOARD_ANCHOR, invitationRequestId: 'inv-1', grantId: 'grant-1' },
  phase: 'completed' as const,
  phaseHistory: history(BOARD_LADDER),
  createdAt: AT,
  updatedAt: AT,
};

const cases: SchemaCase[] = [
  { name: 'handover phase', schema: handover.SessionHandoverPhaseSchema, value: 'verified' },
  { name: 'handover failure', schema: handover.SessionHandoverFailureSchema, value: 'verification_timeout' },
  { name: 'handover request', schema: handover.SessionHandoverRequestSchema, value: request },
  { name: 'resolved account', schema: handover.SessionHandoverResolvedAccountSchema, value: resolvedReplacement },
  {
    name: 'resolved target',
    schema: handover.SessionHandoverResolvedTargetSchema,
    value: { replacement: resolvedReplacement, coordinator: resolvedCoordinator },
  },
  { name: 'board ref', schema: handover.SessionHandoverBoardRefSchema, value: { ...BOARD_ANCHOR } },
  { name: 'phase event', schema: handover.SessionHandoverPhaseEventSchema, value: { phase: 'requested', at: AT } },
  {
    name: 'refusal',
    schema: handover.SessionHandoverRefusalSchema,
    value: { failure: 'step_failed', message: 'late' },
  },
  { name: 'effect intent', schema: handover.SessionHandoverEffectIntentSchema, value: 'accepting' },
  { name: 'handover receipt', schema: handover.SessionHandoverReceiptSchema, value: receipt },
];

describe('session handover protocol', () => {
  it('should round-trip every exported schema through strict durable values', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(handover, cases);
  });

  it('should keep the cause vocabulary separate from the terminal-phase vocabulary', () => {
    // Assert — every terminal phase is a valid phase, and the phase categories are NOT causes.
    for (const phase of ['refused', 'abandoned', 'stranded', 'failed', 'completed'] as const) {
      should(handover.SessionHandoverPhaseSchema.safeParse(phase).success).be.true();
    }
    should(handover.SessionHandoverFailureSchema.safeParse('cancelled').success).be.true();
    should(handover.SessionHandoverFailureSchema.safeParse('coordinator_required').success).be.true();
    for (const phaseCategory of ['abandoned', 'stranded', 'failed', 'refused'] as const) {
      should(handover.SessionHandoverFailureSchema.safeParse(phaseCategory).success).be.false();
    }
    should(handover.SessionHandoverPhaseSchema.safeParse('cancelled').success).be.false();
  });

  it('should accept the legal board and boardless ladders and reject impossible traces', () => {
    // Arrange — a boardless completion skips the board leg and relinquished.
    const boardlessCompleted = {
      ...receipt,
      board: null,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: null },
      phaseHistory: history([
        'requested',
        'replacement_creating',
        'replacement_created',
        'replacement_started',
        'draining',
        'predecessor_stopped',
        'completed',
      ]),
    };
    // Act + Assert
    should(handover.SessionHandoverReceiptSchema.safeParse(receipt).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(boardlessCompleted).success).be.true();
    assertRejects([
      {
        name: 'monotone but impossible trace (skips creation, verification, coordinator, drain, relinquish)',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phaseHistory: history(['requested', 'accepted', 'predecessor_stopped', 'completed']),
        },
      },
      {
        name: 'board root skipping the board leg',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phase: 'replacement_started' as const,
          coordinatorSessionId: undefined,
          phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', 'replacement_started']),
        },
      },
      {
        name: 'boardless trace reaching a board phase',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...boardlessCompleted, phaseHistory: history(['requested', 'invited', 'completed']) },
      },
    ]);
  });

  it('should bind terminals to the ladder position that can reach them', () => {
    // Arrange
    const stranded = {
      ...receipt,
      phase: 'stranded' as const,
      phaseHistory: history([
        'requested',
        'replacement_creating',
        'replacement_created',
        'invited',
        'approved',
        'accepted',
        'stranded',
      ]),
      refusal: { failure: 'verification_timeout', message: 'never verified' },
    };
    const abandoned = {
      ...receipt,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: resolvedCoordinator },
      phase: 'abandoned' as const,
      phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', 'abandoned']),
      refusal: { failure: 'replacement_terminal', message: 'died before acceptance' },
    };
    const refused = {
      ...receipt,
      replacementSessionId: undefined,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: resolvedCoordinator },
      phase: 'refused' as const,
      phaseHistory: history(['requested', 'refused']),
      refusal: { failure: 'harness_same', message: 'use fy migrate' },
    };
    // Act + Assert — stranded is board-only past accepted; abandoned names a replacement pre-acceptance;
    // refused precedes creation (and may omit the replacement id).
    should(handover.SessionHandoverReceiptSchema.safeParse(stranded).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(abandoned).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(refused).success).be.true();
  });

  it('should reject an early failed without source_lost or committed provenance, and accept its twin', () => {
    // Arrange — bethanne's exact counter-example: a generic step_failed must not skip the whole ladder.
    const skippedSuccess = {
      ...receipt,
      replacementSessionId: undefined,
      coordinatorSessionId: undefined,
      phase: 'failed' as const,
      phaseHistory: history(['requested', 'failed']),
      refusal: { failure: 'step_failed', message: 'generic failure' },
    };
    // Act + Assert — the same trace is legal only when the cause is the dedicated source-loss one.
    should(handover.SessionHandoverReceiptSchema.safeParse(skippedSuccess).success).be.false();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...skippedSuccess,
        refusal: { failure: 'source_lost', message: 'predecessor died externally' },
      }).success,
    ).be.true();
  });

  it('should gate irreversible terminal shortcuts on retained committed-effect provenance', () => {
    // Arrange — accepting/retiring provenance is stamped on the authorizing phase event and RETAINED after
    // the active receipt.effectIntent clears, so a terminal receipt can still justify its transition.
    const approvedTrace = ['requested', 'replacement_creating', 'replacement_created', 'invited', 'approved'] as const;
    const withAccepting = [
      ...approvedTrace.slice(0, 4).map(phase => ({ phase, at: AT })),
      { phase: 'approved' as const, at: AT, effectIntent: 'accepting' as const },
    ];
    const strandedFromApproved = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'stranded' as const,
      phaseHistory: [...withAccepting, { phase: 'stranded' as const, at: AT }],
      refusal: { failure: 'step_failed', message: 'accept committed, receipt write failed' },
    };
    const drainingTrace = [
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
    ] as const;
    const failedFromDraining = {
      ...receipt,
      phase: 'failed' as const,
      phaseHistory: [
        ...drainingTrace.map(phase => ({ phase, at: AT })),
        { phase: 'draining' as const, at: AT, effectIntent: 'retiring' as const },
        { phase: 'failed' as const, at: AT },
      ],
      refusal: { failure: 'step_failed', message: 'stop failed inside the retirement tail' },
    };

    // Act + Assert — with provenance both are legal; stripping the stamp rejects the identical trace.
    should(handover.SessionHandoverReceiptSchema.safeParse(strandedFromApproved).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(failedFromDraining).success).be.true();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...strandedFromApproved,
        phaseHistory: [...approvedTrace.map(phase => ({ phase, at: AT })), { phase: 'stranded' as const, at: AT }],
      }).success,
    ).be.false();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...failedFromDraining,
        phaseHistory: [
          ...drainingTrace.map(phase => ({ phase, at: AT })),
          { phase: 'draining' as const, at: AT },
          { phase: 'failed' as const, at: AT },
        ],
      }).success,
    ).be.false();
    // A stamp on the wrong phase or track is not provenance.
    assertRejects([
      {
        name: 'accepting stamped off approved',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...strandedFromApproved,
          phaseHistory: [
            ...approvedTrace.slice(0, 3).map(phase => ({ phase, at: AT })),
            { phase: 'invited' as const, at: AT, effectIntent: 'accepting' as const },
            { phase: 'approved' as const, at: AT },
            { phase: 'stranded' as const, at: AT },
          ],
        },
      },
      {
        name: 'active intent without a matching current event',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          coordinatorSessionId: undefined,
          phase: 'approved' as const,
          phaseHistory: approvedTrace.map(phase => ({ phase, at: AT })),
          effectIntent: 'accepting' as const,
        },
      },
    ]);
  });

  it('should retain the cancel identity when external source loss supersedes a cancellation', () => {
    // Arrange — C1 wrote cancellation intent; the source then died outside the retirement tail, so the
    // honest terminal is failed/source_lost, but C1's identity stays as immutable provenance.
    const supersededByLoss = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'failed' as const,
      phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', 'failed']),
      refusal: { failure: 'source_lost', message: 'predecessor died while the cancellation was settling' },
      cancelRequestId: 'cancel-op-1',
    };

    // Act + Assert — retained here, and still rejected for any other non-cancel cause.
    should(handover.SessionHandoverReceiptSchema.safeParse(supersededByLoss).success).be.true();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...supersededByLoss,
        phase: 'abandoned' as const,
        phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', 'abandoned']),
        refusal: { failure: 'replacement_terminal', message: 'unrelated cause' },
      }).success,
    ).be.false();
  });

  it('should keep the write-ahead source_lost intent valid and bind its terminal to failed', () => {
    // Arrange — C1 wrote cancellation intent, the source then died: source_lost supersedes it and the
    // same-phase intent must persist BEFORE the terminal write, or the crash window cannot be recorded.
    const supersedingIntent = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'replacement_created' as const,
      phaseHistory: history(['requested', 'replacement_creating', 'replacement_created']),
      refusal: { failure: 'source_lost', message: 'predecessor died while the cancellation was settling' },
      cancelRequestId: 'cancel-op-1',
    };

    // Act + Assert — the nonterminal intent parses; every non-failed terminal pairing is refused.
    should(handover.SessionHandoverReceiptSchema.safeParse(supersedingIntent).success).be.true();
    assertRejects(
      (['refused', 'abandoned', 'stranded'] as const).map(phase => ({
        name: `terminal source_lost as ${phase}`,
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...supersedingIntent,
          phase,
          phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', phase]),
        },
      })),
    );
  });

  it('should refuse a same-phase write that erases an active substep intent', () => {
    // Arrange — an accepting/retiring stamp with the active field dropped while the substep phase is still
    // current would let a possibly committed effect read as reversible.
    const erasedAccepting = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'approved' as const,
      phaseHistory: [
        ...['requested', 'replacement_creating', 'replacement_created', 'invited'].map(phase => ({ phase, at: AT })),
        { phase: 'approved' as const, at: AT, effectIntent: 'accepting' as const },
        { phase: 'approved' as const, at: AT, detail: 'retrying accept' },
      ],
    };
    const erasedRetiring = {
      ...receipt,
      phase: 'draining' as const,
      phaseHistory: [
        ...[
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
        ].map(phase => ({ phase, at: AT })),
        { phase: 'draining' as const, at: AT, effectIntent: 'retiring' as const },
        { phase: 'draining' as const, at: AT, detail: 'still retiring' },
      ],
    };

    // Act + Assert — the plain detail twins are rejected, but the SETTLEMENT-intent write is the one
    // deliberate exception: a nonterminal refusal replaces the mutually exclusive active effect and is
    // itself the write-ahead proof for the provenance-backed edge.
    should(handover.SessionHandoverReceiptSchema.safeParse(erasedAccepting).success).be.false();
    should(handover.SessionHandoverReceiptSchema.safeParse(erasedRetiring).success).be.false();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...erasedAccepting,
        refusal: { failure: 'step_failed', message: 'accept failed after the grant may have committed' },
      }).success,
    ).be.true();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...erasedRetiring,
        refusal: { failure: 'step_failed', message: 'stop failed inside the retirement tail' },
      }).success,
    ).be.true();
  });

  it('should let source loss settle from an active accepting substep by trading the intent for the refusal', () => {
    // Arrange — the cross-contract edge: at approved with accepting active, effectIntent and refusal are
    // mutually exclusive, so the settlement write CLEARS the active intent and records the refusal on the
    // same phase while retaining the committed provenance event. That event is what still authorizes the
    // later approved -> failed/stranded edge.
    const acceptingEvents = [
      ...['requested', 'replacement_creating', 'replacement_created', 'invited'].map(phase => ({ phase, at: AT })),
      { phase: 'approved' as const, at: AT, effectIntent: 'accepting' as const },
    ];
    const sourceLostWhileAccepting = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'approved' as const,
      phaseHistory: acceptingEvents,
      refusal: { failure: 'source_lost', message: 'predecessor died while acceptance was in flight' },
    };
    const settledFailed = {
      ...sourceLostWhileAccepting,
      phase: 'failed' as const,
      phaseHistory: [...acceptingEvents, { phase: 'failed' as const, at: AT }],
    };

    // Act + Assert — the write-ahead intent parses, and it settles to failed on the provenance-backed edge.
    should(handover.SessionHandoverReceiptSchema.safeParse(sourceLostWhileAccepting).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(settledFailed).success).be.true();
    // The mutual exclusion still holds: the active intent may not coexist with the refusal.
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...sourceLostWhileAccepting,
        effectIntent: 'accepting' as const,
      }).success,
    ).be.false();
  });

  it('should not let committed accepting authorize a generic early failed, only source_lost', () => {
    // Arrange — at approved with a committed accepting stamp the source is still live and still a member
    // while the replacement may already have been admitted, so a generic failure there is dishonest: the
    // truthful outcome is stranded plus Attention. Only source_lost, where the predecessor really is gone,
    // may settle failed. (The committed RETIRING tail keeps its generic shortcut — covered separately.)
    const acceptingEvents = [
      ...['requested', 'replacement_creating', 'replacement_created', 'invited'].map(phase => ({ phase, at: AT })),
      { phase: 'approved' as const, at: AT, effectIntent: 'accepting' as const },
    ];
    const genericFailed = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'failed' as const,
      phaseHistory: [...acceptingEvents, { phase: 'failed' as const, at: AT }],
      refusal: { failure: 'step_failed', message: 'accept call failed' },
    };

    // Act + Assert — generic cause refused; the source_lost twin on the identical trace is accepted; and
    // the honest generic outcome (stranded on the committed accepting provenance) still parses.
    should(handover.SessionHandoverReceiptSchema.safeParse(genericFailed).success).be.false();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...genericFailed,
        refusal: { failure: 'source_lost', message: 'predecessor died while acceptance was in flight' },
      }).success,
    ).be.true();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...genericFailed,
        phase: 'stranded' as const,
        phaseHistory: [...acceptingEvents, { phase: 'stranded' as const, at: AT }],
      }).success,
    ).be.true();
  });

  it('should close the cancellation boundary on committed provenance, not only on the reached phase', () => {
    // Arrange — the settlement exception clears the ACTIVE intent, so a boundary keyed only on
    // reached('accepted') / reached('predecessor_stopped') would let a cancel through the exact window a
    // committed accepting/retiring stamp has already crossed.
    const cancelAtApproved = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'approved' as const,
      phaseHistory: [
        ...['requested', 'replacement_creating', 'replacement_created', 'invited'].map(phase => ({ phase, at: AT })),
        { phase: 'approved' as const, at: AT, effectIntent: 'accepting' as const },
      ],
      refusal: { failure: 'cancelled', message: 'cancel raced a committed acceptance' },
      cancelRequestId: 'cancel-op-1',
    };
    const cancelAtDrainingBoardless = {
      ...receipt,
      board: null,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: null },
      phase: 'draining' as const,
      phaseHistory: [
        ...['requested', 'replacement_creating', 'replacement_created', 'replacement_started'].map(phase => ({
          phase,
          at: AT,
        })),
        { phase: 'draining' as const, at: AT, effectIntent: 'retiring' as const },
      ],
      refusal: { failure: 'cancelled', message: 'cancel raced a committed retirement' },
      cancelRequestId: 'cancel-op-1',
    };

    // Act + Assert — both are refused despite never reaching accepted / predecessor_stopped.
    should(handover.SessionHandoverReceiptSchema.safeParse(cancelAtApproved).success).be.false();
    should(handover.SessionHandoverReceiptSchema.safeParse(cancelAtDrainingBoardless).success).be.false();
    // The same phases WITHOUT the committed stamp remain cancellable.
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...cancelAtApproved,
        phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', 'invited', 'approved']),
      }).success,
    ).be.true();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...cancelAtDrainingBoardless,
        phaseHistory: history([
          'requested',
          'replacement_creating',
          'replacement_created',
          'replacement_started',
          'draining',
        ]),
      }).success,
    ).be.true();
  });

  it('should forbid unwinding past a committed point of no return, while allowing its roll-forward twin', () => {
    // Arrange — committed provenance must FORBID the unwinds, not only authorize the shortcuts: past
    // acceptance the replacement may hold an unrevokeable grant, and inside the retirement tail the
    // predecessor is no longer a member, so abandoned/stranded would each be a false record.
    const acceptingEvents = [
      ...['requested', 'replacement_creating', 'replacement_created', 'invited'].map(phase => ({ phase, at: AT })),
      { phase: 'approved' as const, at: AT, effectIntent: 'accepting' as const },
    ];
    const retiringHead = ['requested', 'replacement_creating', 'replacement_created', 'replacement_started'] as const;
    const boardlessRetiring = [
      ...retiringHead.map(phase => ({ phase, at: AT })),
      { phase: 'draining' as const, at: AT, effectIntent: 'retiring' as const },
    ];
    const boardRetiring = [
      ...[
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
      ].map(phase => ({ phase, at: AT })),
      { phase: 'draining' as const, at: AT, effectIntent: 'retiring' as const },
    ];
    const boardless = {
      ...receipt,
      board: null,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: null },
    };

    // Act + Assert — every unwind past a committed intent is refused.
    assertRejects([
      {
        name: 'committed accepting settling abandoned',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          coordinatorSessionId: undefined,
          phase: 'abandoned' as const,
          phaseHistory: [...acceptingEvents, { phase: 'abandoned' as const, at: AT }],
          refusal: { failure: 'replacement_terminal', message: 'unwinding past acceptance' },
        },
      },
      {
        name: 'committed retiring settling abandoned (boardless)',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...boardless,
          phase: 'abandoned' as const,
          phaseHistory: [...boardlessRetiring, { phase: 'abandoned' as const, at: AT }],
          refusal: { failure: 'replacement_terminal', message: 'unwinding the retirement tail' },
        },
      },
      {
        name: 'committed retiring settling stranded (board)',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phase: 'stranded' as const,
          phaseHistory: [...boardRetiring, { phase: 'stranded' as const, at: AT }],
          refusal: { failure: 'verification_timeout', message: 'stranding inside the tail' },
        },
      },
    ]);

    // The permitted twins: the narrowly authorized failed shortcut still rolls forward.
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...receipt,
        phase: 'failed' as const,
        phaseHistory: [...boardRetiring, { phase: 'failed' as const, at: AT }],
        refusal: { failure: 'step_failed', message: 'stop failed inside the retirement tail' },
      }).success,
    ).be.true();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...boardless,
        phase: 'failed' as const,
        phaseHistory: [...boardlessRetiring, { phase: 'failed' as const, at: AT }],
        refusal: { failure: 'step_failed', message: 'stop failed inside the boardless tail' },
      }).success,
    ).be.true();
  });

  it('should settle source-loss as failed from a progress phase without a false source-state promise', () => {
    // Arrange — predecessor terminal outside the retirement tail: failed is the honest terminal. At
    // requested no replacement exists yet, so no written-ahead id is required; mid-flight the id was
    // written ahead, so it must be present (gated by the trace, not the current phase).
    const failedAtRequested = {
      ...receipt,
      replacementSessionId: undefined,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: resolvedCoordinator },
      phase: 'failed' as const,
      phaseHistory: history(['requested', 'failed']),
      refusal: { failure: 'source_lost', message: 'predecessor gone before any replacement' },
    };
    const failedBoardless = {
      ...receipt,
      board: null,
      coordinatorSessionId: undefined,
      resolvedTarget: { replacement: resolvedReplacement, coordinator: null },
      phase: 'failed' as const,
      phaseHistory: history([
        'requested',
        'replacement_creating',
        'replacement_created',
        'replacement_started',
        'failed',
      ]),
      refusal: { failure: 'source_lost', message: 'predecessor gone mid-flight' },
    };
    // Act + Assert
    should(handover.SessionHandoverReceiptSchema.safeParse(failedAtRequested).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(failedBoardless).success).be.true();
  });

  it('treats refusal as durable settlement intent: nonterminal for any cause with a terminal edge, cancelled paired with a cancel id', () => {
    // Arrange — a nonterminal cancellation (paired with the cancel id) and a generic nonterminal settlement
    // (board_moved written ahead of the abandon side effect); a crash before the terminal write recovers
    // to the same outcome.
    const cancelling = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'replacement_created' as const,
      phaseHistory: history(['requested', 'replacement_creating', 'replacement_created']),
      refusal: { failure: 'cancelled', message: 'operator cancelled before acceptance' },
      cancelRequestId: 'cancel-op-1',
    };
    const settling = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'replacement_created' as const,
      phaseHistory: history(['requested', 'replacement_creating', 'replacement_created']),
      refusal: { failure: 'board_moved', message: 'board anchor drifted' },
    };
    // Act + Assert
    should(handover.SessionHandoverReceiptSchema.safeParse(cancelling).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(settling).success).be.true();
    assertRejects([
      {
        name: 'cancelled without a cancel operation id',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...cancelling, cancelRequestId: undefined },
      },
      {
        name: 'cancel id on a non-cancelled settlement',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...settling, cancelRequestId: 'cancel-op-1' },
      },
      {
        name: 'cancelled cause on a stranded receipt',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phase: 'stranded' as const,
          phaseHistory: history(['requested', 'accepted', 'stranded']),
          refusal: { failure: 'cancelled', message: 'x' },
          cancelRequestId: 'cancel-op-1',
        },
      },
      {
        name: 'board cancellation after acceptance',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phase: 'replacement_started' as const,
          phaseHistory: history([
            'requested',
            'replacement_creating',
            'replacement_created',
            'invited',
            'approved',
            'accepted',
            'replacement_started',
          ]),
          refusal: { failure: 'cancelled', message: 'too late' },
          cancelRequestId: 'cancel-op-1',
        },
      },
    ]);
  });

  it('should gate the structured effect intent by phase/track and exclude it from terminal and failure receipts', () => {
    // Arrange — accepting is the board point of no return at approved; retiring is the post-preflight
    // intent at draining. Both are nonterminal and never coexist with a failure refusal.
    const accepting = {
      ...receipt,
      coordinatorSessionId: undefined,
      phase: 'approved' as const,
      phaseHistory: [
        ...['requested', 'replacement_creating', 'replacement_created', 'invited'].map(phase => ({ phase, at: AT })),
        { phase: 'approved' as const, at: AT, effectIntent: 'accepting' as const },
      ],
      effectIntent: 'accepting' as const,
    };
    const retiring = {
      ...receipt,
      phase: 'draining' as const,
      phaseHistory: [
        ...[
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
        ].map(phase => ({ phase, at: AT })),
        { phase: 'draining' as const, at: AT, effectIntent: 'retiring' as const },
      ],
      effectIntent: 'retiring' as const,
    };
    // Act + Assert
    should(handover.SessionHandoverReceiptSchema.safeParse(accepting).success).be.true();
    should(handover.SessionHandoverReceiptSchema.safeParse(retiring).success).be.true();
    assertRejects([
      {
        name: 'accepting on a non-approved phase',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...accepting,
          phase: 'invited' as const,
          phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', 'invited']),
        },
      },
      {
        name: 'retiring on a non-draining phase',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...retiring,
          phase: 'relinquished' as const,
          phaseHistory: history([
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
            'relinquished',
          ]),
        },
      },
      {
        name: 'effect intent on a terminal receipt',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...retiring,
          phase: 'failed' as const,
          phaseHistory: history([
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
            'relinquished',
            'predecessor_stopped',
            'failed',
          ]),
          refusal: { failure: 'step_failed', message: 'late' },
        },
      },
      {
        name: 'effect intent alongside a failure refusal',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...accepting, refusal: { failure: 'board_moved', message: 'drifted' } },
      },
    ]);
  });

  it('should treat board, the anchor, the plan and the resolved target as one durable record', () => {
    // Act + Assert — board: null and a board ref both parse; omission and an anchorless ref do not.
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...receipt,
        board: null,
        resolvedTarget: { replacement: resolvedReplacement, coordinator: null },
        coordinatorSessionId: undefined,
        phaseHistory: history([
          'requested',
          'replacement_creating',
          'replacement_created',
          'replacement_started',
          'draining',
          'predecessor_stopped',
          'completed',
        ]),
      }).success,
    ).be.true();
    const { board: _board, ...noBoard } = receipt;
    should(handover.SessionHandoverReceiptSchema.safeParse(noBoard).success).be.false();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({ ...receipt, board: { boardId: 'board-1' } }).success,
    ).be.false();
    // board iff coordinator target.
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...receipt,
        board: null,
        resolvedTarget: { replacement: resolvedReplacement, coordinator: resolvedCoordinator },
      }).success,
    ).be.false();
    // the plan must be handover-shaped (no conversation).
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...receipt,
        plan: { ...plan, source: { ...plan.source, cutMessagePoint: { v: 1, byteOffset: 0 } } },
      }).success,
    ).be.false();
  });

  it('should require planId and source/replacement agreement between the receipt and its plan', () => {
    // Act + Assert
    should(handover.SessionHandoverReceiptSchema.safeParse({ ...receipt, planId: 'other-plan' }).success).be.false();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...receipt,
        resolvedTarget: {
          replacement: { ...resolvedReplacement, agent: 'claude-auto' },
          coordinator: resolvedCoordinator,
        },
      }).success,
    ).be.false();
    should(
      handover.SessionHandoverReceiptSchema.safeParse({ ...receipt, sourceTeammate: 'someone-else' }).success,
    ).be.false();
  });

  it('should require the written-ahead ids and board invitation/grant ids on the ladder', () => {
    // Act + Assert
    assertRejects([
      {
        name: 'replacement id missing at replacement_created',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phase: 'replacement_created' as const,
          replacementSessionId: undefined,
          coordinatorSessionId: undefined,
          phaseHistory: history(['requested', 'replacement_creating', 'replacement_created']),
        },
      },
      {
        name: 'coordinator id missing at coordinator_creating on a board root',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phase: 'coordinator_creating' as const,
          coordinatorSessionId: undefined,
          phaseHistory: history([
            'requested',
            'replacement_creating',
            'replacement_created',
            'invited',
            'approved',
            'accepted',
            'replacement_started',
            'verified',
            'coordinator_creating',
          ]),
        },
      },
      {
        name: 'invitation id missing past invited',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          board: { ...BOARD_ANCHOR, grantId: 'grant-1' },
          phase: 'invited' as const,
          coordinatorSessionId: undefined,
          phaseHistory: history(['requested', 'replacement_creating', 'replacement_created', 'invited']),
        },
      },
      {
        name: 'grant id missing past accepted',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          board: { ...BOARD_ANCHOR, invitationRequestId: 'inv-1' },
          phase: 'accepted' as const,
          coordinatorSessionId: undefined,
          phaseHistory: history([
            'requested',
            'replacement_creating',
            'replacement_created',
            'invited',
            'approved',
            'accepted',
          ]),
        },
      },
    ]);
  });

  it('should reject a resolved replacement that disagrees with the frozen plan on any launch field', () => {
    // The receipt and its plan are ONE record, so every launch field the plan froze must be the one the
    // resolved target names. Field by field rather than as a whole-object comparison: a single mismatched
    // model or context window is the drift that would launch something other than what was authorized,
    // and the caller has to be told which field disagreed.
    // Act + Assert
    assertRejects(
      (
        [
          ['accountId', 'account-9'],
          ['harness', 'claude'],
          ['model', 'gpt-5-mini'],
          ['effort', 'low'],
          ['contextWindow', 1_000_000],
        ] as const
      ).map(([field, value]) => ({
        name: `replacement ${field} disagrees with the plan target`,
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          resolvedTarget: {
            replacement: { ...resolvedReplacement, [field]: value },
            coordinator: resolvedCoordinator,
          },
        },
      })),
    );
  });

  it('should reject a phase history that is empty, ends elsewhere, or stamps retiring off draining', () => {
    // phaseHistory is the receipt's own account of how it got here, so the three ways it can contradict
    // the receipt around it are refused rather than tolerated: no history at all, a history whose last
    // entry is not the current phase, and a committed-effect stamp on a phase that does not authorize it.
    // Act + Assert
    assertRejects([
      {
        name: 'no history at all',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...receipt, phaseHistory: [] },
      },
      {
        name: 'history that stops short of the current phase',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...receipt, phaseHistory: history(BOARD_LADDER.slice(0, -1)) },
      },
      {
        name: 'a retiring stamp on a phase that is not draining',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phaseHistory: BOARD_LADDER.map(phase =>
            phase === 'approved' ? { phase, at: AT, effectIntent: 'retiring' } : { phase, at: AT },
          ),
        },
      },
    ]);
  });

  it('should refuse a handover plan that carries a conversation, whichever half of the pair says so', () => {
    // A handover starts a NEW conversation under a different harness, so the transcript is the one thing
    // that cannot cross. The plan says that twice — a null cut and a null conversation facet — and the
    // receipt refuses a plan that breaks either half, not only the cut.
    // Act + Assert
    should(
      handover.SessionHandoverReceiptSchema.safeParse({
        ...receipt,
        plan: { ...plan, facets: { ...plan.facets, conversation: { messages: [] } } },
      }).success,
    ).be.false();
  });

  it('should bind a refusal to a phase that can settle into one, and keep completed refusal-free', () => {
    // A refusal is the durable settlement intent, so where it may sit is part of the contract: a terminal
    // failure phase must carry one, `completed` must not, and a nonterminal phase may only carry one when
    // its own track has a legal terminal failure edge to settle onto. `relinquished` has none — its only
    // successor is `predecessor_stopped` — so a refusal parked there describes an outcome that can never
    // be reached from it.
    // Act + Assert
    assertRejects([
      {
        name: 'a terminal failure phase with no refusal',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...receipt, phase: 'refused' as const, phaseHistory: history(['requested', 'refused']) },
      },
      {
        name: 'a completed receipt carrying a refusal',
        schema: handover.SessionHandoverReceiptSchema,
        value: { ...receipt, refusal: { failure: 'step_failed', message: 'late' } },
      },
      {
        name: 'a nonterminal refusal on a phase with no terminal failure edge',
        schema: handover.SessionHandoverReceiptSchema,
        value: {
          ...receipt,
          phase: 'relinquished' as const,
          phaseHistory: history(BOARD_LADDER.slice(0, BOARD_LADDER.indexOf('relinquished') + 1)),
          refusal: { failure: 'step_failed', message: 'the stop never ran' },
        },
      },
    ]);
  });

  it('should parse a handover request and reject unknown fields and a missing coordinator', () => {
    // Act + Assert — a non-board root states coordinator: null explicitly.
    should(handover.SessionHandoverRequestSchema.safeParse({ ...request, coordinator: null }).success).be.true();
    assertRejects([
      {
        name: 'unknown request field',
        schema: handover.SessionHandoverRequestSchema,
        value: { ...request, planId: 'p' },
      },
      {
        name: 'missing coordinator',
        schema: handover.SessionHandoverRequestSchema,
        value: { agent: request.agent, model: request.model, reason: request.reason },
      },
      {
        name: 'missing reason',
        schema: handover.SessionHandoverRequestSchema,
        value: { agent: request.agent, coordinator: request.coordinator },
      },
    ]);
  });
});
