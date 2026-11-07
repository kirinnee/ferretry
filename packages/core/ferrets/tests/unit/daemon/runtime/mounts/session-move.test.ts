import { describe, it } from 'bun:test';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { ApiError, type ApiResponse, type CallStanding } from '@ferretry/kernel/contract';
import should from 'should';
import {
  AskToStopJobsResultSchema,
  type AskToStopJobsResult,
  type ConversionPreview,
  ConversionPreviewSchema,
  type MoveRefusal,
} from '../../../../../contract/move.ts';
import { FerretSummarySchema } from '../../../../../contract/ids.ts';
import { ferretId } from '../../../../../contract/testing/index.ts';
import manifest from '../../../../../manifest.ts';
import { FY_REQUEST_ID_HEADER } from '../../../../../daemon/lib/protocol/headers.ts';
import {
  type SessionRelaunchSettings,
  SessionRelaunchSettingsSchema,
  type SessionView,
} from '../../../../../daemon/lib/protocol/session.ts';
import {
  moverOf,
  SESSION_MOVE_ROUTES,
  SessionMoveError,
  type SessionMoveSubsystem,
  sessionMoveRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-move.ts';
import { sessionView } from '../../../../support/daemon/session-view.ts';
import { jsonOf, requestOf } from '../../support/requests.ts';

/**
 * The move surface: what a caller may ask for, what each refusal answers, and what comes back.
 *
 * Every case calls the mounted handler the way the kernel does, with the standing Gate would have put on the call. Who
 * may reach the routes at all (an operator, any caller, never cached) is the manifest's descriptor, so it is asserted
 * against the manifest here and enforced by the kernel's dispatcher, not re-tested through a credential table.
 */

/**
 * A fake mover: answers what a move answers and records what the routes asked of it. Its refusals are keyed by session,
 * so every HTTP answer the mount can give is reachable without a preflight, a pane or a fleet manifest behind it.
 */
class FakeSessionMove implements SessionMoveSubsystem {
  /** Every move that reached the subsystem, as the session and the request it carried. */
  readonly moves: Array<readonly [string, Parameters<SessionMoveSubsystem['move']>[1]]> = [];
  /** Every session asked about, in order. */
  readonly relaunchReads: string[] = [];
  /** Every preview asked for, as the session and the request it carried. */
  readonly previews: Array<readonly [string, { readonly agent: string; readonly model?: string }]> = [];
  /** Every session the agent was asked to stop its jobs in, in order. */
  readonly jobAsks: string[] = [];

  constructor(
    /** Sessions that exist, so a move has something to move. */
    private readonly known: readonly string[] = ['s1'],
    /** Session ids mapped to the refusal asking about them raises. */
    private readonly refusals: Readonly<Record<string, SessionMoveError>> = {},
  ) {}

  private check(sessionId: string): void {
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    if (!this.known.includes(sessionId)) throw new SessionMoveError('not_found', `no session ${sessionId}`);
  }

  async move(sessionId: string, request: Parameters<SessionMoveSubsystem['move']>[1]): Promise<SessionView> {
    this.moves.push([sessionId, request]);
    this.check(sessionId);
    // The agent the caller asked for, in the view: a move that answered with the old account would be
    // indistinguishable from a read.
    return sessionView(sessionId, { agent: request.agent }, { status: 'running', turn: 2 });
  }

  async relaunchSettings(sessionId: string): Promise<SessionRelaunchSettings> {
    this.relaunchReads.push(sessionId);
    this.check(sessionId);
    return { current: false, reasons: ['settings'] };
  }

  async conversionPreview(
    sessionId: string,
    request: { readonly agent: string; readonly model?: string },
  ): Promise<ConversionPreview> {
    this.previews.push([sessionId, request]);
    this.check(sessionId);
    if (request.agent === 'claude-same') return { kind: 'refused', targetAgent: request.agent, reason: 'same harness' };
    return {
      kind: 'ready',
      targetAgent: request.agent,
      targetModel: request.model ?? 'gpt-5.5',
      summary: {
        converter: 1,
        sourceHarness: 'claude',
        sourceVersion: '2.1.281',
        targetHarness: 'codex',
        targetVersion: '0.163.0',
        turns: 4,
        keptTurns: 4,
        omittedTurns: 0,
        cutNewest: false,
        messages: 8,
        nativeToolCalls: 1,
        toolCallsAsText: 2,
        attachments: 0,
        dropped: { reasoning: 1, sidechains: 0, internal: 3, compactions: 0 },
        estimatedTokens: 120,
        budgetTokens: 154800,
      },
    };
  }

  async askToStopJobs(sessionId: string): Promise<AskToStopJobsResult> {
    this.jobAsks.push(sessionId);
    this.check(sessionId);
    const jobs = [{ pid: 4242, command: 'bash /tmp/merge-all.sh 765', age: '3m' }];
    return { messageId: 'move-jobs-4242', jobs, alreadyAsked: this.jobAsks.length > 1 };
  }
}

type Route = (typeof SESSION_MOVE_ROUTES)[number];

/** The mounted handler for a route, over a subsystem; the replay ledger is the mount's, so one mount is one ledger. */
function mount(subsystem: SessionMoveSubsystem, maxReplayEntries?: number) {
  const routes = sessionMoveRoutes(subsystem, maxReplayEntries);
  return (route: Route['path'], method: Route['method']) => {
    const found = routes.find(candidate => candidate.path === route && candidate.method === method);
    if (found === undefined) throw new Error(`no handler for ${method} ${route}`);
    return found.handle;
  };
}

/** What a handler threw, as the ApiError the kernel turns into the answer, or undefined when it answered. */
async function thrown(work: Promise<unknown>): Promise<ApiError | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}

