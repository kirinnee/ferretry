import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER } from '../../../../../daemon/lib/protocol/headers.ts';
import {
  type ForkSessionFailure,
  type ForkSessionOutcome,
  ForkSessionOutcomeSchema,
  type ForkSessionPlanSummary,
  type ForkSessionRequest,
} from '../../../../../contract/fork.ts';
import { ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallContext, RouteHandler } from '@ferretry/kernel/contract';
import should from 'should';
import manifest from '../../../../../manifest.ts';
import { SessionForkRefusal, sessionForkRoutes } from '../../../../../daemon/lib/runtime/mounts/session-fork.ts';
import { refusalOf } from '../../support/calls.ts';
import { jsonOf, requestOf } from '../../support/requests.ts';

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

const ROUTE = 'POST /v1/ferrets/:ferretId/fork';

function handlerOf(subsystem: { fork: FakeSessionFork['fork'] } = new FakeSessionFork()): RouteHandler {
  const route = sessionForkRoutes(subsystem).find(candidate => `${candidate.method} ${candidate.path}` === ROUTE);
  if (route === undefined) throw new Error('the fork route is not mounted');
  return route.handle;
}

const BODY = { through: POINT, selectionBinding: 'selection-binding-1', agent: 'codex-auto' };

/** One call of the fork route, as the kernel hands it to the handler once Gate has admitted the owner. */
function forkCall(
  ferretId: string,
  headers: Readonly<Record<string, string>> = { [FY_REQUEST_ID_HEADER]: 'req-1' },
  body: unknown = BODY,
): CallContext {
  return requestOf({
    method: 'POST',
    path: `/v1/ferrets/${ferretId}/fork`,
    params: { ferretId },
    headers,
    body,
    standing: ownerStanding(),
  });
}

const withRequestId = (requestId: string): Readonly<Record<string, string>> => ({ [FY_REQUEST_ID_HEADER]: requestId });

