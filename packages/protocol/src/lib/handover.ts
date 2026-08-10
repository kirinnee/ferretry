import { z } from 'zod';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';
import { HarnessSchema } from './session.ts';
import { SessionTransferPlanSchema } from './session-transfer.ts';

/**
 * Cross-harness handover (row 48) — the protocol-owned wire contract.
 *
 * A handover starts a replacement top-level session with full durable coordination state on a different
 * harness, invites it onto the predecessor's shared board, verifies it can act, then lets the predecessor
 * relinquish membership and stop. The board and its tasks never move. This module is the wire authority:
 * the daemon drives the state machine, the protocol owns its shape, and the CLI/PWA consume it without
 * restating either closed set.
 */

/**
 * Progress and terminal phases of one handover. Terminal failures are phases too: the receipt's `phase`
 * becomes one of `refused` / `abandoned` / `stranded` / `failed`. `accepted` is the point of no return —
 * after it the board holds two active roots and there is no grant-revoke reducer, so an unverified
 * handover parks in `stranded` and destroys nothing. `coordinator_started` records the post-grant launch
 * and liveness proof before the coordinator is seated.
 */
export const SESSION_HANDOVER_PHASES = [
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
  'refused',
  'abandoned',
  'stranded',
  'failed',
] as const;
export const SessionHandoverPhaseSchema = z.enum(SESSION_HANDOVER_PHASES);
export type SessionHandoverPhase = z.infer<typeof SessionHandoverPhaseSchema>;

/**
 * Actionable refusal CAUSES — distinct from the terminal PHASE (`refused` / `abandoned` / `stranded` /
 * `failed`), which is the coarse outcome. A terminal receipt's `refusal.failure` always names the specific
 * cause below; the daemon maps each cause to its terminal phase. The single protocol-owned set the daemon,
 * CLI and mount all import — no second enumeration. Groupings are for readers only; the enum is a set.
 *
 * Eligibility / early refusal: not_top_level, mode_not_invitable, no_live_coordinator, coordinator_required,
 * harness_same, harness_unknown, source_not_found, already_completed, in_flight, request_conflict, board_busy,
 * board_authority_required. Runtime / drift: source_lost, preflight_blocked, verification_timeout,
 * replacement_terminal, board_moved, plan_drifted, step_failed. Operator: cancelled.
 *
 * `source_not_found` is a BEGIN-TIME eligibility refusal (the subject never existed for this handover);
 * `source_lost` is the external death of a live predecessor mid-flight, and it is the ONLY cause that may
 * settle `failed` before the retirement tail (§4). Keeping them apart is what lets the schema permit that
 * narrow edge without opening a generic skipped-success path.
 */
export const SESSION_HANDOVER_FAILURES = [
  'not_top_level',
  'mode_not_invitable',
  'no_live_coordinator',
  'coordinator_required',
  'harness_same',
  'harness_unknown',
  'source_not_found',
  'already_completed',
  'in_flight',
  'request_conflict',
  'board_busy',
  'board_authority_required',
  'source_lost',
  'preflight_blocked',
  'verification_timeout',
  'replacement_terminal',
  'board_moved',
  'plan_drifted',
  'step_failed',
  'cancelled',
] as const;
export const SessionHandoverFailureSchema = z.enum(SESSION_HANDOVER_FAILURES);
export type SessionHandoverFailure = z.infer<typeof SessionHandoverFailureSchema>;

/** The agent/model spec naming either the replacement or its coordinator descendant (caller's request). */
const HandoverAgentSpecSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
});

/**
 * POST /v1/sessions/:sessionId/handover body. `requestId` is NOT in the body: it travels on
 * FY_REQUEST_ID_HEADER, and the resolved target + plan are frozen by the daemon onto the receipt.
 * `coordinator` is non-null IF AND ONLY IF the source is on a board: a board root that sends `null` and a
 * boardless root that names a coordinator are both refused `coordinator_required`, because each is the same
 * shape invariant broken in one direction. `null` is therefore the total record for a boardless root rather
 * than an omission, and the client must not guess board membership or silently downgrade a board handover.
 */