/**
 * A move must name its logical request id, so the default headers carry one: every case below that is not ABOUT the id
 * is about something else, and should not be re-testing the id's absence.
 */
const withRequestId = (requestId = 'req-1'): Readonly<Record<string, string>> => ({
  [FY_REQUEST_ID_HEADER]: requestId,
});

const MOVE = '/v1/ferrets/:ferretId/move' as const;
const owner = ownerStanding();

function moveCall(
  sessionId: string,
  headers: Readonly<Record<string, string>> = withRequestId(),
  body: unknown = { agent: 'claude-auto-other' },
  standing: CallStanding = owner,
) {
  return requestOf({
    method: 'POST',
    path: `/v1/ferrets/${sessionId}/move`,
    params: { ferretId: sessionId },
    headers,
    body,
    standing,
  });
}

/** The code a refusal carries, or the status of what was answered. */
const codeOf = async (work: Promise<ApiResponse>): Promise<[number, string | undefined]> => {
  const refusal = await thrown(work);
  return refusal === undefined ? [200, undefined] : [refusal.status, refusal.code];
};

/** What a case reads of an answer: the status, and the body as the wire would carry it (a refusal as its `error` and `code`). */
interface Answer {
  readonly status: number;
  readonly body: string;
}

/**
 * The mount as one dispatcher: picks the handler a call's path names and answers either what it answered or the refusal
 * it threw, in the wire shape. The standing is the case's own, as Gate would have put it on the call.
 */
function dispatcherOf(subsystem: SessionMoveSubsystem, maxReplayEntries?: number) {
  const handle = mount(subsystem, maxReplayEntries);
  return {
    dispatch: async (call: ReturnType<typeof moveCall>): Promise<Answer> => {
      const path = call.request.path;
      const handler = path.endsWith('/move/ask-to-stop-jobs')
        ? handle('/v1/ferrets/:ferretId/move/ask-to-stop-jobs', 'POST')
        : handle(MOVE, 'POST');
      try {
        const response = await handler(call);
        return {
          status: response.status,
          body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
        };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return {
          status: error.status,
          body: JSON.stringify({ error: error.message, code: error.code, ...(error.extra ?? {}) }),
        };
      }
    },
  };
}

