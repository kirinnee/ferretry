import { describe, it } from 'bun:test';
import {
  PackNewOutcomeSchema,
  type PackNewOutcome,
  type PackNewRequest,
  type PackRecommendation,
  type PackView,
  SessionPackPatchResultSchema,
  SessionResultSchema,
  type SessionResult,
  type SessionView,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { packRoutes, type PackSubsystem } from '../../../../src/lib/runtime/mounts/pack.ts';
import { SessionPackError } from '../../../../src/lib/session/pack/service.ts';
import { jsonBody, request } from '../../api/support.ts';
import { packConfig } from '../../pack/support.ts';
import { CREDENTIALS, GRANTED, human, sessionView } from './support.ts';

/** The five Pack mode routes, over the real dispatcher: what each status and body is made of. */

const VIEW: PackView = { config: packConfig(), guide: { source: 'derived', useCases: [] }, models: [] };
const RECOMMENDATION: PackRecommendation = {
  task: 'fix the bug',
  useCase: { id: 'everyday', title: 'Everyday coding', matchedBy: 'words' },
  guideSource: 'derived',
  candidates: [
    {
      rank: 1,
      provider: 'anthropic',
      model: 'opus',
      why: 'Strong.',
      ready: false,
      refusal: { code: 'no_candidate', message: 'none' },
    },
  ],
};
const RESULT: SessionResult = { id: 's1', status: 'finished', finished: true, summary: 'done it' };

class FakePack implements PackSubsystem {
  readonly recommended: Array<{ task: string; useCase?: string }> = [];
  readonly started: PackNewRequest[] = [];
  readonly switched: Array<readonly [string, boolean]> = [];

  constructor(
    private readonly options: {
      readonly recommendation?: PackRecommendation | undefined;
      readonly outcome?: PackNewOutcome;
      readonly result?: SessionResult | undefined;
      readonly switchError?: unknown;
    } = {},
  ) {}

  readonly service = {
    view: async () => VIEW,
    recommend: async (input: { readonly task: string; readonly useCase?: string }) => {
      this.recommended.push(input);
      return 'recommendation' in this.options ? this.options.recommendation : RECOMMENDATION;
    },
    newChild: async (input: PackNewRequest): Promise<PackNewOutcome> => {
      this.started.push(input);
      return (
        this.options.outcome ?? {
          outcome: 'started',
          view: sessionView('child-1'),
          decidedBy: 'agent',
          attempts: [{ runtime: 'claude-main', outcome: 'started' }],
        }
      );
    },
  };

  async result(sessionId: string): Promise<SessionResult | undefined> {
    return 'result' in this.options ? this.options.result : { ...RESULT, id: sessionId };
  }

  async setSwitch(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ view: SessionView; outcome: { restartRequired: boolean; note: string } }> {
    this.switched.push([sessionId, enabled]);
    if (this.options.switchError !== undefined) throw this.options.switchError;
    return { view: sessionView(sessionId), outcome: { restartRequired: true, note: 'Pack mode is off.' } };
  }
}

const dispatcher = (subsystem: PackSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(packRoutes(subsystem)), CREDENTIALS, GRANTED);

const call = (method: string, path: string, body?: unknown, loopback = false) =>
  request({ method, path, headers: human, loopback, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('GET /v1/pack', () => {
  it('should answer the settings page’s view, uncached', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('GET', '/v1/pack'));

    // Assert
    should(answer.status).equal(200);
    should(jsonBody(answer)).deepEqual(JSON.parse(JSON.stringify(VIEW)) as Record<string, unknown>);
    should(answer.headers.get('cache-control')).equal('no-store');
  });
});

describe('POST /v1/pack/recommend', () => {
  it('should answer the recommendation for a task and pass on the use case named', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(
      call('POST', '/v1/pack/recommend', { task: 'fix the bug', useCase: 'everyday' }),
    );

    // Assert
    should(answer.status).equal(200);
    should((jsonBody(answer).candidates as unknown[]).length).equal(1);
    should(subsystem.recommended).deepEqual([{ task: 'fix the bug', useCase: 'everyday' }]);
  });

  it('should answer 409 when the guide names no use case, and 400 for a body that is not a task', async () => {
    // Arrange
    const empty = new FakePack({ recommendation: undefined });
    const valid = new FakePack();

    // Act
    const conflict = await dispatcher(empty).dispatch(call('POST', '/v1/pack/recommend', { task: 'x' }));
    const bad = await dispatcher(valid).dispatch(call('POST', '/v1/pack/recommend', { task: '' }));

    // Assert
    should(conflict.status).equal(409);
    should(jsonBody(conflict).code).equal('no_candidate');
    should(bad.status).equal(400);
    should(valid.recommended).be.empty();
  });
});

