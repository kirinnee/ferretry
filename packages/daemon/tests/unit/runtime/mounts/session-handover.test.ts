import { describe, it } from 'bun:test';
import {
  FY_REQUEST_ID_HEADER,
  type SessionHandoverFailure,
  type SessionHandoverReceipt,
  SessionHandoverReceiptSchema,
  type SessionHandoverRequest,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { HandoverError } from '../../../../src/lib/handover/types.ts';
import {
  type SessionHandoverSubsystem,
  sessionHandoverRoutes,
} from '../../../../src/lib/runtime/mounts/session-handover.ts';
import { bodyReads, request } from '../../api/support.ts';
import { receiptAt } from '../../handover/support.ts';
import { agentIn, CREDENTIALS, human } from './support.ts';

/**
 * The handover surface: what a caller may ask for, what each refusal answers, and what comes back.
 *
 * Every case goes through the real dispatcher and the real credentials, because the scope each route
 * is served under is the point of half of them: a handover creates a privileged session and changes
 * board membership, so the writes are as closed as the start and the stop, while the read of what
 * happened is a lesser thing a paired device may do. The subsystem behind the routes is a fake — the
 * state machine it drives has its own coverage — so what is proved here is the route table, the
 * credential policy, the request-id contract, the refusal-to-HTTP mapping, and the receipt read.
 */

/**
 * A receipt at any phase, for the exact session a case addressed.
 *
 * It is the HANDOVER DOMAIN'S OWN fixture (`tests/unit/handover/support.ts`), not a second one built
 * here: the receipt carries a reason, a resolved target and a whole frozen transfer plan whose fields
 * the protocol schema cross-checks against each other, and a copy maintained beside the route table
 * would drift from those refinements the first time the domain that owns them moved. Every receipt is
 * then re-parsed through `SessionHandoverReceiptSchema` before it is served, so a case cannot pass on a
 * document the daemon could not actually have written.
 *
 * A terminal failure phase carries the refusal the schema demands of one; `cancelRequestId` accompanies
 * `abandoned`, which is the phase a cancel produces.
 */
const AT = '2026-02-01T00:00:00.000Z';

/**
 * The board ladder as far as any case here needs it, so a terminal phase is reached along a path the
 * protocol calls legal rather than jumped to.
 *
 * The schema validates the WHOLE trace — `requested -> stranded` is refused as an impossible history —
 * so a fixture that named only the phase it wanted would be describing a receipt the daemon could never
 * have written, and every case built on it would prove nothing about the route.
 */
const LADDER_TO: Readonly<Record<string, readonly SessionHandoverReceipt['phase'][]>> = {
  stranded: ['requested', 'replacement_creating', 'replacement_created', 'invited', 'approved', 'accepted', 'stranded'],
  abandoned: ['requested', 'replacement_creating', 'abandoned'],
};

const TERMINAL_FAILURE_CAUSE = {
  abandoned: 'cancelled',
  stranded: 'verification_timeout',
} as const satisfies Partial<Record<SessionHandoverReceipt['phase'], SessionHandoverFailure>>;

/**
 * A receipt at any phase, for the exact session a case addressed.
 *
 * Built from the HANDOVER DOMAIN'S OWN fixture rather than a second one maintained here: the receipt
 * carries a reason, a resolved target and a whole frozen transfer plan whose fields the protocol schema
 * cross-checks against each other, and a local copy would drift from those refinements the first time
 * the domain that owns them moved. Every receipt is re-parsed through `SessionHandoverReceiptSchema`
 * before a case may use it, so no case can pass on a document the daemon could not have written.
 */
function handoverReceipt(phase: SessionHandoverReceipt['phase'] = 'requested'): SessionHandoverReceipt {
  const cause = (TERMINAL_FAILURE_CAUSE as Partial<Record<string, SessionHandoverFailure>>)[phase];
  const path = LADDER_TO[phase];
  const walked = new Set<string>(path ?? [phase]);
  const base = receiptAt(phase);
  return SessionHandoverReceiptSchema.parse({
    ...base,
    ...(path === undefined ? {} : { phaseHistory: path.map(step => ({ phase: step, at: AT })) }),
    // The board section fills in as the board leg advances, and the schema checks that it has: an
    // invitation id from `invited` onward, a grant id from `accepted` onward. A receipt that walked
    // past those phases without them would be a document the daemon could not have written.
    ...(base.board === null
      ? {}
      : {
          board: {
            ...base.board,
            ...(walked.has('invited') ? { invitationRequestId: 'invite-1' } : {}),
            ...(walked.has('accepted') ? { grantId: 'grant-1' } : {}),
          },
        }),
    ...(cause === undefined
      ? {}
      : {
          refusal: { failure: cause, message: 'the handover stopped here' },
          ...(cause === 'cancelled' ? { cancelRequestId: 'req-cancel' } : {}),
        }),
  });
}

/**
 * A handover subsystem that records instead of driving the state machine.
 *
 * The REQUEST and the request id are what this fake exists to capture: every field of the parsed body
 * is a decision the daemon makes, and the request id never appears in the body — so proving both
 * arrive is the difference between a handover that names what it was asked and one that guesses. Its
 * refusals are keyed by session, so every HTTP answer the mount can give is reachable without a board,
 * a pane or a real replacement behind it.
 */
class FakeSessionHandover implements SessionHandoverSubsystem {
  readonly begins: Array<readonly [string, SessionHandoverRequest, string]> = [];
  readonly reads: string[] = [];
  readonly cancels: Array<readonly [string, string]> = [];

  constructor(
    private readonly refusals: Readonly<Record<string, HandoverError>> = {},
    private readonly phase: SessionHandoverReceipt['phase'] = 'requested',
  ) {}

  async begin(sessionId: string, request: SessionHandoverRequest, requestId: string): Promise<SessionHandoverReceipt> {
    this.begins.push([sessionId, request, requestId]);
    return this.answer(sessionId);
  }

  async receipt(sessionId: string): Promise<SessionHandoverReceipt> {
    this.reads.push(sessionId);
    return this.answer(sessionId);
  }

  async cancel(sessionId: string, requestId: string): Promise<SessionHandoverReceipt> {
    this.cancels.push([sessionId, requestId]);
    return this.answer(sessionId, 'abandoned');
  }

  /**
   * The refusal this session was set up to raise, or the shared receipt.
   *
   * The receipt always describes the fixture's own source session rather than the id in the path,
   * because the protocol cross-checks the receipt's source against the frozen plan inside it — an id
   * substituted here would produce a document the daemon could never have written. What the path id
   * proves is recorded separately, in `begins` / `reads` / `cancels`.
   */
  private answer(sessionId: string, phase?: SessionHandoverReceipt['phase']): SessionHandoverReceipt {
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    return handoverReceipt(phase ?? this.phase);
  }
}

function dispatcher(subsystem: SessionHandoverSubsystem = new FakeSessionHandover()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionHandoverRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

/** Every POST below that is not ABOUT the request id carries one, so the cases that test something else
 *  do not also re-test its absence. A case that wants a specific id, or none, passes its own headers. */
const withRequestId = (headers: Readonly<Record<string, string>>, requestId = 'req-1') => ({
  ...headers,
  [FY_REQUEST_ID_HEADER]: requestId,
});

const VALID_BODY = { agent: 'codex-auto', coordinator: null, reason: 'moving across harnesses' } as const;

function beginRequest(
  sessionId: string,
  headers: Readonly<Record<string, string>> = human,
  body: unknown = VALID_BODY,
): Parameters<ApiDispatcher['dispatch']>[0] {
  const supplied = FY_REQUEST_ID_HEADER in headers ? headers : withRequestId(headers);
  return request({
    method: 'POST',
    path: `/v1/sessions/${sessionId}/handover`,
    headers: supplied,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getRequest(
  sessionId: string,
  headers: Readonly<Record<string, string>> = human,
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'GET', path: `/v1/sessions/${sessionId}/handover`, headers });
}

function cancelRequest(
  sessionId: string,
  headers: Readonly<Record<string, string>> = human,
  body: unknown = {},
): Parameters<ApiDispatcher['dispatch']>[0] {
  const supplied = FY_REQUEST_ID_HEADER in headers ? headers : withRequestId(headers);
  return request({
    method: 'POST',
    path: `/v1/sessions/${sessionId}/handover/cancel`,
    headers: supplied,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('the session handover mount', () => {
  it('should begin a handover and answer 202 with the receipt at its first phase', async () => {
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const response = await subject.dispatch(
      beginRequest('s1', withRequestId(human, 'req-9'), {
        agent: 'codex-auto',
        model: 'gpt-5.6-terra',
        coordinator: { agent: 'codex-auto', model: 'gpt-5.6-terra' },
        reason: 'claude is wedged',
      }),
    );

    // Assert. 202 rather than 200: the receipt is at its first phase and the reconciler keeps advancing
    // it after this call returns, so a cached or "final" answer would misdescribe a live handover.
    should(response.status).equal(202);
    // Parsed with the protocol's own schema: a body the client would refuse is a handover that began
    // and then could not tell anybody what it had begun.
    const receipt = SessionHandoverReceiptSchema.parse(JSON.parse(response.body));
    should(receipt.phase).equal('requested');
    // The parsed target and the header request id pass through untouched.
    should(subsystem.begins).deepEqual([
      [
        's1',
        {
          agent: 'codex-auto',
          model: 'gpt-5.6-terra',
          coordinator: { agent: 'codex-auto', model: 'gpt-5.6-terra' },
          reason: 'claude is wedged',
        },
        'req-9',
      ],
    ]);
  });

  it('should read the durable receipt at any phase over GET, terminal phases included', async () => {
    // GET is authenticated rather than operator-scoped: a paired device checking what happened to a
    // session is a reader, not an actor.
    // Arrange
    const subsystem = new FakeSessionHandover({}, 'stranded');
    const subject = dispatcher(subsystem);

    // Act
    const response = await subject.dispatch(getRequest('s1'));

    // Assert
    should(response.status).equal(200);
    const receipt = SessionHandoverReceiptSchema.parse(JSON.parse(response.body));
    should(receipt.phase).equal('stranded');
    should(subsystem.reads).deepEqual(['s1']);
  });

  it('should cancel an in-flight handover with an empty body and answer 202', async () => {
    // The request id names the cancellation; the body is empty because a cancel takes no parameters
    // the path and the header do not already carry.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const response = await subject.dispatch(cancelRequest('s1', withRequestId(human, 'req-cancel'), {}));

    // Assert
    should(response.status).equal(202);
    SessionHandoverReceiptSchema.parse(JSON.parse(response.body));
    should(subsystem.cancels).deepEqual([['s1', 'req-cancel']]);
  });

  it('should refuse a cancel body that carries a field, because a cancel takes none', async () => {
    // A strict empty object rather than an ignored body: a cancel that silently accepted `{force: true}`
    // would let a caller believe the no-force gate can be overridden through this route, so the route
    // states the empty contract by refusing anything that is not exactly `{}`.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const forced = await subject.dispatch(cancelRequest('s1', human, { force: true }));

    // Assert
    should(forced.status).equal(400);
    should(subsystem.cancels).be.empty();
  });

  it('should refuse an unreadable, unparseable or non-object cancel body without cancelling anything', async () => {
    // The three ways a cancel body can be wrong that are NOT "it carried a field", each answered as the
    // caller-correctable refusal it is rather than as a 500 describing a daemon defect. `null` and an
    // array matter on their own: both are `typeof 'object'`, so a route that only counted keys would
    // read `[]` as an acceptable empty body and cancel a handover on a body that says nothing.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const vanished = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/handover/cancel',
        headers: withRequestId(human, 'req-gone'),
        unreadableBody: true,
      }),
    );
    const unparseable = await subject.dispatch(cancelRequest('s1', withRequestId(human, 'req-junk'), 'not json'));
    const nullBody = await subject.dispatch(cancelRequest('s1', withRequestId(human, 'req-null'), 'null'));
    const arrayBody = await subject.dispatch(cancelRequest('s1', withRequestId(human, 'req-array'), '[]'));

    // Assert
    should(vanished.status).equal(400);
    should((JSON.parse(vanished.body) as { code: string }).code).equal('unreadable_body');
    should([unparseable.status, nullBody.status, arrayBody.status]).deepEqual([400, 400, 400]);
    should(
      [unparseable, nullBody, arrayBody].map(response => (JSON.parse(response.body) as { code: string }).code),
    ).deepEqual(['invalid_body', 'invalid_body', 'invalid_body']);
    // Every one of them was decided before the subsystem was reached, so no handover was touched.
    should(subsystem.cancels).be.empty();
  });

  it('should refuse an oversized cancel body with 413, before buffering all of it', async () => {
    // A cancel's whole contract is `{}` or nothing, so an unbounded read would let a caller make this
    // daemon buffer megabytes to be told the only acceptable body was two characters. The bound is
    // enforced on the READ, and the refusal is the shared 413 every other bounded route answers with
    // rather than a 500 that would describe an ordinary caller mistake as a daemon defect.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);
    const reads = bodyReads();
    const oversized = `{"${'x'.repeat(4096)}":1}`;

    // Act
    const response = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/handover/cancel',
        headers: withRequestId(human, 'req-big'),
        body: oversized,
        // In installments, so the refusal can be shown to happen before the whole body is materialised.
        bodyPieceBytes: 256,
        reads,
      }),
    );

    // Assert
    should(response.status).equal(413);
    should((JSON.parse(response.body) as { code: string }).code).equal('body_too_large');
    // The route asked for a bound rather than an unbounded read...
    should(reads.limits).not.containEql(undefined);
    // ...and nothing reached the subsystem, so no handover was cancelled to produce this answer.
    should(subsystem.cancels).be.empty();
  });

  it('should refuse a begin that names no target, because there is no default replacement', async () => {
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const empty = await subject.dispatch(beginRequest('s1', human, ''));
    const braces = await subject.dispatch(beginRequest('s1', human, {}));
    const blank = await subject.dispatch(beginRequest('s1', human, { agent: '' }));
    const noCoordinator = await subject.dispatch(beginRequest('s1', human, { agent: 'codex-auto', reason: 'x' }));
    const noReason = await subject.dispatch(beginRequest('s1', human, { agent: 'codex-auto', coordinator: null }));

    // Assert
    should([empty.status, braces.status, blank.status, noCoordinator.status, noReason.status]).deepEqual([
      400, 400, 400, 400, 400,
    ]);
    should(subsystem.begins).be.empty();
  });

  it('should refuse a field the protocol does not carry rather than silently dropping it', async () => {
    // `SessionHandoverRequestSchema` is strict, and a route that quietly forced past a refusal would
    // make the whole gate decorative — so `force` is rejected, not accepted-and-ignored.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const forced = await subject.dispatch(beginRequest('s1', human, { ...VALID_BODY, force: true }));

    // Assert
    should(forced.status).equal(400);
    should(subsystem.begins).be.empty();
  });

  it('should refuse anonymously and refuse a warden token on the writes, but read over any credential', async () => {
    // A handover creates a privileged session and changes board membership, so the writes are operator
    // scope; the read is authenticated, because reading what happened is a lesser thing.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const anonymousWrite = await subject.dispatch(beginRequest('s1', {}));
    const wardenWrite = await subject.dispatch(beginRequest('s1', { authorization: `Bearer ${CREDENTIALS.warden}` }));
    const peerWrite = await subject.dispatch(beginRequest('s1', agentIn('s9')));
    const anonymousRead = await subject.dispatch(getRequest('s1', {}));
    const pairedRead = await subject.dispatch(getRequest('s1', agentIn('s9')));

    // Assert
    should(anonymousWrite.status).equal(401);
    should(wardenWrite.status).equal(403);
    // An agent holds the admin token, so it reaches the subsystem exactly as the start and stop allow.
    should(peerWrite.status).equal(202);
    // GET is authenticated: anonymous is refused, a paired device is not.
    should(anonymousRead.status).equal(401);
    should(pairedRead.status).equal(200);
    should(subsystem.begins).have.length(1);
    should(subsystem.reads).deepEqual(['s1']);
  });

  it('should answer each refusal the subsystem raises with its own status and code', async () => {
    // These are genuinely different next actions: reach for fy migrate, run the handover yourself,
    // name a coordinator for a board root, wait for the predecessor, or investigate a step that failed
    // after the retirement.
    // Arrange
    const subject = dispatcher(
      new FakeSessionHandover({
        child: new HandoverError('not_top_level', 'session child has a parent'),
        root: new HandoverError(
          'coordinator_required',
          'a board root must name the coordinator descendant that succeeds its own',
        ),
        same: new HandoverError('harness_same', 'codex-auto is also a claude account — use fy migrate'),
        unknown: new HandoverError('harness_unknown', 'neither family could be recognised'),
        gone: new HandoverError('source_not_found', 'no session gone'),
        busy: new HandoverError('board_busy', 'board already carries an outstanding invitation'),
        warden: new HandoverError('board_authority_required', 'a warden cannot widen board membership'),
        again: new HandoverError('in_flight', 'another handover of this root is already under way'),
        replay: new HandoverError('request_conflict', 'this request id named a different target'),
        blocked: new HandoverError('preflight_blocked', 'a destructive command is in flight'),
        lost: new HandoverError('source_lost', 'the predecessor was killed by something outside this handover'),
        drifted: new HandoverError('plan_drifted', 're-preparing produced a different plan'),
        stuck: new HandoverError('step_failed', 'a step failed after the predecessor was stopped'),
      }),
    );

    // Act
    const answers = await Promise.all(
      [
        'child',
        'same',
        'unknown',
        'gone',
        'busy',
        'warden',
        'again',
        'replay',
        'blocked',
        'lost',
        'drifted',
        'stuck',
      ].map(async id => await subject.dispatch(beginRequest(id))),
    );

    // Assert
    should(answers.map(response => [response.status, (JSON.parse(response.body) as { code: string }).code])).deepEqual([
      [409, 'not_top_level'],
      [409, 'harness_same'],
      [409, 'harness_unknown'],
      [404, 'not-found'],
      [409, 'board_busy'],
      [403, 'board_authority_required'],
      [409, 'in_flight'],
      [409, 'request_conflict'],
      [409, 'preflight_blocked'],
      // Distinct from source_not_found's 404: the predecessor WAS live and was lost under way, so a
      // handover happened and its receipt records how far it got.
      [409, 'source_lost'],
      [500, 'handover_plan_drifted'],
      [500, 'session_handover_failed'],
    ]);
  });

  it('should require a request id on both POSTs, and reach the subsystem without one never', async () => {
    // A retried POST could create a second replacement or stop a predecessor twice, so the daemon
    // refuses to begin or cancel a handover that carries no request id rather than guess it will not
    // be retried.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const beginWithoutId = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/handover',
        headers: human,
        body: JSON.stringify(VALID_BODY),
      }),
    );
    const cancelWithoutId = await subject.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/handover/cancel', headers: human, body: '{}' }),
    );

    // Assert
    should(beginWithoutId.status).equal(400);
    should((JSON.parse(beginWithoutId.body) as { code: string }).code).equal('missing_request_id');
    should(cancelWithoutId.status).equal(400);
    should((JSON.parse(cancelWithoutId.body) as { code: string }).code).equal('missing_request_id');
    should(subsystem.begins).be.empty();
    should(subsystem.cancels).be.empty();
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // A session id is a directory name downstream, and this route writes a receipt into that directory.
    // Arrange
    const subsystem = new FakeSessionHandover();
    const subject = dispatcher(subsystem);

    // Act
    const traversal = await subject.dispatch(beginRequest('%2e%2e%2fetc'));

    // Assert
    should(traversal.status).equal(400);
    should((JSON.parse(traversal.body) as { code: string }).code).equal('invalid_session_id');
    should(subsystem.begins).be.empty();
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // the handover decides, and anything else is this daemon being broken.
    // Arrange
    const subject = dispatcher(
      new FakeSessionHandover({
        // Not a HandoverError: the cast is the point of the case.
        s1: new Error('the receipt store was closed') as HandoverError,
      }),
    );

    // Act
    const response = await subject.dispatch(beginRequest('s1'));

    // Assert
    should(response.status).equal(500);
    should((JSON.parse(response.body) as { code: string }).code).not.equal('not_top_level');
  });
});
