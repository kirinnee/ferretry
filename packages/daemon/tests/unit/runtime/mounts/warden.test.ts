import { describe, it } from 'bun:test';
import {
  WardenAgendaViewSchema,
  WardenConfigViewSchema,
  WardenInvestigateViewSchema,
  WardenLeaveViewSchema,
  WardenRunViewSchema,
  WardenStatusViewSchema,
  WardenVerdictsViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { WardenError, wardenRoutes } from '../../../../src/lib/runtime/mounts/warden.ts';
import { WardenRequestError } from '../../../../src/lib/warden/sweep.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeWarden, FERRET_SESSION, fromFerret, GRANTED, human } from './support.ts';

/**
 * Fleet supervision, over the real dispatcher and the real credentials.
 *
 * The authorization is the half that cannot be checked by calling a route function directly, and it
 * is the half that matters most here: the read is warden-scoped because a live warden reads its own
 * status, while running a sweep and changing the configuration spend agent sessions and decide how
 * many, so a warden that could reach them could escalate its own authority.
 */

const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

function dispatcher(subsystem = new FakeWarden()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(wardenRoutes(subsystem)), CREDENTIALS, GRANTED);
}

const get = (path: string, headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'GET', path, headers });

const send = (method: string, path: string, body?: string, headers: Readonly<Record<string, string>> = human) =>
  request({ method, path, headers, ...(body === undefined ? {} : { body }) });

describe('reading the warden status', () => {
  it('should answer with a body the client can parse', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    const response = await subject.dispatch(get('/v1/warden/status'));

    // Assert
    should(response.status).equal(200);
    should(() => WardenStatusViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should be readable by a live warden, which reads the fleet it was sent to triage', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(get('/v1/warden/status', warden));

    // Assert
    should(response.status).equal(200);
  });

  it('should never be cached: a stale one is a struggling fleet reporting all-clear', async () => {
    // Arrange / Act
    const routes = wardenRoutes(new FakeWarden());

    // Assert
    should(routes.every(route => route.noStore === true)).be.true();
  });
});