export const SessionHandoverRequestSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  coordinator: HandoverAgentSpecSchema.nullable(),
  reason: z.string().min(1),
});
export type SessionHandoverRequest = z.infer<typeof SessionHandoverRequestSchema>;
export type SessionHandoverRequestInput = z.input<typeof SessionHandoverRequestSchema>;

/** A fully resolved account the daemon froze at begin — the durable launch fact, never re-resolved. */
export const SessionHandoverResolvedAccountSchema = z.strictObject({
  accountId: z.string().min(1),
  agent: z.string().min(1),
  harness: HarnessSchema,
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
  contextWindow: PositiveIntegerSchema,
});
export type SessionHandoverResolvedAccount = z.infer<typeof SessionHandoverResolvedAccountSchema>;

/** The replacement target plus, for a board root, the coordinator descendant it will spawn. */
export const SessionHandoverResolvedTargetSchema = z.strictObject({
  replacement: SessionHandoverResolvedAccountSchema,
  coordinator: SessionHandoverResolvedAccountSchema.nullable(),
});
export type SessionHandoverResolvedTarget = z.infer<typeof SessionHandoverResolvedTargetSchema>;

/**
 * The predecessor's board. The first four fields are the §4.9 invariant anchor — captured at begin and
 * compared as a tuple on every board advance, because the board document is never re-created across a
 * handover (a later replacement root may hand over again, but boardId plus creator/canonical/createdAt must
 * not drift). The invitation/grant ids fill in as the board leg advances.
 */
export const SessionHandoverBoardRefSchema = z.strictObject({
  boardId: z.string().min(1),
  creatorSessionId: z.string().min(1),
  canonicalSessionId: z.string().min(1),
  createdAt: InstantSchema,
  invitationRequestId: z.string().min(1).optional(),
  grantId: z.string().min(1).optional(),
});
export type SessionHandoverBoardRef = z.infer<typeof SessionHandoverBoardRefSchema>;

/** The structured substep intent for a classification-changing side effect: acceptance or retirement. */
export const SessionHandoverEffectIntentSchema = z.enum(['accepting', 'retiring']);
export type SessionHandoverEffectIntent = z.infer<typeof SessionHandoverEffectIntentSchema>;

/**
 * One append-only entry in the receipt's phase history; the same phase may repeat with new detail.
 *
 * `effectIntent` here is the DURABLE PROVENANCE of a classification-changing side effect, stamped in the
 * same write that activates the receipt's own `effectIntent` and RETAINED after that active field clears.
 * Without it, a terminal receipt could not prove that an otherwise-skipped transition was authorized by a
 * committed effect — the active field alone is erased by the very transition it authorized. It is a typed
 * value, never inferred from `detail` text.
 */
export const SessionHandoverPhaseEventSchema = z.strictObject({
  phase: SessionHandoverPhaseSchema,
  at: InstantSchema,
  detail: z.string().min(1).optional(),
  effectIntent: SessionHandoverEffectIntentSchema.optional(),
});
export type SessionHandoverPhaseEvent = z.infer<typeof SessionHandoverPhaseEventSchema>;

/** A terminal failure's actionable datum: a named cause and an operator-facing message. */
export const SessionHandoverRefusalSchema = z.strictObject({
  failure: SessionHandoverFailureSchema,
  message: z.string().min(1),
});
export type SessionHandoverRefusal = z.infer<typeof SessionHandoverRefusalSchema>;

const TERMINAL_FAILURE_PHASES: readonly SessionHandoverPhase[] = ['refused', 'abandoned', 'stranded', 'failed'];