describe('the session move mount', () => {
  it('should be declared as four operator-scoped, any-caller, uncached routes in the manifest', () => {
    // The scope is the kernel's, from `manifest.ts`: a move kills one agent process holding this daemon's own
    // privileges and launches another under a different account, so it is as closed as the start and the stop.
    // Act
    const declared = SESSION_MOVE_ROUTES.map(route =>
      manifest.actions?.routes?.find(candidate => candidate.key === `${route.method} ${route.path}`),
    );

    // Assert
    should(declared.every(route => route !== undefined)).be.true();
    should(declared.map(route => route?.minimum)).deepEqual(['operator', 'operator', 'operator', 'operator']);
    should(declared.map(route => route?.caller)).deepEqual(['any', 'any', 'any', 'any']);
    should(declared.every(route => route?.noStore === true)).be.true();
  });

  it('should move a session and answer with the ferret summary the command line parses', async () => {
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const response = await handle(
      MOVE,
      'POST',
    )(moveCall('s1', withRequestId(), { agent: 'codex-auto', model: 'gpt-5.6-terra' }));

    // Assert
    should(response.status).equal(200);
    // Parsed with the contract's own schema: a body the client would refuse is a move that moved a session and then
    // could not tell anybody where it went.
    const summary = FerretSummarySchema.parse(jsonOf(response));
    should(summary).match({ id: 's1', runtime: 'codex-auto', state: 'working', folder: '/work/ferretry' });
    should(mover.moves).deepEqual([
      [
        's1',
        {
          agent: 'codex-auto',
          model: 'gpt-5.6-terra',
          allowContextDowngrade: false,
          forceInflight: false,
          movedBy: 'owner',
        },
      ],
    ]);
  });

  it('should record who asked: the owner, or the ferret that called', async () => {
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    await handle(MOVE, 'POST')(moveCall('s1', withRequestId('req-owner')));
    await handle(
      MOVE,
      'POST',
    )(moveCall('s1', withRequestId('req-peer'), { agent: 'claude-auto-other' }, ferretStanding(ferretId('s9'))));

    // Assert
    should(mover.moves.map(([, sent]) => sent.movedBy)).deepEqual(['owner', 'session:s9']);
    should(moverOf(ferretStanding(ferretId('s9')))).equal('session:s9');
    should(moverOf({})).equal('owner');
    should(moverOf(owner)).equal('owner');
    should(moverOf(deviceStanding('d1'))).equal('owner');
  });

  it('should pass an unstated context downgrade through as a refusal rather than as consent', async () => {
    // `allowContextDowngrade` is `z.default(false)` on the wire, so a caller that says nothing has
    // NOT accepted a smaller window. The subsystem decides what to do about it, and it can only
    // decide correctly if the mount hands it `false` rather than `undefined`.
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act. Two request ids, because these are two different moves: stating consent to a smaller
    // window is not a replay of declining to.
    const silent = await handle(MOVE, 'POST')(moveCall('s1', withRequestId('req-silent')));
    const accepted = await handle(
      MOVE,
      'POST',
    )(moveCall('s1', withRequestId('req-accepted'), { agent: 'claude-auto-other', allowContextDowngrade: true }));

    // Assert
    should(silent.status).equal(200);
    should(accepted.status).equal(200);
    should(mover.moves.map(([, sent]) => sent.allowContextDowngrade)).deepEqual([false, true]);
  });

  it('should refuse a move that names no target, because there is no default account', async () => {
    // Unlike the revive, whose body is entirely optional, a move with no agent is not a
    // move with a default — it names nothing to move to.
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const empty = await codeOf(handle(MOVE, 'POST')(moveCall('s1', withRequestId(), '')));
    const braces = await codeOf(handle(MOVE, 'POST')(moveCall('s1', withRequestId(), {})));
    const blank = await codeOf(handle(MOVE, 'POST')(moveCall('s1', withRequestId(), { agent: '' })));

    // Assert
    should([empty[0], braces[0], blank[0]]).deepEqual([400, 400, 400]);
    should(mover.moves).be.empty();
  });

  it('should refuse a field the protocol does not carry rather than silently dropping it', async () => {
    // `MoveSessionRequestSchema` is strict. A caller sending `force` believes the gate can be
    // overridden through this route; accepting and ignoring it would let them believe that.
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const forced = await codeOf(
      handle(MOVE, 'POST')(moveCall('s1', withRequestId(), { agent: 'claude-auto-other', force: true })),
    );

    // Assert
    should(forced[0]).equal(400);
    should(mover.moves).be.empty();
  });

  it('should answer each refusal the move raises with its own status and code', async () => {
    // These are genuinely different next actions: wait for the work to finish, pick another account,
    // accept the smaller window, or read the session's record to see what the relaunch did.
    // Arrange
    const handle = mount(
      new FakeSessionMove(['s1'], {
        busy: new SessionMoveError('refused', 'refused: a destructive command is in flight'),
        broken: new SessionMoveError('unusable', 'the documents for session broken do not satisfy the protocol'),
        nosuch: new SessionMoveError('unknown_agent', 'no account is published as "ghost"'),
        spent: new SessionMoveError('unavailable', 'account ghost cannot serve a session'),
        smaller: new SessionMoveError('context_downgrade', 'the conversation would be truncated'),
        crossed: new SessionMoveError(
          'harness_mismatch',
          'this session runs the claude harness and codex-auto-target is a codex account',
        ),
        stuck: new SessionMoveError('failed', 'the replacement pane never became ready'),
        amnesia: new SessionMoveError('unresumable', 'this session has no recorded conversation'),
        weird: new SessionMoveError('invalid', '"weird" is not a usable session id'),
        unserved: new SessionMoveError('unservable_model', 'the account does not serve that model'),
      }),
    );

    // Act
    const answers = await Promise.all(
      [
        'busy',
        'broken',
        'nosuch',
        'spent',
        'smaller',
        'crossed',
        'stuck',
        'amnesia',
        'weird',
        'unserved',
        'absent',
      ].map(async id => await codeOf(handle(MOVE, 'POST')(moveCall(id)))),
    );

    // Assert
    should(answers).deepEqual([
      [409, 'move_refused'],
      [409, 'session_unusable'],
      [404, 'unknown_agent'],
      [503, 'agent_unavailable'],
      [409, 'context_downgrade_refused'],
      // The account exists and is available; it is simply not this session's harness family. 409
      // rather than 404 or 400, because the request is well formed and names a real account.
      [409, 'harness_mismatch'],
      [500, 'session_move_failed'],
      // The conversation cannot go with it, and only the person may choose to start a fresh one.
      [409, 'conversation_unresumable'],
      [400, 'invalid_session_id'],
      [409, 'unservable_model'],
      [404, 'not-found'],
    ]);
  });

  it('should hand the gate an explicit force only when the caller sent one', async () => {
    // `forceInflight` is `z.default(false)` on the wire: saying nothing is declining to go past the
    // refusal, and only a caller that sends `true` — a person who confirmed "Restart anyway" — forces.
    // Two request ids, because forcing is a different request, not a replay of declining.
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const plain = await handle(MOVE, 'POST')(moveCall('s1', withRequestId('req-plain')));
    const forced = await handle(
      MOVE,
      'POST',
    )(moveCall('s1', withRequestId('req-forced'), { agent: 'claude-auto-other', forceInflight: true }));
    const malformed = await codeOf(
      handle(
        MOVE,
        'POST',
      )(moveCall('s1', withRequestId('req-bad'), { agent: 'claude-auto-other', forceInflight: 'yes' })),
    );

    // Assert
    should([plain.status, forced.status, malformed[0]]).deepEqual([200, 200, 400]);
    should(mover.moves.map(([, sent]) => sent.forceInflight)).deepEqual([false, true]);
  });

  it('should answer a refusal with the inventory as data beside the sentence', async () => {
    // The sentence is for a log; the PWA lists what is running from `inflight`, so a person can decide
    // whether to restart anyway. A refusal with no data carries no such field.
    // Arrange
    const inflight: MoveRefusal = {
      status: 'running',
      turn: 13,
      blockedBy: 'unknown',
      restartsWithCli: 1,
      items: [
        {
          kind: 'process',
          verdict: 'unknown',
          title: 'A program Ferretry doesn’t recognise is running',
          detail: 'some-vendor-tool --watch',
          age: '2m',
          blocks: true,
        },
      ],
    };
    const handle = mount(
      new FakeSessionMove(['s1'], {
        s1: new SessionMoveError('refused', 'refused: a program', { inflight }),
        s2: new SessionMoveError('refused', 'refused: ps failed'),
      }),
    );

    // Act
    const withData = await thrown(handle(MOVE, 'POST')(moveCall('s1')));
    const without = await thrown(handle(MOVE, 'POST')(moveCall('s2')));

    // Assert
    should(withData?.message).equal('refused: a program');
    should(withData?.code).equal('move_refused');
    should(withData?.extra).deepEqual({ inflight });
    should(without?.message).equal('refused: ps failed');
    should(without?.extra).be.undefined();
  });

  it('should carry the two windows of a context downgrade as data, never as an API field name', async () => {
    // Arrange
    const downgrade = { model: 'claude-sonnet-5', targetWindow: 200_000, currentWindow: 1_000_000 };
    const handle = mount(
      new FakeSessionMove(['s1'], {
        s1: new SessionMoveError('context_downgrade', 'cut off', { downgrade }),
      }),
    );

    // Act
    const refusal = await thrown(handle(MOVE, 'POST')(moveCall('s1')));

    // Assert
    should(refusal?.status).equal(409);
    should(refusal?.message).equal('cut off');
    should(refusal?.code).equal('context_downgrade_refused');
    should(refusal?.extra).deepEqual({ downgrade });
  });

  it('should carry the whole in-flight inventory in the refusal, because a bare 409 is unactionable', async () => {
    // The gate's refusal names what it found — the process, the verdict, the blind spot — and the
    // operator decides from that whether to wait or to stop the work. Truncating it to a code would
    // leave them with no way to tell "a build is running" from "we could not look".
    // Arrange
    const inventory =
      'refused: a destructive command is in flight\nin-flight inventory — status running, turn 3, worst: DESTRUCTIVE\n' +
      '  proc  [DESTRUCTIVE] pid 4242 (2m): git push origin main';
    const handle = mount(new FakeSessionMove(['s1'], { s1: new SessionMoveError('refused', inventory) }));

    // Act
    const refusal = await thrown(handle(MOVE, 'POST')(moveCall('s1')));

    // Assert
    should(refusal?.status).equal(409);
    should(refusal?.message).equal(inventory);
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // A session id is a directory name downstream, and this route writes a report into that
    // directory before anything else happens.
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const traversal = await thrown(handle(MOVE, 'POST')(moveCall('%2e%2e%2fetc')));

    // Assert
    should(traversal?.status).equal(400);
    should(traversal?.code).equal('invalid_session_id');
    should(mover.moves).be.empty();
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // the move decides, and anything else is this daemon being broken.
    // Arrange
    const handle = mount(
      new FakeSessionMove(['s1'], {
        // Not a SessionMoveError: the cast is the point of the case.
        s1: new Error('the storage index was closed') as SessionMoveError,
      }),
    );

    // Act
    const failure = await handle(
      MOVE,
      'POST',
    )(moveCall('s1')).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(Error);
    should(failure).not.be.instanceOf(ApiError);
    should((failure as Error).message).equal('the storage index was closed');
  });
});

