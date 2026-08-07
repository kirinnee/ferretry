import { describe, it } from 'bun:test';
import {
  type ForkSessionFailure,
  type ForkSessionOutcome,
  ForkSessionOutcomeSchema,
  type ForkSessionPlanSummary,
  type ForkSessionRequest,
  FY_REQUEST_ID_HEADER,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionForkRefusal, sessionForkRoutes } from '../../../../src/lib/runtime/mounts/session-fork.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, human } from './support.ts';

/**
 * The fork surface: what a caller may ask for, what each refusal answers, and what comes back.
 *
 * Every case goes through the real dispatcher and the real credentials, because the scope this route
 * is served under is the point of several of them: a fork launches an agent wrapper holding this
 * daemon's own privileges, under an account the caller chose.
 *
 * The other half of the cases are about what this mount must NOT do. It holds no replay ledger — the
 * durable fork receipt owns that — so "did the subsystem see this exact request, exactly once, with
 * exactly these three arguments" is what every forwarding case asserts.
 */

const AT = '2026-08-06T07:00:00.000Z';
const POINT = { v: 1 as const, byteOffset: 4_096, blockIndex: 2 };

/** The remote-safe projection of a cross-harness plan. */
const PLAN = {
  v: 1,
  planId: 's1:req-1',
  preparedAt: AT,
  source: {
    sessionId: 's1',
    cutMessagePoint: POINT,
  },
  target: {
    agent: 'codex-auto',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    contextWindow: 200_000,
  },
  notCarried: [
    {
      facet: 'references',
      subject: '%terminal:build',
      reason: 'session_scoped',
      detail: 'a terminal belongs to the session it was opened in',
    },
  ],
} satisfies ForkSessionPlanSummary;

const sessionSummary = (id: string, agent = 'codex-auto'): ForkSessionOutcome['session'] => ({
  id,
  name: `Fork of ${id}`,
  agent,
  harness: agent.startsWith('claude') ? 'claude' : 'codex',
  model: agent.startsWith('claude') ? 'opus' : 'gpt-5.6-sol',
  status: 'running',
});

/**
 * Records exactly what reached the subsystem, and can be told what asking about a source raises.
 *
 * The recorded triple is the assertion in most cases below: the mount's whole job is to hand the
 * source id, the parsed request and the logical request id on unchanged, and a mount that helpfully
 * defaulted a model or normalised an id would be making a decision the fleet manifest owns.
 */
class FakeSessionFork {
  readonly forks: Array<readonly [string, ForkSessionRequest, string]> = [];

  constructor(private readonly refusals: Readonly<Record<string, Error>> = {}) {}

  async fork(sessionId: string, forkRequest: ForkSessionRequest, requestId: string): Promise<ForkSessionOutcome> {
    this.forks.push([sessionId, forkRequest, requestId]);
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    return { session: sessionSummary(`${sessionId}-fork`, forkRequest.agent), plan: PLAN };
  }
}

/** A subsystem that answers with a body the protocol does not describe. */
class LyingSessionFork {
  async fork(): Promise<ForkSessionOutcome> {
    return { session: sessionSummary('s2') } as unknown as ForkSessionOutcome;
  }
}

/** A subsystem that tries to put internal plan/session facts back onto the public response. */
class LeakingSessionFork {
  async fork(): Promise<ForkSessionOutcome> {
    return {
      session: { ...sessionSummary('s2'), cwd: '/daemon/work', correlationToken: 'private-proof' },
      plan: {
        ...PLAN,
        target: { ...PLAN.target, accountId: 'private-account' },
        facets: { workspace: { cwd: '/daemon/work' } },
      },
    } as unknown as ForkSessionOutcome;
  }
}

