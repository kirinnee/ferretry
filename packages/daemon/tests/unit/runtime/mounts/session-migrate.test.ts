import { describe, it } from 'bun:test';
import {
  AskToStopJobsResultSchema,
  type ConversionPreview,
  ConversionPreviewSchema,
  FY_REQUEST_ID_HEADER,
  type MigrationRefusal,
  MigrationRefusedBodySchema,
  type SessionRelaunchSettings,
  SessionRelaunchSettingsSchema,
  type SessionView,
  SessionViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionMigrateError, sessionMigrateRoutes } from '../../../../src/lib/runtime/mounts/session-migrate.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeSessionMigrate, human } from './support.ts';

/**
 * The migration surface: what a caller may ask for, what each refusal answers, and what comes back.
 *
 * Every case goes through the real dispatcher and the real credentials, because the scope this route
 * is served under is the point of half of them: a migration kills one privileged process and starts
 * another under a different account, so it must be as closed as the start and the stop.
 */

function dispatcher(subsystem = new FakeSessionMigrate()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionMigrateRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

/**
 * A migration must name its logical request id, so the default headers carry one: every case below
 * that is not ABOUT the id is about something else, and should not be re-testing the id's absence.
 * A test that wants a specific id, or none, passes its own headers.
 */
const withRequestId = (headers: Readonly<Record<string, string>>, requestId = 'req-1') => ({
  ...headers,
  [FY_REQUEST_ID_HEADER]: requestId,
});

function migrateRequest(
  sessionId: string,
  headers: Readonly<Record<string, string>> = human,
  body: unknown = { agent: 'claude-auto-other' },
): Parameters<ApiDispatcher['dispatch']>[0] {
  const supplied = FY_REQUEST_ID_HEADER in headers ? headers : withRequestId(headers);
  return request({
    method: 'POST',
    path: `/v1/sessions/${sessionId}/migrate`,
    headers: supplied,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('the session migrate mount', () => {
  it('should migrate a session and answer with the view the read surface serves', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const response = await subject.dispatch(
      migrateRequest('s1', human, { agent: 'codex-auto', model: 'gpt-5.6-terra' }),
    );

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the client would refuse is a migration that
    // moved a session and then could not tell anybody where it went.
    const view = SessionViewSchema.parse(JSON.parse(response.body));
    should(view.config.id).equal('s1');
    should(view.config.agent).equal('codex-auto');
    should(migrator.migrations).deepEqual([
      ['s1', { agent: 'codex-auto', model: 'gpt-5.6-terra', allowContextDowngrade: false, forceInflight: false }],
    ]);
  });

  it('should pass an unstated context downgrade through as a refusal rather than as consent', async () => {
    // `allowContextDowngrade` is `z.default(false)` on the wire, so a caller that says nothing has
    // NOT accepted a smaller window. The subsystem decides what to do about it, and it can only
    // decide correctly if the mount hands it `false` rather than `undefined`.
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act. Two request ids, because these are two different migrations: stating consent to a smaller
    // window is not a replay of declining to.
    const silent = await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-silent')));
    const accepted = await subject.dispatch(
      migrateRequest('s1', withRequestId(human, 'req-accepted'), {
        agent: 'claude-auto-other',
        allowContextDowngrade: true,
      }),
    );

    // Assert
    should(silent.status).equal(200);
    should(accepted.status).equal(200);
    should(migrator.migrations.map(([, sent]) => sent.allowContextDowngrade)).deepEqual([false, true]);
  });

  it('should refuse a migration that names no target, because there is no default account', async () => {
    // Unlike the revive, whose body is entirely optional, a migration with no agent is not a
    // migration with a default — it names nothing to move to.
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const empty = await subject.dispatch(migrateRequest('s1', human, ''));
    const braces = await subject.dispatch(migrateRequest('s1', human, {}));
    const blank = await subject.dispatch(migrateRequest('s1', human, { agent: '' }));

    // Assert
    should([empty.status, braces.status, blank.status]).deepEqual([400, 400, 400]);
    should(migrator.migrations).be.empty();
  });

  it('should refuse a field the protocol does not carry rather than silently dropping it', async () => {
    // `MigrateSessionRequestSchema` is strict. A caller sending `force` believes the gate can be
    // overridden through this route; accepting and ignoring it would let them believe that.
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const forced = await subject.dispatch(migrateRequest('s1', human, { agent: 'claude-auto-other', force: true }));

    // Assert
    should(forced.status).equal(400);
    should(migrator.migrations).be.empty();
  });

  it('should refuse anonymously and refuse a warden token, because a migration replaces an agent', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const anonymous = await subject.dispatch(migrateRequest('s1', {}));
    const warden = await subject.dispatch(migrateRequest('s1', { authorization: `Bearer ${CREDENTIALS.warden}` }));
    const peer = await subject.dispatch(migrateRequest('s1', agentIn('s9')));

    // Assert
    should(anonymous.status).equal(401);
    should(warden.status).equal(403);
    // A peer holds the admin token, so it reaches the subsystem exactly as the start and stop allow.
    should(peer.status).equal(200);
    should(migrator.migrations).have.length(1);
  });

  it('should answer each refusal the migration raises with its own status and code', async () => {
    // These are genuinely different next actions: wait for the work to finish, pick another account,
    // accept the smaller window, or read the session's record to see what the relaunch did.
    // Arrange
    const subject = dispatcher(
      new FakeSessionMigrate(['s1'], {
        busy: new SessionMigrateError('refused', 'refused: a destructive command is in flight'),
        broken: new SessionMigrateError('unusable', 'the documents for session broken do not satisfy the protocol'),
        nosuch: new SessionMigrateError('unknown_agent', 'no account is published as "ghost"'),
        spent: new SessionMigrateError('unavailable', 'account ghost cannot serve a session'),
        smaller: new SessionMigrateError('context_downgrade', 'the conversation would be truncated'),
        crossed: new SessionMigrateError(
          'harness_mismatch',
          'this session runs the claude harness and codex-auto-target is a codex account',
        ),
        stuck: new SessionMigrateError('failed', 'the replacement pane never became ready'),
        amnesia: new SessionMigrateError('unresumable', 'this session has no recorded conversation'),
        weird: new SessionMigrateError('invalid', '"weird" is not a usable session id'),
      }),
    );

    // Act
    const answers = await Promise.all(
      ['busy', 'broken', 'nosuch', 'spent', 'smaller', 'crossed', 'stuck', 'amnesia', 'weird', 'absent'].map(
        async id => await subject.dispatch(migrateRequest(id)),
      ),
    );

    // Assert
    should(answers.map(response => [response.status, (JSON.parse(response.body) as { code: string }).code])).deepEqual([
      [409, 'migration_refused'],
      [409, 'session_unusable'],
      [404, 'unknown_agent'],
      [503, 'agent_unavailable'],
      [409, 'context_downgrade_refused'],
      // The account exists and is available; it is simply not this session's harness family. 409
      // rather than 404 or 400, because the request is well formed and names a real account.
      [409, 'harness_mismatch'],
      [500, 'session_migrate_failed'],
      // The conversation cannot go with it, and only the person may choose to start a fresh one.
      [409, 'conversation_unresumable'],
      [400, 'invalid_session_id'],
      [404, 'not-found'],
    ]);
  });

  it('should hand the gate an explicit force only when the caller sent one', async () => {
    // `forceInflight` is `z.default(false)` on the wire: saying nothing is declining to go past the
    // refusal, and only a caller that sends `true` — a person who confirmed "Restart anyway" — forces.
    // Two request ids, because forcing is a different request, not a replay of declining.
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const plain = await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-plain')));
    const forced = await subject.dispatch(
      migrateRequest('s1', withRequestId(human, 'req-forced'), { agent: 'claude-auto-other', forceInflight: true }),
    );
    const malformed = await subject.dispatch(
      migrateRequest('s1', withRequestId(human, 'req-bad'), { agent: 'claude-auto-other', forceInflight: 'yes' }),
    );

    // Assert
    should([plain.status, forced.status, malformed.status]).deepEqual([200, 200, 400]);
    should(migrator.migrations.map(([, sent]) => sent.forceInflight)).deepEqual([false, true]);
  });

  it('should answer a refusal with the inventory as data beside the sentence', async () => {
    // The sentence is for a log; the PWA lists what is running from `inflight`, so a person can decide
    // whether to restart anyway. A refusal with no data carries no such field.
    // Arrange
    const inflight: MigrationRefusal = {
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
    const subject = dispatcher(
      new FakeSessionMigrate(['s1'], {
        s1: new SessionMigrateError('refused', 'refused: a program', { inflight }),
        s2: new SessionMigrateError('refused', 'refused: ps failed'),
      }),
    );

    // Act
    const withData = await subject.dispatch(migrateRequest('s1'));
    const without = await subject.dispatch(migrateRequest('s2'));

    // Assert
    should(JSON.parse(withData.body)).deepEqual({ error: 'refused: a program', code: 'migration_refused', inflight });
    should(MigrationRefusedBodySchema.parse(JSON.parse(withData.body)).inflight?.items).have.length(1);
    should(JSON.parse(without.body)).deepEqual({ error: 'refused: ps failed', code: 'migration_refused' });
  });

  it('should carry the two windows of a context downgrade as data, never as an API field name', async () => {
    // Arrange
    const downgrade = { model: 'claude-sonnet-5', targetWindow: 200_000, currentWindow: 1_000_000 };
    const subject = dispatcher(
      new FakeSessionMigrate(['s1'], {
        s1: new SessionMigrateError('context_downgrade', 'cut off', { downgrade }),
      }),
    );

    // Act
    const response = await subject.dispatch(migrateRequest('s1'));

    // Assert
    should(response.status).equal(409);
    should(JSON.parse(response.body)).deepEqual({ error: 'cut off', code: 'context_downgrade_refused', downgrade });
  });

  it('should carry the whole in-flight inventory in the refusal, because a bare 409 is unactionable', async () => {
    // The gate's refusal names what it found — the process, the verdict, the blind spot — and the
    // operator decides from that whether to wait or to stop the work. Truncating it to a code would
    // leave them with no way to tell "a build is running" from "we could not look".
    // Arrange
    const inventory =
      'refused: a destructive command is in flight\nin-flight inventory — status running, turn 3, worst: DESTRUCTIVE\n' +
      '  proc  [DESTRUCTIVE] pid 4242 (2m): git push origin main';
    const subject = dispatcher(new FakeSessionMigrate(['s1'], { s1: new SessionMigrateError('refused', inventory) }));

    // Act
    const response = await subject.dispatch(migrateRequest('s1'));

    // Assert
    should(response.status).equal(409);
    should((JSON.parse(response.body) as { error: string }).error).equal(inventory);
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // A session id is a directory name downstream, and this route writes a report into that
    // directory before anything else happens.
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const traversal = await subject.dispatch(migrateRequest('%2e%2e%2fetc'));

    // Assert
    should(traversal.status).equal(400);
    should((JSON.parse(traversal.body) as { code: string }).code).equal('invalid_session_id');
    should(migrator.migrations).be.empty();
  });

  it('should let an error that is not a stated refusal surface as itself', async () => {
    // A defect must not be dressed up as a refusal the caller could act on: the taxonomy covers what
    // the migration decides, and anything else is this daemon being broken.
    // Arrange
    const subject = dispatcher(
      new FakeSessionMigrate(['s1'], {
        // Not a SessionMigrateError: the cast is the point of the case.
        s1: new Error('the storage index was closed') as SessionMigrateError,
      }),
    );

    // Act
    const response = await subject.dispatch(migrateRequest('s1'));

    // Assert
    should(response.status).equal(500);
    should((JSON.parse(response.body) as { code: string }).code).not.equal('migration_refused');
  });
});

/**
 * The stale-settings read: whether a Restart would relaunch this session on different settings.
 *
 * It lives on the migration's mount because a Restart IS a migration onto the same account, so it is
 * served under the same credential floor and answers the same refusals for an id it cannot use.
 */
describe('the session relaunch-settings read', () => {
  const read = (sessionId: string, headers: Readonly<Record<string, string>> = human) =>
    request({ method: 'GET', path: `/v1/sessions/${sessionId}/relaunch-settings`, headers });

  it('should answer what the subsystem says, in the protocol shape', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const response = await subject.dispatch(read('s1'));

    // Assert
    should(response.status).equal(200);
    should(SessionRelaunchSettingsSchema.parse(JSON.parse(response.body))).deepEqual({
      current: false,
      reasons: ['settings'],
    });
    should(migrator.relaunchReads).deepEqual(['s1']);
    // A read moves nothing.
    should(migrator.migrations).be.empty();
  });

  it('should answer an unknown session as not found, and refuse anonymously', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const absent = await subject.dispatch(read('s404'));
    const anonymous = await subject.dispatch(read('s1', {}));

    // Assert
    should(absent.status).equal(404);
    should(anonymous.status).equal(401);
  });

  it('should refuse a path parameter that would regain a separator', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const traversal = await subject.dispatch(read('%2e%2e%2fetc'));

    // Assert
    should(traversal.status).equal(400);
    should(migrator.relaunchReads).be.empty();
  });
});