describe('reading concise warden reports', () => {
  it('should serve the report index to a live warden without granting a write', async () => {
    const response = await dispatcher().dispatch(get('/v1/warden/verdicts', warden));

    should(response.status).equal(200);
    should(() => WardenVerdictsViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should keep reports warden-readable but refuse missing and foreign paths alike', async () => {
    const subject = new FakeWarden();
    const missing = await dispatcher(subject).dispatch(
      request({
        method: 'GET',
        path: '/v1/warden/report',
        query: [['path', '/state/warden/reports/missing.md']],
        headers: warden,
      }),
    );
    const foreign = await dispatcher(subject).dispatch(
      request({ method: 'GET', path: '/v1/warden/report', query: [['path', '/etc/passwd']], headers: warden }),
    );

    should(missing.status).equal(404);
    should(foreign.status).equal(404);
  });

  it('should serve a readable report as plain text to a live warden', async () => {
    // Arrange
    class ReportingWarden extends FakeWarden {
      override async report(reportPath: string): Promise<string | undefined> {
        return reportPath === '/state/warden/reports/sweep.md' ? '# sweep\nall quiet\n' : undefined;
      }
    }

    // Act
    const response = await dispatcher(new ReportingWarden()).dispatch(
      request({
        method: 'GET',
        path: '/v1/warden/report',
        query: [['path', '/state/warden/reports/sweep.md']],
        headers: warden,
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.body).equal('# sweep\nall quiet\n');
    should(response.headers.get('content-type')).equal('text/plain; charset=utf-8');
  });

  it('should reject an omitted report path instead of treating it as empty evidence', async () => {
    const response = await dispatcher().dispatch(get('/v1/warden/report', warden));

    should(response.status).equal(400);
  });
});

describe('running a sweep on request', () => {
  it('should default to detection without spend when no body is sent', async () => {
    // Arrange
    const subsystem = new FakeWarden();

    // Act
    const response = await dispatcher(subsystem).dispatch(send('POST', '/v1/warden/run'));

    // Assert
    should(response.status).equal(200);
    should(subsystem.runs).deepEqual([false]);
    should(() => WardenRunViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should force a spawn only when an operator explicitly asked for one', async () => {
    // Arrange
    const subsystem = new FakeWarden();

    // Act
    await dispatcher(subsystem).dispatch(send('POST', '/v1/warden/run', JSON.stringify({ spawn: true })));

    // Assert
    should(subsystem.runs).deepEqual([true]);
  });

  it('should refuse a ferret forcing investigators, which are warden sessions with no parent, and still let it look', async () => {
    // Arrange
    const subsystem = new FakeWarden();
    const on = dispatcher(subsystem);

    // Act
    const own = await on.dispatch(fromFerret(send('POST', '/v1/warden/run', JSON.stringify({ spawn: true }))));
    const header = await on.dispatch(
      send('POST', '/v1/warden/run', JSON.stringify({ spawn: true }), agentIn(FERRET_SESSION)),
    );
    const look = await on.dispatch(fromFerret(send('POST', '/v1/warden/run', JSON.stringify({ spawn: false }))));

    // Assert
    should([own.status, JSON.parse(own.body).code]).deepEqual([403, 'owner_only']);
    should([header.status, JSON.parse(header.body).code]).deepEqual([403, 'owner_only']);
    should(look.status).equal(200);
    should(subsystem.runs).deepEqual([false]);
  });

  it('should refuse a warden-scoped caller, which must not be able to force its own re-spawn', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(send('POST', '/v1/warden/run', undefined, warden));

    // Assert
    should(response.status).equal(403);
  });

  it('should reject a body that is not JSON rather than downgrading it to no fields', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(send('POST', '/v1/warden/run', '{oops'));

    // Assert
    should(response.status).equal(400);
  });
});

describe('the warden configuration surface', () => {
  it('should serve the configuration with its accounts and warnings', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(get('/v1/warden/config'));

    // Assert
    should(response.status).equal(200);
    should(() => WardenConfigViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should refuse a warden-scoped caller, which must not raise its own concurrency cap', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(get('/v1/warden/config', warden));

    // Assert
    should(response.status).equal(403);
  });

  it('should hand the patch to the subsystem', async () => {
    // Arrange
    const subsystem = new FakeWarden();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      send('PATCH', '/v1/warden/config', JSON.stringify({ enabled: true })),
    );

    // Assert
    should(response.status).equal(200);
    should(subsystem.patches).deepEqual([{ enabled: true }]);
  });

  it('should refuse a patch naming a field that does not exist', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(
      send('PATCH', '/v1/warden/config', JSON.stringify({ intervalMinuts: 5 })),
    );

    // Assert
    should(response.status).equal(400);
  });

  it('should refuse an empty patch rather than reporting success for nothing', async () => {
    // Arrange: unlike the run, there is no safe default meaning for "change nothing".
    const response = await dispatcher().dispatch(send('PATCH', '/v1/warden/config'));

    // Assert
    should(response.status).equal(400);
  });
});

describe('restating a warden refusal', () => {
  it.each([
    { failure: 'invalid' as const, status: 400, code: 'invalid_request' },
    { failure: 'failed' as const, status: 500, code: 'warden_sweep_failed' },
  ])('should answer $status for a $failure refusal', async ({ failure, status, code }) => {
    // Arrange
    const subject = dispatcher(new FakeWarden(new WardenError(failure, 'the sweep could not run')));

    // Act
    const response = await subject.dispatch(send('POST', '/v1/warden/run'));

    // Assert
    should(response.status).equal(status);
    should(JSON.parse(response.body).code).equal(code);
  });

  it('should restate a refusal from the status read too', async () => {
    // Arrange
    const subject = dispatcher(new FakeWarden(new WardenError('failed', 'the fleet could not be read')));

    // Act
    const response = await subject.dispatch(get('/v1/warden/status'));

    // Assert
    should(response.status).equal(500);
  });

  it('should restate a refusal from both halves of the configuration surface', async () => {
    // Arrange
    const subject = dispatcher(new FakeWarden(new WardenError('invalid', 'the configuration is impossible')));

    // Act
    const read = await subject.dispatch(get('/v1/warden/config'));
    const write = await subject.dispatch(send('PATCH', '/v1/warden/config', JSON.stringify({ enabled: true })));

    // Assert
    should(read.status).equal(400);
    should(write.status).equal(400);
  });

  it('should let a failure that is not a warden refusal through unchanged', async () => {
    // Arrange: a bug in the sweep must not be dressed up in the warden's own taxonomy — that would
    // report a programming error as a supervision outcome an operator could act on.
    class Exploding extends FakeWarden {
      override async status(): Promise<never> {
        throw new TypeError('cannot read properties of undefined');
      }
    }

    // Act
    const response = await dispatcher(new Exploding()).dispatch(get('/v1/warden/status'));

    // Assert
    should(response.status).equal(500);
    should(JSON.parse(response.body).code).not.equal('warden_sweep_failed');
  });
});