/**
 * The stale-settings read: whether a Restart would relaunch this session on different settings.
 *
 * It lives on the move's mount because a Restart IS a move onto the same account, so it answers the same refusals for an
 * id it cannot use.
 */
describe('the session relaunch-settings read', () => {
  const RELAUNCH = '/v1/ferrets/:ferretId/relaunch-settings' as const;
  const read = (sessionId: string) =>
    requestOf({
      method: 'GET',
      path: `/v1/ferrets/${sessionId}/relaunch-settings`,
      params: { ferretId: sessionId },
      standing: owner,
    });

  it('should answer what the subsystem says, in the protocol shape', async () => {
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const response = await handle(RELAUNCH, 'GET')(read('s1'));

    // Assert
    should(response.status).equal(200);
    should(SessionRelaunchSettingsSchema.parse(jsonOf(response))).deepEqual({ current: false, reasons: ['settings'] });
    should(mover.relaunchReads).deepEqual(['s1']);
    // A read moves nothing.
    should(mover.moves).be.empty();
  });

  it('should answer an unknown session as not found', async () => {
    // Arrange
    const handle = mount(new FakeSessionMove());

    // Act
    const absent = await codeOf(handle(RELAUNCH, 'GET')(read('s404')));

    // Assert
    should(absent).deepEqual([404, 'not-found']);
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const traversal = await codeOf(handle(RELAUNCH, 'GET')(read('%2e%2e%2fetc')));

    // Assert
    should(traversal).deepEqual([400, 'invalid_session_id']);
    should(mover.relaunchReads).be.empty();
  });
});