describe('the session fork mount', () => {
  it('should serve exactly one fork route', () => {
    // The route table is the daemon's own statement of what exists, and the protocol client dials
    // this exact address; a rename on either side is the shipped-404 shape the repository gates for.
    // Act
    const routes = sessionForkRoutes(new FakeSessionFork());

    // Assert
    should(routes).have.length(1);
    should(routes[0]?.method).equal('POST');
    should(routes[0]?.path).equal('/v1/ferrets/:ferretId/fork');
  });

  it('should be declared as an operator-scoped, person-only, uncached route in the manifest', () => {
    // The scope is the kernel's, from `manifest.ts`: a fork launches an agent wrapper holding this daemon's own
    // privileges under an account the caller chose (operator), and a fork's target descends from NOTHING, so a ferret
    // that could fork would start a parent-less session past its sub-ferret limits (person).
    // Act
    const declared = manifest.actions?.routes?.find(route => route.key === ROUTE);

    // Assert
    should(declared?.minimum).equal('operator');
    should(declared?.caller).equal('person');
    should(declared?.noStore).be.true();
  });

  it('should fork a session and answer with the fresh session and the plan that built it', async () => {
    // Arrange
    const forker = new FakeSessionFork();
    const handler = handlerOf(forker);

    // Act
    const response = await handler(
      forkCall('s1', withRequestId('req-1'), {
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
    const outcome = ForkSessionOutcomeSchema.parse(jsonOf(response));
    should(outcome.session.id).equal('s1-fork');
    should(outcome.session.agent).equal('codex-auto');
    should(outcome.plan.notCarried).deepEqual(PLAN.notCarried);
  });

  it('should hand the subsystem the source, the parsed request and the request id unchanged', async () => {
    // The mount decides nothing. An unstated model must arrive as ABSENT rather than as a null or a
    // default, because "the caller stated no model" is what the target resolver reads.
    // Arrange
    const forker = new FakeSessionFork();
    const handler = handlerOf(forker);

    // Act
    const full = await handler(
      forkCall('s1', withRequestId('req-full'), {
        through: POINT,
        selectionBinding: 'selection-binding-full',
        agent: 'codex-auto',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }),
    );
    const bare = await handler(
      forkCall('s1', withRequestId('req-bare'), {
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
    // A move keeps an in-memory ledger because a repeat could destroy a pane twice and the
    // memory cannot be rebuilt from disk. A fork destroys nothing and its receipt IS on disk, so a
    // second ledger here would forget on restart and answer for a fact it does not own. The mount
    // must therefore pass a repeated id straight through and let the service replay it.
    // Arrange
    const forker = new FakeSessionFork();
    const handler = handlerOf(forker);

    // Act
    const first = await handler(forkCall('s1', withRequestId('req-same')));
    const second = await handler(forkCall('s1', withRequestId('req-same')));

    // Assert
    should([first.status, second.status]).deepEqual([200, 200]);
    should(forker.forks.map(([, , id]) => id)).deepEqual(['req-same', 'req-same']);
  });

  it('should refuse a fork that carries no request id, rather than one it cannot recognise twice', async () => {
    // Arrange
    const forker = new FakeSessionFork();
    const handler = handlerOf(forker);

    // Act
    const missing = await refusalOf(handler(forkCall('s1', {})));
    const blank = await refusalOf(handler(forkCall('s1', withRequestId('   '))));

    // Assert
    should([missing, blank]).deepEqual([
      { status: 400, code: 'missing_request_id' },
      { status: 400, code: 'missing_request_id' },
    ]);
    should(forker.forks).be.empty();
  });

  it('should refuse a body that is not a fork, including a field the wire does not carry', async () => {
    // Arrange
    const forker = new FakeSessionFork();
    const handler = handlerOf(forker);
    const bodies: unknown[] = [
      '',
      {},
      { through: POINT },
      { agent: 'codex-auto' },
      { through: POINT, agent: 'codex-auto' },
      { through: '4096:2', selectionBinding: 'selection-binding-1', agent: 'codex-auto' },
      { ...BODY, undeclared: 'a field the wire does not carry' },
    ];

    // Act
    const answers = await Promise.all(
      bodies.map(async body => await refusalOf(handler(forkCall('s1', withRequestId('req-1'), body)))),
    );

    // Assert
    should(answers.map(answer => answer?.status)).deepEqual([400, 400, 400, 400, 400, 400, 400]);
    should(forker.forks).be.empty();
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // A session id is a directory name downstream, and a fork reads a transcript out of one.
    // Arrange
    const forker = new FakeSessionFork();
    const handler = handlerOf(forker);

    // Act
    const traversal = await refusalOf(handler(forkCall('%2e%2e%2fetc')));

    // Assert
    should(traversal).deepEqual({ status: 400, code: 'invalid_session_id' });
    should(forker.forks).be.empty();
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
    const handler = handlerOf(
      new FakeSessionFork(
        Object.fromEntries(
          Object.entries(refusals).map(([id, failure]) => [id, new SessionForkRefusal(failure, `refused: ${failure}`)]),
        ),
      ),
    );

    // Act
    const answers = await Promise.all(Object.keys(refusals).map(async id => await refusalOf(handler(forkCall(id)))));

    // Assert — the code IS the protocol failure, so a client branches on the declared closed set.
    should(answers.map(answer => [answer?.status, answer?.code])).deepEqual([
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
    const handler = handlerOf(new FakeSessionFork({ s1: new SessionForkRefusal('target_not_found', detail) }));

    // Act
    const thrown = await handler(forkCall('s1')).catch((error: unknown) => error);

    // Assert
    should((thrown as { status?: number }).status).equal(404);
    should((thrown as Error).message).equal(detail);
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // a fork decides, and anything else is this daemon being broken.
    // Arrange
    const defect = new Error('the transcript index was closed');
    const handler = handlerOf(new FakeSessionFork({ s1: defect }));

    // Act
    const thrown = await handler(forkCall('s1')).catch((error: unknown) => error);

    // Assert — the very error, not an `ApiError` carrying a code a client could branch on.
    should(thrown).equal(defect);
  });

  it('should refuse to report an outcome the wire does not describe', async () => {
    // Arrange
    const handler = handlerOf(new LyingSessionFork() as unknown as FakeSessionFork);

    // Act
    const thrown = await handler(forkCall('s1')).catch((error: unknown) => error);

    // Assert — a thrown schema error (the kernel answers 500), not a 200 carrying a body the client would throw on.
    should(thrown).be.instanceOf(Error);
    should((thrown as { status?: number }).status).be.undefined();
  });

  it('should refuse daemon-local fields instead of silently stripping them on the way out', async () => {
    // Arrange
    const handler = handlerOf(new LeakingSessionFork() as unknown as FakeSessionFork);

    // Act
    const thrown = await handler(forkCall('s1')).catch((error: unknown) => error);

    // Assert — strict outbound parsing catches the producing defect before it becomes a 200 leak.
    should(thrown).be.instanceOf(Error);
    const message = (thrown as Error).message;
    should(message).not.containEql('/daemon/work');
    should(message).not.containEql('private-account');
    should(message).not.containEql('private-proof');
  });
});