describe('POST /v1/pack/new', () => {
  const body = { task: 'fix the bug', runtime: 'claude-main', parent: 'p1' };

  it('should answer 201 with the started outcome', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', body));

    // Assert
    should(answer.status).equal(201);
    should(PackNewOutcomeSchema.parse(jsonBody(answer)).outcome).equal('started');
    should(subsystem.started).deepEqual([body]);
  });

  it('should answer 200 for a refusal, because a refusal is an answer', async () => {
    // Arrange
    const refused: PackNewOutcome = {
      outcome: 'refused',
      refusal: { code: 'limit_reached', message: 'too many' },
      attempts: [],
    };
    const subsystem = new FakePack({ outcome: refused });

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', body));

    // Assert
    should(answer.status).equal(200);
    should(jsonBody(answer)).deepEqual({ ...refused });
  });

  it('should let a caller at the machine name the sub-ferret’s folder', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', { ...body, cwd: '/work' }, true));

    // Assert
    should(answer.status).equal(201);
    should(subsystem.started[0]?.cwd).equal('/work');
  });

  it('should refuse 403 a folder chosen by a caller who is not at the machine', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', { ...body, cwd: '/etc' }));

    // Assert
    should(answer.status).equal(403);
    should(jsonBody(answer).code).equal('not-granted');
    should(subsystem.started).be.empty();
  });

  it('should refuse 400 a start that names no runtime and does not ask for --auto', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('POST', '/v1/pack/new', { task: 'x' }));

    // Assert
    should(answer.status).equal(400);
    should(subsystem.started).be.empty();
  });
});

describe('GET /v1/sessions/:sessionId/result', () => {
  it('should answer what a ferret reported', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('GET', '/v1/sessions/s1/result'));

    // Assert
    should(answer.status).equal(200);
    should(SessionResultSchema.parse(jsonBody(answer))).deepEqual(RESULT);
  });

  it('should answer 404 for a session that does not exist and 400 for an id that cannot be read', async () => {
    // Arrange
    const subsystem = new FakePack({ result: undefined });

    // Act
    const gone = await dispatcher(subsystem).dispatch(call('GET', '/v1/sessions/ghost/result'));
    const blank = await dispatcher(subsystem).dispatch(call('GET', '/v1/sessions/%E0%A4%A/result'));

    // Assert
    should(gone.status).equal(404);
    should(jsonBody(gone).code).equal('not-found');
    should(blank.status).equal(400);
    should(jsonBody(blank).code).equal('invalid_session_id');
  });
});

describe('PATCH /v1/sessions/:sessionId/pack', () => {
  it('should switch one ferret and answer with its view, whether it needs a restart, and why', async () => {
    // Arrange
    const subsystem = new FakePack();

    // Act
    const answer = await dispatcher(subsystem).dispatch(call('PATCH', '/v1/sessions/s1/pack', { enabled: false }));

    // Assert
    should(answer.status).equal(200);
    const result = SessionPackPatchResultSchema.parse(jsonBody(answer));
    should(result.restartRequired).be.true();
    should(result.note).equal('Pack mode is off.');
    should(result.view.config.id).equal('s1');
    should(subsystem.switched).deepEqual([['s1', false]]);
  });

  it('should answer 404 for a session that does not exist, 400 for a bad body, and 500 for a fault it does not own', async () => {
    // Arrange
    const missing = new FakePack({ switchError: new SessionPackError('not-found', 'no session ghost') });
    const broken = new FakePack({ switchError: new Error('disk full') });
    const valid = new FakePack();

    // Act
    const gone = await dispatcher(missing).dispatch(call('PATCH', '/v1/sessions/ghost/pack', { enabled: true }));
    const fault = await dispatcher(broken).dispatch(call('PATCH', '/v1/sessions/s1/pack', { enabled: true }));
    const bad = await dispatcher(valid).dispatch(call('PATCH', '/v1/sessions/s1/pack', { on: true }));

    // Assert
    should(gone.status).equal(404);
    should(jsonBody(gone).code).equal('not-found');
    should(fault.status).equal(500);
    should(bad.status).equal(400);
    should(valid.switched).be.empty();
  });
});

describe('the Pack route table', () => {
  it('should be five operator routes, never cached, with fleet.use on the two reads of the fleet only', () => {
    // Arrange / Act
    const routes = packRoutes(new FakePack());

    // Assert
    should(
      routes.map(route => [route.method, route.path, route.minimum, route.noStore, route.capability?.capability]),
    ).deepEqual([
      ['GET', '/v1/pack', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/recommend', 'operator', true, 'fleet'],
      ['POST', '/v1/pack/new', 'operator', true, undefined],
      ['GET', '/v1/sessions/:sessionId/result', 'operator', true, undefined],
      ['PATCH', '/v1/sessions/:sessionId/pack', 'operator', true, undefined],
    ]);
  });
});