/**
 * The conversion preview: what a cross-harness move would carry, asked before anything moves.
 *
 * A read with a body. Needing no request id because nothing is written, and answering a refusal as a 200 `refused` the
 * sheet shows in place.
 */
describe('the session conversion-preview read', () => {
  const PREVIEW = '/v1/ferrets/:ferretId/conversion-preview' as const;
  const preview = (sessionId: string, body: unknown) =>
    requestOf({
      method: 'POST',
      path: `/v1/ferrets/${sessionId}/conversion-preview`,
      params: { ferretId: sessionId },
      body,
      standing: owner,
    });

  it('should answer the subsystem preview in the protocol shape, passing the account and model through', async () => {
    // Arrange
    const mover = new FakeSessionMove();
    const handle = mount(mover);

    // Act
    const ready = await handle(PREVIEW, 'POST')(preview('s1', { agent: 'codex-a', model: 'gpt-5.5' }));
    const refused = await handle(PREVIEW, 'POST')(preview('s1', { agent: 'claude-same' }));

    // Assert
    should(ready.status).equal(200);
    should(ConversionPreviewSchema.parse(jsonOf(ready))).match({ kind: 'ready', targetAgent: 'codex-a' });
    should(refused.status).equal(200);
    should(ConversionPreviewSchema.parse(jsonOf(refused))).deepEqual({
      kind: 'refused',
      targetAgent: 'claude-same',
      reason: 'same harness',
    });
    should(mover.previews).deepEqual([
      ['s1', { agent: 'codex-a', model: 'gpt-5.5' }],
      ['s1', { agent: 'claude-same' }],
    ]);
    should(mover.moves).be.empty();
  });

  it('should refuse a body with no account, and an unknown session', async () => {
    // Arrange
    const handle = mount(new FakeSessionMove());

    // Act
    const noAgent = await codeOf(handle(PREVIEW, 'POST')(preview('s1', {})));
    const absent = await codeOf(handle(PREVIEW, 'POST')(preview('s404', { agent: 'codex-a' })));

    // Assert
    should(noAgent[0]).equal(400);
    should(absent[0]).equal(404);
  });
});

