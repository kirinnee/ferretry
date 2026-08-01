import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type SessionView, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
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
  return new ApiDispatcher(new ApiRouter(sessionMigrateRoutes(subsystem)), CREDENTIALS);
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
      ['s1', { agent: 'codex-auto', model: 'gpt-5.6-terra', allowContextDowngrade: false }],
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
        stuck: new SessionMigrateError('failed', 'the replacement pane never became ready'),
        weird: new SessionMigrateError('invalid', '"weird" is not a usable session id'),
      }),
    );

    // Act
    const answers = await Promise.all(
      ['busy', 'broken', 'nosuch', 'spent', 'smaller', 'stuck', 'weird', 'absent'].map(
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
      [500, 'session_migrate_failed'],
      [400, 'invalid_session_id'],
      [404, 'not-found'],
    ]);
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
      request: { readonly agent: string; readonly model?: string; readonly allowContextDowngrade: boolean },
    ): Promise<SessionView> {
      const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)];
      this.calls += 1;
      if (outcome !== 'ok') throw outcome;
      return await this.#views.migrate(sessionId, request);
    }
  }

  const mounted = (subsystem: CountingMigrate) =>
    new ApiDispatcher(new ApiRouter(sessionMigrateRoutes(subsystem)), CREDENTIALS);

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
});
