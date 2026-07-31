import { describe, it } from 'bun:test';
import { SessionViewSchema } from '@ferretry/protocol';
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

function migrateRequest(
  sessionId: string,
  headers: Readonly<Record<string, string>> = human,
  body: unknown = { agent: 'claude-auto-other' },
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({
    method: 'POST',
    path: `/v1/sessions/${sessionId}/migrate`,
    headers,
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

    // Act
    const silent = await subject.dispatch(migrateRequest('s1'));
    const accepted = await subject.dispatch(
      migrateRequest('s1', human, { agent: 'claude-auto-other', allowContextDowngrade: true }),
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