/**
 * The route's replay contract.
 *
 * The protocol client retries this POST up to three times on transport failure and a move kills
 * and relaunches a pane, so "how many times did the subsystem actually run" is the only assertion
 * that matters in every case here.
 */
describe('the session move mount, replayed', () => {
  /**
   * Counts subsystem entries and can be told what each successive call does. Views come from the
   * shared fake, so the body every case compares is the one the read surface really serves.
   */
  class CountingMove {
    calls = 0;
    readonly #views = new FakeSessionMove(['s1', 's2']);
    constructor(private readonly outcomes: ReadonlyArray<'ok' | SessionMoveError> = ['ok']) {}
    async move(
      sessionId: string,
      request: {
        readonly agent: string;
        readonly model?: string;
        readonly allowContextDowngrade: boolean;
        readonly forceInflight: boolean;
      },
    ): Promise<SessionView> {
      const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)];
      this.calls += 1;
      if (outcome !== 'ok') throw outcome;
      return await this.#views.move(sessionId, request);
    }
    async relaunchSettings(sessionId: string): Promise<SessionRelaunchSettings> {
      return await this.#views.relaunchSettings(sessionId);
    }
    async conversionPreview(sessionId: string, request: { readonly agent: string }): Promise<ConversionPreview> {
      return await this.#views.conversionPreview(sessionId, request);
    }
    async askToStopJobs(sessionId: string) {
      return await this.#views.askToStopJobs(sessionId);
    }
  }

  const mounted = (subsystem: CountingMove) => dispatcherOf(subsystem);

  it('should refuse a move that carries no request id, and destroy nothing', async () => {
    // Arrange
    const mover = new CountingMove();
    const subject = mounted(mover);

    // Act
    const response = await subject.dispatch(moveCall('s1', {}, { agent: 'claude-auto-other' }));

    // Assert
    should(response.status).equal(400);
    should((JSON.parse(response.body) as { code: string }).code).equal('missing_request_id');
    should(mover.calls).equal(0);
  });

  it('should answer a replayed request id with the first move, without relaunching again', async () => {
    // Arrange
    const mover = new CountingMove();
    const subject = mounted(mover);
    const headers = withRequestId('req-replay');

    // Act
    const first = await subject.dispatch(moveCall('s1', headers));
    const replay = await subject.dispatch(moveCall('s1', headers));

    // Assert
    should(first.status).equal(200);
    should(replay.status).equal(200);
    should(replay.body).equal(first.body);
    should(mover.calls).equal(1);
  });

  it('should keep distinct request ids as distinct moves', async () => {
    // Arrange
    const mover = new CountingMove();
    const subject = mounted(mover);

    // Act
    await subject.dispatch(moveCall('s1', withRequestId('req-a')));
    await subject.dispatch(moveCall('s1', withRequestId('req-b')));

    // Assert
    should(mover.calls).equal(2);
  });

  it('should let a refused preflight be re-evaluated under the same request id', async () => {
    // Nothing was destroyed, so asking again must consult the session's CURRENT condition — this is
    // what the sheet's "Retry safety check" does, and caching the refusal would freeze the answer.
    // Arrange
    const mover = new CountingMove([new SessionMoveError('refused', 'in-flight work refuses this'), 'ok']);
    const subject = mounted(mover);
    const headers = withRequestId('req-retry');

    // Act
    const refused = await subject.dispatch(moveCall('s1', headers));
    const retried = await subject.dispatch(moveCall('s1', headers));

    // Assert
    should(refused.status).equal(409);
    should((JSON.parse(refused.body) as { code: string }).code).equal('move_refused');
    should(retried.status).equal(200);
    should(mover.calls).equal(2);
  });

  it('should let a cross-family refusal be re-evaluated under the same request id', async () => {
    // A mismatch is decided BEFORE the pane is touched, exactly like the preflight's refusal above, so
    // it must behave like one in the ledger: the request id is not spent, and the same id presented
    // again after the caller corrects the account is a move that runs rather than a cached 409.
    // If this were treated as post-destruction the operator's only remedy would be a new request id
    // for a session nothing had touched.
    // Arrange
    const mover = new CountingMove([
      new SessionMoveError('harness_mismatch', 'this session runs the claude harness and X is a codex account'),
      'ok',
    ]);
    const subject = mounted(mover);
    const headers = withRequestId('req-crossed');

    // Act
    const refused = await subject.dispatch(moveCall('s1', headers, { agent: 'codex-auto-target' }));
    const corrected = await subject.dispatch(moveCall('s1', headers, { agent: 'claude-auto-target' }));

    // Assert
    should(refused.status).equal(409);
    should((JSON.parse(refused.body) as { code: string }).code).equal('harness_mismatch');
    should(corrected.status).equal(200);
    should(mover.calls).equal(2);
  });

  it('should never re-attempt a relaunch that failed after the pane was already replaced', async () => {
    // `failed` is past the point of no return: the pane is dead and the document restamped. A retry
    // 250ms later must be told what happened, not allowed to destroy a second time.
    // Arrange
    const mover = new CountingMove([new SessionMoveError('failed', 'the relaunch under the new account failed'), 'ok']);
    const subject = mounted(mover);
    const headers = withRequestId('req-committed');

    // Act
    const failed = await subject.dispatch(moveCall('s1', headers));
    const replay = await subject.dispatch(moveCall('s1', headers));

    // Assert
    should(failed.status).equal(500);
    should((JSON.parse(failed.body) as { code: string }).code).equal('session_move_failed');
    should(replay.status).equal(500);
    should((JSON.parse(replay.body) as { code: string }).code).equal('session_move_failed');
    should(mover.calls).equal(1);
  });

  it('should refuse one request id that arrives naming a different target', async () => {
    // Answering the second with the first's result would tell a caller its move to one account
    // succeeded when a move to another is what happened.
    // Arrange
    const mover = new CountingMove();
    const subject = mounted(mover);
    const headers = withRequestId('req-reused');

    // Act
    await subject.dispatch(moveCall('s1', headers, { agent: 'codex-auto' }));
    const reused = await subject.dispatch(moveCall('s1', headers, { agent: 'codex-auto-other' }));

    // Assert
    should(reused.status).equal(409);
    should((JSON.parse(reused.body) as { code: string }).code).equal('request_id_reused');
    should(mover.calls).equal(1);
  });

  it('should treat two spellings of one target as the same move', async () => {
    // `allowContextDowngrade` is `z.default(false)`, so omitting it and stating it are the same ask.
    // Arrange
    const mover = new CountingMove();
    const subject = mounted(mover);
    const headers = withRequestId('req-same');

    // Act
    const stated = await subject.dispatch(
      moveCall('s1', headers, { agent: 'codex-auto', allowContextDowngrade: false }),
    );
    const omitted = await subject.dispatch(moveCall('s1', headers, { agent: 'codex-auto' }));

    // Assert
    should(stated.status).equal(200);
    should(omitted.status).equal(200);
    should(mover.calls).equal(1);
  });

  it('should scope the ledger by session, so one id cannot answer for another session', async () => {
    // Arrange
    const mover = new CountingMove();
    const subject = mounted(mover);
    const headers = withRequestId('req-shared');

    // Act
    await subject.dispatch(moveCall('s1', headers));
    await subject.dispatch(moveCall('s2', headers));

    // Assert
    should(mover.calls).equal(2);
  });

  it('should answer 503 when the ledger will admit no further move, having destroyed nothing', async () => {
    // The ledger never discards a receipt, so the only way to bound it is to stop admitting NEW work.
    // A caller minting fresh request ids forever meets this wall instead of the daemon's heap.
    // Arrange: a mount that admits exactly two moves.
    const mover = new CountingMove();
    const subject = dispatcherOf(mover, 2);

    // Act
    await subject.dispatch(moveCall('s1', withRequestId('req-1')));
    await subject.dispatch(moveCall('s1', withRequestId('req-2')));
    const full = await subject.dispatch(moveCall('s1', withRequestId('req-3')));

    // Assert
    should(full.status).equal(503);
    const body = JSON.parse(full.body) as { code: string; error: string };
    should(body.code).equal('move_ledger_full');
    // The message names the operator's actual remedy rather than implying that waiting helps.
    should(body.error).match(/will not admit another/);
    should(body.error).match(/Restart the daemon/);
    // The refused request never reached the subsystem, so no third pane was destroyed.
    should(mover.calls).equal(2);
  });

  it('should keep replaying the moves it already holds while the ledger is full', async () => {
    // A memory limit that stopped answering for moves already performed would BE the
    // re-destruction hazard the limit exists to prevent.
    // Arrange
    const mover = new CountingMove();
    const subject = dispatcherOf(mover, 1);
    const held = withRequestId('req-held');

    // Act
    const first = await subject.dispatch(moveCall('s1', held));
    const refused = await subject.dispatch(moveCall('s1', withRequestId('req-new')));
    const replay = await subject.dispatch(moveCall('s1', held));

    // Assert
    should(first.status).equal(200);
    should(refused.status).equal(503);
    should(replay.status).equal(200);
    should(replay.body).equal(first.body);
    should(mover.calls).equal(1);
  });

  it('should free admission again once a move is refused before it touches the pane', async () => {
    // A refused preflight destroyed nothing, so it holds no receipt and its slot returns to the pool.
    // Arrange: one admission, and a subsystem that refuses first and then succeeds.
    const mover = new CountingMove([new SessionMoveError('refused', 'in-flight work refuses this'), 'ok']);
    const subject = dispatcherOf(mover, 1);

    // Act
    const refusedPreflight = await subject.dispatch(moveCall('s1', withRequestId('req-blocked')));
    const admitted = await subject.dispatch(moveCall('s1', withRequestId('req-after')));
    const full = await subject.dispatch(moveCall('s1', withRequestId('req-third')));

    // Assert
    should(refusedPreflight.status).equal(409);
    should((JSON.parse(refusedPreflight.body) as { code: string }).code).equal('move_refused');
    // The freed slot admitted real work...
    should(admitted.status).equal(200);
    // ...and now that the slot holds a committed receipt, the cap bites.
    should(full.status).equal(503);
    should(mover.calls).equal(2);
  });
});