function dispatcher(subsystem: { fork: FakeSessionFork['fork'] } = new FakeSessionFork()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionForkRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

const withRequestId = (headers: Readonly<Record<string, string>>, requestId = 'req-1') => ({
  ...headers,
  [FY_REQUEST_ID_HEADER]: requestId,
});

function forkRequest(
  sessionId: string,
  headers: Readonly<Record<string, string>> = human,
  body: unknown = { through: POINT, selectionBinding: 'selection-binding-1', agent: 'codex-auto' },
): Parameters<ApiDispatcher['dispatch']>[0] {
  const supplied = FY_REQUEST_ID_HEADER in headers ? headers : withRequestId(headers);
  return request({
    method: 'POST',
    path: `/v1/sessions/${sessionId}/fork`,
    headers: supplied,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const codeOf = (response: { readonly body: string }): string => (JSON.parse(response.body) as { code: string }).code;

describe('the session fork mount', () => {
  it('should serve exactly one operator-scoped, uncached fork route', () => {
    // The route table is the daemon's own statement of what exists, and the protocol client dials
    // this exact address; a rename on either side is the shipped-404 shape the repository gates for.
    // Act
    const routes = sessionForkRoutes(new FakeSessionFork());

    // Assert
    should(routes).have.length(1);
    should(routes[0]?.method).equal('POST');
    should(routes[0]?.path).equal('/v1/sessions/:sessionId/fork');
    should(routes[0]?.minimum).equal('operator');
    should(routes[0]?.noStore).be.true();
  });

  it('should fork a session and answer with the fresh session and the plan that built it', async () => {
    // Arrange
    const forker = new FakeSessionFork();
    const subject = dispatcher(forker);

    // Act
    const response = await subject.dispatch(
      forkRequest('s1', human, {
        through: POINT,
        selectionBinding: 'selection-binding-1',
        agent: 'codex-auto',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }),
    );

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the client would refuse is a fork that happened
    // and could not tell anybody what it did or did not carry.
    const outcome = ForkSessionOutcomeSchema.parse(JSON.parse(response.body));
    should(outcome.session.id).equal('s1-fork');
    should(outcome.session.agent).equal('codex-auto');
    should(outcome.plan.notCarried).deepEqual(PLAN.notCarried);
  });

  it('should hand the subsystem the source, the parsed request and the request id unchanged', async () => {
    // The mount decides nothing. An unstated model must arrive as ABSENT rather than as a null or a
    // default, because "the caller stated no model" is what the target resolver reads.
    // Arrange
    const forker = new FakeSessionFork();
    const subject = dispatcher(forker);

    // Act
    const full = await subject.dispatch(
      forkRequest('s1', withRequestId(human, 'req-full'), {
        through: POINT,
        selectionBinding: 'selection-binding-full',
        agent: 'codex-auto',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }),
    );
    const bare = await subject.dispatch(
      forkRequest('s1', withRequestId(human, 'req-bare'), {
        through: { v: 1, byteOffset: 0, blockIndex: 0 },
        selectionBinding: 'selection-binding-bare',
        agent: 'claude-auto',
      }),
    );

    // Assert
    should([full.status, bare.status]).deepEqual([200, 200]);
    should(forker.forks).deepEqual([
      [
        's1',
        {
          through: POINT,
          selectionBinding: 'selection-binding-full',
          agent: 'codex-auto',
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
        'req-full',
      ],
      [
        's1',
        {
          through: { v: 1, byteOffset: 0, blockIndex: 0 },
          selectionBinding: 'selection-binding-bare',
          agent: 'claude-auto',
        },
        'req-bare',
      ],
    ]);
  });

  it('should not remember a request id, because the durable receipt owns replay', async () => {
    // A migration keeps an in-memory ledger because a repeat could destroy a pane twice and the
    // memory cannot be rebuilt from disk. A fork destroys nothing and its receipt IS on disk, so a
    // second ledger here would forget on restart and answer for a fact it does not own. The mount
    // must therefore pass a repeated id straight through and let the service replay it.
    // Arrange
    const forker = new FakeSessionFork();
    const subject = dispatcher(forker);

    // Act
    const first = await subject.dispatch(forkRequest('s1', withRequestId(human, 'req-same')));
    const second = await subject.dispatch(forkRequest('s1', withRequestId(human, 'req-same')));

    // Assert
    should([first.status, second.status]).deepEqual([200, 200]);
    should(forker.forks.map(([, , id]) => id)).deepEqual(['req-same', 'req-same']);
  });

  it('should refuse a fork that carries no request id, rather than one it cannot recognise twice', async () => {
    // Arrange
    const forker = new FakeSessionFork();
    const subject = dispatcher(forker);

    // Act
    const missing = await subject.dispatch(forkRequest('s1', { ...human, [FY_REQUEST_ID_HEADER]: '' }));
    const blank = await subject.dispatch(forkRequest('s1', { ...human, [FY_REQUEST_ID_HEADER]: '   ' }));

    // Assert
    should([missing.status, blank.status]).deepEqual([400, 400]);
    should([codeOf(missing), codeOf(blank)]).deepEqual(['missing_request_id', 'missing_request_id']);
    should(forker.forks).be.empty();
  });

  it('should refuse a body that is not a fork, including a field the wire does not carry', async () => {
    // Arrange
    const forker = new FakeSessionFork();
    const subject = dispatcher(forker);

    // Act
    const empty = await subject.dispatch(forkRequest('s1', human, ''));
    const braces = await subject.dispatch(forkRequest('s1', human, {}));
    const noAgent = await subject.dispatch(forkRequest('s1', human, { through: POINT }));
    const noPoint = await subject.dispatch(forkRequest('s1', human, { agent: 'codex-auto' }));
    const noBinding = await subject.dispatch(forkRequest('s1', human, { through: POINT, agent: 'codex-auto' }));
    const stringPoint = await subject.dispatch(
      forkRequest('s1', human, {
        through: '4096:2',
        selectionBinding: 'selection-binding-1',
        agent: 'codex-auto',
      }),
    );
    const board = await subject.dispatch(
      forkRequest('s1', human, {
        through: POINT,
        selectionBinding: 'selection-binding-1',
        agent: 'codex-auto',
        boardAccess: 'reader',
      }),
    );

    // Assert
    should([empty, braces, noAgent, noPoint, noBinding, stringPoint, board].map(answer => answer.status)).deepEqual([
      400, 400, 400, 400, 400, 400, 400,
    ]);
    should(forker.forks).be.empty();
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // A session id is a directory name downstream, and a fork reads a transcript out of one.
    // Arrange
    const forker = new FakeSessionFork();
    const subject = dispatcher(forker);

    // Act
    const traversal = await subject.dispatch(forkRequest('%2e%2e%2fetc'));

    // Assert
    should(traversal.status).equal(400);
    should(codeOf(traversal)).equal('invalid_session_id');
    should(forker.forks).be.empty();
  });

  it('should refuse anonymously and refuse a warden token, because a fork launches an agent', async () => {
    // Arrange
    const forker = new FakeSessionFork();
    const subject = dispatcher(forker);

    // Act
    const anonymous = await subject.dispatch(forkRequest('s1', {}));
    const warden = await subject.dispatch(forkRequest('s1', { authorization: `Bearer ${CREDENTIALS.warden}` }));
    const peer = await subject.dispatch(forkRequest('s1', agentIn('s9')));

    // Assert
    should(anonymous.status).equal(401);
    should(warden.status).equal(403);
    // A peer holds the admin token, so it reaches the subsystem exactly as the start and migrate allow.
    should(peer.status).equal(200);
    should(forker.forks).have.length(1);
  });

  it('should answer each refusal with its own status and with the failure as the wire code', async () => {
    // These are genuinely different next actions: pick another message, pick another account, wait,
    // decide which fork the id meant, or read the session's record. Crossing harness families is not
    // among them — that is allowed, and it is reported as omissions on a committed plan.
    // Arrange
    const refusals: Readonly<Record<string, ForkSessionFailure>> = {
      weird: 'invalid_session_id',
      absent: 'source_not_found',
      stale: 'selection_stale',
      partial: 'incomplete_transcript',
      gone: 'target_not_found',
      tool: 'target_not_message',
      unbound: 'conversation_unavailable',
      untraced: 'lineage_untraceable',
      badplan: 'plan_invalid',
      badedge: 'edge_invalid',
      shortplan: 'cut_not_carried',
      unreadable: 'cut_unreadable',
      compacted: 'cut_rewritten',
      ghost: 'unknown_agent',
      spent: 'agent_unavailable',
      reused: 'request_id_reused',
      stuck: 'session_fork_failed',
    };
    const subject = dispatcher(
      new FakeSessionFork(
        Object.fromEntries(
          Object.entries(refusals).map(([id, failure]) => [id, new SessionForkRefusal(failure, `refused: ${failure}`)]),
        ),
      ),
    );

    // Act
    const answers = await Promise.all(Object.keys(refusals).map(async id => await subject.dispatch(forkRequest(id))));

    // Assert — the code IS the protocol failure, so a client branches on the declared closed set.
    should(answers.map(answer => [answer.status, codeOf(answer)])).deepEqual([
      [400, 'invalid_session_id'],
      [404, 'source_not_found'],
      [409, 'selection_stale'],
      [409, 'incomplete_transcript'],
      [404, 'target_not_found'],
      [409, 'target_not_message'],
      [409, 'conversation_unavailable'],
      [409, 'lineage_untraceable'],
      [500, 'plan_invalid'],
      [500, 'edge_invalid'],
      [500, 'cut_not_carried'],
      // A source that moved under a frozen plan is a refusal, not a defect: nothing was written, and
      // the caller picks a message again against the transcript as it reads now.
      [409, 'cut_unreadable'],
      [409, 'cut_rewritten'],
      [404, 'unknown_agent'],
      [503, 'agent_unavailable'],
      [409, 'request_id_reused'],
      [500, 'session_fork_failed'],
    ]);
  });

  it('should carry the refusal message, because a bare code is unactionable', async () => {
    // "that message is gone" and "that is a tool call" are the same code family to a status line and
    // completely different things to the person who clicked a message.
    // Arrange
    const detail = 'byte offset 4096 is past the end of the transcript this session has on disk';
    const subject = dispatcher(new FakeSessionFork({ s1: new SessionForkRefusal('target_not_found', detail) }));

    // Act
    const response = await subject.dispatch(forkRequest('s1'));

    // Assert
    should(response.status).equal(404);
    should((JSON.parse(response.body) as { error: string }).error).equal(detail);
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // a fork decides, and anything else is this daemon being broken.
    // Arrange
    const subject = dispatcher(new FakeSessionFork({ s1: new Error('the transcript index was closed') }));

    // Act
    const response = await subject.dispatch(forkRequest('s1'));

    // Assert
    should(response.status).equal(500);
    should(codeOf(response)).not.equal('session_fork_failed');
  });

  it('should refuse to report an outcome the wire does not describe', async () => {
    // Arrange
    const subject = dispatcher(new LyingSessionFork() as unknown as FakeSessionFork);

    // Act
    const response = await subject.dispatch(forkRequest('s1'));

    // Assert — a 500, not a 200 carrying a body the client would throw on.
    should(response.status).equal(500);
  });

  it('should refuse daemon-local fields instead of silently stripping them on the way out', async () => {
    // Arrange
    const subject = dispatcher(new LeakingSessionFork() as unknown as FakeSessionFork);

    // Act
    const response = await subject.dispatch(forkRequest('s1'));

    // Assert — strict outbound parsing catches the producing defect before it becomes a 200 leak.
    should(response.status).equal(500);
    should(response.body).not.containEql('/daemon/work');
    should(response.body).not.containEql('private-account');
    should(response.body).not.containEql('private-proof');
  });
});