/** Board-track linear successor for each progress phase. */
const BOARD_LADDER_NEXT: Readonly<Record<string, SessionHandoverPhase | undefined>> = {
  requested: 'replacement_creating',
  replacement_creating: 'replacement_created',
  replacement_created: 'invited',
  invited: 'approved',
  approved: 'accepted',
  accepted: 'replacement_started',
  replacement_started: 'verified',
  verified: 'coordinator_creating',
  coordinator_creating: 'coordinator_created',
  coordinator_created: 'coordinator_granted',
  coordinator_granted: 'coordinator_started',
  coordinator_started: 'coordinator_replaced',
  coordinator_replaced: 'draining',
  draining: 'relinquished',
  relinquished: 'predecessor_stopped',
  predecessor_stopped: 'completed',
};

/** Boardless handovers skip the board leg AND relinquished (no membership to relinquish):
 *  replacement_created -> replacement_started -> draining -> predecessor_stopped. */
const BOARDLESS_NEXT: Readonly<Record<string, SessionHandoverPhase | undefined>> = {
  replacement_created: 'replacement_started',
  replacement_started: 'draining',
  draining: 'predecessor_stopped',
};

const includes = (values: readonly string[], target: string): boolean => values.includes(target);

/**
 * Progress phases from which `failed` may terminate EARLY — that is, before the predecessor stop. This edge
 * is deliberately NOT generic: the refinement additionally demands either the dedicated `source_lost` cause
 * (external death of a live predecessor, §4) or committed-effect provenance for an irreversible substep.
 * Generic `failed` (e.g. `step_failed`) stays reachable only from `predecessor_stopped`, so an arbitrary
 * skipped-success trace such as requested -> failed with `step_failed` is refused.
 */