describe('asking the agent to stop its background jobs', () => {
  const ask = (sessionId: string, body?: unknown) =>
    requestOf({
      method: 'POST',
      path: `/v1/ferrets/${sessionId}/move/ask-to-stop-jobs`,
      params: { ferretId: sessionId },
      standing: owner,
      ...(body === undefined ? {} : { body }),
    });

  it('should answer with the jobs the agent was asked about, with no body and no request id needed', async () => {
    // Arrange
    const mover = new FakeSessionMove();
    const subject = dispatcherOf(mover);

    // Act
    const response = await subject.dispatch(ask('s1'));

    // Assert
    should(response.status).equal(200);
    const body = AskToStopJobsResultSchema.parse(JSON.parse(response.body));
    should(body).match({ messageId: 'move-jobs-4242', alreadyAsked: false, jobs: [{ pid: 4242 }] });
    should(mover.jobAsks).deepEqual(['s1']);
    // It is an ask, not a move: no move reached the subsystem.
    should(mover.moves).be.empty();
  });

  it('should refuse a body that names anything, because the daemon decides what to ask about', async () => {
    // Arrange
    const mover = new FakeSessionMove();
    const subject = dispatcherOf(mover);

    // Act
    const response = await subject.dispatch(ask('s1', { pids: [1] }));

    // Assert
    should(response.status).equal(400);
    should(mover.jobAsks).be.empty();
  });

  it('should answer 409 no_background_jobs when there is nothing of the agent’s left to ask about', async () => {
    // Arrange
    const subject = dispatcherOf(
      new FakeSessionMove(['s1'], {
        gone: new SessionMoveError('no_jobs', 'none of the agent’s own background jobs is in the way any more'),
      }),
    );

    // Act
    const response = await subject.dispatch(ask('gone'));

    // Assert
    should(response.status).equal(409);
    should((JSON.parse(response.body) as { code: string }).code).equal('no_background_jobs');
  });
});