/**
 * The conversion preview: what a cross-harness move would carry, asked before anything moves.
 *
 * A read with a body. Served under the migration's own floor and refusals, needing no request id
 * because nothing is written, and answering a refusal as a 200 `refused` the sheet shows in place.
 */
describe('the session conversion-preview read', () => {
  const preview = (sessionId: string, body: unknown, headers: Readonly<Record<string, string>> = human) =>
    request({
      method: 'POST',
      path: `/v1/sessions/${sessionId}/conversion-preview`,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('should answer the subsystem preview in the protocol shape, passing the account and model through', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const ready = await subject.dispatch(preview('s1', { agent: 'codex-a', model: 'gpt-5.5' }));
    const refused = await subject.dispatch(preview('s1', { agent: 'claude-same' }));

    // Assert
    should(ready.status).equal(200);
    should(ConversionPreviewSchema.parse(JSON.parse(ready.body))).match({ kind: 'ready', targetAgent: 'codex-a' });
    should(refused.status).equal(200);
    should(ConversionPreviewSchema.parse(JSON.parse(refused.body))).deepEqual({
      kind: 'refused',
      targetAgent: 'claude-same',
      reason: 'same harness',
    });
    should(migrator.previews).deepEqual([
      ['s1', { agent: 'codex-a', model: 'gpt-5.5' }],
      ['s1', { agent: 'claude-same' }],
    ]);
    should(migrator.migrations).be.empty();
  });

  it('should refuse a body with no account, an unknown session, and an anonymous caller', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const noAgent = await subject.dispatch(preview('s1', {}));
    const absent = await subject.dispatch(preview('s404', { agent: 'codex-a' }));
    const anonymous = await subject.dispatch(preview('s1', { agent: 'codex-a' }, {}));

    // Assert
    should(noAgent.status).equal(400);
    should(absent.status).equal(404);
    should(anonymous.status).equal(401);
  });
});