describe('the "who needs you" feed', () => {
  it('should answer with a body the client can parse, to a live warden too', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    const owner = await subject.dispatch(get('/v1/warden/attention'));
    const live = await subject.dispatch(get('/v1/warden/attention', warden));

    // Assert
    should(owner.status).equal(200);
    should(live.status).equal(200);
    should(() => WardenAgendaViewSchema.parse(JSON.parse(owner.body))).not.throw();
  });

  it('should restate a refusal from the feed', async () => {
    // Arrange
    const subject = dispatcher(new FakeWarden(new WardenError('failed', 'the boards could not be read')));

    // Act
    const response = await subject.dispatch(get('/v1/warden/attention'));

    // Assert
    should(response.status).equal(500);
  });
});

describe('asking for an investigation', () => {
  it('should hand the owner’s request to the subsystem and answer where it stands', async () => {
    // Arrange
    const subsystem = new FakeWarden();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      send('POST', '/v1/warden/investigate', JSON.stringify({ sessionId: 's1', note: 'CI went red' })),
    );

    // Assert
    should(response.status).equal(200);
    should(subsystem.investigations).deepEqual([{ sessionId: 's1', note: 'CI went red' }]);
    should(() => WardenInvestigateViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should refuse a warden-scoped caller, which must not spend on investigations of its own', async () => {
    // Arrange
    const subsystem = new FakeWarden();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      send('POST', '/v1/warden/investigate', JSON.stringify({ sessionId: 's1' }), warden),
    );

    // Assert
    should(response.status).equal(403);
    should(subsystem.investigations).deepEqual([]);
  });

  it('should refuse a request that names no ferret', async () => {
    // Act
    const response = await dispatcher().dispatch(send('POST', '/v1/warden/investigate', JSON.stringify({})));

    // Assert
    should(response.status).equal(400);
  });

  it.each([
    ['off', 409, 'warden_off'],
    ['not_found', 404, 'not-found'],
    ['finished', 409, 'session_finished'],
    ['cap', 409, 'warden_cap_reached'],
  ] as const)('should answer a %s refusal with %d %s', async (failure, status, code) => {
    // Arrange
    const subject = dispatcher(new FakeWarden(new WardenRequestError(failure, `refused: ${failure}`)));

    // Act
    const response = await subject.dispatch(
      send('POST', '/v1/warden/investigate', JSON.stringify({ sessionId: 's1' })),
    );

    // Assert
    should(response.status).equal(status);
    should(JSON.parse(response.body)).match({ code, error: `refused: ${failure}` });
  });
});

describe('leaving a ferret alone longer', () => {
  it('should hand the owner’s choice to the subsystem and answer the blessing it made', async () => {
    // Arrange
    const subsystem = new FakeWarden();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      send('POST', '/v1/warden/leave', JSON.stringify({ sessionId: 's1', duration: 'until_change' })),
    );

    // Assert
    should(response.status).equal(200);
    should(subsystem.leaves).deepEqual([{ sessionId: 's1', duration: 'until_change' }]);
    should(() => WardenLeaveViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should refuse a warden-scoped caller, which must not switch off its own supervision', async () => {
    // Arrange
    const subsystem = new FakeWarden();

    // Act
    const response = await dispatcher(subsystem).dispatch(
      send('POST', '/v1/warden/leave', JSON.stringify({ sessionId: 's1', duration: '1h' }), warden),
    );

    // Assert
    should(response.status).equal(403);
    should(subsystem.leaves).deepEqual([]);
  });

  it('should refuse a duration nobody can pick', async () => {
    // Act
    const response = await dispatcher().dispatch(
      send('POST', '/v1/warden/leave', JSON.stringify({ sessionId: 's1', duration: 'forever' })),
    );

    // Assert
    should(response.status).equal(400);
  });

  it.each([
    ['not_found', 404, 'not-found'],
    ['finished', 409, 'session_finished'],
    ['not_flagged', 409, 'warden_nothing_flagged'],
  ] as const)('should answer a %s refusal with %d %s', async (failure, status, code) => {
    // Arrange
    const subject = dispatcher(new FakeWarden(new WardenRequestError(failure, `refused: ${failure}`)));

    // Act
    const response = await subject.dispatch(
      send('POST', '/v1/warden/leave', JSON.stringify({ sessionId: 's1', duration: '4h' })),
    );

    // Assert
    should(response.status).equal(status);
    should(JSON.parse(response.body)).match({ code, error: `refused: ${failure}` });
  });
});