const EARLY_FAILED_FROM: readonly SessionHandoverPhase[] = [
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

/**
 * The exact allowed successor set for a phase on this receipt's track. Replaces rank-only monotonicity,
 * which accepted impossible traces (e.g. accepted -> predecessor_stopped). Same-phase transitions are
 * allowed separately (a phase may repeat to record fresh detail). Terminal reachability follows the
 * contract: refused before any replacement existed; abandoned for a created, unaccepted replacement
 * (boardless has no acceptance, so its post-create pre-stop range); stranded board-only past acceptance;
 * failed once the predecessor is stopped.
 */
const legalNext = (from: SessionHandoverPhase, board: boolean): readonly SessionHandoverPhase[] => {
  const next: SessionHandoverPhase[] = [];
  const ladderNext = board ? BOARD_LADDER_NEXT[from] : (BOARDLESS_NEXT[from] ?? BOARD_LADDER_NEXT[from]);
  if (ladderNext !== undefined) next.push(ladderNext);
  if (from === 'requested' || from === 'replacement_creating') next.push('refused');
  if (board) {
    if (includes(['replacement_creating', 'replacement_created', 'invited', 'approved'], from)) next.push('abandoned');
    // `approved` reaches `stranded` only with committed accepting provenance (checked in the refinement):
    // the board grant may have committed before the receipt recorded `accepted`.
    if (from === 'approved') next.push('stranded');
    if (
      includes(
        [
          'accepted',
          'replacement_started',
          'verified',
          'coordinator_creating',
          'coordinator_created',
          'coordinator_granted',
          'coordinator_started',
          'coordinator_replaced',
          'draining',
        ],
        from,
      )
    ) {
      next.push('stranded');
    }
  } else if (includes(['replacement_creating', 'replacement_created', 'replacement_started', 'draining'], from)) {
    next.push('abandoned');
  }
  if (from === 'predecessor_stopped' || includes(EARLY_FAILED_FROM, from)) next.push('failed');
  return next;
};

/**
 * The durable handover receipt — the one owner of every fact a restart needs, frozen before any replacement
 * identity or session is created. It carries the caller's `reason`, the fully `resolvedTarget`, and the full
 * immutable `plan`; `planId` is a join key refined against `plan.planId` and the source/replacement anchors,
 * so manifest or source drift cannot turn a legitimate replay into a different launch. `board` is ALWAYS
 * present (null for a non-board handover) and, when set, carries the §4.9 anchor; `cancelRequestId` records
 * the cancel operation. A terminal receipt stays inspectable through GET at every phase.
 *
 * The refinement makes damaged durable state fail validation: the phaseHistory is a legal walk on the
 * board/boardless transition graph that begins at `requested` and ends at the current phase; the plan and
 * resolved target agree with the receipt's own source/replacement fields; and a terminal failure carries an
 * actionable refusal while `completed` carries none.
 *
 * `refusal` is the durable SETTLEMENT INTENT as well as the terminal outcome. It may sit on a nonterminal
 * progress phase for ANY named cause whose phase has a legal terminal failure edge on this track, so a crash
 * between the intent and its side effect recovers to the same settlement rather than resuming the ladder.
 * `cancelRequestId` is present exactly for `cancelled`, and is additionally RETAINED when `source_lost`
 * supersedes a cancellation — an operator's cancel identity is immutable provenance. A cancellation itself is
 * bounded (board: before `accepted`; boardless: before `predecessor_stopped`) and never lands on
 * `stranded`/`failed`, while a terminal `source_lost` is always `failed`.
 *
 * Committed-effect provenance (`effectIntent` on a phase event) both authorizes and constrains: it permits
 * the irreversible shortcuts (`approved` → `stranded`, `draining` → `failed`) and forbids the unwinds past a
 * point of no return (a committed `accepting` may not settle `abandoned`; a committed `retiring` tail may not
 * settle `abandoned` or `stranded`). An active `effectIntent` must be stamped on the current same-phase
 * entry and may not be dropped by a plain same-phase write — only a settlement-intent write may replace it.
 */
export const SessionHandoverReceiptSchema = z
  .strictObject({
    requestId: z.string().min(1),
    fingerprint: z.string().min(1),
    reason: z.string().min(1),
    sourceSessionId: z.string().min(1),
    sourceHarness: HarnessSchema,
    sourceAgent: z.string().min(1),
    sourceTeammate: z.string().min(1).optional(),
    resolvedTarget: SessionHandoverResolvedTargetSchema,
    planId: z.string().min(1),
    plan: SessionTransferPlanSchema,
    replacementSessionId: z.string().min(1).optional(),
    coordinatorSessionId: z.string().min(1).optional(),
    board: SessionHandoverBoardRefSchema.nullable(),
    phase: SessionHandoverPhaseSchema,
    phaseHistory: z.array(SessionHandoverPhaseEventSchema).readonly(),
    inflightReportPath: z.string().min(1).optional(),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    refusal: SessionHandoverRefusalSchema.optional(),
    cancelRequestId: z.string().min(1).optional(),
    effectIntent: SessionHandoverEffectIntentSchema.optional(),
  })
  .superRefine((value, context) => {
    const add = (message: string, path: (string | number)[]): void => {
      context.addIssue({ code: 'custom', message, path });
    };
    const {
      phase,
      phaseHistory,
      refusal,
      board,
      cancelRequestId,
      effectIntent,
      plan,
      resolvedTarget,
      planId,
      sourceSessionId,
      sourceHarness,
      sourceAgent,
      sourceTeammate,
      replacementSessionId,
      coordinatorSessionId,
    } = value;
    const isTerminalFailure = (TERMINAL_FAILURE_PHASES as readonly string[]).includes(phase);
    const onBoardTrack = board !== null;
    const trace = phaseHistory.map(entry => entry.phase);
    const reached = (target: SessionHandoverPhase): boolean => trace.includes(target);

    if (trace.length === 0) {
      add('phaseHistory must record at least the requested phase', ['phaseHistory']);
    } else {
      if (trace[0] !== 'requested') add('phaseHistory must begin at requested', ['phaseHistory', 0, 'phase']);
      if (trace[trace.length - 1] !== phase) {
        add('phaseHistory must end at the current phase', ['phaseHistory', trace.length - 1, 'phase']);
      }
      for (let index = 1; index < trace.length; index += 1) {
        const previous = trace[index - 1];
        const current = trace[index];
        if (previous === undefined || current === undefined) continue;
        if (current !== previous && !includes(legalNext(previous, onBoardTrack), current)) {
          add(`${previous} -> ${current} is not a legal handover transition`, ['phaseHistory', index, 'phase']);
        }
      }
    }

    if (planId !== plan.planId) add('planId must equal plan.planId', ['planId']);
    if (plan.source.cutMessagePoint !== null) {
      add('a handover plan carries no conversation cut (cutMessagePoint must be null)', [
        'plan',
        'source',
        'cutMessagePoint',
      ]);
    }
    if (plan.facets.conversation !== null) {
      add('a handover plan carries no conversation facet (must be null)', ['plan', 'facets', 'conversation']);
    }
    if (sourceSessionId !== plan.source.sessionId)
      add('sourceSessionId must agree with plan.source.sessionId', ['sourceSessionId']);
    if (sourceHarness !== plan.source.harness)
      add('sourceHarness must agree with plan.source.harness', ['sourceHarness']);
    if (sourceAgent !== plan.source.agent) add('sourceAgent must agree with plan.source.agent', ['sourceAgent']);
    if ((sourceTeammate ?? null) !== plan.source.teammate) {
      add('sourceTeammate must agree with plan.source.teammate', ['sourceTeammate']);
    }
    const replacement = resolvedTarget.replacement;
    const target = plan.target;
    if (replacement.accountId !== target.accountId)
      add('resolvedTarget.replacement.accountId must agree with plan.target.accountId', [
        'resolvedTarget',
        'replacement',
        'accountId',
      ]);
    if (replacement.agent !== target.agent)
      add('resolvedTarget.replacement.agent must agree with plan.target.agent', [
        'resolvedTarget',
        'replacement',
        'agent',
      ]);
    if (replacement.harness !== target.harness)
      add('resolvedTarget.replacement.harness must agree with plan.target.harness', [
        'resolvedTarget',
        'replacement',
        'harness',
      ]);
    if (replacement.model !== target.model)
      add('resolvedTarget.replacement.model must agree with plan.target.model', [
        'resolvedTarget',
        'replacement',
        'model',
      ]);
    if (replacement.effort !== target.effort)
      add('resolvedTarget.replacement.effort must agree with plan.target.effort', [
        'resolvedTarget',
        'replacement',
        'effort',
      ]);
    if (replacement.contextWindow !== target.contextWindow) {
      add('resolvedTarget.replacement.contextWindow must agree with plan.target.contextWindow', [
        'resolvedTarget',
        'replacement',
        'contextWindow',
      ]);
    }

    if (onBoardTrack !== (resolvedTarget.coordinator !== null)) {
      add('board membership and resolvedTarget.coordinator must agree (board iff coordinator target)', [
        'resolvedTarget',
        'coordinator',
      ]);
    }

    if ((reached('replacement_creating') || phase === 'abandoned') && replacementSessionId === undefined) {
      add('replacementSessionId is written ahead from replacement_creating', ['replacementSessionId']);
    }
    if (onBoardTrack && reached('coordinator_creating') && coordinatorSessionId === undefined) {
      add('coordinatorSessionId is written ahead from coordinator_creating on a board root', ['coordinatorSessionId']);
    }

    if (board !== null) {
      if (reached('invited') && board.invitationRequestId === undefined) {
        add('board.invitationRequestId is present from invited onward', ['board', 'invitationRequestId']);
      }
      if (reached('accepted') && board.grantId === undefined) {
        add('board.grantId is present from accepted onward', ['board', 'grantId']);
      }
    }

    // Committed-effect PROVENANCE: each stamped phase event must sit on the phase and track that authorizes
    // it, and it survives the clearing of the active field so a terminal receipt can still prove the window
    // was entered.
    for (const [index, event] of phaseHistory.entries()) {
      if (event.effectIntent === undefined) continue;
      if (event.effectIntent === 'accepting' && (!onBoardTrack || event.phase !== 'approved')) {
        add('an accepting event is valid only at approved on the board track', ['phaseHistory', index, 'effectIntent']);
      }
      if (event.effectIntent === 'retiring' && event.phase !== 'draining') {
        add('a retiring event is valid only at draining', ['phaseHistory', index, 'effectIntent']);
      }
    }
    const committed = (intent: 'accepting' | 'retiring'): boolean =>
      phaseHistory.some(event => event.effectIntent === intent);
    const lastEvent = phaseHistory[phaseHistory.length - 1];

    // effectIntent: the two classification-changing side effects, as a structured substep intent (never
    // encoded in phaseHistory detail). accepting is the board point of no return at approved; retiring is
    // the post-preflight intent at draining. They never coexist with a failure refusal or a terminal phase.
    if (effectIntent !== undefined && lastEvent?.effectIntent !== effectIntent) {
      add('an active effect intent must be stamped on the current same-phase history entry', ['effectIntent']);
    }
    if (effectIntent !== undefined) {
      if (isTerminalFailure) add('an effect intent is not valid on a terminal receipt', ['effectIntent']);
      if (effectIntent === 'accepting' && (!onBoardTrack || phase !== 'approved')) {
        add('accepting intent is valid only for a board receipt at approved', ['effectIntent']);
      }
      if (effectIntent === 'retiring' && phase !== 'draining') {
        add('retiring intent is valid only at draining', ['effectIntent']);
      }
      if (refusal !== undefined) {
        add('a receipt cannot carry both an effect intent and a failure refusal', ['effectIntent']);
      }
    }

    // refusal is the durable settlement intent as well as the terminal outcome: it may sit on a nonterminal
    // progress phase for any named cause when that phase has a legal terminal failure edge on its track, so
    // a crash before the terminal side effect still recovers to the same settlement.
    // An EARLY `failed` (before the predecessor stop) is the narrow source-loss settlement, or an
    // irreversible shortcut backed by committed-effect provenance. Generic causes stay post-stop, so
    // requested -> failed with `step_failed` is refused while its `source_lost` twin is accepted.
    if (phase === 'failed' && !reached('predecessor_stopped')) {
      const priorPhase = trace[trace.length - 2];
      // Only the COMMITTED RETIRING tail authorizes a generic early `failed`: there the predecessor is
      // already being retired, so `failed` makes no false promise. A committed `accepting` does NOT — the
      // source is still live and still a member while the replacement may have been admitted, so the honest
      // generic outcome there is `stranded` plus Attention. `source_lost` remains the one cause that may
      // settle `failed` from any progress phase, because the predecessor really is gone.
      const shortcutProven = priorPhase === 'draining' && committed('retiring');
      if (refusal?.failure !== 'source_lost' && !shortcutProven) {
        add('failed before predecessor_stopped requires the source_lost cause or committed-effect provenance', [
          'refusal',
          'failure',
        ]);
      }
    }
    // stranded past `approved` without acceptance is likewise only honest with committed accepting
    // provenance: the board grant may have committed even though the receipt never recorded `accepted`.
    if (phase === 'stranded' && !reached('accepted') && !committed('accepting')) {
      add('stranded before accepted requires committed accepting provenance', ['phaseHistory']);
    }

    // Committed provenance does not merely AUTHORIZE the forward shortcuts — it also FORBIDS the unwinds.
    // Past a point of no return the replacement may hold an unrevokeable grant, so a terminal that promises
    // it was disposed of, or that the predecessor is still a member, would be a false record.
    if (committed('accepting') && phase === 'abandoned') {
      add('a committed accepting substep may not settle abandoned: the grant may be unrevokeable', ['phase']);
    }
    if (committed('retiring') && (phase === 'abandoned' || phase === 'stranded')) {
      add('a committed retiring tail may only roll forward: abandoned and stranded are not legal there', ['phase']);
    }

    if (isTerminalFailure && refusal === undefined) {
      add('a terminal failure phase must carry an actionable refusal', ['refusal']);
    }
    if (phase === 'completed' && refusal !== undefined) {
      add('a completed receipt must not carry a refusal', ['refusal']);
    }
    if (!isTerminalFailure && refusal !== undefined && phase !== 'completed') {
      const hasTerminalEdge = legalNext(phase, onBoardTrack).some(target =>
        (TERMINAL_FAILURE_PHASES as readonly string[]).includes(target),
      );
      if (!hasTerminalEdge) {
        add('a nonterminal refusal requires a legal terminal failure edge on this track', ['refusal', 'failure']);
      }
    }
    if (refusal?.failure === 'cancelled' && (phase === 'stranded' || phase === 'failed')) {
      add('a cancelled outcome is never stranded or failed', ['refusal', 'failure']);
    }
    // The cancellation boundary is the point of no return, and COMMITTED provenance crosses it before the
    // phase that records it: an `accepting` stamp means the board grant may already have committed even
    // though the receipt never reached `accepted`, and a `retiring` stamp means the retirement tail is
    // underway before `predecessor_stopped` is written. Keying only on the reached phases would let a cancel
    // slip through exactly the window the settlement exception opens.
    if (refusal?.failure === 'cancelled' && onBoardTrack && (reached('accepted') || committed('accepting'))) {
      add('a board handover can be cancelled only before acceptance is attempted', ['refusal', 'failure']);
    }
    if (
      refusal?.failure === 'cancelled' &&
      !onBoardTrack &&
      (reached('predecessor_stopped') || committed('retiring'))
    ) {
      add('a boardless handover can be cancelled only before retirement is committed', ['refusal', 'failure']);
    }

    // `cancelRequestId` is immutable historical provenance: a durable cancellation always records it, and it
    // SURVIVES when external source loss supersedes that cancellation (the honest terminal becomes `failed`
    // with `source_lost`, but the operator's cancel identity is never erased or replaced). Any other pairing
    // with a non-cancel cause would be an unexplained id.
    // A terminal `source_lost` is always `failed`: the predecessor died outside the recorded retirement
    // tail, so refused/abandoned/stranded would each make a false promise about the source's state. The
    // NONTERMINAL source_lost intent stays legal while cleanup is still pending.
    if (refusal?.failure === 'source_lost' && isTerminalFailure && phase !== 'failed') {
      add('a terminal source_lost outcome must be failed', ['refusal', 'failure']);
    }

    // Provenance may not be silently dropped while its substep phase is still active: a plain same-phase
    // detail write that erases the active field would let a possibly committed acceptance or retirement read
    // as reversible after a damaged write. The ONE deliberate exception is a durable settlement-intent
    // write, which replaces the mutually exclusive active effect with a nonterminal refusal on that same
    // phase — that refusal is the write-ahead proof for the provenance-backed stranded/failed edge.
    if (effectIntent === undefined && !isTerminalFailure && refusal === undefined) {
      if (phase === 'approved' && committed('accepting') && !reached('accepted')) {
        add('accepting intent may not be cleared while the receipt is still at approved', ['effectIntent']);
      }
      if (phase === 'draining' && committed('retiring')) {
        add('retiring intent may not be cleared while the receipt is still at draining', ['effectIntent']);
      }
    }

    const isCancelled = refusal?.failure === 'cancelled';
    // Source loss may supersede an in-flight cancellation, and C1's identity is immutable provenance — so
    // the retained id is legal from the write-ahead nonterminal intent through the terminal `failed`.
    const supersededBySourceLoss = refusal?.failure === 'source_lost';
    if (isCancelled && cancelRequestId === undefined) {
      add('a cancelled handover must record the cancel operation id', ['cancelRequestId']);
    }
    if (!isCancelled && !supersededBySourceLoss && cancelRequestId !== undefined) {
      add('cancelRequestId is retained only for a cancelled handover or a source_lost supersession', [
        'cancelRequestId',
      ]);
    }
  });
export type SessionHandoverReceipt = z.infer<typeof SessionHandoverReceiptSchema>;