/**
 * The route's replay contract.
 *
 * The protocol client retries this POST up to three times on transport failure and a migration kills
 * and relaunches a pane, so "how many times did the subsystem actually run" is the only assertion
 * that matters in every case here.
 */
describe('the session migrate mount, replayed', () => {
  /**
   * Counts subsystem entries and can be told what each successive call does. Views come from the
   * shared fake, so the body every case compares is the one the read surface really serves.
   */
  class CountingMigrate {
    calls = 0;
    readonly #views = new FakeSessionMigrate(['s1', 's2']);
    constructor(private readonly outcomes: ReadonlyArray<'ok' | SessionMigrateError> = ['ok']) {}
    async migrate(
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
      return await this.#views.migrate(sessionId, request);
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

  const mounted = (subsystem: CountingMigrate) =>
    new ApiDispatcher(new ApiRouter(sessionMigrateRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

  it('should refuse a migration that carries no request id, and destroy nothing', async () => {
    // Arrange
    const migrator = new CountingMigrate();
    const subject = mounted(migrator);

    // Act
    const response = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/migrate',
        headers: human,
        body: JSON.stringify({ agent: 'claude-auto-other' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should((JSON.parse(response.body) as { code: string }).code).equal('missing_request_id');
    should(migrator.calls).equal(0);
  });

  it('should answer a replayed request id with the first migration, without relaunching again', async () => {
    // Arrange
    const migrator = new CountingMigrate();
    const subject = mounted(migrator);
    const headers = withRequestId(human, 'req-replay');

    // Act
    const first = await subject.dispatch(migrateRequest('s1', headers));
    const replay = await subject.dispatch(migrateRequest('s1', headers));

    // Assert
    should(first.status).equal(200);
    should(replay.status).equal(200);
    should(replay.body).equal(first.body);
    should(migrator.calls).equal(1);
  });

  it('should keep distinct request ids as distinct migrations', async () => {
    // Arrange
    const migrator = new CountingMigrate();
    const subject = mounted(migrator);

    // Act
    await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-a')));
    await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-b')));

    // Assert
    should(migrator.calls).equal(2);
  });

  it('should let a refused preflight be re-evaluated under the same request id', async () => {
    // Nothing was destroyed, so asking again must consult the session's CURRENT condition — this is
    // what the sheet's "Retry safety check" does, and caching the refusal would freeze the answer.
    // Arrange
    const migrator = new CountingMigrate([new SessionMigrateError('refused', 'in-flight work refuses this'), 'ok']);
    const subject = mounted(migrator);
    const headers = withRequestId(human, 'req-retry');

    // Act
    const refused = await subject.dispatch(migrateRequest('s1', headers));
    const retried = await subject.dispatch(migrateRequest('s1', headers));

    // Assert
    should(refused.status).equal(409);
    should((JSON.parse(refused.body) as { code: string }).code).equal('migration_refused');
    should(retried.status).equal(200);
    should(migrator.calls).equal(2);
  });

  it('should let a cross-family refusal be re-evaluated under the same request id', async () => {
    // A mismatch is decided BEFORE the pane is touched, exactly like the preflight's refusal above, so
    // it must behave like one in the ledger: the request id is not spent, and the same id presented
    // again after the caller corrects the account is a migration that runs rather than a cached 409.
    // If this were treated as post-destruction the operator's only remedy would be a new request id
    // for a session nothing had touched.
    // Arrange
    const migrator = new CountingMigrate([
      new SessionMigrateError('harness_mismatch', 'this session runs the claude harness and X is a codex account'),
      'ok',
    ]);
    const subject = mounted(migrator);
    const headers = withRequestId(human, 'req-crossed');

    // Act
    const refused = await subject.dispatch(migrateRequest('s1', headers, { agent: 'codex-auto-target' }));
    const corrected = await subject.dispatch(migrateRequest('s1', headers, { agent: 'claude-auto-target' }));

    // Assert
    should(refused.status).equal(409);
    should((JSON.parse(refused.body) as { code: string }).code).equal('harness_mismatch');
    should(corrected.status).equal(200);
    should(migrator.calls).equal(2);
  });

  it('should never re-attempt a relaunch that failed after the pane was already replaced', async () => {
    // `failed` is past the point of no return: the pane is dead and the document restamped. A retry
    // 250ms later must be told what happened, not allowed to destroy a second time.
    // Arrange
    const migrator = new CountingMigrate([
      new SessionMigrateError('failed', 'the relaunch under the new account failed'),
      'ok',
    ]);
    const subject = mounted(migrator);
    const headers = withRequestId(human, 'req-committed');

    // Act
    const failed = await subject.dispatch(migrateRequest('s1', headers));
    const replay = await subject.dispatch(migrateRequest('s1', headers));

    // Assert
    should(failed.status).equal(500);
    should((JSON.parse(failed.body) as { code: string }).code).equal('session_migrate_failed');
    should(replay.status).equal(500);
    should((JSON.parse(replay.body) as { code: string }).code).equal('session_migrate_failed');
    should(migrator.calls).equal(1);
  });

  it('should refuse one request id that arrives naming a different target', async () => {
    // Answering the second with the first's result would tell a caller its migration to one account
    // succeeded when a migration to another is what happened.
    // Arrange
    const migrator = new CountingMigrate();
    const subject = mounted(migrator);
    const headers = withRequestId(human, 'req-reused');

    // Act
    await subject.dispatch(migrateRequest('s1', headers, { agent: 'codex-auto' }));
    const reused = await subject.dispatch(migrateRequest('s1', headers, { agent: 'codex-auto-other' }));

    // Assert
    should(reused.status).equal(409);
    should((JSON.parse(reused.body) as { code: string }).code).equal('request_id_reused');
    should(migrator.calls).equal(1);
  });

  it('should treat two spellings of one target as the same migration', async () => {
    // `allowContextDowngrade` is `z.default(false)`, so omitting it and stating it are the same ask.
    // Arrange
    const migrator = new CountingMigrate();
    const subject = mounted(migrator);
    const headers = withRequestId(human, 'req-same');

    // Act
    const stated = await subject.dispatch(
      migrateRequest('s1', headers, { agent: 'codex-auto', allowContextDowngrade: false }),
    );
    const omitted = await subject.dispatch(migrateRequest('s1', headers, { agent: 'codex-auto' }));

    // Assert
    should(stated.status).equal(200);
    should(omitted.status).equal(200);
    should(migrator.calls).equal(1);
  });

  it('should scope the ledger by session, so one id cannot answer for another session', async () => {
    // Arrange
    const migrator = new CountingMigrate();
    const subject = mounted(migrator);
    const headers = withRequestId(human, 'req-shared');

    // Act
    await subject.dispatch(migrateRequest('s1', headers));
    await subject.dispatch(migrateRequest('s2', headers));

    // Assert
    should(migrator.calls).equal(2);
  });

  it('should answer 503 when the ledger will admit no further migration, having destroyed nothing', async () => {
    // The ledger never discards a receipt, so the only way to bound it is to stop admitting NEW work.
    // A caller minting fresh request ids forever meets this wall instead of the daemon's heap.
    // Arrange: a mount that admits exactly two migrations.
    const migrator = new CountingMigrate();
    const subject = new ApiDispatcher(
      new ApiRouter(sessionMigrateRoutes(migrator, 2)),
      CREDENTIALS,
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-1')));
    await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-2')));
    const full = await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-3')));

    // Assert
    should(full.status).equal(503);
    const body = JSON.parse(full.body) as { code: string; error: string };
    should(body.code).equal('migration_ledger_full');
    // The message names the operator's actual remedy rather than implying that waiting helps.
    should(body.error).match(/will not admit another/);
    should(body.error).match(/Restart the daemon/);
    // The refused request never reached the subsystem, so no third pane was destroyed.
    should(migrator.calls).equal(2);
  });

  it('should keep replaying the migrations it already holds while the ledger is full', async () => {
    // A memory limit that stopped answering for migrations already performed would BE the
    // re-destruction hazard the limit exists to prevent.
    // Arrange
    const migrator = new CountingMigrate();
    const subject = new ApiDispatcher(
      new ApiRouter(sessionMigrateRoutes(migrator, 1)),
      CREDENTIALS,
      NO_GOVERNED_ROUTES_GUARD,
    );
    const held = withRequestId(human, 'req-held');

    // Act
    const first = await subject.dispatch(migrateRequest('s1', held));
    const refused = await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-new')));
    const replay = await subject.dispatch(migrateRequest('s1', held));

    // Assert
    should(first.status).equal(200);
    should(refused.status).equal(503);
    should(replay.status).equal(200);
    should(replay.body).equal(first.body);
    should(migrator.calls).equal(1);
  });

  it('should free admission again once a migration is refused before it touches the pane', async () => {
    // A refused preflight destroyed nothing, so it holds no receipt and its slot returns to the pool.
    // Arrange: one admission, and a subsystem that refuses first and then succeeds.
    const migrator = new CountingMigrate([new SessionMigrateError('refused', 'in-flight work refuses this'), 'ok']);
    const subject = new ApiDispatcher(
      new ApiRouter(sessionMigrateRoutes(migrator, 1)),
      CREDENTIALS,
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const refusedPreflight = await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-blocked')));
    const admitted = await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-after')));
    const full = await subject.dispatch(migrateRequest('s1', withRequestId(human, 'req-third')));

    // Assert
    should(refusedPreflight.status).equal(409);
    should((JSON.parse(refusedPreflight.body) as { code: string }).code).equal('migration_refused');
    // The freed slot admitted real work...
    should(admitted.status).equal(200);
    // ...and now that the slot holds a committed receipt, the cap bites.
    should(full.status).equal(503);
    should(migrator.calls).equal(2);
  });
});

describe('asking the agent to stop its background jobs', () => {
  const ask = (sessionId: string, headers: Readonly<Record<string, string>> = human, body?: string) =>
    request({
      method: 'POST',
      path: `/v1/sessions/${sessionId}/migrate/ask-to-stop-jobs`,
      headers,
      ...(body === undefined ? {} : { body }),
    });

  it('should answer with the jobs the agent was asked about, with no body and no request id needed', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const response = await subject.dispatch(ask('s1'));

    // Assert
    should(response.status).equal(200);
    const body = AskToStopJobsResultSchema.parse(JSON.parse(response.body));
    should(body).match({ messageId: 'migrate-jobs-4242', alreadyAsked: false, jobs: [{ pid: 4242 }] });
    should(migrator.jobAsks).deepEqual(['s1']);
    // It is an ask, not a move: no migration reached the subsystem.
    should(migrator.migrations).be.empty();
  });

  it('should refuse anonymously and refuse a warden token, as sending the agent a message does', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const anonymous = await subject.dispatch(ask('s1', {}));
    const warden = await subject.dispatch(ask('s1', { authorization: `Bearer ${CREDENTIALS.warden}` }));

    // Assert
    should(anonymous.status).equal(401);
    should(warden.status).equal(403);
    should(migrator.jobAsks).be.empty();
  });

  it('should refuse a body that names anything, because the daemon decides what to ask about', async () => {
    // Arrange
    const migrator = new FakeSessionMigrate();
    const subject = dispatcher(migrator);

    // Act
    const response = await subject.dispatch(ask('s1', human, JSON.stringify({ pids: [1] })));

    // Assert
    should(response.status).equal(400);
    should(migrator.jobAsks).be.empty();
  });

  it('should answer 409 no_background_jobs when there is nothing of the agent’s left to ask about', async () => {
    // Arrange
    const subject = dispatcher(
      new FakeSessionMigrate(['s1'], {
        gone: new SessionMigrateError('no_jobs', 'none of the agent’s own background jobs is in the way any more'),
      }),
    );

    // Act
    const response = await subject.dispatch(ask('gone'));

    // Assert
    should(response.status).equal(409);
    should((JSON.parse(response.body) as { code: string }).code).equal('no_background_jobs');
  });
});
